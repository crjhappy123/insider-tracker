"""Daily batch ingestion of A-share 董监高增持 records.

The A-share mirror of ``scraper.ingest``: fetch a day's 董监高持股变动明细 from
东方财富, keep only the 增持 (net-buy) rows, attach each company's live 总市值,
and upsert into ``cn_transactions`` / ``cn_companies``.

    python -m scraper.cn_ingest                 # today
    python -m scraper.cn_ingest 2026-09-03      # one day
    python -m scraper.cn_ingest 2026-09-01 2026-09-05   # inclusive range

Re-running a day is idempotent (deduped on 东方财富's GGEID).
No records are published on weekends/holidays — those days ingest 0 rows.
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

from dateutil import parser as dateparser
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import CnCompany, CnTransaction
from scraper.cn_eastmoney import exchange_of, holding_changes, quotes

# Skip companies below this 总市值. 0 disables the filter. ¥10亿 by default —
# below the page's ¥50亿 display floor, so the filter can be raised later without
# a re-ingest.
MIN_MARKET_CAP = float(os.environ.get("CN_MIN_MARKET_CAP", "1000000000"))  # ¥10亿

# Only count 二级市场 purchases as signal. 竞价交易 / 集中竞价 are open-market;
# 大宗交易 (block trades) and 协议转让 are negotiated, so they carry much less
# information about the insider's view. Set CN_INGEST_REASONS="" to keep all.
_DEFAULT_REASONS = "竞价交易,集中竞价,二级市场买卖,集中竞价交易"
INGEST_REASONS = {
    r.strip()
    for r in os.environ.get("CN_INGEST_REASONS", _DEFAULT_REASONS).split(",")
    if r.strip()
}


def _iso_date(raw: str | None) -> str | None:
    """"2026-09-07 00:00:00" -> "2026-09-07"."""
    if not raw:
        return None
    return str(raw)[:10]


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) else None


def _dedupe_key(r: dict) -> tuple:
    """Identity of a real-world 增持, independent of 东方财富's record id.

    东方财富 emits one record per (变动人, 关联董监高) pair, so a single purchase by
    an entity tied to two officers — e.g. a holding company that is both 董事长 and
    董事/副总裁 — arrives twice with different GGEIDs. Left as-is that double-counts
    增持总额 and the leaderboard's 增持额, so we collapse them.
    """
    return (r["change_date"], r["code"], r["insider_name"], r["shares"], r["price"], r["change_reason"])


def _collapse_duplicates(rows: list[dict]) -> list[dict]:
    """Keep one row per _dedupe_key, merging the 职务 of the collapsed records."""
    merged: dict[tuple, dict] = {}
    for r in sorted(rows, key=lambda x: x["change_id"]):  # stable across re-runs
        key = _dedupe_key(r)
        kept = merged.get(key)
        if kept is None:
            merged[key] = r
            continue
        titles = [t for t in (kept["insider_title"], r["insider_title"]) if t]
        # Preserve every disclosed 职务 — that's the only information the dropped
        # record carried, and the AI uses it for the 资金面 read.
        kept["insider_title"] = " / ".join(dict.fromkeys(titles)) or None
    return list(merged.values())


def _buy_rows(day: date) -> list[dict]:
    """The day's 增持 records, normalised to our column names and deduplicated."""
    rows = []
    for rec in holding_changes(day):
        shares = _num(rec.get("CHANGE_SHARES"))
        if not shares or shares <= 0:
            continue  # 减持 or a zero-share correction
        reason = rec.get("CHANGE_REASON")
        if INGEST_REASONS and reason not in INGEST_REASONS:
            continue
        code = rec.get("SECURITY_CODE")
        change_id = rec.get("GGEID")
        if not code or change_id is None:
            continue
        # CHANGE_AMOUNT is signed like CHANGE_SHARES; these are buys, so take abs.
        value = _num(rec.get("CHANGE_AMOUNT"))
        rows.append(
            {
                "change_id": str(change_id),
                "change_date": _iso_date(rec.get("CHANGE_DATE")) or day.isoformat(),
                "code": code,
                "exchange": exchange_of(rec.get("DERIVE_SECURITY_CODE"), code),
                "company_name": rec.get("SECURITY_NAME") or code,
                "insider_name": rec.get("PERSON_NAME") or rec.get("DSE_PERSON_NAME") or "—",
                "insider_title": rec.get("POSITION_NAME"),
                "relation": rec.get("PERSON_DSE_RELATION"),
                "change_reason": reason,
                "shares": shares,
                "price": _num(rec.get("AVERAGE_PRICE")),
                "value": abs(value) if value is not None else None,
                "shares_owned_after": _num(rec.get("CHANGE_AFTER_HOLDNUM")),
                "change_ratio": _num(rec.get("CHANGE_RATIO")),
            }
        )
    return _collapse_duplicates(rows)


