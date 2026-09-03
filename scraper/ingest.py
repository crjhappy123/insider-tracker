"""Daily batch ingestion: fetch a day's Form 4 filings and upsert into the DB.

Usage:
    python -m scraper.ingest              # ingest today
    python -m scraper.ingest 2026-08-29   # ingest a specific date
    python -m scraper.ingest 2026-08-25 2026-08-29   # inclusive date range
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import requests
from dateutil import parser as dateparser
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import Transaction
from scraper.edgar import daily_form4_filings, fetch_filing_transactions
from scraper.marketcap import estimate_market_cap

# Skip companies below this estimated market cap. 0 disables the filter.
MIN_MARKET_CAP = float(os.environ.get("MIN_MARKET_CAP", "100000000"))  # $100M

# Only store real open-market purchases. Set INGEST_CODES="" to store every code.
INGEST_CODES = {
    c.strip().upper()
    for c in os.environ.get("INGEST_CODES", "P").split(",")
    if c.strip()
}


def _filing_market_cap(cik: str, rows) -> float | None:
    """Estimate a filing's company market cap using its best nonzero price."""
    prices = [r.price for r in rows if r.price and r.price > 0]
    if not prices:
        return None
    return estimate_market_cap(cik, max(prices))


def ingest_day(day: date) -> int:
    """Ingest one day; returns number of transaction rows written.

    Only transactions whose code is in INGEST_CODES (default: P, real open-market
    purchases) are stored. Filings whose estimated company market cap is below
    MIN_MARKET_CAP are skipped. Companies whose market cap can't be estimated
    (no price / no shares data) are kept, with market_cap = NULL.
    """
    init_db()
    count = 0
    with SessionLocal() as session:
        for filing in daily_form4_filings(day):
            try:
                rows = fetch_filing_transactions(filing)
            except requests.HTTPError:
                continue  # skip individual filing failures; keep the batch going
            if not rows:
                continue

            # Estimate market cap from every priced row, then keep only the codes
            # we store — a sale's price is still a valid price reference.
            mktcap = _filing_market_cap(rows[0].issuer_cik, rows)
            if INGEST_CODES:
                rows = [r for r in rows if r.transaction_code in INGEST_CODES]
            if not rows:
                continue

            # Drop known small caps; keep unknowns (mktcap is None).
            if mktcap is not None and MIN_MARKET_CAP > 0 and mktcap < MIN_MARKET_CAP:
                continue

            for row in rows:
                stmt = (
                    sqlite_insert(Transaction)
                    .values(
                        accession_no=row.accession_no,
                        line_no=row.line_no,
                        filing_date=day,
                        trade_date=row.trade_date,
                        ticker=row.ticker,
                        company_name=row.company_name,
                        issuer_cik=row.issuer_cik,
                        insider_name=row.insider_name,
                        insider_title=row.insider_title,
                        transaction_code=row.transaction_code,
                        acquired_disposed=row.acquired_disposed,
                        shares=row.shares,
                        price=row.price,
                        value=row.value,
                        shares_owned_after=row.shares_owned_after,
                        market_cap=mktcap,
                        security_title=row.security_title,
                    )
                    # Re-running a day is idempotent thanks to the unique key.
                    .on_conflict_do_nothing(index_elements=["accession_no", "line_no"])
                )
                result = session.execute(stmt)
                count += result.rowcount or 0
        session.commit()
    return count


def _parse_arg_date(s: str) -> date:
    return dateparser.parse(s).date()


def main(argv: list[str]) -> None:
    if len(argv) == 0:
        days = [date.today()]
    elif len(argv) == 1:
        days = [_parse_arg_date(argv[0])]
    else:
        start, end = _parse_arg_date(argv[0]), _parse_arg_date(argv[1])
        days = [start + timedelta(d) for d in range((end - start).days + 1)]

    total = 0
    for day in days:
        n = ingest_day(day)
        total += n
        print(f"{day}: ingested {n} transactions")
    print(f"Done. {total} new transactions across {len(days)} day(s).")


if __name__ == "__main__":
    main(sys.argv[1:])
