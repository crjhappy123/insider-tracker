# RudyStock (Insider Tracker)

A web app with **three sections**, switched from a sidebar (a tab strip on phones):

| Section     | Pages                                   | Source                                                |
| ----------- | --------------------------------------- | ----------------------------------------------------- |
| 美股 Insider | `/`                                     | SEC EDGAR **Form 4** open-market purchases (code P)   |
| A股 Insider  | `/cn`                                   | 东方财富 **董监高持股变动** — 二级市场增持 (Chinese UI) |
| 博主汇总     | `/yt` 个股观点, `/yt/macro` 宏观报告, `/yt/heatmap` 热力图 | Finance YouTubers' videos, read by Gemini |

The two insider sides are deliberately independent: separate D1 tables (`cn_*`),
separate scrapers, separate workflows, separate currency formatting and copy. Only
the app shell, theme/CSS and the leaderboard windowing are shared
(`functions/_shared.js`), so neither market's data or ingest can change what the
other page shows. The top bar's clock shows the page's market (美东 or 北京) and
whether it is open; exchange holidays aren't known to it.

## For AI agents and scheduled tasks

`/digest` returns the whole site as one Markdown document (`functions/_digest.js`):
the day's 博主 macro report and stock calls, the 7-day blogger consensus, and the top
25 US and A-share insider buys with AI comments — same data and filters as the pages.
`/llms.txt` lists every page and endpoint, and `robots.txt` allows all crawlers.
Point a scheduled task at `https://www.rudystock.com/digest`.

## Stack

- **Scraper** (`scraper/`) — for the US, pulls the SEC EDGAR daily master index,
  fetches each Form 4 ownership XML, and parses non-derivative transactions. For
  A-shares, `cn_*` modules read three free 东方财富 endpoints (see below).
- **Backend** (`app/`) — FastAPI + SQLAlchemy over SQLite. Local dev only, and it
  serves the **US** page only; production is Cloudflare Pages Functions.
- **Frontend** — server-rendered pages from `functions/` (Cloudflare Pages).

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

## A-share (A股) side

Served at **`/cn`**, with a JSON API at `/api/cn/transactions`. Data comes from
three keyless 东方财富 endpoints, wrapped in `scraper/cn_eastmoney.py`:

| Endpoint                      | Used for                                          |
| ----------------------------- | ------------------------------------------------- |
| `RPT_EXECUTIVE_HOLD_DETAILS`  | 董监高持股变动明细 — the A-share analogue of Form 4 |
| `qt/ulist.np/get`             | batched 总市值 / 流通市值 / 最新价                  |
| `qt/stock/kline/get`          | 前复权 daily closes (entry/current price, 技术面)   |

### Ingest

```bash
.venv/bin/python -m scraper.cn_ingest                        # today
.venv/bin/python -m scraper.cn_ingest 2026-09-04             # one 变动日期
.venv/bin/python -m scraper.cn_ingest 2026-09-01 2026-09-05  # inclusive range
```

Only **增持** is stored (`CHANGE_SHARES > 0`), and only 二级市场 purchases —
`竞价交易` / `集中竞价` / `二级市场买卖`. `大宗交易` and negotiated transfers are
skipped as low-signal; override with `CN_INGEST_REASONS`.

Two things worth knowing about the source data:

- **A-share insiders disclose within 2 trading days**, so records for a given
  变动日期 keep arriving afterwards. The workflow re-ingests a rolling **5-day
  window** on every run to pick up late disclosures.
- **东方财富 emits one record per (变动人, 关联董监高) pair**, so a single purchase by
  an entity tied to two officers arrives twice under different `GGEID`s. Ingest
  collapses those (merging the 职务), and a unique index enforces it in D1 — without
  this, 增持总额 double-counts.

Market caps are fetched live per ingest, so there is no separate weekly job; the
final `refresh_caps()` step also self-heals any cap missed to a transient 502.

```bash
CN_MIN_MARKET_CAP=1000000000 python -m scraper.cn_ingest   # default ¥10亿 floor
```

创业板 (30x) and 科创板 (688/689) are **not followed**: ingest drops them at the
source and `prune` clears any left over, leaderboard rows included. Change the set
with `CN_EXCLUDE_CODE_PREFIXES` (empty keeps every board).

The page hides companies below **¥50亿** (raise it with the 最小市值 filter), and
tints rows by cap tier: 超大 ≥¥1万亿, 大盘 ≥¥500亿, 中盘 ≥¥100亿, 小盘 ≥¥30亿.

### AI report + leaderboard

Same Gemini pipeline as the US side, with an A-share-tuned Chinese prompt
(主板/创业板/科创板/北交所 valuation differences, ST caution):

```bash
python -m scraper.cn_ai_report 2026-09-04   # scores + 每日复盘 → cn_ai_scores
python -m scraper.cn_ai_report 2026-09-04 1 # …only that 变动日期 (window = 1 day)
python -m scraper.cn_leaderboard            # durable 日/周/季/年 boards
python -m scraper.prune --market cn         # rolling retention window
```

