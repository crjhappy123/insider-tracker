"""SQLAlchemy models for insider trading data."""
from datetime import date, datetime
from typing import ClassVar, Optional

from sqlalchemy import Date, DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Transaction(Base):
    """A single non-derivative insider transaction parsed from a Form 4."""

    __tablename__ = "transactions"
    __table_args__ = (
        # A filing can hold several transactions; this key dedupes re-ingests.
        UniqueConstraint("accession_no", "line_no", name="uq_accession_line"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    accession_no: Mapped[str] = mapped_column(String(32), index=True)
    line_no: Mapped[int] = mapped_column(Integer)

    filing_date: Mapped[date] = mapped_column(Date, index=True)
    trade_date: Mapped[Optional[date]] = mapped_column(Date, index=True, nullable=True)

    ticker: Mapped[Optional[str]] = mapped_column(String(16), index=True, nullable=True)
    company_name: Mapped[str] = mapped_column(String(255))
    issuer_cik: Mapped[str] = mapped_column(String(16), index=True)

    insider_name: Mapped[str] = mapped_column(String(255), index=True)
    insider_title: Mapped[str] = mapped_column(String(255))  # e.g. "Dir, CEO, 10%"

    transaction_code: Mapped[str] = mapped_column(String(4), index=True)  # P, S, A...
    acquired_disposed: Mapped[Optional[str]] = mapped_column(String(1), nullable=True)

    shares: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    value: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    shares_owned_after: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    market_cap: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    security_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Effective (company-level) market cap, attached at query time; not persisted.
    effective_market_cap: ClassVar[Optional[float]] = None

    def as_dict(self) -> dict:
        return {
            "filing_date": self.filing_date.isoformat() if self.filing_date else None,
            "trade_date": self.trade_date.isoformat() if self.trade_date else None,
            "ticker": self.ticker,
            "company_name": self.company_name,
            "insider_name": self.insider_name,
            "insider_title": self.insider_title,
            "transaction_code": self.transaction_code,
            "acquired_disposed": self.acquired_disposed,
            "shares": self.shares,
            "price": self.price,
            "value": self.value,
            "shares_owned_after": self.shares_owned_after,
            "market_cap": self.effective_market_cap
            if self.effective_market_cap is not None
            else self.market_cap,
            "accession_no": self.accession_no,
        }


class Company(Base):
    """Company-level market cap, refreshed weekly (see scraper/build_companies.py)."""

    __tablename__ = "companies"

    cik: Mapped[str] = mapped_column(String(16), primary_key=True)
    ticker: Mapped[Optional[str]] = mapped_column(String(16), index=True, nullable=True)
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    shares_outstanding: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ref_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    market_cap: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
