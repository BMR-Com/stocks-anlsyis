#!/usr/bin/env python3
"""
Universe Scanner — the whole-market trade-idea screener.
--------------------------------------------------------
Bulk-downloads OHLCV for S&P 500 + Nasdaq-100 + Russell 2000 (free Yahoo data),
computes indicators, and tags each name with trade-idea signals:
  bullish/bearish divergence, price near EMA20/EMA50/SMA200, MACD cross/turn,
  RSI oversold/overbought, golden/death cross, 50-day breakout/breakdown,
  volume spike, distance from 52-week high.
Writes ONE compact data/scan.json the dashboard's Scanner tab reads.

Reuses the indicator/divergence functions from ta_engine.py.

Run:  python scan_engine.py
Deps: yfinance pandas numpy lxml requests
"""

import os, io, json, time
import numpy as np
import pandas as pd
import ta_engine as TA          # reuse ema/sma/rsi/macd/pivot_mask/divergences

# ----------------------------- CONFIG -----------------------------
INCLUDE      = ["SP500", "NASDAQ100", "RUSSELL2000"]   # trim this list to go smaller/faster
HIST_PERIOD  = "2y"        # full history downloaded ONCE per ticker (first run)
RECENT_PERIOD= "1mo"       # daily top-up window (covers gaps/holidays)
INTERVAL     = "1d"
CHUNK        = 150         # tickers per bulk yf.download call
MAX_HIST_BARS= 520         # keep ~2y of bars per ticker in the cache
NEAR_MA_PCT  = 0.02        # "near a moving average" = within 2%
FRESH_BARS   = 8           # a signal is "fresh" if it occurred in the last N bars
MAX_TICKERS  = None        # set an int to cap for testing
CACHE_FILE   = "cache/prices.parquet"   # persisted via GitHub Actions cache, not committed
OUTPUT       = "data/scan.json"
UA           = {"User-Agent": "Mozilla/5.0 (scanner)"}
# ------------------------------------------------------------------


# ============================ universe ============================
def _read_html(url):
    import requests
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    return pd.read_html(io.StringIO(r.text))

def get_sp500():
    try:
        t = _read_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")[0]
        return [s.replace(".", "-") for s in t["Symbol"].astype(str)]
    except Exception as e:
        print(f"  sp500 fetch failed: {e}"); return []

def get_nasdaq100():
    try:
        for t in _read_html("https://en.wikipedia.org/wiki/Nasdaq-100"):
            for col in ("Ticker", "Symbol"):
                if col in t.columns:
                    return [s.replace(".", "-") for s in t[col].astype(str)]
    except Exception as e:
        print(f"  nasdaq100 fetch failed: {e}")
    return []

def get_russell2000():
    """iShares IWM holdings CSV — the standard free Russell 2000 constituent source."""
    import requests
    url = ("https://www.ishares.com/us/products/239710/"
           "ishares-russell-2000-etf/1467271812596.ajax"
           "?fileType=csv&fileName=IWM_holdings&dataType=fund")
    try:
        r = requests.get(url, headers=UA, timeout=40); r.raise_for_status()
        # find the header row that contains "Ticker"
        lines = r.text.splitlines()
        start = next(i for i, ln in enumerate(lines) if ln.startswith('"Ticker"') or ln.startswith("Ticker"))
        df = pd.read_csv(io.StringIO("\n".join(lines[start:])))
        tick = df["Ticker"].dropna().astype(str)
        return [t.replace(".", "-") for t in tick if t.isalpha()]
    except Exception as e:
        print(f"  russell2000 fetch failed: {e}"); return []

FALLBACK = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","HOOD","SPY",
            "AMD","NFLX","CRM","ADBE","PLTR","COIN","MU","MARA","SOFI","RIVN"]

def build_universe():
    syms = set()
    if "SP500" in INCLUDE:       syms |= set(get_sp500())
    if "NASDAQ100" in INCLUDE:   syms |= set(get_nasdaq100())
    if "RUSSELL2000" in INCLUDE: syms |= set(get_russell2000())
    syms = sorted(s for s in syms if s and s.isalpha() and len(s) <= 5)
    if not syms:
        print("  universe empty — using fallback list")
        syms = FALLBACK
    if MAX_TICKERS:
        syms = syms[:MAX_TICKERS]
    return syms


# ============================ per-ticker scan ============================
BULL = {"bullish divergence","near EMA20","near EMA50","near SMA200",
        "MACD bull cross","RSI oversold","golden cross","50d breakout","volume spike"}
