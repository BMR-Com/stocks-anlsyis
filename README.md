# Signal Charts — self-updating TA dashboard

TradingView-style charts + auto-detected signals (RSI/MACD divergence, double
tops/bottoms, crosses, breakouts, S/R), powered by free Yahoo Finance data.
Hosted on GitHub Pages; refreshed daily by a GitHub Action.

## Repo layout
```
index.html                       the dashboard (served by GitHub Pages)
ta_engine.py                     pulls Yahoo data, writes data/*.json
requirements.txt                 yfinance, pandas, numpy
.github/workflows/update-data.yml  scheduled job that runs the engine + commits data
data/                            generated JSON (created on first run)
```

## One-time setup
1. Create a new GitHub repo and push these files to the `main` branch.
2. **Settings → Actions → General → Workflow permissions** → select
   **Read and write permissions** → Save. (Lets the Action commit data back.)
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**,
   folder: **/(root)** → Save.
4. **Actions** tab → select **Update TA data** → **Run workflow** (manual first run).
   It installs deps, runs the engine, and commits `data/`.
5. Open your site: `https://<your-username>.github.io/<repo>/`

After that it updates itself every weekday at 22:00 UTC (after US close). Edit the
`SYMBOLS` list at the top of `ta_engine.py` to track different tickers; edit the
`cron` line in the workflow to change the schedule.

## Notes
- Yahoo Finance is unofficial and occasionally rate-limits datacenter IPs. The
  engine retries; if a run comes back short, just re-run the workflow.
- All data is end-of-day; pattern detection is rule-based (candidates, not calls).
