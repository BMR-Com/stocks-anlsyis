#!/usr/bin/env python3
"""
Yahoo Finance Technical-Analysis Engine
---------------------------------------
Free data via yfinance. Pulls OHLCV, computes indicators (EMA/SMA/RSI/MACD/
Bollinger/ATR), auto-detects RSI & MACD divergences plus common chart patterns
(double top/bottom, golden/death cross, N-day breakouts, RSI extremes, support/
resistance), and writes data/<SYMBOL>.json for the TradingView-style dashboard.

Run:  cd ~/ta-charts && source .venv/bin/activate && python ta_engine.py
Deps: pip install yfinance pandas numpy
"""

import os, json, math
import numpy as np
import pandas as pd

# ----------------------------- CONFIG -----------------------------
SYMBOLS   = ["AAPL", "NVDA", "MSFT", "HOOD", "SPY"]
PERIOD    = "1y"        # 6mo, 1y, 2y, 5y, max
INTERVAL  = "1d"        # 1d, 1h, 1wk  (daily is most reliable on Yahoo)
PIVOT_L   = 3          # bars to the left/right that define a swing pivot
PIVOT_R   = 3
DIV_MAXBARS = 60       # max bar gap between the two pivots forming a divergence
N_OPT_EXP  = 8         # nearest N option expirations to pull
OPT_STRIKE_PCT = 0.40  # keep option strikes within +/-40% of spot
OUTPUT_DIR = "data"
# ------------------------------------------------------------------


# ============================ indicators ============================
def ema(s, n):  return s.ewm(span=n, adjust=False).mean()
def sma(s, n):  return s.rolling(n).mean()

def rsi(close, n=14):
    d = close.diff()
    gain = d.clip(lower=0)
    loss = -d.clip(upper=0)
    ag = gain.ewm(alpha=1/n, adjust=False).mean()
    al = loss.ewm(alpha=1/n, adjust=False).mean()
    rs = ag / al.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)

def macd(close, fast=12, slow=26, sig=9):
    line = ema(close, fast) - ema(close, slow)
    signal = ema(line, sig)
    return line, signal, line - signal

