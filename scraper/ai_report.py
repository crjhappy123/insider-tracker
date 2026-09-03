"""Generate an AI daily report + per-transaction scores with Google Gemini.

Runs once per day in the pipeline (never per web request). It picks the day's
most notable insider BUYS, asks Gemini for a conviction score + one-line comment
per pick and a short daily buy-opinion report, and stores both in the DB.

Requires GEMINI_API_KEY. If unset, generate() is a no-op (pipeline still succeeds).
Model is configurable via GEMINI_MODEL (default gemini-3.6-flash).

    python -m scraper.ai_report 2026-09-02
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime

import requests
from dateutil import parser as dateparser
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import AiScore, Company, DailyReport, Transaction

API_KEY = os.environ.get("GEMINI_API_KEY")
# `or` (not a default arg) so an empty env value from CI falls back too.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.6-flash"
TOP_N = int(os.environ.get("AI_TOP_N", "15"))
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "report": {"type": "STRING"},
        "picks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "score": {"type": "INTEGER"},
                    "rating": {"type": "STRING"},
                    "comment": {"type": "STRING"},
                },
                "required": ["id", "score", "rating", "comment"],
            },
        },
    },
    "required": ["report", "picks"],
}

_INSTRUCTIONS = (
    "You are an equity analyst reviewing U.S. insider open-market purchases "
    "(SEC Form 4). For each transaction give a 0-100 conviction score and a "
    "one-sentence rationale. Weigh: buy size vs. company market cap, the "
    "insider's role (CEO/CFO/Director/10% owner carry more signal), whether it "
    "is a true open-market purchase (code P) vs. a grant/award, and clustering "
    "of buyers. rating must be one of Strong/Moderate/Weak. Then write a concise "
    "(3-5 sentence) daily report highlighting the most compelling buys and any "
    "themes. This is informational only, not financial advice."
)


def _notable_buys(day: date) -> list[dict]:
    """Top-N buys for the day by dollar value, with effective market cap."""
    eff_mktcap = func.coalesce(Company.market_cap, Transaction.market_cap)
    stmt = (
        select(Transaction, eff_mktcap)
        .outerjoin(Company, Company.cik == Transaction.issuer_cik)
        .where(Transaction.filing_date == day)
        .where(Transaction.acquired_disposed == "A")
        .order_by(Transaction.value.desc().nullslast())
        .limit(TOP_N)
    )
    items = []
    with SessionLocal() as session:
        for t, mktcap in session.execute(stmt):
            items.append(
                {
                    "id": f"{t.accession_no}:{t.line_no}",
                    "ticker": t.ticker,
                    "company": t.company_name,
                    "insider": t.insider_name,
                    "title": t.insider_title,
                    "code": t.transaction_code,
                    "shares": t.shares,
                    "price": t.price,
                    "value": t.value,
                    "market_cap": mktcap,
                }
            )
    return items


def _call_gemini(items: list[dict]) -> dict:
    prompt = (
        _INSTRUCTIONS
        + "\n\nTransactions (JSON):\n"
        + json.dumps(items, default=str)
        + "\n\nReturn one score object per transaction id."
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
            "temperature": 0.4,
        },
    }
    resp = requests.post(
        ENDPOINT.format(model=MODEL),
        params={"key": API_KEY},
        json=body,
        timeout=120,
    )
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def generate(day: date) -> int:
    """Generate + store the report and scores for `day`. Returns picks scored."""
    if not API_KEY:
        print("GEMINI_API_KEY not set; skipping AI report.")
        return 0

    init_db()
    items = _notable_buys(day)
    if not items:
        print(f"{day}: no buys to score.")
        return 0

    result = _call_gemini(items)
    # Map returned scores back to (accession_no, line_no) via the id we passed in.
    by_id = {p["id"]: p for p in result.get("picks", [])}

    with SessionLocal() as session:
        session.execute(
            sqlite_insert(DailyReport)
            .values(
                report_date=day.isoformat(),
                summary=result.get("report", ""),
                model=MODEL,
                created_at=datetime.utcnow(),
            )
            .on_conflict_do_update(
                index_elements=["report_date"],
                set_={"summary": result.get("report", ""), "model": MODEL},
            )
        )
        for pid, p in by_id.items():
            accession, _, line = pid.rpartition(":")
            if not accession:
                continue
            session.execute(
                sqlite_insert(AiScore)
                .values(
                    accession_no=accession,
                    line_no=int(line),
                    score=p.get("score"),
                    rating=p.get("rating"),
                    comment=p.get("comment"),
                    created_at=datetime.utcnow(),
                )
                .on_conflict_do_update(
                    index_elements=["accession_no", "line_no"],
                    set_={
                        "score": p.get("score"),
                        "rating": p.get("rating"),
                        "comment": p.get("comment"),
                    },
                )
            )
        session.commit()
    print(f"{day}: scored {len(by_id)} picks; report stored.")
    return len(by_id)


def main(argv: list[str]) -> None:
    day = dateparser.parse(argv[0]).date() if argv else date.today()
    generate(day)


if __name__ == "__main__":
    main(sys.argv[1:])
