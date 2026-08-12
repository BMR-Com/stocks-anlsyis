# Signal Terminal — self-updating market screener + charts

Free Yahoo Finance data. Two engines, one dashboard, hosted on GitHub Pages and
refreshed daily by a GitHub Action.

## What it does
- **Scanner** (whole market): S&P 500 + Nasdaq-100 + Russell 2000, price-derived
  trade ideas — bullish/bearish divergence, near a moving average, MACD cross,
  RSI extremes, golden/death cross, 50-day breakout, volume spikes. -> `data/scan.json`
- **Detail** (watchlist): per-symbol chart + signals, options (OI/volume by strike
  & expiry, GEX, most-active contracts, chain), fundamentals, and ownership.

## Layout
```
index.html                          the dashboard (GitHub Pages)
scan_engine.py                      whole-universe price scanner  -> data/scan.json
ta_engine.py                        detailed per-symbol (edit SYMBOLS = your watchlist)
requirements.txt
.github/workflows/update-data.yml   runs both engines daily, commits data/
data/                               generated JSON
```

## Setup (one time)
1. Push these files to a new repo's `main` branch.
2. Settings -> Actions -> General -> Workflow permissions -> **Read and write**.
3. Settings -> Pages -> Deploy from a branch -> `main` / `(root)`.
4. Actions -> **Update market data** -> **Run workflow** (first run).
5. Open `https://<user>.github.io/<repo>/`.

## Tuning
- **Watchlist** (deep detail): edit `SYMBOLS` at the top of `ta_engine.py`. Keep it
  to ~30-50 names — options/fundamentals pulls are heavy.
- **Scanner universe**: edit `INCLUDE` in `scan_engine.py` (drop RUSSELL2000 to go
  faster). `MAX_TICKERS` caps it for testing.
- **Signal sensitivity**: `NEAR_MA_PCT`, `FRESH_BARS` in `scan_engine.py`.

## Honest limits
- Yahoo is unofficial and rate-limits datacenter IPs. The scanner downloads in
  chunks with retries; some tickers will fail on any given run — re-run if a scan
  comes back thin. Options/fundamentals for the *whole* market is NOT feasible on
  free Yahoo, which is why deep detail is watchlist-only.
- Pattern signals are rule-based candidates, not calls. All data is end-of-day.

## Incremental price cache
The scanner downloads each ticker's full history ONCE, stores it in `cache/prices.parquet`,
and on later runs only tops up the newest bars. The cache is persisted via GitHub Actions
cache (not committed to the repo). The **first workflow run is slow** (full history for the
whole universe); every run after that is fast (a ~1-month top-up merged into the cache).

## Charts for the whole universe
`scan_engine.py` also exports a compact candle file per ticker to `data/charts/<SYM>.json`
(reused from the price cache — no extra downloads) plus `data/charts_index.json`. The
Chart tab can plot ANY of these: type a ticker (autocompletes from the index), switch
Daily/Weekly/Monthly (resampled in-browser), and toggle indicators from the Indicators
menu — EMA 20/50/200, SMA 50/200, Bollinger, VWAP, RSI, MACD, Stochastic, and a
**High-OI strikes** overlay (draws the biggest open-interest strikes as price lines, for
symbols that have options data). All indicators compute client-side.

Note: this commits ~one small file per ticker (a few thousand files, ~8 KB each). If your
repo gets too large over time, reduce the scanner `INCLUDE` universe or trim `MAX_HIST_BARS`.
