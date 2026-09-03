"""FastAPI app: browse and filter insider transactions."""
import os
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import AiScore, Company, DailyReport, Transaction

# Baseline market-cap floor for the table (mirrors functions/_query.js).
MIN_DISPLAY_MKTCAP = 1e9  # $1B

app = FastAPI(title="Insider Tracker")
templates = Jinja2Templates(
    directory=os.path.join(os.path.dirname(__file__), "templates")
)

@app.on_event("startup")
def _startup() -> None:
    init_db()


def _coerce_float(s: Optional[str]) -> Optional[float]:
    """Empty/blank form fields arrive as ""; treat those as no filter."""
    if s is None or str(s).strip() == "":
        return None
    try:
        return float(str(s).replace(",", ""))
    except ValueError:
        return None


def _money(v) -> str:
    """Compact currency: $9.9M, $270K, $540."""
    if v is None:
        return "—"
    n = float(v)
    a = abs(n)
    sign = "-" if n < 0 else ""
    if a >= 1e9:
        return f"{sign}${a / 1e9:.2f}B"
    if a >= 1e6:
        return f"{sign}${a / 1e6:.2f}M"
    if a >= 1e3:
        return f"{sign}${a / 1e3:.1f}K"
    return f"{sign}${a:.0f}"


def _bcap(v) -> str:
    """Market cap, always in billions: $45.31B, $0.22B."""
    if v is None:
        return "—"
    return f"${float(v) / 1e9:.2f}B"


def _mcap_tier(v) -> str:
    """Market-cap tier CSS class so larger companies stand out visually.

    mega ≥ $200B, large ≥ $10B, mid ≥ $2B, small ≥ $300M, else micro/unknown.
    """
    if v is None:
        return "mc-unknown"
    n = float(v)
    if n >= 200e9:
        return "mc-mega"
    if n >= 10e9:
        return "mc-large"
    if n >= 2e9:
        return "mc-mid"
    if n >= 300e6:
        return "mc-small"
    return "mc-micro"


def _compute_stats(rows) -> dict:
    """Headline stats over the rolled-up (per-company) rows."""
    buy_value = 0.0
    buys = 0
    max_buy = 0.0
    max_ticker = ""
    for r in rows:
        v = r["value"] or 0
        buy_value += v
        buys += r["buy_count"] or 0
        if v > max_buy:
            max_buy = v
            max_ticker = r["ticker"] or ""
    return {
        "companies": len(rows),
        "buys": buys,
        "buy_value": buy_value,
        "avg_company": buy_value / len(rows) if rows else 0,
        "max_buy": max_buy,
        "max_ticker": max_ticker,
    }