Unlike the US side, scoring covers a **window** of 变动日期 (`CN_AI_LOOKBACK_DAYS`,
default 7 = the retention window) and only records that have no score yet. A-share
disclosures keep landing on days already past, and a 总市值 missed by a failed quote
only becomes known later — scoping to the freshest day alone left most records
permanently unscored. `CN_AI_MIN_MARKET_CAP` (default ¥50亿, matching the page's
display floor) gates which 增持 get scored; `CN_AI_MAX_PICKS` (40) bounds cost per
run, and anything over the cap is picked up by the next run.

### Automate

`.github/workflows/cn-daily-ingest.yml` and `cn-leaderboard.yml` mirror the US
workflows and reuse the **same repo secrets** — no new ones are needed. They run
on 北京时间 (09:30 UTC after the 15:00 close, 01:00 UTC before the open).

## 博主汇总 (`/yt`)

Tracks what finance YouTubers said in their latest videos. Channels live in
`scraper/yt_channels.json` (name + `UC…` channel id); edit that file to add or
remove one.

```bash
GEMINI_API_KEY=… python -m scraper.yt_ingest   # list, store and analyze new videos
GEMINI_API_KEY=… python -m scraper.yt_macro    # (re)build recent days' macro reports
```

Gemini reads each public video URL directly and returns the creator's market stance,
a summary, key points and stock calls, each with any price levels they named and a
0-100 **Score** for how bullish the creator is on it (calls analyzed before Score
existed show "—"). The three pages, each with a ◀ date ▶ picker:

- **个股观点** `/yt` — one row per creator and stock for the day: 股票, 博主,
  博主分析总结, 建议, Score; filter by creator or stock. The day's videos follow.
- **宏观报告** `/yt/macro` — `scraper/yt_macro.py` sends the day's analyzed views
  (text only, so it's one cheap call) to Gemini and stores one report per day in
  `yt_macro_reports`: overall call, headline, 大盘, 宏观与政策, sectors, 共识, 分歧,
  风险, what to watch. A day is rebuilt whenever more of its videos have been analyzed
  since. Days without a report yet still show every creator's stance and summary.
- **热力图** `/yt/heatmap` — a treemap of the stocks called on the day or the 7 days
  ending on it (area = creators who took a side, color = which side), above the
  看多 / 看空 / 分歧 board ranked by how many creators made the call.

Days are the video's UTC `publish_date`. `.github/workflows/yt-views.yml` runs twice
a day: ingest, then macro reports; it keeps 30 days of videos in D1 (reports are kept).

- `GEMINI_API_KEY` — required, or nothing gets analyzed and the pages stay empty.
  The free tier allows 8 hours of YouTube video a day, so each run analyzes at most
  `YT_MAX_VIDEOS` (default 8), newest first; the rest wait for the next run.
- `YOUTUBE_API_KEY` — required in CI (YouTube Data API v3, free quota). Without it,
  listing falls back to the RSS feed, which returned 404/500 for every channel from
  GitHub Actions; the run then fails. RSS is only usable locally, and even there
  often fails.

## Run the web app

```bash
./run.sh
# then open http://127.0.0.1:8000
```

Filters: ticker, insider name (substring), transaction type (P/S/A/M/F/G),
minimum dollar value. JSON API at `/api/transactions` with the same query params.

Note this FastAPI app serves the **US** page only — it's the local dev backend
that predates the Cloudflare deployment. The A-share page exists only as a Pages
Function, so preview it with `npx wrangler pages dev public` instead.

## Data model

US: one row per non-derivative transaction (`transactions`): filing date, trade
date, ticker, company, insider name + title, transaction code, acquired/disposed
(A/D), shares, price, value, shares owned after.

A-shares: one row per 增持 record (`cn_transactions`), keyed on 东方财富's `GGEID`:
变动日期, 股票代码 + exchange, 证券简称, 变动人 + 职务 + 关系, 变动途径, shares,
均价, 金额, 变动后持股数, 占总股本比例, 总市值.

Both sides also have `*_companies` (market cap), `*_daily_reports` (AI summary),
`*_ai_scores`, and a durable `*_leaderboard` that survives the rolling prune so
the quarterly/yearly boards have history.

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
npx wrangler d1 execute insider --remote --file=schema.sql   # both markets' tables
python -m scraper.export_d1 > data.sql
npx wrangler d1 execute insider --remote --file=data.sql
```

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`) and holds the `cn_*`
tables too, so re-running it on an existing database just adds the A-share side.

### Deploy the site

```bash
npx wrangler pages deploy public   # first run creates the Pages project
```

After that, `.github/workflows/deploy.yml` publishes automatically on every push
to `main` that touches `public/`, `functions/` or `wrangler.toml`.

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
- `GEMINI_API_KEY` — optional; without it the AI report/scores are skipped

The A-share workflows need no additional secrets (东方财富's endpoints are keyless).

## Scope / next steps

US side:

- Currently parses **non-derivative** transactions only (like OpenInsider's main
  view). Derivative transactions (options) are not yet ingested.
- No ticker backfill for filings missing `issuerTradingSymbol`.

A-share side:

- Covers **董监高增持** only. 大股东增减持 (the `股东增减持` report) is a separate
  Eastmoney report with different fields and isn't ingested yet.
- The FastAPI dev app has no `/cn` route; preview via `wrangler pages dev`.

Both: cluster-buy detection, per-ticker pages, real-time polling, Postgres for
larger history, pagination.