def atr(df, n=14):
    h, l, c = df["High"], df["Low"], df["Close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/n, adjust=False).mean()

def indicators(df):
    c = df["Close"]
    df["ema20"] = ema(c, 20); df["ema50"] = ema(c, 50)
    df["sma50"] = sma(c, 50); df["sma200"] = sma(c, 200)
    df["rsi"] = rsi(c, 14)
    df["macd"], df["macd_sig"], df["macd_hist"] = macd(c)
    m = sma(c, 20); sd = c.rolling(20).std()
    df["bb_mid"] = m; df["bb_up"] = m + 2 * sd; df["bb_lo"] = m - 2 * sd
    df["atr"] = atr(df)
    return df


# ============================ pivots ============================
def pivot_mask(series, left, right, kind):
    """True at bars that are a local max ('high') or min ('low') over +/-window."""
    v = series.values
    n = len(v)
    out = np.zeros(n, dtype=bool)
    for i in range(left, n - right):
        window = v[i - left:i + right + 1]
        if kind == "high" and v[i] == window.max() and (window == v[i]).sum() == 1:
            out[i] = True
        if kind == "low" and v[i] == window.min() and (window == v[i]).sum() == 1:
            out[i] = True
    return out


# ============================ divergence ============================
def divergences(df, osc_col, left, right, maxbars, label):
    """Regular bullish/bearish divergence between price and an oscillator."""
    idx = df.index
    lows  = np.where(pivot_mask(df["Low"],  left, right, "low"))[0]
    highs = np.where(pivot_mask(df["High"], left, right, "high"))[0]
    osc = df[osc_col].values
    price_low = df["Low"].values; price_high = df["High"].values
    sig = []
    # bullish: price lower-low, oscillator higher-low
    for a, b in zip(lows, lows[1:]):
        if 0 < b - a <= maxbars and price_low[b] < price_low[a] and osc[b] > osc[a]:
            sig.append({"time": idx[b].strftime("%Y-%m-%d"), "kind": "bull_div",
                        "price": round(float(price_low[b]), 2),
                        "label": f"Bullish {label} divergence",
                        "detail": f"Price LL, {label} HL"})
    # bearish: price higher-high, oscillator lower-high
    for a, b in zip(highs, highs[1:]):
        if 0 < b - a <= maxbars and price_high[b] > price_high[a] and osc[b] < osc[a]:
            sig.append({"time": idx[b].strftime("%Y-%m-%d"), "kind": "bear_div",
                        "price": round(float(price_high[b]), 2),
                        "label": f"Bearish {label} divergence",
                        "detail": f"Price HH, {label} LH"})
    return sig


# ============================ patterns ============================
def crosses(df):
    sig = []
    diff = (df["sma50"] - df["sma200"]).dropna()
    s = np.sign(diff.values); t = diff.index
    for i in range(1, len(s)):
        if s[i-1] < 0 <= s[i]:
            sig.append({"time": t[i].strftime("%Y-%m-%d"), "kind": "golden_cross",
                        "price": round(float(df["Close"].loc[t[i]]), 2),
                        "label": "Golden cross", "detail": "SMA50 crossed above SMA200"})
        if s[i-1] > 0 >= s[i]:
            sig.append({"time": t[i].strftime("%Y-%m-%d"), "kind": "death_cross",
                        "price": round(float(df["Close"].loc[t[i]]), 2),
                        "label": "Death cross", "detail": "SMA50 crossed below SMA200"})
    return sig

def breakouts(df, n=50):
    sig = []
    c = df["Close"]; hi = df["High"].rolling(n).max().shift(); lo = df["Low"].rolling(n).min().shift()
    for i in range(n, len(df)):
        t = df.index[i]
        if c.iloc[i] > hi.iloc[i] and c.iloc[i-1] <= hi.iloc[i-1]:
            sig.append({"time": t.strftime("%Y-%m-%d"), "kind": "breakout_up",
                        "price": round(float(c.iloc[i]), 2), "label": f"{n}-day breakout",
                        "detail": f"Close above {n}-day high"})
        if c.iloc[i] < lo.iloc[i] and c.iloc[i-1] >= lo.iloc[i-1]:
            sig.append({"time": t.strftime("%Y-%m-%d"), "kind": "breakout_down",
                        "price": round(float(c.iloc[i]), 2), "label": f"{n}-day breakdown",
                        "detail": f"Close below {n}-day low"})
    return sig

def rsi_extremes(df):
    sig = []; r = df["rsi"].values; t = df.index
    for i in range(1, len(r)):
        if r[i-1] < 70 <= r[i]:
            sig.append({"time": t[i].strftime("%Y-%m-%d"), "kind": "rsi_ob",
                        "price": round(float(df["Close"].iloc[i]), 2),
                        "label": "RSI overbought", "detail": "RSI crossed above 70"})
        if r[i-1] > 30 >= r[i]:
            sig.append({"time": t[i].strftime("%Y-%m-%d"), "kind": "rsi_os",
                        "price": round(float(df["Close"].iloc[i]), 2),
                        "label": "RSI oversold", "detail": "RSI crossed below 30"})
    return sig

def double_patterns(df, left, right, tol=0.03):
    sig = []
    highs = np.where(pivot_mask(df["High"], left, right, "high"))[0]
    lows  = np.where(pivot_mask(df["Low"],  left, right, "low"))[0]
    H = df["High"].values; L = df["Low"].values; t = df.index
    for a, b in zip(highs, highs[1:]):
        if abs(H[b] - H[a]) / H[a] < tol and 5 <= b - a <= 60:
            sig.append({"time": t[b].strftime("%Y-%m-%d"), "kind": "double_top",
                        "price": round(float(H[b]), 2), "label": "Double top",
                        "detail": "Two swing highs at a similar level"})
    for a, b in zip(lows, lows[1:]):
        if abs(L[b] - L[a]) / L[a] < tol and 5 <= b - a <= 60:
            sig.append({"time": t[b].strftime("%Y-%m-%d"), "kind": "double_bottom",
                        "price": round(float(L[b]), 2), "label": "Double bottom",
                        "detail": "Two swing lows at a similar level"})
    return sig

def sr_levels(df, left, right, top=6):
    highs = df["High"].values[pivot_mask(df["High"], left, right, "high")]
    lows  = df["Low"].values[pivot_mask(df["Low"],  left, right, "low")]
    pts = np.concatenate([highs, lows])
    if len(pts) == 0:
        return []
    span = df["High"].max() - df["Low"].min()
    binsize = span * 0.015
    levels = {}
    for p in pts:
        key = round(p / binsize) * binsize
        levels[key] = levels.get(key, 0) + 1
    ranked = sorted(levels.items(), key=lambda kv: -kv[1])[:top]
    return [{"price": round(float(k), 2), "touches": int(v)} for k, v in ranked if v >= 2]


# ============================ serialize ============================
def series(df, col):
    s = df[col].dropna()
    return [{"time": t.strftime("%Y-%m-%d"), "value": round(float(v), 4)}
            for t, v in s.items()]

def build(df, symbol, name):
    df = indicators(df.copy())
    candles = [{"time": t.strftime("%Y-%m-%d"),
                "open": round(float(r.Open), 2), "high": round(float(r.High), 2),
                "low": round(float(r.Low), 2), "close": round(float(r.Close), 2),
                "volume": int(r.Volume) if not math.isnan(r.Volume) else 0}
               for t, r in df.iterrows()]
    signals = []
    signals += divergences(df, "rsi", PIVOT_L, PIVOT_R, DIV_MAXBARS, "RSI")
    signals += divergences(df, "macd", PIVOT_L, PIVOT_R, DIV_MAXBARS, "MACD")
    signals += crosses(df) + breakouts(df) + rsi_extremes(df) + double_patterns(df, PIVOT_L, PIVOT_R)
    signals.sort(key=lambda s: s["time"])
    return {
        "symbol": symbol, "name": name, "interval": INTERVAL,
        "asOf": pd.Timestamp.now().isoformat(),
        "candles": candles,
        "ema20": series(df, "ema20"), "ema50": series(df, "ema50"),
        "sma200": series(df, "sma200"),
        "bbUp": series(df, "bb_up"), "bbMid": series(df, "bb_mid"), "bbLo": series(df, "bb_lo"),
        "rsi": series(df, "rsi"),
        "macd": series(df, "macd"), "macdSignal": series(df, "macd_sig"),
        "macdHist": series(df, "macd_hist"),
        "signals": signals,
        "levels": sr_levels(df, PIVOT_L, PIVOT_R),
    }


# ============================ options / fundamentals / ownership ============================
def _num(x):
    try:
        f = float(x)
        return None if math.isnan(f) else f
    except Exception:
        return None

def build_options(tk, spot):
    """Yahoo option chain -> {spot, expiries, chain[]}. Greeks computed in the UI from IV."""
    import datetime as dt
    today = dt.date.today()
    try:
        expiries = list(tk.options)[:N_OPT_EXP]
    except Exception:
        return {"spot": spot, "expiries": [], "chain": []}
    lo, hi = spot * (1 - OPT_STRIKE_PCT), spot * (1 + OPT_STRIKE_PCT)
    rows = []
    for exp in expiries:
        try:
            oc = tk.option_chain(exp)
        except Exception:
            continue
        dte = (dt.datetime.strptime(exp, "%Y-%m-%d").date() - today).days
        for right, dfc in (("C", oc.calls), ("P", oc.puts)):
            for _, r in dfc.iterrows():
                k = _num(r.get("strike"))
                if k is None or not (lo <= k <= hi):
                    continue
                rows.append({
                    "expiry": exp, "dte": dte, "strike": k, "right": right,
                    "bid": _num(r.get("bid")), "ask": _num(r.get("ask")),
                    "last": _num(r.get("lastPrice")),
                    "iv": round(_num(r.get("impliedVolatility")) or 0, 4),
                    "volume": int(_num(r.get("volume")) or 0),
                    "oi": int(_num(r.get("openInterest")) or 0),
                })
    return {"spot": spot, "expiries": expiries, "chain": rows,
            "active": sorted(rows, key=lambda r: -(r["volume"] or 0))[:15]}

def build_extra(tk):
    """Fundamentals + short interest + insider transactions + institutional holders."""
    import time
    out = {"fundamentals": {}, "short": {}, "insider": [], "institutional": []}
    info = {}
    for attempt in range(3):                     # .info is rate-limit prone; retry
        try:
            info = tk.get_info() if hasattr(tk, "get_info") else tk.info
            if info:
                break
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))
    def g(*keys):
        for k in keys:
            if k in info and info[k] is not None:
                return info[k]
        return None
    out["fundamentals"] = {
        "sector": g("sector"), "industry": g("industry"),
        "marketCap": g("marketCap"), "employees": g("fullTimeEmployees"),
        "trailingPE": g("trailingPE"), "forwardPE": g("forwardPE"),
        "priceToBook": g("priceToBook"), "priceToSales": g("priceToSalesTrailing12Months"),
        "pegRatio": g("pegRatio", "trailingPegRatio"), "beta": g("beta"),
        "profitMargin": g("profitMargins"), "operatingMargin": g("operatingMargins"),
        "grossMargin": g("grossMargins"), "roe": g("returnOnEquity"), "roa": g("returnOnAssets"),
        "revenueGrowth": g("revenueGrowth"), "earningsGrowth": g("earningsGrowth"),
        "totalRevenue": g("totalRevenue"), "ebitda": g("ebitda"),
        "freeCashflow": g("freeCashflow"), "totalCash": g("totalCash"),
        "totalDebt": g("totalDebt"), "debtToEquity": g("debtToEquity"),
        "currentRatio": g("currentRatio"), "trailingEps": g("trailingEps"),
        "forwardEps": g("forwardEps"), "dividendYield": g("dividendYield"),
        "payoutRatio": g("payoutRatio"),
        "fiftyTwoWeekHigh": g("fiftyTwoWeekHigh"), "fiftyTwoWeekLow": g("fiftyTwoWeekLow"),
        "targetMean": g("targetMeanPrice"), "recommendation": g("recommendationKey"),
    }
    out["short"] = {
        "sharesShort": g("sharesShort"), "shortRatio": g("shortRatio"),
        "shortPercentOfFloat": g("shortPercentOfFloat"),
        "sharesShortPriorMonth": g("sharesShortPriorMonth"),
        "floatShares": g("floatShares"), "sharesOutstanding": g("sharesOutstanding"),
        "heldPercentInsiders": g("heldPercentInsiders"),
        "heldPercentInstitutions": g("heldPercentInstitutions"),
    }
    try:
        it = tk.insider_transactions
        if it is not None and not it.empty:
            for _, r in it.head(15).iterrows():
                d = r.to_dict()
                out["insider"].append({
                    "insider": str(d.get("Insider", "")), "position": str(d.get("Position", "")),
                    "transaction": str(d.get("Transaction", "")),
                    "shares": _num(d.get("Shares")), "value": _num(d.get("Value")),
                    "date": str(d.get("Start Date", d.get("Date", "")))[:10],
                })
    except Exception:
        pass
    try:
        ih = tk.institutional_holders
        if ih is not None and not ih.empty:
            cols = {c.lower(): c for c in ih.columns}
            for _, r in ih.head(12).iterrows():
                d = r.to_dict()
                holder = d.get(cols.get("holder", "Holder"), "")
                out["institutional"].append({
                    "holder": str(holder),
                    "shares": _num(d.get(cols.get("shares", "Shares"))),
                    "pct": _num(d.get(cols.get("pctheld", "% Out")) or d.get("% Out")),
                    "value": _num(d.get(cols.get("value", "Value"))),
                    "date": str(d.get(cols.get("date reported", "Date Reported"), ""))[:10],
                })
    except Exception:
        pass
    return out