def _query_ticker_rollup(
    ticker: Optional[str],
    insider: Optional[str],
    code: Optional[str],
    min_value: Optional[str],
    min_market_cap: Optional[str],
    limit: int,
):
    """One row per company (issuer_cik): sum buy value + count, best AI score.

    Mirrors functions/_query.js queryTickerRollup — the page's rolled-up view.
    """
    eff_mktcap = func.coalesce(Company.market_cap, func.max(Transaction.market_cap))
    # Baseline $1B floor: hide no-cap and sub-$1B companies; the filter can raise it.
    mcap_floor = max(MIN_DISPLAY_MKTCAP, _coerce_float(min_market_cap) or 0)
    stmt = (
        select(
            func.max(Transaction.filing_date).label("filing_date"),
            Transaction.ticker.label("ticker"),
            func.max(Transaction.company_name).label("company_name"),
            Transaction.issuer_cik.label("issuer_cik"),
            func.count().label("buy_count"),
            func.count(func.distinct(Transaction.insider_name)).label("insider_count"),
            func.sum(Transaction.shares).label("shares"),
            func.sum(Transaction.value).label("value"),
            eff_mktcap.label("eff_mktcap"),
            func.max(AiScore.score).label("ai_score"),
        )
        .outerjoin(Company, Company.cik == Transaction.issuer_cik)
        .outerjoin(
            AiScore,
            (AiScore.accession_no == Transaction.accession_no)
            & (AiScore.line_no == Transaction.line_no),
        )
    )
    if ticker:
        stmt = stmt.where(Transaction.ticker == ticker.upper())
    if insider:
        stmt = stmt.where(Transaction.insider_name.ilike(f"%{insider}%"))
    if code:
        stmt = stmt.where(Transaction.transaction_code == code.upper())
    stmt = stmt.group_by(Transaction.issuer_cik).having(eff_mktcap >= mcap_floor)
    mv = _coerce_float(min_value)
    if mv is not None:  # min_value filters the company total in this view
        stmt = stmt.having(func.sum(Transaction.value) >= mv)
    stmt = stmt.order_by(
        func.max(Transaction.filing_date).desc(), func.sum(Transaction.value).desc()
    ).limit(limit)

    with SessionLocal() as session:
        rows = []
        for r in session.execute(stmt):
            m = r._mapping
            shares, value = m["shares"], m["value"]
            rows.append(
                {
                    "filing_date": m["filing_date"],
                    "ticker": m["ticker"],
                    "company_name": m["company_name"],
                    "issuer_cik": m["issuer_cik"],
                    "buy_count": m["buy_count"],
                    "insider_count": m["insider_count"],
                    "shares": shares,
                    "value": value,
                    "avg_price": (value / shares) if (value and shares) else None,
                    "eff_mktcap": m["eff_mktcap"],
                    "ai_score": m["ai_score"],
                    "ai_rating": None,
                    "ai_comment": None,
                }
            )
        # Best AI pick (highest score) per company drives the score pill hover.
        best: dict[str, tuple] = {}
        for cik, rating, comment in session.execute(
            select(Transaction.issuer_cik, AiScore.rating, AiScore.comment)
            .join(
                AiScore,
                (AiScore.accession_no == Transaction.accession_no)
                & (AiScore.line_no == Transaction.line_no),
            )
            .order_by(AiScore.score.desc())
        ):
            best.setdefault(cik, (rating, comment))
        for row in rows:
            if row["issuer_cik"] in best:
                row["ai_rating"], row["ai_comment"] = best[row["issuer_cik"]]
        return rows


def _rank_board(rows) -> list[dict]:
    """Collapse score-desc rows to one per ticker (best score), sum buy value."""
    by_ticker: dict[str, dict] = {}
    for r in rows:
        key = r.ticker or r.company_name
        if key not in by_ticker:
            by_ticker[key] = {
                "ticker": r.ticker,
                "company_name": r.company_name,
                "score": r.score,
                "rating": r.rating,
                "comment": r.comment,
                "value": 0.0,
                "buys": 0,
            }
        e = by_ticker[key]
        e["value"] += r.value or 0
        e["buys"] += 1
    return sorted(by_ticker.values(), key=lambda e: e["score"] or 0, reverse=True)[:15]


def _leaderboards() -> dict:
    """Daily (latest scored day) + weekly (whole window) AI score boards."""
    stmt = (
        select(
            Transaction.filing_date,
            Transaction.ticker,
            Transaction.company_name,
            Transaction.value,
            AiScore.score,
            AiScore.rating,
            AiScore.comment,
        )
        .join(
            AiScore,
            (AiScore.accession_no == Transaction.accession_no)
            & (AiScore.line_no == Transaction.line_no),
        )
        .where(AiScore.score.is_not(None))
        .order_by(AiScore.score.desc())
    )
    with SessionLocal() as session:
        rows = list(session.execute(stmt))
    if not rows:
        return {"daily": [], "weekly": []}
    latest = max(r.filing_date for r in rows)
    return {
        "daily": _rank_board([r for r in rows if r.filing_date == latest]),
        "weekly": _rank_board(rows),
    }


