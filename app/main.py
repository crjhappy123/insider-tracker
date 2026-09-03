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

# Common OpenInsider-style transaction codes.
CODE_LABELS = {
    "P": "P - Purchase",
    "S": "S - Sale",
    "A": "A - Grant/Award",
    "M": "M - Option Exercise",
    "F": "F - Tax Withholding",
    "G": "G - Gift",
}


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
    buy_value = sell_value = 0.0
    buys = sells = 0
    for r in rows:
        v = r.value or 0
        if r.acquired_disposed == "A":
            buy_value += v
            buys += 1
        elif r.acquired_disposed == "D":
            sell_value += v
            sells += 1
    total = buy_value + sell_value or 1
    return {
        "count": len(rows),
        "buys": buys,
        "sells": sells,
        "buy_value": buy_value,
        "sell_value": sell_value,
        "net": buy_value - sell_value,
        "buy_pct": buy_value / total * 100,
    }


def _query_transactions(
    ticker: Optional[str],
    insider: Optional[str],
    code: Optional[str],
    min_value: Optional[str],
    min_market_cap: Optional[str],
    show_sells: bool,
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
    if not show_sells:
        stmt = stmt.where(Transaction.acquired_disposed == "A")  # buys only
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
    show_sells: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    show = show_sells is not None
    rows = _query_transactions(
        ticker, insider, code, min_value, min_market_cap, show, limit
    )
    stats = _compute_stats(rows)
    with SessionLocal() as session:
        report = session.scalars(
            select(DailyReport).order_by(DailyReport.report_date.desc()).limit(1)
        ).first()
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "rows": rows,
            "stats": stats,
            "report": report,
            "money": _money,
            "bcap": _bcap,
            "filters": {
                "ticker": ticker or "",
                "insider": insider or "",
                "code": code or "",
                "min_value": min_value if min_value is not None else "",
                "min_market_cap": min_market_cap if min_market_cap is not None else "",
                "show_sells": show,
                "limit": limit,
            },
            "code_labels": CODE_LABELS,
        },
    )


@app.get("/api/transactions")
def api_transactions(
    ticker: Optional[str] = None,
    insider: Optional[str] = None,
    code: Optional[str] = None,
    min_value: Optional[str] = None,
    min_market_cap: Optional[str] = None,
    show_sells: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    rows = _query_transactions(
        ticker, insider, code, min_value, min_market_cap, show_sells is not None, limit
    )
    return JSONResponse([r.as_dict() for r in rows])
