"""Export the local SQLite DB into a D1-importable SQL file.

Produces INSERT OR IGNORE statements (deduped on the accession+line unique key),
so re-loading is safe. Usage:

    python -m scraper.export_d1 > data.sql
    # then: wrangler d1 execute insider --remote --file=data.sql

Optionally limit to recent filings to keep daily loads small:
    python -m scraper.export_d1 --since 2026-08-01 > data.sql
"""
from __future__ import annotations

import argparse
import sqlite3
import sys

from app.db import DB_PATH

COLUMNS = [
    "accession_no", "line_no", "filing_date", "trade_date", "ticker",
    "company_name", "issuer_cik", "insider_name", "insider_title",
    "transaction_code", "acquired_disposed", "shares", "price", "value",
    "shares_owned_after", "market_cap", "security_title",
]


def _sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="only export filing_date >= this ISO date")
    ap.add_argument(
        "--db",
        default=DB_PATH.replace("sqlite:///", ""),
        help="path to source SQLite file",
    )
    args = ap.parse_args(argv)

    conn = sqlite3.connect(args.db)
    q = f"SELECT {', '.join(COLUMNS)} FROM transactions"
    params: tuple = ()
    if args.since:
        q += " WHERE filing_date >= ?"
        params = (args.since,)
    q += " ORDER BY filing_date, id"

    cols = ", ".join(COLUMNS)
    out = sys.stdout
    # No BEGIN/COMMIT wrapper: D1's `d1 execute --file` rejects explicit SQL
    # transactions and batches the statements itself.
    n = 0
    for row in conn.execute(q, params):
        values = ", ".join(_sql_literal(v) for v in row)
        out.write(f"INSERT OR IGNORE INTO transactions ({cols}) VALUES ({values});\n")
        n += 1
    print(f"-- exported {n} rows", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
