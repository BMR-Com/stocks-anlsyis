#!/usr/bin/env python3
"""
Daily option-chain snapshot and analytics from Yahoo (yfinance), run once each weekday
after the US close by the research-data workflow.

Per symbol it writes
  data/options/latest/<SYM>.json   term structure, smiles (IV by strike), OI/volume by expiry, max pain
  data/options/hist/<SYM>.csv      one row per trading day: IV30/60/90, 25-delta skew, P/C ratios, RV ...
  data/options/term/<SYM>.json     ATM IV by days-to-expiry for every day on file
and for all symbols
  data/options/monitor.json        latest summary row per symbol with IV rank / percentile
  data/options/archive/<YYYY-MM>/<date>.csv.gz   the raw chains (strikes within +/-35%), kept for good

IV is solved from the bid/ask mid (Black-Scholes, no dividends) and falls back to Yahoo's
IV when there is no usable two-sided quote. Expiries under 15 days are kept in the chain
and OI views but left out of every IV reading (IV30/60/90, skew, term-structure stats).

Run: python options_engine.py
"""
import os, json, gzip, math, time, datetime as dt
import numpy as np
import pandas as pd
import yfinance as yf
import hist_store as HS

try:
    from ta_engine import SYMBOLS as WATCH
except Exception:
    WATCH = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA"]
EXTRA = ["GLD", "SLV", "USO", "UNG", "TLT", "XLE", "SMH"]
UNIVERSE = list(dict.fromkeys(WATCH + EXTRA))
MIN_DTE_IV = 15          # expiries closer than this are excluded from IV readings
MAX_DTE = 400
STRIKE_PCT = 0.35
OUT = os.path.join("data", "options")
# CBOE volatility indexes on Yahoo, used for a long IV-rank history where one exists
VOL_INDEX = {"SPY": "^VIX", "QQQ": "^VXN", "IWM": "^RVX", "GLD": "^GVZ", "USO": "^OVX", "SLV": "^VXSLV",
             "AAPL": "^VXAPL", "AMZN": "^VXAZN", "GOOGL": "^VXGOG"}


# ------------------------------------------------------------- Black-Scholes
def _ncdf(x):
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def bs_price(S, K, T, r, v, call):
    v = np.maximum(v, 1e-6)
    sq = v * np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * v * v) * T) / sq
    d2 = d1 - sq
    c = S * _ncdf(d1) - K * np.exp(-r * T) * _ncdf(d2)
    p = K * np.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1)
    return np.where(call, c, p)


def bs_delta(S, K, T, r, v, call):
    v = np.maximum(v, 1e-6)
    d1 = (np.log(S / K) + (r + 0.5 * v * v) * T) / (v * np.sqrt(T))
    return np.where(call, _ncdf(d1), _ncdf(d1) - 1)


def implied_vol(price, S, K, T, r, call):
    """Vectorised bisection; NaN where the price is below intrinsic or above the bound."""
    price, K, T, call = map(np.asarray, (price, K, T, call))
    lo = np.full(price.shape, 1e-4)
    hi = np.full(price.shape, 5.0)
    intrinsic = np.where(call, np.maximum(S - K * np.exp(-r * T), 0), np.maximum(K * np.exp(-r * T) - S, 0))
    bad = (~np.isfinite(price)) | (price <= intrinsic + 1e-6) | (price <= 0)
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        pm = bs_price(S, K, T, r, mid, call)
        up = pm > price
        hi = np.where(up, mid, hi)
        lo = np.where(up, lo, mid)
    iv = 0.5 * (lo + hi)
    iv[bad | (iv > 4.9)] = np.nan
    return iv


# ------------------------------------------------------------- helpers
def risk_free():
    try:
        d = HS.load("^IRX")
        if d is not None and len(d):
            return float(d["Close"].iloc[-1]) / 100
    except Exception:
        pass
    return 0.04


def interp(x, xs, ys):
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    m = np.isfinite(xs) & np.isfinite(ys)
    xs, ys = xs[m], ys[m]
    if len(xs) == 0:
        return None
    o = np.argsort(xs)
    xs, ys = xs[o], ys[o]
    if len(xs) == 1:
        return float(ys[0])
    return float(np.interp(x, xs, ys))


