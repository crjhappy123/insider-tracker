-- D1 (Cloudflare SQLite) schema for the insider tracker.
-- Apply with: wrangler d1 execute insider --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  accession_no       TEXT    NOT NULL,
  line_no            INTEGER NOT NULL,
  filing_date        TEXT    NOT NULL,          -- ISO date
  trade_date         TEXT,
  ticker             TEXT,
  company_name       TEXT    NOT NULL,
  issuer_cik         TEXT    NOT NULL,
  insider_name       TEXT    NOT NULL,
  insider_title      TEXT    NOT NULL,
  transaction_code   TEXT    NOT NULL,
  acquired_disposed  TEXT,
  shares             REAL,
  price              REAL,
  value              REAL,
  shares_owned_after REAL,
  market_cap         REAL,               -- estimated: shares outstanding × price
  security_title     TEXT,
  created_at         TEXT    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(accession_no, line_no)
);

CREATE INDEX IF NOT EXISTS ix_filing_date ON transactions(filing_date);
CREATE INDEX IF NOT EXISTS ix_ticker      ON transactions(ticker);
CREATE INDEX IF NOT EXISTS ix_value       ON transactions(value);
CREATE INDEX IF NOT EXISTS ix_code        ON transactions(transaction_code);
CREATE INDEX IF NOT EXISTS ix_insider     ON transactions(insider_name);
CREATE INDEX IF NOT EXISTS ix_market_cap  ON transactions(market_cap);

-- Company-level market cap, refreshed on its own (weekly) schedule.
CREATE TABLE IF NOT EXISTS companies (
  cik                TEXT PRIMARY KEY,
  ticker             TEXT,
  name               TEXT,
  shares_outstanding REAL,
  ref_price          REAL,               -- most recent nonzero insider trade price
  market_cap         REAL,               -- shares_outstanding × ref_price
  updated_at         TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_companies_ticker ON companies(ticker);

-- AI-generated daily report (buy opinions), one row per day.
CREATE TABLE IF NOT EXISTS daily_reports (
  report_date TEXT PRIMARY KEY,
  summary     TEXT,
  model       TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- AI score + comment per scored transaction.
CREATE TABLE IF NOT EXISTS ai_scores (
  accession_no TEXT,
  line_no      INTEGER,
  score        INTEGER,          -- 0-100 conviction
  rating       TEXT,             -- e.g. Strong / Moderate / Weak
  comment      TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (accession_no, line_no)
);

-- Durable AI leaderboard: one row per ticker that has ever been an AI pick.
-- Survives the rolling prune (unlike transactions/ai_scores), so it can back the
-- quarterly/yearly boards. Windows (daily/weekly/quarterly/yearly) are derived
-- from last_seen_date. first_added_date + entry_price are set once and preserved;
-- current_price is refreshed on every maintenance run.
CREATE TABLE IF NOT EXISTS leaderboard (
  ticker           TEXT PRIMARY KEY,
  company_name     TEXT,
  first_added_date TEXT,          -- first date this ticker became an AI pick
  last_seen_date   TEXT,          -- most recent date it was a pick (windowing)
  entry_price      REAL,          -- market close on first_added_date (set once)
  current_price    REAL,          -- latest market price, refreshed each run
  best_score       INTEGER,       -- best AI conviction score to date
  best_rating      TEXT,
  best_comment     TEXT,
  total_value      REAL,          -- summed insider buy $ of its scored picks
  price_updated_at TEXT,
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_lb_last_seen ON leaderboard(last_seen_date);
CREATE INDEX IF NOT EXISTS ix_lb_score     ON leaderboard(best_score);

-- ---------------------------------------------------------------------------
-- A-share (中国 A 股) side of the site, served at /cn.
--
-- Deliberately a separate set of `cn_*` tables rather than a `market` column on
-- the US tables: the two markets have different identifiers (6-digit 股票代码 vs
-- CIK/ticker), different currencies, and different source APIs — and keeping them
-- apart means no A-share ingest or query can change what the US page shows.
-- ---------------------------------------------------------------------------

-- One row per 董监高持股变动 record (only 增持 / net buys are ingested).
CREATE TABLE IF NOT EXISTS cn_transactions (
  change_id          TEXT PRIMARY KEY,   -- 东方财富 GGEID, stable per record
  change_date        TEXT NOT NULL,      -- 变动日期 (ISO date)
  code               TEXT NOT NULL,      -- 股票代码, e.g. 600826
  exchange           TEXT,               -- SH / SZ / BJ
  company_name       TEXT NOT NULL,      -- 证券简称
  insider_name       TEXT NOT NULL,      -- 变动人
  insider_title      TEXT,               -- 职务, e.g. 董事长
  relation           TEXT,               -- 与董监高关系, e.g. 本人 / 配偶
  change_reason      TEXT,               -- 变动途径, e.g. 集中竞价 / 大宗交易
  shares             REAL,               -- 增持股数
  price              REAL,               -- 成交均价 (¥)
  value              REAL,               -- 增持金额 (¥)
  shares_owned_after REAL,               -- 变动后持股数
  change_ratio       REAL,               -- 占总股本比例 (%)
  market_cap         REAL,               -- 总市值 (¥) at ingest time
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);
-- 东方财富 emits one record per (变动人, 关联董监高) pair, so one purchase by an
-- entity tied to two officers arrives twice under different GGEIDs. This unique
-- index collapses those to one row (the export uses INSERT OR IGNORE) so 增持总额
-- isn't double-counted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cn_change
  ON cn_transactions(change_date, code, insider_name, shares, price, change_reason);
CREATE INDEX IF NOT EXISTS ix_cn_change_date ON cn_transactions(change_date);
CREATE INDEX IF NOT EXISTS ix_cn_code        ON cn_transactions(code);
CREATE INDEX IF NOT EXISTS ix_cn_value       ON cn_transactions(value);
CREATE INDEX IF NOT EXISTS ix_cn_insider     ON cn_transactions(insider_name);
CREATE INDEX IF NOT EXISTS ix_cn_market_cap  ON cn_transactions(market_cap);

-- Company-level 市值, refreshed on every ingest (the quote API is live, so unlike
-- the US side this needs no separate weekly job).
CREATE TABLE IF NOT EXISTS cn_companies (
  code               TEXT PRIMARY KEY,
  name               TEXT,
  exchange           TEXT,
  last_price         REAL,               -- 最新价 (¥)
  market_cap         REAL,               -- 总市值 (¥)
  float_market_cap   REAL,               -- 流通市值 (¥)
  updated_at         TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cn_daily_reports (
  report_date TEXT PRIMARY KEY,
  summary     TEXT,
  model       TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cn_ai_scores (
  change_id  TEXT PRIMARY KEY,
  score      INTEGER,                    -- 0-100 conviction
  rating     TEXT,                       -- 强 / 中等 / 弱
  comment    TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Durable A-share AI leaderboard. Same shape as `leaderboard` so the frontend's
-- windowing/ranking is shared; `ticker` holds the 6-digit 股票代码.
CREATE TABLE IF NOT EXISTS cn_leaderboard (
  ticker           TEXT PRIMARY KEY,
  company_name     TEXT,
  first_added_date TEXT,
  last_seen_date   TEXT,
  entry_price      REAL,
  current_price    REAL,
  best_score       INTEGER,
  best_rating      TEXT,
  best_comment     TEXT,
  total_value      REAL,
  price_updated_at TEXT,
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_cnlb_last_seen ON cn_leaderboard(last_seen_date);
CREATE INDEX IF NOT EXISTS ix_cnlb_score     ON cn_leaderboard(best_score);
