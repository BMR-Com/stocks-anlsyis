#!/usr/bin/env python3
"""
Options-Volume Scanner (rotating, cached)
-----------------------------------------
Free Yahoo data can't fetch full option chains for ~3,000 stocks daily, so this
sweeps the universe over time instead of all at once:
  * each run probes a rotating CHUNK of not-yet-known names,
  * plus refreshes the top known option-volume names,
  * samples the nearest few expiries per name to measure call/put volume & OI,
  * caches results (and permanently flags names with NO options so they stop
    wasting the request budget).
Output: data/options_scan.json — every name with meaningful option volume,
ranked, so you can catch where the activity is across the whole market.

Reads the universe from the price cache written by scan_engine.py.
Run:  python opt_scan_engine.py
"""

import os, json, time
import pandas as pd

# ----------------------------- CONFIG -----------------------------
OPT_CHUNK    = 150     # NEW/unchecked names probed per run (rotation)
REFRESH_TOP  = 150     # always refresh this many top known-active names
OPT_NEAR     = 3       # nearest expiries sampled to gauge volume (cheap)
OPT_MIN_VOL  = 500     # list a name only if total sampled option volume >= this
RECHECK_DAYS = 21      # re-probe "no options" names occasionally (they may list later)
REQ_SLEEP    = 0.4     # politeness delay between tickers
PRICE_CACHE  = "cache/prices.parquet"
OPT_CACHE    = "cache/options_cache.json"
OUTPUT       = "data/options_scan.json"
FALLBACK     = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","AMD","HOOD"]
# ------------------------------------------------------------------


def universe_from_cache():
    try:
        df = pd.read_parquet(PRICE_CACHE, columns=["ticker"])
        return sorted(df["ticker"].unique().tolist())
    except Exception:
        print("  price cache not found — using fallback universe")
        return FALLBACK

def load_cache():
    if os.path.exists(OPT_CACHE):
        try:
            return json.load(open(OPT_CACHE))
        except Exception:
            pass
    return {}

def save_cache(c):
    os.makedirs(os.path.dirname(OPT_CACHE), exist_ok=True)
    json.dump(c, open(OPT_CACHE, "w"))


def summarize(tk):
    """Sample nearest OPT_NEAR expiries -> total call/put volume & OI, top contract."""
    try:
        exps = list(tk.options)
    except Exception:
        return {"hasOptions": False, "asOf": pd.Timestamp.now().isoformat()}
    if not exps:
        return {"hasOptions": False, "asOf": pd.Timestamp.now().isoformat()}
    cv = pv = coi = poi = 0
    top = None
    for e in exps[:OPT_NEAR]:
        try:
            oc = tk.option_chain(e)
        except Exception:
            continue
        for right, df in (("C", oc.calls), ("P", oc.puts)):
            if df is None or df.empty:
                continue
            v = df["volume"].fillna(0)
            oi = df["openInterest"].fillna(0)
            if right == "C": cv += float(v.sum()); coi += float(oi.sum())
            else:            pv += float(v.sum()); poi += float(oi.sum())
            if v.max() > 0:
                i = v.idxmax()
                tv = float(v.loc[i])
                if top is None or tv > top["vol"]:
                    top = {"vol": tv, "strike": float(df.loc[i, "strike"]), "right": right, "exp": e}
    return {"hasOptions": True, "exps": len(exps),
            "callVol": int(cv), "putVol": int(pv), "optVol": int(cv + pv),
            "callOI": int(coi), "putOI": int(poi), "optOI": int(coi + poi),
            "pc": round(pv / cv, 3) if cv else None,
            "top": top, "asOf": pd.Timestamp.now().isoformat()}


def _stale(rec, days):
    try:
        return (pd.Timestamp.now() - pd.Timestamp(rec["asOf"])).days >= days
    except Exception:
        return True


def main():
    import yfinance as yf
    os.makedirs("data", exist_ok=True)
    uni = universe_from_cache()
    cache = load_cache()
    cursor = int(cache.get("_cursor", 0))

    # rotation candidates: unknown, or optionable, or "no options" but stale enough to recheck
    def is_candidate(t):
        r = cache.get(t)
        if not isinstance(r, dict) or "hasOptions" not in r:
            return True
        if r["hasOptions"] is False:
            return _stale(r, RECHECK_DAYS)
        return True
    cand = [t for t in uni if is_candidate(t)]
    n = len(cand)
    chunk = [cand[(cursor + i) % n] for i in range(min(OPT_CHUNK, n))] if n else []
    cache["_cursor"] = ((cursor + len(chunk)) % n) if n else 0

    # always refresh the top known-active names
    known = [(t, d) for t, d in cache.items()
             if isinstance(d, dict) and d.get("optVol")]
    known.sort(key=lambda x: -x[1]["optVol"])
    refresh = [t for t, _ in known[:REFRESH_TOP]]

    todo = list(dict.fromkeys(chunk + refresh))
    print(f"Universe {len(uni)} | candidates {n} | probing {len(todo)} "
          f"({len(chunk)} rotation + {len(refresh)} refresh)")

    for i, t in enumerate(todo):
        try:
            s = summarize(yf.Ticker(t))
            cache[t] = {**(cache.get(t) if isinstance(cache.get(t), dict) else {}), **s}
        except Exception:
            pass
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}")
        time.sleep(REQ_SLEEP)

    save_cache(cache)

    rows = []
    for t, d in cache.items():
        if not isinstance(d, dict) or d.get("optVol", 0) < OPT_MIN_VOL:
            continue
        rows.append({"t": t, "optVol": d["optVol"], "callVol": d.get("callVol"),
                     "putVol": d.get("putVol"), "optOI": d.get("optOI"),
                     "pc": d.get("pc"), "top": d.get("top"), "asOf": d.get("asOf")})
    rows.sort(key=lambda r: -r["optVol"])
    checked = sum(1 for t, d in cache.items() if isinstance(d, dict) and "hasOptions" in d)
    out = {"asOf": pd.Timestamp.now().isoformat(),
           "universe": len(uni), "checked": checked, "listed": len(rows), "rows": rows}
    json.dump(out, open(OUTPUT, "w"))
    print(f"Listed {len(rows)} names with option volume >= {OPT_MIN_VOL} -> {OUTPUT}")


if __name__ == "__main__":
    main()