def _bias(ideas):
    bull = sum(1 for i in ideas if i in BULL and "bear" not in i)
    bear = len(ideas) - bull
    return bull - bear

def scan_one(t, df):
    df = df[["Open","High","Low","Close","Volume"]].dropna()
    if len(df) < 60:
        return None
    close = df["Close"]
    e20, e50, s200 = TA.ema(close,20), TA.ema(close,50), TA.sma(close,200)
    s50 = TA.sma(close,50)
    r = TA.rsi(close,14)
    ml, ms, mh = TA.macd(close)
    last = float(close.iloc[-1]); prev = float(close.iloc[-2])
    ideas = []

    def dist(ma):
        return None if pd.isna(ma.iloc[-1]) else round(float(last/ma.iloc[-1]-1),4)
    d20, d50, d200 = dist(e20), dist(e50), dist(s200)
    for d, name in ((d20,"EMA20"),(d50,"EMA50"),(d200,"SMA200")):
        if d is not None and abs(d) <= NEAR_MA_PCT:
            ideas.append(f"near {name}")

    if mh.iloc[-1] > 0 >= mh.iloc[-2]: ideas.append("MACD bull cross")
    if mh.iloc[-1] < 0 <= mh.iloc[-2]: ideas.append("MACD bear cross")
    if r.iloc[-1] < 30: ideas.append("RSI oversold")
    if r.iloc[-1] > 70: ideas.append("RSI overbought")

    # golden / death cross in last FRESH_BARS
    gd = np.sign((s50 - s200).dropna().values)
    if len(gd) > FRESH_BARS:
        seg = gd[-FRESH_BARS:]
        if (seg[:-1] < 0).any() and seg[-1] >= 0: ideas.append("golden cross")
        if (seg[:-1] > 0).any() and seg[-1] <= 0: ideas.append("death cross")

    # fresh divergence
    dfr = df.copy(); dfr["rsi"] = r
    cutoff = df.index[-FRESH_BARS].strftime("%Y-%m-%d")
    for d in TA.divergences(dfr, "rsi", TA.PIVOT_L, TA.PIVOT_R, TA.DIV_MAXBARS, "RSI"):
        if d["time"] >= cutoff:
            ideas.append("bullish divergence" if d["kind"]=="bull_div" else "bearish divergence")

    # breakout / breakdown (new 50-day high/low)
    hi = df["High"].rolling(50).max().shift(); lo = df["Low"].rolling(50).min().shift()
    if pd.notna(hi.iloc[-1]) and last > hi.iloc[-1]: ideas.append("50d breakout")
    if pd.notna(lo.iloc[-1]) and last < lo.iloc[-1]: ideas.append("50d breakdown")

    # volume spike
    vr = None
    av = df["Volume"].rolling(20).mean().iloc[-1]
    if av and not pd.isna(av):
        vr = round(float(df["Volume"].iloc[-1]/av),2)
        if vr >= 2: ideas.append("volume spike")

    if not ideas:
        return None
    win = min(252, len(df))
    h52 = round(float(last/df["High"].iloc[-win:].max()-1),4)
    return {
        "t": t, "px": round(last,2), "chg": round(last/prev-1,4),
        "rsi": round(float(r.iloc[-1]),1),
        "d20": d20, "d50": d50, "d200": d200,
        "h52": h52, "vr": vr, "ideas": ideas,
        "score": _bias(ideas), "n": len(ideas),
    }


# ============================ bulk fetch + cache ============================
def fetch_bulk(tickers, period):
    """Bulk-download OHLCV for many tickers. Returns {ticker: DataFrame}."""
    import yfinance as yf
    frames = {}
    for i in range(0, len(tickers), CHUNK):
        batch = tickers[i:i+CHUNK]
        try:
            data = yf.download(batch, period=period, interval=INTERVAL,
                               group_by="ticker", auto_adjust=True,
                               threads=True, progress=False)
        except Exception as e:
            print(f"  batch {i//CHUNK+1} failed: {e}"); continue
        for t in batch:
            try:
                df = data[t] if len(batch) > 1 else data
                if df is not None and not df.dropna(how="all").empty:
                    frames[t] = df.dropna(how="all")
            except Exception:
                pass
        print(f"  batch {i//CHUNK+1}/{-(-len(tickers)//CHUNK)}: {len(frames)} loaded")
        time.sleep(2)
    return frames

