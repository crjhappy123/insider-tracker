"""Export a local SQLite table into a D1-importable SQL file.

Idempotent: transactions use INSERT OR IGNORE (accession+line unique key);
companies use INSERT OR REPLACE so weekly refreshes overwrite prior values.

    python -m scraper.export_d1 > data.sql                 # transactions (default)
    python -m scraper.export_d1 --table companies > companies.sql
    python -m scraper.export_d1 --table cn_transactions > cn_data.sql   # A-share side
    python -m scraper.export_d1 --since 2026-08-01 > data.sql   # limit transactions
    # then: wrangler d1 execute insider --remote --file=data.sql
"""
from __future__ import annotations

import argparse
import sqlite3
import sys

from app.db import DB_PATH

TXN_COLUMNS = [
    "accession_no", "line_no", "filing_date", "trade_date", "ticker",
    "company_name", "issuer_cik", "insider_name", "insider_title",
    "transaction_code", "acquired_disposed", "shares", "price", "value",
    "shares_owned_after", "market_cap", "security_title",
]
COMPANY_COLUMNS = [
    "cik", "ticker", "name", "shares_outstanding", "ref_price",
    "market_cap", "updated_at",
]
REPORT_COLUMNS = ["report_date", "summary", "model", "created_at"]
SCORE_COLUMNS = [
    "accession_no", "line_no", "score", "rating", "comment", "created_at",
]
LEADERBOARD_COLUMNS = [
    "ticker", "company_name", "first_added_date", "last_seen_date",
    "entry_price", "current_price", "best_score", "best_rating", "best_comment",
    "total_value", "price_updated_at", "updated_at",
]
# A-share (/cn) tables.
CN_TXN_COLUMNS = [
    "change_id", "change_date", "code", "exchange", "company_name",
    "insider_name", "insider_title", "relation", "change_reason", "shares",
    "price", "value", "shares_owned_after", "change_ratio", "market_cap",
]
CN_COMPANY_COLUMNS = [
    "code", "name", "exchange", "last_price", "market_cap", "float_market_cap",
    "updated_at",
]
CN_SCORE_COLUMNS = ["change_id", "score", "rating", "comment", "created_at"]

# table -> (columns, insert verb)
TABLES = {
    "transactions": (TXN_COLUMNS, "INSERT OR IGNORE"),
    "companies": (COMPANY_COLUMNS, "INSERT OR REPLACE"),
    "daily_reports": (REPORT_COLUMNS, "INSERT OR REPLACE"),
    "ai_scores": (SCORE_COLUMNS, "INSERT OR REPLACE"),
    "leaderboard": (LEADERBOARD_COLUMNS, "INSERT OR REPLACE"),
    "cn_transactions": (CN_TXN_COLUMNS, "INSERT OR IGNORE"),
    "cn_companies": (CN_COMPANY_COLUMNS, "INSERT OR REPLACE"),
    "cn_daily_reports": (REPORT_COLUMNS, "INSERT OR REPLACE"),
    "cn_ai_scores": (CN_SCORE_COLUMNS, "INSERT OR REPLACE"),
    "cn_leaderboard": (LEADERBOARD_COLUMNS, "INSERT OR REPLACE"),
}
# Tables whose rows are date-windowed by `--since`: filter column -> ORDER BY.
SINCE_COLUMN = {
    "transactions": ("filing_date", "filing_date, id"),
    "cn_transactions": ("change_date", "change_date, change_id"),
}


def _sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", choices=list(TABLES), default="transactions")
    ap.add_argument("--since", help="transactions only: export filing_date >= this ISO date")
    ap.add_argument("--db", default=DB_PATH.replace("sqlite:///", ""), help="source SQLite file")
    args = ap.parse_args(argv)

    conn = sqlite3.connect(args.db)
    out = sys.stdout
    params: tuple = ()

    cols, verb = TABLES[args.table]
    q = f"SELECT {', '.join(cols)} FROM {args.table}"
    windowed = SINCE_COLUMN.get(args.table)
    if windowed:
        date_col, order_by = windowed
        if args.since:
            q += f" WHERE {date_col} >= ?"
            params = (args.since,)
        q += f" ORDER BY {order_by}"

    col_list = ", ".join(cols)
    # No BEGIN/COMMIT wrapper: D1's `d1 execute --file` rejects explicit SQL
    # transactions and batches the statements itself.
    n = 0
    for row in conn.execute(q, params):
        values = ", ".join(_sql_literal(v) for v in row)
        out.write(f"{verb} INTO {args.table} ({col_list}) VALUES ({values});\n")
        n += 1
    print(f"-- exported {n} {args.table} rows", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
