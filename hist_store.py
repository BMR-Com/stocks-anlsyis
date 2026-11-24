#!/usr/bin/env python3
"""
Long daily price history store (shared by hist_engine, commod_engine, options_engine).

Each series lives in two files so the daily commit stays small:
  data/hist/<SAFE>.base.json   every bar before 1 January of the current year (rewritten once a year)
  data/hist/<SAFE>.json        bars of the current year (topped up every run)
Format of both: {"t":[YYYY-MM-DD...],"o":[],"h":[],"l":[],"c":[],"v":[]}
data/hist/index.json lists every series with name, group, kind, first/last date and row count.

Rules: rows are never dropped; a fresh download only adds new dates and overwrites
overlapping ones. Prices are split-adjusted (Yahoo Close), not dividend-adjusted; when a new
split shows up as a step between stored and fresh overlapping closes, the stored history is
rescaled by that ratio.
"""
import os, json, datetime as dt
import numpy as np
import pandas as pd

ROOT = os.path.join("data", "hist")
INDEX = os.path.join(ROOT, "index.json")
COLS = ["Open", "High", "Low", "Close", "Volume"]


def safe(sym):
    return (sym.replace("^", "_I_").replace("=", "_").replace("/", "_")
               .replace("!", "").replace(":", "_"))


def _paths(sym):
    s = safe(sym)
    return os.path.join(ROOT, f"{s}.base.json"), os.path.join(ROOT, f"{s}.json")


def _read(p):
    if not os.path.exists(p):
        return None
    with open(p) as f:
        d = json.load(f)
    if not d.get("t"):
        return None
    df = pd.DataFrame({"Open": d["o"], "High": d["h"], "Low": d["l"], "Close": d["c"],
                       "Volume": d.get("v") or [0] * len(d["t"])},
                      index=pd.to_datetime(d["t"]))
    return df


def load(sym):
    b, c = _paths(sym)
    parts = [x for x in (_read(b), _read(c)) if x is not None]
    if not parts:
        return None
    df = pd.concat(parts)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def _rnd(x):
    if x is None or not np.isfinite(x):
        return None
    ax = abs(x)
    nd = 2 if ax >= 1000 else 4 if ax >= 1 else 6
    return round(float(x), nd)


def _dump(df, p):
    d = {"t": [t.strftime("%Y-%m-%d") for t in df.index],
         "o": [_rnd(x) for x in df["Open"]], "h": [_rnd(x) for x in df["High"]],
         "l": [_rnd(x) for x in df["Low"]], "c": [_rnd(x) for x in df["Close"]],
         "v": [int(x) if np.isfinite(x) else 0 for x in df["Volume"].fillna(0)]}
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, separators=(",", ":"))
    os.replace(tmp, p)


def clean(df):
    """Normalise a yfinance frame to Open/High/Low/Close/Volume with a naive date index."""
    if df is None or len(df) == 0:
        return None
    df = df.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.title)
    for c in COLS:
        if c not in df.columns:
            df[c] = np.nan if c != "Volume" else 0
    df = df[COLS]
    df.index = pd.to_datetime(df.index)
    if getattr(df.index, "tz", None) is not None:
        df.index = df.index.tz_localize(None)
    df.index = df.index.normalize()
    df = df.dropna(subset=["Close"])
    df = df[df["Close"] > 0] if (df["Close"] > 0).any() else df
    for c in ("Open", "High", "Low"):
        df[c] = df[c].fillna(df["Close"])
    df["Volume"] = df["Volume"].fillna(0)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df if len(df) else None


def merge(old, new):
    new = clean(new)
    if new is None:
        return old
    if old is None or not len(old):
        return new
    ov = old.index.intersection(new.index)
    if len(ov):
        r = (new.loc[ov, "Close"] / old.loc[ov, "Close"]).median()
        # a split or reverse split shows up as a large step on every overlapping bar
        if np.isfinite(r) and (r < 0.8 or r > 1.25):
            old = old.copy()
            for c in ("Open", "High", "Low", "Close"):
                old[c] = old[c] * r
            if r > 0:
                old["Volume"] = old["Volume"] / r
    out = pd.concat([old[~old.index.isin(new.index)], new]).sort_index()
    return out


def save(sym, df):
    if df is None or not len(df):
        return
    os.makedirs(ROOT, exist_ok=True)
    b, c = _paths(sym)
    y0 = pd.Timestamp(dt.date(dt.date.today().year, 1, 1))
    base, cur = df[df.index < y0], df[df.index >= y0]
    if len(base):
        old = _read(b)
        same = (old is not None and len(old) == len(base) and old.index[-1] == base.index[-1]
                and np.allclose(old["Close"].values, base["Close"].values, rtol=1e-6, equal_nan=True))
        if not same:
            _dump(base, b)
    if len(cur):
        _dump(cur, c)
    elif os.path.exists(c):
        os.remove(c)


def load_index():
    if os.path.exists(INDEX):
        with open(INDEX) as f:
            return json.load(f)
    return {}


def save_index(ix):
    os.makedirs(ROOT, exist_ok=True)
    with open(INDEX, "w") as f:
        json.dump(dict(sorted(ix.items())), f, separators=(",", ":"))


def index_entry(df, **meta):
    e = {k: v for k, v in meta.items() if v not in (None, "")}
    e.update({"f": df.index[0].strftime("%Y-%m-%d"), "l": df.index[-1].strftime("%Y-%m-%d"),
              "r": int(len(df)), "file": safe(meta.get("sym", "")) if meta.get("sym") else None})
    e.pop("sym", None)
    return e


def yf_download(tickers, **kw):
    """Chunked yf.download that returns {ticker: frame}; failures are skipped."""
    import yfinance as yf, time
    out = {}
    chunk = kw.pop("chunk", 60)
    for i in range(0, len(tickers), chunk):
        part = tickers[i:i + chunk]
        for attempt in range(3):
            try:
                d = yf.download(part, group_by="ticker", auto_adjust=False, actions=False,
                                progress=False, threads=True, **kw)
                break
            except Exception as e:
                print(f"  download retry {attempt + 1}: {e}")
                time.sleep(5 * (attempt + 1))
                d = None
        if d is None or not len(d):
            continue
        for t in part:
            try:
                sub = d[t] if isinstance(d.columns, pd.MultiIndex) else d
                sub = clean(sub)
                if sub is not None:
                    out[t] = sub
            except Exception:
                pass
        time.sleep(1)
    return out
