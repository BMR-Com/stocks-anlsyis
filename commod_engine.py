#!/usr/bin/env python3
"""
Bloomberg Commodity Index (BCOM) constituents: continuous front-month history plus the
next listed contracts (for calendar spreads).

Feeds are tried in order and the first that returns data is used:
  1. Yahoo continuous futures (e.g. CL=F)
  2. TradingView continuous contract via tvDatafeed (no login), for markets Yahoo lacks
  3. A clearly labelled proxy (e.g. COMEX aluminium for LME aluminium)
Anything with no working feed is listed as missing in data/commod/meta.json; it is never
shown with made-up data.

Stores every series through hist_store (data/hist/...): full history on the first run,
then only new bars. Expired contracts stay on file, so calendar-spread history builds up.

Run: python commod_engine.py
"""
import os, json, datetime as dt, time, traceback
import pandas as pd
import hist_store as HS

M = "FGHJKMNQUVXZ"
MONTH_NAME = dict(zip(M, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]))
N_CONTRACTS = 8

# key, name, group, BCOM ticker, 2026 / 2027 target weight (%), unit,
# yahoo continuous, yahoo contract (root, suffix, months), TradingView candidates, proxy
BCOM = [
    ("CO", "Brent crude", "Energy", 8.3602, 8.5856, "$/bbl", "BZ=F", ("BZ", ".NYM", M), [("BRN1!", "ICEEUR")], None),
    ("CL", "WTI crude", "Energy", 6.6398, 6.4144, "$/bbl", "CL=F", ("CL", ".NYM", M), [], None),
    ("NG", "Natural gas", "Energy", 7.1979, 7.0217, "$/MMBtu", "NG=F", ("NG", ".NYM", M), [], None),
    ("QS", "Low sulphur gasoil", "Energy", 2.8906, 3.0133, "$/t", None, None,
     [("G1!", "ICEEUR"), ("LGO1!", "ICEEUR"), ("GO1!", "ICEEUR")], None),
    ("HO", "ULS diesel", "Energy", 2.1923, 2.2390, "$/gal", "HO=F", ("HO", ".NYM", M), [], None),
    ("XB", "RBOB gasoline", "Energy", 2.1547, 2.0957, "$/gal", "RB=F", ("RB", ".NYM", M), [], None),
    ("C", "Corn", "Grains", 5.5282, 5.2388, "c/bu", "ZC=F", ("ZC", ".CBT", "HKNUZ"), [], None),
    ("S", "Soybeans", "Grains", 5.3553, 5.1323, "c/bu", "ZS=F", ("ZS", ".CBT", "FHKNQUX"), [], None),
    ("SM", "Soybean meal", "Grains", 2.9335, 2.9491, "$/st", "ZM=F", ("ZM", ".CBT", "FHKNQUVZ"), [], None),
    ("BO", "Soybean oil", "Grains", 2.8238, 2.9589, "c/lb", "ZL=F", ("ZL", ".CBT", "FHKNQUVZ"), [], None),
    ("W", "Wheat (Chicago SRW)", "Grains", 2.7217, 2.5756, "c/bu", "ZW=F", ("ZW", ".CBT", "HKNUZ"), [], None),
    ("KW", "Wheat (KC HRW)", "Grains", 1.7911, 1.7539, "c/bu", "KE=F", ("KE", ".CBT", "HKNUZ"), [], None),
    ("HG", "Copper (COMEX)", "Industrial metals", 6.3620, 6.5208, "$/lb", "HG=F", ("HG", ".CMX", "HKNUZ"), [], None),
    ("LA", "Aluminium (LME)", "Industrial metals", 3.9706, 3.9062, "$/t", None, None,
     [("MAL1!", "LME"), ("AH1!", "LME"), ("ALI1!", "LME")], ("ALI=F", "COMEX aluminium (proxy for LME)")),
    ("LX", "Zinc (LME)", "Industrial metals", 2.2499, 2.2139, "$/t", None, None,
     [("MZN1!", "LME"), ("ZS1!", "LME"), ("ZNC1!", "LME")], None),
    ("LN", "Nickel (LME)", "Industrial metals", 2.2278, 2.1567, "$/t", None, None,
     [("MNI1!", "LME"), ("NI1!", "LME")], None),
    ("LL", "Lead (LME)", "Industrial metals", 0.9498, 0.9559, "$/t", None, None,
     [("MPB1!", "LME"), ("PB1!", "LME")], None),
    ("GC", "Gold", "Precious metals", 14.8957, 14.9298, "$/oz", "GC=F", ("GC", ".CMX", "GJMQVZ"), [], None),
    ("SI", "Silver", "Precious metals", 3.9436, 4.5560, "$/oz", "SI=F", ("SI", ".CMX", "HKNUZ"), [], None),
    ("SB", "Sugar No.11", "Softs", 2.9514, 2.7022, "c/lb", "SB=F", ("SB", ".NYB", "HKNV"), [], None),
    ("KC", "Coffee C", "Softs", 2.9146, 2.8744, "c/lb", "KC=F", ("KC", ".NYB", "HKNUZ"), [], None),
    ("CC", "Cocoa (NY)", "Softs", 1.7137, 1.6996, "$/t", "CC=F", ("CC", ".NYB", "HKNUZ"), [], None),
    ("CT", "Cotton No.2", "Softs", 1.5950, 1.5646, "c/lb", "CT=F", ("CT", ".NYB", "HKNZ"), [], None),
    ("LC", "Live cattle", "Livestock", 3.8580, 4.1998, "c/lb", "LE=F", ("LE", ".CME", "GJMQVZ"), [], None),
    ("LH", "Lean hogs", "Livestock", 1.7786, 1.7417, "c/lb", "HE=F", ("HE", ".CME", "GJKMNQVZ"), [], None),
]
TV_SEARCH = {"QS": ("gasoil", "ICEEUR"), "LA": ("aluminium", "LME"), "LX": ("zinc", "LME"),
             "LN": ("nickel", "LME"), "LL": ("lead", "LME")}


