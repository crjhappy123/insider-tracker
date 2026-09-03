# Insider Tracker

An OpenInsider-style web app that tracks U.S. insider trading by parsing
SEC EDGAR **Form 4** filings, storing them in SQLite, and serving a filterable
web table.

## Stack

- **Scraper** (`scraper/`) — pulls the SEC EDGAR daily master index, fetches each
  Form 4 ownership XML, and parses non-derivative transactions.
- **Backend** (`app/`) — FastAPI + SQLAlchemy over SQLite.
- **Frontend** — a single server-rendered Jinja2 page with filter form.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

SEC requires a descriptive User-Agent with contact info. Set your own:

```bash
export EDGAR_USER_AGENT="your-name your-email@example.com"
```

## Ingest data

The scraper is a **daily batch** job. Run it for a date (or range):

```bash
.venv/bin/python -m scraper.ingest                 # today
.venv/bin/python -m scraper.ingest 2026-08-28      # one day
.venv/bin/python -m scraper.ingest 2026-08-25 2026-08-29   # inclusive range
```

Re-running a day is idempotent (deduped on accession + line number).
No index is published on weekends/holidays — those days return 0 rows.

### Market-cap filtering

During ingest, each filing's company market cap is **estimated** from free SEC
data — shares outstanding (`dei:EntityCommonStockSharesOutstanding`) × the Form 4
transaction price (a real recent execution price). Filings whose estimated market
cap is below `MIN_MARKET_CAP` (default **$100M**) are skipped and never stored.
Companies whose cap can't be estimated (no price, or no shares data) are kept with
`market_cap = NULL` and shown as "—".

```bash
MIN_MARKET_CAP=100000000 python -m scraper.ingest 2026-08-24   # default $100M
MIN_MARKET_CAP=0 python -m scraper.ingest 2026-08-24           # disable the filter
```

The site also has a **Min mkt cap** filter and a **Mkt Cap** column. Note this is
an estimate for coarse screening, not a real-time quote.

### Automate (daily cron)

Add to `crontab -e` to ingest yesterday every morning:

```
30 6 * * * cd /Users/ruijiche/Desktop/stock && EDGAR_USER_AGENT="you you@example.com" .venv/bin/python -m scraper.ingest "$(date -v-1d +\%Y-\%m-\%d)" >> ingest.log 2>&1
```

## Run the web app

```bash
./run.sh
# then open http://127.0.0.1:8000
```

Filters: ticker, insider name (substring), transaction type (P/S/A/M/F/G),
minimum dollar value. JSON API at `/api/transactions` with the same query params.

## Data model

One row per non-derivative transaction (`transactions` table): filing date,
trade date, ticker, company, insider name + title, transaction code,
acquired/disposed (A/D), shares, price, value, shares owned after.

## Deploy to Cloudflare (Pages + D1)

The read path (website + API) runs 100% on Cloudflare: **Pages Functions**
(`functions/`) query a **D1** database. The scraper stays in Python and runs on
a schedule (GitHub Actions), pushing rows into D1.

### Prerequisites
- Node.js (`brew install node`) — wrangler needs it.
- A Cloudflare account (the one that owns your domain).

### One-time setup

```bash
npm install                       # installs wrangler locally
npx wrangler login                # run this yourself: opens a browser
npx wrangler d1 create insider    # copy the printed database_id
```

Paste that `database_id` into `wrangler.toml`, then create the schema and load
your current data:

```bash
npx wrangler d1 execute insider --remote --file=schema.sql
python -m scraper.export_d1 > data.sql
npx wrangler d1 execute insider --remote --file=data.sql
```

### Deploy the site

```bash
npx wrangler pages deploy public   # first run creates the Pages project
```

Then in the Cloudflare dashboard → your Pages project → **Custom domains**, add
your domain (DNS is auto-configured since Cloudflare manages it). Also bind the
D1 database to the Pages project (Settings → Functions → D1 bindings: `DB` →
`insider`) if the dashboard doesn't pick it up from `wrangler.toml`.

Local preview against remote D1:

```bash
npx wrangler pages dev public
```

### Automate daily ingest

`.github/workflows/daily-ingest.yml` runs every morning: ingests yesterday's
filings, exports, and pushes to D1. Add these GitHub repo secrets:

- `EDGAR_USER_AGENT` — your name + email
- `CLOUDFLARE_API_TOKEN` — a token with **D1 Edit** permission
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard

## Scope / next steps

- Currently parses **non-derivative** transactions only (like OpenInsider's main
  view). Derivative transactions (options) are not yet ingested.
- No ticker backfill for filings missing `issuerTradingSymbol`.
- Consider: cluster-buy detection, per-ticker pages, real-time polling,
  Postgres for larger history, pagination.
