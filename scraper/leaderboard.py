"""Maintain the durable AI leaderboard (run each pipeline cycle).

The `leaderboard` table is an accumulator that outlives the rolling prune window,
so it can back the quarterly and yearly boards. Each run it:

  1. Rolls up the currently-scored buys (ai_scores ⋈ transactions) into one entry
     per ticker: its best AI score, the date range it was seen, summed buy value.
  2. Inserts newly-picked tickers, stamping first_added_date + entry_price
     (Yahoo close on that date). Existing rows keep their first_added_date /
     entry_price; only last_seen_date, best_score, and total_value move forward.
  3. Refreshes current_price for EVERY tracked ticker (not just today's picks),
     so the "涨幅 since entry" stays live across the whole board.

Run against a DB that already holds the current transactions + ai_scores AND the
existing leaderboard rows (in CI, reconstructed from a D1 dump — see
.github/workflows/leaderboard.yml). Safe to re-run; it is idempotent.

    python -m scraper.leaderboard
"""
from __future__ import annotations

import sys
from datetime import datetime

from sqlalchemy import and_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import AiScore, Leaderboard, Transaction
from scraper.technicals import close_on, latest_close


def _current_picks() -> dict[str, dict]:
    """Roll up currently-scored buys into one dict per ticker key."""
    stmt = (
        select(
            Transaction.ticker,
            Transaction.company_name,
            Transaction.filing_date,
            Transaction.value,
            AiScore.score,
            AiScore.rating,
            AiScore.comment,
        )
        .join(
            AiScore,
            and_(
                AiScore.accession_no == Transaction.accession_no,
                AiScore.line_no == Transaction.line_no,
            ),
        )
        .where(AiScore.score.is_not(None))
    )
    picks: dict[str, dict] = {}
    with SessionLocal() as session:
        for ticker, name, fdate, value, score, rating, comment in session.execute(stmt):
            key = ticker or name
            if not key:
                continue
            fdate = fdate.isoformat() if hasattr(fdate, "isoformat") else str(fdate)
            p = picks.get(key)
            if p is None:
                p = picks[key] = {
                    "ticker": ticker or name,
                    "company_name": name,
                    "first": fdate,
                    "last": fdate,
                    "best_score": score,
                    "best_rating": rating,
                    "best_comment": comment,
                    "value": 0.0,
                }
            p["first"] = min(p["first"], fdate)
            p["last"] = max(p["last"], fdate)
            p["value"] += float(value or 0)
            if score is not None and (p["best_score"] is None or score > p["best_score"]):
                p["best_score"], p["best_rating"], p["best_comment"] = score, rating, comment
    return picks


def maintain() -> dict:
    """Upsert current picks, then refresh every tracked ticker's price."""
    init_db()
    picks = _current_picks()
    now = datetime.utcnow().isoformat(timespec="seconds")
    added = updated = 0

    with SessionLocal() as session:
        existing = {row.ticker: row for row in session.scalars(select(Leaderboard))}

        for key, p in picks.items():
            tk = p["ticker"]
            ex = existing.get(tk)
            if ex is None:
                # New pick: stamp the first-added date + entry price (set once).
                entry = close_on(tk, p["first"])
                session.execute(
                    sqlite_insert(Leaderboard).values(
                        ticker=tk,
                        company_name=p["company_name"],
                        first_added_date=p["first"],
                        last_seen_date=p["last"],
                        entry_price=entry,
                        best_score=p["best_score"],
                        best_rating=p["best_rating"],
                        best_comment=p["best_comment"],
                        total_value=p["value"],
                        updated_at=datetime.utcnow(),
                    )
                )
                added += 1
            else:
                # Existing: preserve first_added_date/entry_price; move the rest forward.
                ex.company_name = p["company_name"] or ex.company_name
                ex.last_seen_date = max(ex.last_seen_date or "", p["last"])
                ex.total_value = max(ex.total_value or 0, p["value"])
                if p["best_score"] is not None and (
                    ex.best_score is None or p["best_score"] > ex.best_score
                ):
                    ex.best_score = p["best_score"]
                    ex.best_rating = p["best_rating"]
                    ex.best_comment = p["best_comment"]
                # Backfill entry price if a past run couldn't fetch it.
                if ex.entry_price is None and ex.first_added_date:
                    ex.entry_price = close_on(tk, ex.first_added_date)
                ex.updated_at = datetime.utcnow()
                updated += 1

        session.commit()

        # Refresh current price for EVERY tracked ticker (keeps老成员的涨幅 live).
        priced = 0
        rows = list(session.scalars(select(Leaderboard)))
        for row in rows:
            px = latest_close(row.ticker)
            if px is not None:
                row.current_price = px
                row.price_updated_at = now
                priced += 1
        session.commit()

    return {"added": added, "updated": updated, "priced": priced, "total": len(existing) + added}


if __name__ == "__main__":
    # Positional date arg accepted for symmetry with the other scrapers; unused
    # (the leaderboard is derived from whatever scored buys are present).
    _ = sys.argv[1:]
    result = maintain()
    print(
        f"Leaderboard: {result['added']} added, {result['updated']} updated, "
        f"{result['priced']} priced ({result['total']} total)."
    )