def const_maturity(days, term):
    """ATM IV at a constant maturity, interpolated in total variance; expiries < 15 DTE excluded."""
    pts = [(t["dte"], t["atm"]) for t in term if t["dte"] >= MIN_DTE_IV and t["atm"]]
    if not pts:
        return None
    pts.sort()
    if days <= pts[0][0]:
        return pts[0][1]
    if days >= pts[-1][0]:
        return pts[-1][1] if days <= pts[-1][0] * 1.5 else None
    for (t1, v1), (t2, v2) in zip(pts, pts[1:]):
        if t1 <= days <= t2:
            w1, w2 = v1 * v1 * t1, v2 * v2 * t2
            w = w1 + (w2 - w1) * (days - t1) / (t2 - t1)
            return math.sqrt(max(w, 0) / days)
    return None


def max_pain(strikes, coi, poi):
    strikes = np.asarray(strikes, float)
    if len(strikes) == 0:
        return None
    best, bk = None, None
    for s in strikes:
        pain = np.sum(coi * np.maximum(s - strikes, 0)) + np.sum(poi * np.maximum(strikes - s, 0))
        if best is None or pain < best:
            best, bk = pain, s
    return float(bk)


def rnd(x, n=4):
    return None if x is None or not np.isfinite(x) else round(float(x), n)