# ============================ main ============================
def main():
    import time
    import yfinance as yf
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    done = []
    for sym in SYMBOLS:
        try:
            tk = yf.Ticker(sym)
            # retry history a few times — Yahoo can rate-limit datacenter IPs (e.g. CI)
            df = None
            for attempt in range(3):
                df = tk.history(period=PERIOD, interval=INTERVAL, auto_adjust=True)
                if not df.empty:
                    break
                time.sleep(3 * (attempt + 1))
            if df is None or df.empty:
                print(f"  {sym}: no data after retries (skipped)"); continue
            df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
            # name lookup is best-effort — tk.info is slow/flaky and must not kill the symbol
            name = sym
            try:
                name = (tk.info or {}).get("shortName") or sym
            except Exception:
                pass
            out = build(df, sym, name)
            with open(os.path.join(OUTPUT_DIR, f"{sym}.json"), "w") as f:
                json.dump(out, f)

            spot = float(df["Close"].iloc[-1])
            # options (best-effort — Yahoo option pulls are the flakiest part)
            try:
                opts = build_options(tk, spot)
            except Exception as e:
                opts = {"spot": spot, "expiries": [], "chain": []}
                print(f"    {sym} options warn: {e}")
            with open(os.path.join(OUTPUT_DIR, f"{sym}.options.json"), "w") as f:
                json.dump(opts, f)
            # fundamentals + ownership
            try:
                extra = build_extra(tk)
            except Exception as e:
                extra = {"fundamentals": {}, "short": {}, "insider": [], "institutional": []}
                print(f"    {sym} extra warn: {e}")
            with open(os.path.join(OUTPUT_DIR, f"{sym}.extra.json"), "w") as f:
                json.dump(extra, f)

            done.append(sym)
            print(f"  {sym}: {len(out['candles'])} bars, {len(out['signals'])} signals, "
                  f"{len(opts['chain'])} option rows -> data/{sym}.*")
            time.sleep(1)   # be gentle with Yahoo
        except Exception as e:
            print(f"  {sym}: ERROR {type(e).__name__}: {e}")
    with open(os.path.join(OUTPUT_DIR, "index.json"), "w") as f:
        json.dump(done, f)
    print(f"\nWrote {len(done)} symbols. Index: data/index.json")


if __name__ == "__main__":
    main()
