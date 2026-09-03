"""Prune data outside the rolling retention window.

The site only shows recent insider buying, so anything older than
RETENTION_DAYS (default 7) is dropped — from transactions, the AI scores tied to
them, and the daily reports. Keeps the DB (and D1) small and cheap.

    python -m scraper.prune              # prune local SQLite
    python -m scraper.prune --print-sql  # emit DELETEs to run against D1
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

from sqlalchemy import text

from app.db import SessionLocal, init_db

# `or` so an empty env value from CI falls back to the default too.
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS") or 7)


def cutoff_date(today: date | None = None) -> date:
    """Oldest filing_date to keep (inclusive)."""
    return (today or date.today()) - timedelta(days=RETENTION_DAYS - 1)


# Ordered so AI rows go before the transactions they reference.
def _delete_statements(cutoff: str) -> list[str]:
    return [
        # AI scores whose transaction falls outside the window.
        "DELETE FROM ai_scores WHERE accession_no IN ("
        f"SELECT accession_no FROM transactions WHERE filing_date < '{cutoff}')",
        f"DELETE FROM transactions WHERE filing_date < '{cutoff}'",
        f"DELETE FROM daily_reports WHERE report_date < '{cutoff}'",
    ]


def prune(today: date | None = None) -> dict:
    """Delete out-of-window rows from the local DB; returns rows removed per table."""
    init_db()
    cutoff = cutoff_date(today).isoformat()
    removed = {}
    with SessionLocal() as session:
        for label, table, where in (
            ("ai_scores", "ai_scores", None),
            ("transactions", "transactions", f"filing_date < '{cutoff}'"),
            ("daily_reports", "daily_reports", f"report_date < '{cutoff}'"),
        ):
            if where:
                n = session.execute(
                    text(f"SELECT count(*) FROM {table} WHERE {where}")
                ).scalar()
            else:
                n = session.execute(
                    text(
                        "SELECT count(*) FROM ai_scores WHERE accession_no IN "
                        f"(SELECT accession_no FROM transactions WHERE filing_date < '{cutoff}')"
                    )
                ).scalar()
            removed[label] = n or 0
        for stmt in _delete_statements(cutoff):
            session.execute(text(stmt))
        session.commit()
    return {"cutoff": cutoff, **removed}


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--print-sql",
        action="store_true",
        help="print the DELETE statements (for `wrangler d1 execute --file`)",
    )
    args = ap.parse_args(argv)

    cutoff = cutoff_date().isoformat()
    if args.print_sql:
        for stmt in _delete_statements(cutoff):
            print(stmt + ";")
        return

    result = prune()
    print(
        f"Pruned data before {result['cutoff']} "
        f"(keeping {RETENTION_DAYS} days): "
        f"{result['transactions']} transactions, "
        f"{result['ai_scores']} ai_scores, "
        f"{result['daily_reports']} daily_reports removed."
    )


if __name__ == "__main__":
    main(sys.argv[1:])