# ------------------------------------------------------------- per symbol
def snap(sym, r, trade_date):
    tk = yf.Ticker(sym)
    h = tk.history(period="6mo", auto_adjust=False)
    h = HS.clean(h)
    if h is None or len(h) < 25:
        raise RuntimeError("no price history")
    spot = float(h["Close"].iloc[-1])
    lr = np.log(h["Close"]).diff().dropna()
    rv20 = float(lr.tail(20).std() * math.sqrt(252))
    rv60 = float(lr.tail(60).std() * math.sqrt(252))
    exps = list(tk.options or [])
    today = pd.Timestamp(trade_date)
    rows, term, smiles = [], [], {}
    for e in exps:
        dte = (pd.Timestamp(e) - today).days
        if dte < 0 or dte > MAX_DTE:
            continue
        try:
            ch = tk.option_chain(e)
        except Exception as ex:
            print(f"    {sym} {e}: {ex}")
            continue
        T = max(dte, 0.5) / 365.0
        parts = []
        for df, right in ((ch.calls, "C"), (ch.puts, "P")):
            if df is None or not len(df):
                continue
            d = pd.DataFrame({"strike": df["strike"].astype(float), "bid": df["bid"].fillna(0).astype(float),
                              "ask": df["ask"].fillna(0).astype(float), "last": df["lastPrice"].fillna(0).astype(float),
                              "vol": df["volume"].fillna(0).astype(float), "oi": df["openInterest"].fillna(0).astype(float),
                              "yiv": df["impliedVolatility"].fillna(0).astype(float)})
            d["right"] = right
            parts.append(d)
        if not parts:
            continue
        d = pd.concat(parts, ignore_index=True)
        d = d[(d["strike"] >= spot * (1 - STRIKE_PCT)) & (d["strike"] <= spot * (1 + STRIKE_PCT))].copy()
        if not len(d):
            continue
        two_sided = (d["bid"] > 0) & (d["ask"] >= d["bid"])
        d["mid"] = np.where(two_sided, (d["bid"] + d["ask"]) / 2, np.nan)
        call = (d["right"] == "C").values
        iv = implied_vol(d["mid"].values, spot, d["strike"].values, np.full(len(d), T), r, call)
        yiv = d["yiv"].values
        iv = np.where(np.isfinite(iv), iv, np.where((yiv > 0.01) & (yiv < 4), yiv, np.nan))
        d["iv"] = iv
        d["expiry"], d["dte"] = e, dte
        rows.append(d)
        # OTM smile: puts below the forward, calls at/above
        F = spot * math.exp(r * T)
        otm = d[((d["right"] == "P") & (d["strike"] < F)) | ((d["right"] == "C") & (d["strike"] >= F))]
        otm = otm[np.isfinite(otm["iv"])].sort_values("strike")
        atm = interp(F, otm["strike"], otm["iv"]) if len(otm) >= 2 else None
        p25 = c25 = None
        if len(otm) >= 3:
            dl = bs_delta(spot, otm["strike"].values, T, r, otm["iv"].values, (otm["right"] == "C").values)
            pm, cm = otm["right"].values == "P", otm["right"].values == "C"
            if pm.sum() >= 2:
                p25 = interp(-0.25, dl[pm], otm["iv"].values[pm])
            if cm.sum() >= 2:
                c25 = interp(0.25, dl[cm], otm["iv"].values[cm])
        calls, puts = d[d["right"] == "C"], d[d["right"] == "P"]
        ks = np.array(sorted(d["strike"].unique()))
        coi = calls.groupby("strike")["oi"].sum().reindex(ks).fillna(0).values
        poi = puts.groupby("strike")["oi"].sum().reindex(ks).fillna(0).values
        cvol = calls.groupby("strike")["vol"].sum().reindex(ks).fillna(0).values
        pvol = puts.groupby("strike")["vol"].sum().reindex(ks).fillna(0).values
        civ = calls.groupby("strike")["iv"].mean().reindex(ks).values
        piv = puts.groupby("strike")["iv"].mean().reindex(ks).values
        term.append({"exp": e, "dte": int(dte), "atm": rnd(atm), "p25": rnd(p25), "c25": rnd(c25),
                     "rr25": rnd(c25 - p25) if (p25 and c25) else None,
                     "callOI": int(coi.sum()), "putOI": int(poi.sum()),
                     "callVol": int(cvol.sum()), "putVol": int(pvol.sum()),
                     "maxPain": max_pain(ks, coi, poi), "ivUsed": dte >= MIN_DTE_IV})
        smiles[e] = {"dte": int(dte), "k": [rnd(k, 2) for k in ks],
                     "smile": [rnd(interp(k, otm["strike"], otm["iv"])) if len(otm) >= 2 and otm["strike"].min() <= k <= otm["strike"].max() else None for k in ks],
                     "callIV": [rnd(x) for x in civ], "putIV": [rnd(x) for x in piv],
                     "callOI": [int(x) for x in coi], "putOI": [int(x) for x in poi],
                     "callVol": [int(x) for x in cvol], "putVol": [int(x) for x in pvol]}
        time.sleep(0.3)
    if not term:
        raise RuntimeError("no option chains")
    allr = pd.concat(rows, ignore_index=True)
    iv30, iv60, iv90 = (const_maturity(x, term) for x in (30, 60, 90))
    used = [t for t in term if t["ivUsed"] and t["p25"] and t["c25"]]
    sk = min(used, key=lambda t: abs(t["dte"] - 30)) if used else None
    tot_c_oi, tot_p_oi = sum(t["callOI"] for t in term), sum(t["putOI"] for t in term)
    tot_c_v, tot_p_v = sum(t["callVol"] for t in term), sum(t["putVol"] for t in term)
    near = term[0]
    near15 = next((t for t in term if t["dte"] >= MIN_DTE_IV), None)
    summary = {
        "date": trade_date, "spot": rnd(spot, 2), "iv30": rnd(iv30), "iv60": rnd(iv60), "iv90": rnd(iv90),
        "termSlope": rnd(iv90 - iv30) if (iv30 and iv90) else None,
        "skewExp": sk["exp"] if sk else None, "put25": sk["p25"] if sk else None,
        "call25": sk["c25"] if sk else None, "rr25": sk["rr25"] if sk else None,
        "putSkew": rnd(sk["p25"] - sk["c25"]) if sk else None,
        "pcOI": rnd(tot_p_oi / tot_c_oi, 3) if tot_c_oi else None,
        "pcVol": rnd(tot_p_v / tot_c_v, 3) if tot_c_v else None,
        "oi": int(tot_c_oi + tot_p_oi), "vol": int(tot_c_v + tot_p_v),
        "rv20": rnd(rv20), "rv60": rnd(rv60),
        "ivRv": rnd(iv30 - rv20) if iv30 else None,
        "nearExp": near["exp"], "nearMaxPain": near["maxPain"],
        "monthExp": near15["exp"] if near15 else None, "monthMaxPain": near15["maxPain"] if near15 else None,
    }
    latest = {"symbol": sym, "asOf": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "rate": rnd(r),
              "minDteIV": MIN_DTE_IV, "summary": summary, "term": term, "smiles": smiles}
    allr.insert(0, "symbol", sym)
    return latest, summary, allr


