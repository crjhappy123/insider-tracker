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


class DailyReport(Base):
    """AI-generated daily buy-opinion report, one per day."""

    __tablename__ = "daily_reports"

    report_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    summary: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AiScore(Base):
    """AI conviction score + comment for a single transaction."""

    __tablename__ = "ai_scores"

    accession_no: Mapped[str] = mapped_column(String(32), primary_key=True)
    line_no: Mapped[int] = mapped_column(Integer, primary_key=True)
    score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    rating: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    comment: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Leaderboard(Base):
    """Durable AI leaderboard membership: one row per ticker ever picked.

    Unlike transactions/ai_scores (pruned to a rolling window), these rows
    persist, so they can back the quarterly/yearly boards and track each pick's
    performance since it was first added. first_added_date/entry_price are set
    once; current_price is refreshed on every maintenance run.
    """

    __tablename__ = "leaderboard"

    ticker: Mapped[str] = mapped_column(String(16), primary_key=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    first_added_date: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    last_seen_date: Mapped[Optional[str]] = mapped_column(String(10), index=True, nullable=True)
    entry_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    current_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    best_score: Mapped[Optional[int]] = mapped_column(Integer, index=True, nullable=True)
    best_rating: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    best_comment: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    total_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price_updated_at: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# A-share (中国 A 股) tables, served at /cn. Kept entirely separate from the US
# tables above — different identifiers (6-digit 股票代码 vs CIK), different
# currency, different source API — so neither side can affect the other.
# ---------------------------------------------------------------------------


class CnTransaction(Base):
    """One 董监高持股变动 record. Only 增持 (net buys) are ingested."""

    __tablename__ = "cn_transactions"
    __table_args__ = (
        # 东方财富 emits one record per (变动人, 关联董监高) pair, so one purchase by
        # an entity tied to two officers arrives twice under different GGEIDs.
        # This key collapses them so 增持总额 isn't double-counted.
        UniqueConstraint(
            "change_date", "code", "insider_name", "shares", "price", "change_reason",
            name="uq_cn_change",
        ),
    )

    # 东方财富 GGEID: stable per disclosed change, so re-ingesting a day is a no-op.
    change_id: Mapped[str] = mapped_column(String(32), primary_key=True)

    change_date: Mapped[date] = mapped_column(Date, index=True)  # 变动日期
    code: Mapped[str] = mapped_column(String(8), index=True)  # 股票代码
    exchange: Mapped[Optional[str]] = mapped_column(String(4), nullable=True)  # SH/SZ/BJ
    company_name: Mapped[str] = mapped_column(String(255))  # 证券简称

    insider_name: Mapped[str] = mapped_column(String(64), index=True)  # 变动人
    insider_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # 职务
    relation: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # 关系
    change_reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # 途径

    shares: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    value: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    shares_owned_after: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    change_ratio: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    market_cap: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CnCompany(Base):
    """A-share company 市值 snapshot, refreshed on every ingest."""

    __tablename__ = "cn_companies"

    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    exchange: Mapped[Optional[str]] = mapped_column(String(4), nullable=True)
    last_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    market_cap: Mapped[Optional[float]] = mapped_column(Float, index=True, nullable=True)
    float_market_cap: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CnDailyReport(Base):
    """AI-generated daily A-share report, one per day."""

    __tablename__ = "cn_daily_reports"

    report_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    summary: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CnAiScore(Base):
    """AI conviction score + comment for a single 增持 record."""

    __tablename__ = "cn_ai_scores"

    change_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    rating: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    comment: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class YtVideo(Base):
    """A finance YouTuber's video plus the AI-extracted view (/yt page)."""

    __tablename__ = "yt_videos"

    video_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    channel_id: Mapped[str] = mapped_column(String(32), index=True)
    channel_name: Mapped[str] = mapped_column(String(255))
    title: Mapped[str] = mapped_column(String)
    published_at: Mapped[str] = mapped_column(String(32), index=True)
    publish_date: Mapped[str] = mapped_column(String(10), index=True)
    stance: Mapped[Optional[str]] = mapped_column(String(8), index=True, nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    views: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    stocks: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # JSON array
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CnLeaderboard(Base):
    """Durable A-share AI leaderboard; `ticker` holds the 6-digit 股票代码.

    Same shape as `Leaderboard` so the frontend's windowing/ranking is shared.
    """

    __tablename__ = "cn_leaderboard"

    ticker: Mapped[str] = mapped_column(String(8), primary_key=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    first_added_date: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    last_seen_date: Mapped[Optional[str]] = mapped_column(String(10), index=True, nullable=True)
    entry_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    current_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    best_score: Mapped[Optional[int]] = mapped_column(Integer, index=True, nullable=True)
    best_rating: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    best_comment: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    total_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price_updated_at: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
