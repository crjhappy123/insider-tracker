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
