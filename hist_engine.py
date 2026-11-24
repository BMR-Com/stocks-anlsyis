#!/usr/bin/env python3
"""
Long daily history for the stock universe, ETFs, indexes, vol indexes and FX.

First run per symbol: full history (from 1980 where Yahoo has it).
Every later run: only the last month is downloaded and merged in (old rows are kept).
Output: data/hist/<SAFE>.base.json + data/hist/<SAFE>.json and data/hist/index.json
(see hist_store.py). Feeds the Pro Chart and Seasonality tabs.

Run: python hist_engine.py
"""
import os, json
import hist_store as HS

ETFS = {
    "SPY": "SPDR S&P 500 ETF", "QQQ": "Invesco QQQ", "IWM": "iShares Russell 2000", "DIA": "SPDR Dow Jones",
    "XLK": "Technology Select SPDR", "XLF": "Financial Select SPDR", "XLE": "Energy Select SPDR",
    "XLV": "Health Care Select SPDR", "XLI": "Industrial Select SPDR", "XLY": "Consumer Discretionary SPDR",
    "XLP": "Consumer Staples SPDR", "XLU": "Utilities Select SPDR", "XLB": "Materials Select SPDR",
    "XLRE": "Real Estate Select SPDR", "XLC": "Communication Services SPDR", "SMH": "VanEck Semiconductor",
    "KRE": "SPDR Regional Banks", "GLD": "SPDR Gold Shares", "SLV": "iShares Silver Trust",
    "USO": "United States Oil Fund", "UNG": "United States Natural Gas Fund", "CPER": "US Copper Index Fund",
    "DBA": "Invesco DB Agriculture", "DBC": "Invesco DB Commodity", "TLT": "iShares 20+ Year Treasury",
    "IEF": "iShares 7-10 Year Treasury", "HYG": "iShares High Yield Corporate", "EEM": "iShares MSCI Emerging Markets",
    "FXI": "iShares China Large-Cap", "EWZ": "iShares MSCI Brazil", "INDA": "iShares MSCI India",
    "ARKK": "ARK Innovation", "BITO": "ProShares Bitcoin Strategy",
}
INDEXES = {
    "^GSPC": "S&P 500", "^NDX": "Nasdaq 100", "^DJI": "Dow Jones Industrial", "^RUT": "Russell 2000",
    "^VIX": "CBOE VIX (S&P 500 vol)", "^VXN": "CBOE Nasdaq-100 vol", "^RVX": "CBOE Russell 2000 vol",
    "^GVZ": "CBOE Gold ETF vol", "^OVX": "CBOE Crude Oil ETF vol", "^VXSLV": "CBOE Silver ETF vol",
    "^VXEEM": "CBOE Emerging Markets ETF vol", "^VXEWZ": "CBOE Brazil ETF vol", "^VXAPL": "CBOE Apple vol",
    "^VXAZN": "CBOE Amazon vol", "^VXGOG": "CBOE Google vol", "^VXGS": "CBOE Goldman Sachs vol",
    "^TNX": "US 10-year yield", "^IRX": "US 13-week T-bill yield", "^FVX": "US 5-year yield",
    "DX-Y.NYB": "US Dollar Index",
}
FX = {"EURUSD=X": "EUR/USD", "JPY=X": "USD/JPY", "BRL=X": "USD/BRL", "CNY=X": "USD/CNY",
      "INR=X": "USD/INR", "AUDUSD=X": "AUD/USD", "MYR=X": "USD/MYR", "BTC-USD": "Bitcoin"}


def sp500_names():
    try:
        import scan_engine as SE
        t = SE._read_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")[0]
        return {str(s).replace(".", "-"): (str(n), str(g)) for s, n, g in
                zip(t["Symbol"], t["Security"], t["GICS Sector"])}
    except Exception as e:
        print("  S&P names unavailable:", e)
        return {}


def universe():
    u = {}
    names = sp500_names()
    try:
        with open("data/charts_index.json") as f:
            for s in json.load(f):
                n, g = names.get(s, (None, None))
                u[s] = {"n": n, "g": g or "Stock", "k": "stock"}
    except Exception:
        pass
    try:
        from ta_engine import SYMBOLS
    except Exception:
        SYMBOLS = []
    for s in SYMBOLS:
        if s not in u:
            n = None
            try:
                with open(f"data/{s}.json") as f:
                    n = json.load(f).get("name")
            except Exception:
                pass
            u[s] = {"n": n, "g": "Stock", "k": "stock"}
    for s, n in ETFS.items():
        u[s] = {"n": n, "g": "ETF", "k": "etf"}
    for s, n in INDEXES.items():
        u[s] = {"n": n, "g": "Index", "k": "index"}
    for s, n in FX.items():
        u[s] = {"n": n, "g": "FX", "k": "fx"}
    return u


def main():
    U = universe()
    ix = HS.load_index()
    have = {s: HS.load(s) for s in U}
    new = [s for s, d in have.items() if d is None]
    old = [s for s, d in have.items() if d is not None]
    print(f"universe {len(U)}: backfill {len(new)}, top-up {len(old)}")
    got = {}
    if new:
        got.update(HS.yf_download(new, start="1980-01-01", interval="1d", chunk=40))
    if old:
        got.update(HS.yf_download(old, period="1mo", interval="1d", chunk=80))
    ok = 0
    for s, meta in U.items():
        df = HS.merge(have.get(s), got.get(s))
        if df is None or not len(df):
            continue
        HS.save(s, df)
        ix[s] = HS.index_entry(df, sym=s, **meta)
        ok += 1
    HS.save_index(ix)
    print(f"saved {ok} series; missing: {[s for s in U if s not in ix][:40]}")


if __name__ == "__main__":
    main()