def _query_transactions(
    ticker: Optional[str],
    insider: Optional[str],
    code: Optional[str],
    min_value: Optional[str],
    min_market_cap: Optional[str],
    limit: int,
):
    # Effective market cap prefers the weekly company table, else the per-row estimate.
    eff_mktcap = func.coalesce(Company.market_cap, Transaction.market_cap)
    stmt = (
        select(Transaction, eff_mktcap, AiScore.score, AiScore.rating, AiScore.comment)
        .outerjoin(Company, Company.cik == Transaction.issuer_cik)
        .outerjoin(
            AiScore,
            (AiScore.accession_no == Transaction.accession_no)
            & (AiScore.line_no == Transaction.line_no),
        )
    )
    if ticker:
        stmt = stmt.where(Transaction.ticker == ticker.upper())
    if insider:
        stmt = stmt.where(Transaction.insider_name.ilike(f"%{insider}%"))
    if code:
        stmt = stmt.where(Transaction.transaction_code == code.upper())
    mv = _coerce_float(min_value)
    if mv is not None:
        stmt = stmt.where(Transaction.value >= mv)
    mc = _coerce_float(min_market_cap)
    if mc is not None:
        stmt = stmt.where(eff_mktcap >= mc)
    stmt = stmt.order_by(
        Transaction.filing_date.desc(), Transaction.id.desc()
    ).limit(limit)
    with SessionLocal() as session:
        rows = []
        for txn, eff, score, rating, comment in session.execute(stmt):
            txn.effective_market_cap = eff
            txn.ai_score = score
            txn.ai_rating = rating
            txn.ai_comment = comment
            rows.append(txn)
        return rows


@app.get("/", response_class=HTMLResponse)
def index(
    request: Request,
    ticker: Optional[str] = None,
    insider: Optional[str] = None,
    code: Optional[str] = None,
    min_value: Optional[str] = None,
    min_market_cap: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    rows = _query_ticker_rollup(
        ticker, insider, code, min_value, min_market_cap, limit
    )
    stats = _compute_stats(rows)
    boards = _leaderboards()
    with SessionLocal() as session:
        report = session.scalars(
            select(DailyReport).order_by(DailyReport.report_date.desc()).limit(1)
        ).first()
        # Only show the report if it covers the most recent data day; never fall
        # back to a stale prior-day report.
        latest_day = session.scalar(select(func.max(Transaction.filing_date)))
        if (
            report is not None
            and latest_day is not None
            and report.report_date != latest_day.isoformat()
        ):
            report = None
        report_picks = []
        if report is not None:
            seen = set()
            for row in session.execute(
                select(
                    Transaction.ticker,
                    Transaction.company_name,
                    AiScore.score,
                    AiScore.rating,
                    AiScore.comment,
                )
                .join(
                    AiScore,
                    (AiScore.accession_no == Transaction.accession_no)
                    & (AiScore.line_no == Transaction.line_no),
                )
                .where(Transaction.filing_date == report.report_date)
                .order_by(AiScore.score.desc())
            ):
                if row.ticker in seen:  # one block per company
                    continue
                seen.add(row.ticker)
                report_picks.append(row)
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "rows": rows,
            "stats": stats,
            "boards": boards,
            "report": report,
            "report_picks": report_picks,
            "money": _money,
            "bcap": _bcap,
            "mcap_tier": _mcap_tier,
            "filters": {
                "ticker": ticker or "",
                "insider": insider or "",
                "code": code or "",
                "min_value": min_value if min_value is not None else "",
                "min_market_cap": min_market_cap if min_market_cap is not None else "",
                "limit": limit,
            },
        },
    )


@app.get("/api/transactions")
def api_transactions(
    ticker: Optional[str] = None,
    insider: Optional[str] = None,
    code: Optional[str] = None,
    min_value: Optional[str] = None,
    min_market_cap: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    rows = _query_transactions(
        ticker, insider, code, min_value, min_market_cap, limit
    )
    return JSONResponse([r.as_dict() for r in rows])
