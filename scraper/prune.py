"""Prune data outside the rolling retention window.

The site only shows recent insider buying, so anything older than
RETENTION_DAYS (default 7) is dropped — from the transactions table, the AI
scores tied to them, and the daily reports. Keeps the DB (and D1) small and cheap.
The durable leaderboard tables are never pruned; they back the quarterly/yearly
boards.

    python -m scraper.prune                      # prune US tables in local SQLite
    python -m scraper.prune --market cn          # prune the A-share tables
    python -m scraper.prune --market all --print-sql   # emit DELETEs for D1
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

MARKETS = ("us", "cn")


def cutoff_date(today: date | None = None) -> date:
    """Oldest filing_date to keep (inclusive)."""
    return (today or date.today()) - timedelta(days=RETENTION_DAYS - 1)


# Ordered so AI rows go before the transactions they reference.
def _market_statements(market: str, cutoff: str) -> list[str]:
    if market == "cn":
        return [
            # AI scores whose 增持 record falls outside the window.
            "DELETE FROM cn_ai_scores WHERE change_id IN ("
            f"SELECT change_id FROM cn_transactions WHERE change_date < '{cutoff}')",
            f"DELETE FROM cn_transactions WHERE change_date < '{cutoff}'",
            f"DELETE FROM cn_daily_reports WHERE report_date < '{cutoff}'",
        ]
    return [
        # AI scores whose transaction falls outside the window.
        "DELETE FROM ai_scores WHERE accession_no IN ("
        f"SELECT accession_no FROM transactions WHERE filing_date < '{cutoff}')",
        f"DELETE FROM transactions WHERE filing_date < '{cutoff}'",
        f"DELETE FROM daily_reports WHERE report_date < '{cutoff}'",
    ]


def _delete_statements(cutoff: str, markets: tuple[str, ...] = ("us",)) -> list[str]:
    return [s for m in markets for s in _market_statements(m, cutoff)]


# label -> (COUNT query template) for the pre-delete tally, per market.
def _count_queries(market: str, cutoff: str) -> dict[str, str]:
    if market == "cn":
        return {
            "cn_ai_scores": "SELECT count(*) FROM cn_ai_scores WHERE change_id IN "
            f"(SELECT change_id FROM cn_transactions WHERE change_date < '{cutoff}')",
            "cn_transactions": f"SELECT count(*) FROM cn_transactions WHERE change_date < '{cutoff}'",
            "cn_daily_reports": f"SELECT count(*) FROM cn_daily_reports WHERE report_date < '{cutoff}'",
        }
    return {
        "ai_scores": "SELECT count(*) FROM ai_scores WHERE accession_no IN "
        f"(SELECT accession_no FROM transactions WHERE filing_date < '{cutoff}')",
        "transactions": f"SELECT count(*) FROM transactions WHERE filing_date < '{cutoff}'",
        "daily_reports": f"SELECT count(*) FROM daily_reports WHERE report_date < '{cutoff}'",
    }


def prune(today: date | None = None, markets: tuple[str, ...] = ("us",)) -> dict:
    """Delete out-of-window rows from the local DB; returns rows removed per table."""
    init_db()
    cutoff = cutoff_date(today).isoformat()
    removed = {}
    with SessionLocal() as session:
        for market in markets:
            for label, query in _count_queries(market, cutoff).items():
                removed[label] = session.execute(text(query)).scalar() or 0
        for stmt in _delete_statements(cutoff, markets):
            session.execute(text(stmt))
        session.commit()
    return {"cutoff": cutoff, **removed}


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--market",
        choices=[*MARKETS, "all"],
        default="us",
        help="which market's tables to prune (default: us)",
    )
    ap.add_argument(
        "--print-sql",
        action="store_true",
        help="print the DELETE statements (for `wrangler d1 execute --file`)",
    )
    args = ap.parse_args(argv)
    markets = MARKETS if args.market == "all" else (args.market,)

    cutoff = cutoff_date().isoformat()
    if args.print_sql:
        for stmt in _delete_statements(cutoff, markets):
            print(stmt + ";")
        return

    result = prune(markets=markets)
    counts = ", ".join(
        f"{n} {label}" for label, n in result.items() if label != "cutoff"
    )
    print(
        f"Pruned data before {result['cutoff']} "
        f"(keeping {RETENTION_DAYS} days): {counts} removed."
    )


if __name__ == "__main__":
    main(sys.argv[1:])
