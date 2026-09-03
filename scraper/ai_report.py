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
import time
from datetime import date, datetime

import requests
from dateutil import parser as dateparser
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import AiScore, Company, DailyReport, Transaction
from scraper.technicals import get_technicals

API_KEY = os.environ.get("GEMINI_API_KEY")
# `or` (not a default arg) so an empty env value from CI falls back too.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.7-flash"
# Try these in order when the primary model is overloaded (503). Gemini models
# get transiently overloaded, so falling back keeps the daily report flowing.
FALLBACK_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-flash-latest",
]
# Score every open-market purchase (code P) in a company at/above this market cap.
MIN_SCORE_MKTCAP = float(os.environ.get("AI_MIN_MARKET_CAP", "5000000000"))  # $5B
MAX_PICKS = int(os.environ.get("AI_MAX_PICKS", "60"))  # hard cap to bound cost
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
    "You are an equity analyst reviewing U.S. insider OPEN-MARKET PURCHASES "
    "(SEC Form 4, transaction code P). Respond in SIMPLIFIED CHINESE (简体中文) "
    "for the `report` and every `comment`. For EACH transaction:\n"
    "- Give a 0-100 conviction score and a `rating` that is exactly one of "
    "强 / 中等 / 弱.\n"
    "- Write a DETAILED `comment` of 2-3 Chinese sentences that combines the "
    "insider signal (buy size vs. market cap, the insider's role, buyer "
    "clustering) WITH the stock's TECHNICAL posture from the provided "
    "`technicals` (price vs. 50/200-day moving averages, distance from 52-week "
    "high/low, 1M/3M momentum). Name the concrete technical read, e.g. "
    "『股价跌破200日均线，近3个月下跌18%，内部人逆势买入』。\n"
    "Then write `report`: a SHORT 1-2 sentence Chinese overall intro to the day "
    "only (per-company detail belongs in each comment, not here).\n"
    "仅供参考，非投资建议。"
)


def _scored_buys(day: date) -> list[dict]:
    """Open-market purchases (code P) at companies >= MIN_SCORE_MKTCAP for the day.

    Each item is enriched with technical indicators for the AI to reason about.
    """
    eff_mktcap = func.coalesce(Company.market_cap, Transaction.market_cap)
    stmt = (
        select(Transaction, eff_mktcap)
        .outerjoin(Company, Company.cik == Transaction.issuer_cik)
        .where(Transaction.filing_date == day)
        .where(Transaction.transaction_code == "P")
        .where(eff_mktcap >= MIN_SCORE_MKTCAP)
        .order_by(Transaction.value.desc().nullslast())
        .limit(MAX_PICKS)
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
                    "shares": t.shares,
                    "price": t.price,
                    "value": t.value,
                    "market_cap": mktcap,
                    "technicals": get_technicals(t.ticker),
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
    # Try each model with a short backoff; move to the next on overload/timeout.
    models = list(dict.fromkeys([MODEL] + FALLBACK_MODELS))  # primary first, deduped
    last_exc = None
    for model in models:
        for attempt in range(3):
            try:
                resp = requests.post(
                    ENDPOINT.format(model=model),
                    params={"key": API_KEY},
                    json=body,
                    timeout=300,
                )
            except (requests.Timeout, requests.ConnectionError) as e:
                last_exc = e
                time.sleep(2 ** attempt * 4)
                continue
            if resp.status_code in (429, 500, 503):
                last_exc = requests.HTTPError(f"{resp.status_code} from {model}")
                time.sleep(2 ** attempt * 4)  # 4s, 8s, 16s
                continue
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text), model
    raise last_exc


def generate(day: date) -> int:
    """Generate + store the report and scores for `day`. Returns picks scored."""
    if not API_KEY:
        print("GEMINI_API_KEY not set; skipping AI report.")
        return 0

    init_db()
    items = _scored_buys(day)
    if not items:
        print(f"{day}: no code-P buys >= threshold to score.")
        return 0

    try:
        result, used_model = _call_gemini(items)
    except (requests.HTTPError, requests.RequestException, ValueError, KeyError) as e:
        # Don't fail the pipeline on a transient AI outage; skip today's report.
        print(f"{day}: AI report skipped ({e}).")
        return 0
    # Map returned scores back to (accession_no, line_no) via the id we passed in.
    by_id = {p["id"]: p for p in result.get("picks", [])}

    with SessionLocal() as session:
        session.execute(
            sqlite_insert(DailyReport)
            .values(
                report_date=day.isoformat(),
                summary=result.get("report", ""),
                model=used_model,
                created_at=datetime.utcnow(),
            )
            .on_conflict_do_update(
                index_elements=["report_date"],
                set_={"summary": result.get("report", ""), "model": used_model},
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