def next_contracts(root, suffix, months, n=N_CONTRACTS, today=None):
    today = today or dt.date.today()
    out = []
    for k in range(0, 40):
        mm = (today.month - 1 + k) % 12 + 1
        yy = today.year + (today.month - 1 + k) // 12
        code = M[mm - 1]
        if code in months:
            out.append((f"{root}{code}{str(yy)[2:]}{suffix}", f"{MONTH_NAME[code]} {yy}", yy, mm))
        if len(out) >= n:
            break
    return out


_tv = None


def tv_client():
    global _tv
    if _tv is None:
        from tvDatafeed import TvDatafeed
        _tv = TvDatafeed()
    return _tv


def tv_hist(sym, ex, n_bars):
    from tvDatafeed import Interval
    d = tv_client().get_hist(symbol=sym, exchange=ex, interval=Interval.in_daily, n_bars=n_bars)
    if d is None or not len(d):
        return None
    d = d.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"})
    return HS.clean(d)


def main():
    ix = HS.load_index()
    status_path = os.path.join("data", "commod", "meta.json")
    os.makedirs(os.path.dirname(status_path), exist_ok=True)
    prev = {}
    if os.path.exists(status_path):
        with open(status_path) as f:
            prev = {c["key"]: c for c in json.load(f).get("commodities", [])}

    # ---------- 1. Yahoo continuous + contracts, one bulk call each for backfill / top-up
    yahoo_syms, contract_rows = [], {}
    for key, name, grp, w26, w27, unit, yc, ct, tvc, proxy in BCOM:
        if yc:
            yahoo_syms.append(yc)
        if proxy:
            yahoo_syms.append(proxy[0])
        if ct:
            rows = next_contracts(*ct)
            contract_rows[key] = rows
            yahoo_syms += [r[0] for r in rows]
    # previously active contracts keep being topped up until they stop trading
    for key, c in prev.items():
        for r in c.get("contracts", []):
            if r["sym"] not in yahoo_syms and r.get("last", "") >= (dt.date.today() - dt.timedelta(days=10)).isoformat():
                yahoo_syms.append(r["sym"])
    have = {s: HS.load(s) for s in yahoo_syms}
    new = [s for s in yahoo_syms if have[s] is None]
    old = [s for s in yahoo_syms if have[s] is not None]
    got = {}
    if new:
        got.update(HS.yf_download(new, period="max", interval="1d", chunk=30))
    if old:
        got.update(HS.yf_download(old, period="1mo", interval="1d", chunk=60))
    stored = {}
    for s in yahoo_syms:
        df = HS.merge(have[s], got.get(s))
        if df is not None and len(df):
            HS.save(s, df)
            stored[s] = df

    # ---------- 2. per commodity: pick feed, record status
    out = []
    for key, name, grp, w26, w27, unit, yc, ct, tvc, proxy in BCOM:
        rec = {"key": key, "name": name, "group": grp, "w2026": w26, "w2027": w27, "unit": unit,
               "sym": None, "source": None, "note": None, "contracts": []}
        if yc and yc in stored and stored[yc].index[-1] >= pd.Timestamp.today() - pd.Timedelta(days=10):
            rec.update(sym=yc, source="Yahoo continuous")
        if rec["sym"] is None and tvc:
            for tsym, tex in tvc:
                skey = f"TV:{tex}:{tsym}"
                try:
                    old_df = HS.load(skey)
                    d = tv_hist(tsym, tex, 60 if old_df is not None else 5000)
                    df = HS.merge(old_df, d)
                    if df is not None and len(df) and df.index[-1] >= pd.Timestamp.today() - pd.Timedelta(days=10):
                        HS.save(skey, df)
                        stored[skey] = df
                        rec.update(sym=skey, source=f"TradingView {tex}:{tsym}")
                        break
                except Exception as e:
                    rec["note"] = f"TradingView {tex}:{tsym} failed: {str(e)[:80]}"
                time.sleep(1)
        if rec["sym"] is None and key in TV_SEARCH:
            # discovery: record what TradingView lists, so the config can be fixed later
            try:
                q, ex = TV_SEARCH[key]
                hits = tv_client().search_symbol(q, ex) or []
                rec["tv_search"] = [f"{h.get('exchange')}:{h.get('symbol')} ({h.get('type')}) {h.get('description')}"
                                    for h in hits[:8]]
            except Exception as e:
                rec["tv_search"] = [f"search failed: {str(e)[:80]}"]
        if rec["sym"] is None and proxy and proxy[0] in stored:
            rec.update(sym=proxy[0], source="Yahoo continuous", note=proxy[1])
        if rec["sym"] is None:
            rec["note"] = rec.get("note") or "no working free daily feed found"
        # contracts with data, nearest first
        for sym, label, yy, mm in contract_rows.get(key, []):
            df = stored.get(sym)
            if df is not None and len(df) and df.index[-1] >= pd.Timestamp.today() - pd.Timedelta(days=10):
                rec["contracts"].append({"sym": sym, "label": label, "first": df.index[0].strftime("%Y-%m-%d"),
                                         "last": df.index[-1].strftime("%Y-%m-%d"), "rows": int(len(df))})
        out.append(rec)
        for s in [rec["sym"]] + [c["sym"] for c in rec["contracts"]]:
            if s and s in stored:
                kind = "commod" if s == rec["sym"] else "contract"
                nm = name if kind == "commod" else f"{name} {next(c['label'] for c in rec['contracts'] if c['sym'] == s)}"
                ix[s] = HS.index_entry(stored[s], sym=s, n=nm, g=grp, k=kind, root=key, u=unit)

    HS.save_index(ix)
    meta = {"asOf": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "index": "Bloomberg Commodity Index (BCOM)",
            "weights_note": "BCOM target weights: 2026 and 2027 (2027 weights take effect in the January 2027 roll)",
            "commodities": out,
            "missing": [c["key"] for c in out if c["sym"] is None]}
    with open(status_path, "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps({c["key"]: (c["sym"], c["source"], len(c["contracts"]), c["note"]) for c in out}, indent=0))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