def ingest_day(day: date) -> int:
    """Ingest one day; returns the number of new 增持 rows written.

    Rows whose company 总市值 is below MIN_MARKET_CAP are skipped. Companies whose
    cap can't be fetched (suspended/delisted) are kept with market_cap = NULL and
    render as "—", matching the US side's treatment of unknown caps.
    """
    init_db()
    rows = _buy_rows(day)
    if not rows:
        return 0

    # One batched quote request covers the whole day.
    caps = quotes([(r["code"], r["exchange"]) for r in rows])

    count = 0
    with SessionLocal() as session:
        _upsert_companies(session, caps, {r["code"]: r["exchange"] for r in rows})

        for r in rows:
            mktcap = (caps.get(r["code"]) or {}).get("market_cap")
            # Drop known small caps; keep unknowns (mktcap is None).
            if mktcap is not None and MIN_MARKET_CAP > 0 and mktcap < MIN_MARKET_CAP:
                continue
            stmt = (
                sqlite_insert(CnTransaction)
                .values(
                    change_date=dateparser.parse(r["change_date"]).date(),
                    market_cap=mktcap,
                    **{k: v for k, v in r.items() if k != "change_date"},
                )
                # No index_elements: skip on EITHER conflict — the GGEID primary
                # key (re-running a day) or uq_cn_change (a duplicate already
                # stored under a different GGEID by an earlier run).
                .on_conflict_do_nothing()
            )
            count += session.execute(stmt).rowcount or 0
        session.commit()
    return count


def _upsert_companies(session, caps: dict[str, dict], exchanges: dict[str, str | None]) -> None:
    """Upsert one cn_companies row per quoted code (live 总市值 snapshot)."""
    for code, q in caps.items():
        session.execute(
            sqlite_insert(CnCompany)
            .values(
                code=code,
                name=q["name"],
                exchange=exchanges.get(code),
                last_price=q["last_price"],
                market_cap=q["market_cap"],
                float_market_cap=q["float_market_cap"],
            )
            .on_conflict_do_update(
                index_elements=["code"],
                set_={
                    "name": q["name"],
                    "last_price": q["last_price"],
                    "market_cap": q["market_cap"],
                    "float_market_cap": q["float_market_cap"],
                },
            )
        )


def refresh_caps() -> int:
    """Re-quote every code in cn_transactions and refresh cn_companies.

    Both a freshness step (市值 moves daily) and a self-heal: the page reads
    ``COALESCE(cn_companies.market_cap, cn_transactions.market_cap)``, so a row
    whose cap was missed at ingest (transient 502) starts showing a cap as soon
    as its company is quoted successfully here. Returns companies refreshed.
    """
    init_db()
    with SessionLocal() as session:
        pairs = [
            (code, exchange)
            for code, exchange in session.execute(
                CnTransaction.__table__.select()
                .with_only_columns(CnTransaction.code, CnTransaction.exchange)
                .distinct()
            )
        ]
        if not pairs:
            return 0
        caps = quotes(pairs)
        _upsert_companies(session, caps, dict(pairs))
        session.commit()
    return len(caps)


def _parse_arg_date(s: str) -> date:
    return dateparser.parse(s).date()


def main(argv: list[str]) -> None:
    if len(argv) == 0:
        days = [date.today()]
    elif len(argv) == 1:
        days = [_parse_arg_date(argv[0])]
    else:
        start, end = _parse_arg_date(argv[0]), _parse_arg_date(argv[1])
        days = [start + timedelta(d) for d in range((end - start).days + 1)]

    total = 0
    for day in days:
        n = ingest_day(day)
        total += n
        print(f"{day}: ingested {n} A-share 增持 records")
    # Refresh every tracked company's 市值 last, so caps missed above self-heal.
    print(f"Refreshed 市值 for {refresh_caps()} companies.")
    print(f"Done. {total} new records across {len(days)} day(s).")


if __name__ == "__main__":
    main(sys.argv[1:])