def iv_rank(sym, summary):
    """IV rank / percentile over the last 252 sessions: CBOE vol index where Yahoo has a current
    one, else this repo's own IV30 history (which starts on the first run)."""
    src, s = None, None
    vi = VOL_INDEX.get(sym)
    if vi:
        d = HS.load(vi)
        if d is not None and len(d) > 200 and d.index[-1] >= pd.Timestamp.today() - pd.Timedelta(days=10):
            s, src = d["Close"].tail(252) / 100, vi
    if s is None:
        p = os.path.join(OUT, "hist", f"{sym}.csv")
        if os.path.exists(p):
            h = pd.read_csv(p).dropna(subset=["iv30"])
            if len(h) >= 20:
                s, src = h["iv30"].tail(252), "own history"
    if s is None or summary.get("iv30") is None:
        return None, None, None, int(0 if s is None else len(s))
    cur = s.iloc[-1] if src != "own history" and vi else summary["iv30"]
    lo, hi = float(s.min()), float(s.max())
    rank = (cur - lo) / (hi - lo) * 100 if hi > lo else None
    pct = float((s < cur).mean() * 100)
    return rnd(rank, 1), rnd(pct, 1), src, int(len(s))


def main():
    os.makedirs(os.path.join(OUT, "latest"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "hist"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "term"), exist_ok=True)
    # keep the vol indexes current for IV rank (cheap top-up)
    try:
        vis = sorted(set(VOL_INDEX.values()) | {"^IRX"})
        got = HS.yf_download(vis, period="1mo", interval="1d")
        for s in vis:
            old = HS.load(s)
            if old is None:
                got.update(HS.yf_download([s], start="1990-01-01", interval="1d"))
            df = HS.merge(old, got.get(s))
            if df is not None:
                HS.save(s, df)
    except Exception as e:
        print("vol index top-up failed:", e)
    r = risk_free()
    spy = HS.clean(yf.Ticker("SPY").history(period="5d", auto_adjust=False))
    trade_date = spy.index[-1].strftime("%Y-%m-%d") if spy is not None else dt.date.today().isoformat()
    monitor, chains, failed = [], [], []
    for sym in UNIVERSE:
        try:
            latest, summ, allr = snap(sym, r, trade_date)
        except Exception as e:
            print(f"  {sym}: {e}")
            failed.append(sym)
            continue
        with open(os.path.join(OUT, "latest", f"{sym}.json"), "w") as f:
            json.dump(latest, f, separators=(",", ":"))
        hp = os.path.join(OUT, "hist", f"{sym}.csv")
        h = pd.read_csv(hp) if os.path.exists(hp) else pd.DataFrame()
        row = pd.DataFrame([summ])
        h = pd.concat([h[h["date"] != trade_date] if len(h) else h, row], ignore_index=True).sort_values("date")
        h.to_csv(hp, index=False)
        tp = os.path.join(OUT, "term", f"{sym}.json")
        tj = json.load(open(tp)) if os.path.exists(tp) else {}
        tj[trade_date] = [[t["dte"], t["atm"]] for t in latest["term"] if t["atm"]]
        with open(tp, "w") as f:
            json.dump(dict(sorted(tj.items())), f, separators=(",", ":"))
        rank, pct, src, n = iv_rank(sym, summ)
        monitor.append({"symbol": sym, **summ, "ivRank": rank, "ivPct": pct, "rankSrc": src, "rankN": n})
        chains.append(allr)
        print(f"  {sym}: iv30={summ['iv30']} skew={summ['putSkew']} pcOI={summ['pcOI']} rank={rank}")
    with open(os.path.join(OUT, "monitor.json"), "w") as f:
        json.dump({"asOf": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "date": trade_date,
                   "minDteIV": MIN_DTE_IV, "rows": monitor, "failed": failed}, f, separators=(",", ":"))
    if chains:
        a = pd.concat(chains, ignore_index=True)
        a = a[["symbol", "expiry", "dte", "strike", "right", "bid", "ask", "last", "vol", "oi", "yiv", "iv"]]
        ad = os.path.join(OUT, "archive", trade_date[:7])
        os.makedirs(ad, exist_ok=True)
        with gzip.open(os.path.join(ad, f"{trade_date}.csv.gz"), "wt") as f:
            a.round({"iv": 4, "yiv": 4}).to_csv(f, index=False)
    print(f"done: {len(monitor)} ok, failed {failed}")


if __name__ == "__main__":
    main()
