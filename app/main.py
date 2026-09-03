"""FastAPI app: browse and filter insider transactions."""
import os
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import AiScore, Company, DailyReport, Transaction

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


def _compute_stats(rows) -> dict:
    """Headline stats. Every stored row is an open-market purchase (code P)."""
    buy_value = 0.0
    max_buy = 0.0
    max_ticker = ""
    for r in rows:
        v = r.value or 0
        buy_value += v
        if v > max_buy:
            max_buy = v
            max_ticker = r.ticker or ""
    return {
        "count": len(rows),
        "buy_value": buy_value,
        "avg_buy": buy_value / len(rows) if rows else 0,
        "max_buy": max_buy,
        "max_ticker": max_ticker,
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
    rows = _query_transactions(
        ticker, insider, code, min_value, min_market_cap, limit
    )
    stats = _compute_stats(rows)
    with SessionLocal() as session:
        report = session.scalars(
            select(DailyReport).order_by(DailyReport.report_date.desc()).limit(1)
        ).first()
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
            "report": report,
            "report_picks": report_picks,
            "money": _money,
            "bcap": _bcap,
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
