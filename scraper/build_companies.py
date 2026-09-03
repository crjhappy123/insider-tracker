"""Build/refresh the company-level market cap table (run weekly).

For every company that appears in the transactions table, estimate market cap as
  shares outstanding (SEC XBRL)  ×  most recent nonzero insider trade price
and upsert it into the `companies` table. Because the reference price is taken
from *any* priced filing of the company, even companies whose recent filings are
all grants/gifts (price = 0) still get a market cap.

Usage:
    python -m scraper.build_companies
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import Company, Transaction
from scraper.marketcap import shares_outstanding


def _reference_prices() -> dict[str, dict]:
    """Latest nonzero trade price (and ticker/name) per company CIK."""
    refs: dict[str, dict] = {}
    with SessionLocal() as session:
        # Newest first; the first time we see a CIK is its most recent priced trade.
        stmt = (
            select(
                Transaction.issuer_cik,
                Transaction.ticker,
                Transaction.company_name,
                Transaction.price,
            )
            .where(Transaction.price.is_not(None))
            .where(Transaction.price > 0)
            .order_by(Transaction.filing_date.desc(), Transaction.id.desc())
        )
        for cik, ticker, name, price in session.execute(stmt):
            if cik not in refs:
                refs[cik] = {"ticker": ticker, "name": name, "price": price}
    return refs


def build() -> int:
    """Refresh the companies table; returns number of companies upserted."""
    init_db()
    refs = _reference_prices()
    n = 0
    with SessionLocal() as session:
        for cik, info in refs.items():
            shares = shares_outstanding(cik)
            mktcap = shares * info["price"] if shares else None
            stmt = (
                sqlite_insert(Company)
                .values(
                    cik=cik,
                    ticker=info["ticker"],
                    name=info["name"],
                    shares_outstanding=shares,
                    ref_price=info["price"],
                    market_cap=mktcap,
                    updated_at=datetime.utcnow(),
                )
                .on_conflict_do_update(
                    index_elements=["cik"],
                    set_={
                        "ticker": info["ticker"],
                        "name": info["name"],
                        "shares_outstanding": shares,
                        "ref_price": info["price"],
                        "market_cap": mktcap,
                        "updated_at": datetime.utcnow(),
                    },
                )
            )
            session.execute(stmt)
            n += 1
        session.commit()
    return n


if __name__ == "__main__":
    count = build()
    print(f"Refreshed {count} companies.")
