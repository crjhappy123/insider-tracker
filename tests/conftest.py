"""Test fixtures: point the app at a throwaway SQLite DB (no network needed)."""
import os
import tempfile

# Must be set BEFORE importing app.db (it reads DATABASE_URL at import time).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Transaction  # noqa: E402


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def seeded_db():
    """Fresh table with two known rows: one $5M purchase, one small sale."""
    from datetime import date

    init_db()
    with SessionLocal() as s:
        s.query(Transaction).delete()
        s.add_all(
            [
                Transaction(
                    accession_no="acc-1", line_no=0, filing_date=date(2026, 8, 28),
                    trade_date=date(2026, 8, 27), ticker="AAPL",
                    company_name="Apple Inc.", issuer_cik="320193",
                    insider_name="COOK TIMOTHY D", insider_title="Dir, CEO",
                    transaction_code="P", acquired_disposed="A",
                    shares=10000, price=500, value=5_000_000, shares_owned_after=60000,
                    market_cap=3_000_000_000_000,  # $3T
                ),
                Transaction(
                    accession_no="acc-2", line_no=0, filing_date=date(2026, 8, 28),
                    trade_date=date(2026, 8, 27), ticker="MSFT",
                    company_name="Microsoft Corp", issuer_cik="789019",
                    insider_name="NADELLA SATYA", insider_title="Dir, CEO",
                    transaction_code="P", acquired_disposed="A",
                    shares=100, price=400, value=40_000, shares_owned_after=900,
                    market_cap=50_000_000,  # $50M — below the $100M threshold
                ),
            ]
        )
        s.commit()
    yield