def _to_long(frames):
    """dict{ticker:df(OHLCV)} -> long DataFrame [ticker,date,open,high,low,close,volume]."""
    parts = []
    for t, df in frames.items():
        d = df.reset_index()
        d = d.rename(columns={d.columns[0]: "date"})          # former index is the date
        d.columns = [str(c).lower() for c in d.columns]
        keep = [c for c in ("date", "open", "high", "low", "close", "volume") if c in d.columns]
        d = d[keep].copy()
        d["ticker"] = t
        parts.append(d)
    if not parts:
        return pd.DataFrame(columns=["ticker", "date", "open", "high", "low", "close", "volume"])
    out = pd.concat(parts, ignore_index=True)
    out["date"] = pd.to_datetime(out["date"]).dt.tz_localize(None).dt.normalize()
    return out

def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            df = pd.read_parquet(CACHE_FILE)
            df["date"] = pd.to_datetime(df["date"])
            print(f"  cache loaded: {df['ticker'].nunique()} tickers, {len(df)} rows")
            return df
        except Exception as e:
            print(f"  cache read failed ({e}); rebuilding")
    return pd.DataFrame(columns=["ticker", "date", "open", "high", "low", "close", "volume"])

def save_cache(df):
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    df.to_parquet(CACHE_FILE, index=False)
    print(f"  cache saved: {df['ticker'].nunique()} tickers, {len(df)} rows -> {CACHE_FILE}")

def update_cache(cache, universe):
    """Download full history for NEW tickers once; top up recent bars for all; merge."""
    have = set(cache["ticker"].unique()) if len(cache) else set()
    new = [t for t in universe if t not in have]
    frames = {}
    if new:
        print(f"  first-time full history for {len(new)} new tickers ({HIST_PERIOD}) ...")
        frames.update(fetch_bulk(new, HIST_PERIOD))
    print(f"  recent top-up for {len(universe)} tickers ({RECENT_PERIOD}) ...")
    recent = fetch_bulk(universe, RECENT_PERIOD)
    frames_recent = {t: df for t, df in recent.items()}
    new_long = pd.concat([_to_long(frames), _to_long(frames_recent)], ignore_index=True) \
        if (frames or frames_recent) else pd.DataFrame(columns=cache.columns)
    merged = pd.concat([cache, new_long], ignore_index=True)
    if len(merged):
        merged = (merged.dropna(subset=["date"])
                        .drop_duplicates(["ticker", "date"], keep="last")
                        .sort_values(["ticker", "date"]))
        merged = merged.groupby("ticker", group_keys=False).tail(MAX_HIST_BARS)
    return merged


# ============================ chart export ============================
def export_charts(cache):
    """Write a compact candle file per ticker so the dashboard can chart ANY name."""
    d = "data/charts"
    os.makedirs(d, exist_ok=True)
    idx = []
    for t, g in cache.groupby("ticker"):
        g = g.sort_values("date")
        if len(g) < 5:
            continue
        rec = {
            "t": [x.strftime("%Y-%m-%d") for x in g["date"]],
            "o": [round(float(v), 3) for v in g["open"]],
            "h": [round(float(v), 3) for v in g["high"]],
            "l": [round(float(v), 3) for v in g["low"]],
            "c": [round(float(v), 3) for v in g["close"]],
            "v": [int(v) if pd.notna(v) else 0 for v in g["volume"]],
        }
        json.dump(rec, open(f"{d}/{t}.json", "w"))
        idx.append(t)
    json.dump(sorted(idx), open("data/charts_index.json", "w"))
    print(f"Exported {len(idx)} candle files -> data/charts/")


# ============================ main ============================
def main():
    os.makedirs("data", exist_ok=True)
    print("Building universe ...")
    universe = build_universe()
    print(f"Universe: {len(universe)} tickers")

    cache = load_cache()
    cache = update_cache(cache, universe)
    save_cache(cache)

    print("Scanning cached history ...")
    rows = []
    for t, g in cache.groupby("ticker"):
        try:
            df = g.rename(columns={"open": "Open", "high": "High", "low": "Low",
                                   "close": "Close", "volume": "Volume"}).set_index("date")
            df.index = pd.to_datetime(df.index)
            rec = scan_one(t, df.sort_index())
            if rec:
                rows.append(rec)
        except Exception:
            pass
    rows.sort(key=lambda r: (-abs(r["score"]), -r["n"]))
    out = {"asOf": pd.Timestamp.now().isoformat(),
           "universe": len(universe), "scanned": int(cache["ticker"].nunique()),
           "hits": len(rows), "rows": rows}
    with open(OUTPUT, "w") as f:
        json.dump(out, f)
    print(f"Wrote {len(rows)} idea rows -> {OUTPUT}")
    export_charts(cache)


if __name__ == "__main__":
    main()
