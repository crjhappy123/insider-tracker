"""Generate the A-share AI daily report + per-record scores with Google Gemini.

The A-share mirror of ``scraper.ai_report``: picks the notable 董监高 增持 records
that don't have a score yet, asks Gemini for a 0-100 conviction score plus a
four-section Chinese comment per pick and a short daily summary, and stores both in
``cn_ai_scores`` / ``cn_daily_reports``.

Unlike the US side it scores a *window* (CN_AI_LOOKBACK_DAYS, default 7) instead of
one 变动日期: A-share disclosures keep landing on days already past, so anything
scoped to the freshest day alone would leave most records unscored forever.

Requires GEMINI_API_KEY. If unset, generate() is a no-op (pipeline still succeeds).
Model is configurable via GEMINI_MODEL.

    python -m scraper.cn_ai_report 2026-09-04
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import date, datetime, timedelta

import requests
from dateutil import parser as dateparser
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import CnAiScore, CnCompany, CnDailyReport, CnTransaction
from scraper.cn_eastmoney import get_technicals
from scraper.prune import cutoff_date

API_KEY = os.environ.get("GEMINI_API_KEY")
# `or` (not a default arg) so an empty env value from CI falls back too.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.7-flash"
# Try these in order when the primary model is overloaded (503).
FALLBACK_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-flash-latest",
]
# Score 增持 records at companies at/above this 总市值. ¥50亿 matches the /cn page's
# MIN_DISPLAY_MKTCAP, so everything the page actually shows is eligible for a score
# (a higher floor here would silently leave visible rows unscored forever).
MIN_SCORE_MKTCAP = float(os.environ.get("CN_AI_MIN_MARKET_CAP") or 5_000_000_000)  # ¥50亿
MAX_PICKS = int(os.environ.get("CN_AI_MAX_PICKS") or 40)  # hard cap to bound cost
# How far back to look for still-unscored records. A-share insiders disclose within
# 2 trading days and 东方财富 keeps adding records to an already-past 变动日期, so
# scoring only the freshest day would permanently miss the late arrivals. Defaults to
# the prune retention window: every record we still store gets scored exactly once.
LOOKBACK_DAYS = int(os.environ.get("CN_AI_LOOKBACK_DAYS") or 7)
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
                    # Four separate analysis sections, each a bullet list.
                    "fundamental": {"type": "STRING"},
                    "technical": {"type": "STRING"},
                    "capital": {"type": "STRING"},
                    "summary": {"type": "STRING"},
                },
                "required": [
                    "id", "score", "rating",
                    "fundamental", "technical", "capital", "summary",
                ],
            },
        },
    },
    "required": ["report", "picks"],
}

_INSTRUCTIONS = (
    "以下是中国 A 股上市公司的董监高（董事、监事、高级管理人员）在二级市场"
    "增持自家股票的公开披露记录。你是一名基本面股票分析师。全部内容用简体中文回答。\n"
    "为每一家公司给出一个 0-100 的 `score`，衡量该公司的【投资吸引力】，"
    "且只能基于【基本面】与【行业景气度】（估值、营收/利润增速、盈利能力与毛利率、"
    "资产负债表健康度、护城河、行业前景）。不要让增持这一行为本身、增持金额大小、"
    "或增持人的职务影响评分。若对该公司了解不足，请保守打分并明确说明。"
    "`rating` 必须恰好是 强 / 中等 / 弱 三者之一。\n"
    "然后写四个独立段落。每段必须是要点形式——每行一个要点，以 '• ' 开头，"
    "每段控制在 2-3 条：\n"
    "- `fundamental` 基本面：估值、增长、利润率、资产负债表、护城河、行业前景"
    "（这是评分的唯一依据）。\n"
    "- `technical` 技术面：解读给出的 `technicals` —— 股价与 50/200 日均线的关系、"
    "在 52 周区间中的位置、近 1 个月/3 个月动量。若技术数据缺失，写 数据缺失。\n"
    "- `capital` 资金面：把这次董监高增持当作资金流信号来解读 —— 增持金额"
    "（`buy_value`）、增持人职务（`insider_title`）、增持途径（`change_reason`）、"
    "以及近期动量。仅作为背景与时点参考，不计入评分。\n"
    "- `summary` 总结：1-2 条要点，给出整体判断和最主要的风险。\n"
    "最后写 `report`：一段 1-2 句的中文导语，概括这批记录中基本面最扎实的几只标的"
    "（这批记录可能跨越多个交易日，见每条的 `change_date`）。\n"
    "注意 A 股特有背景：注意区分主板/创业板/科创板/北交所的估值体系差异，"
    "对 ST 股、高估值小盘股保持谨慎。仅供参考，非投资建议。"
)


def _format_comment(p: dict) -> str:
    """Assemble the four returned sections into one labeled, bulleted comment."""
    sections = [
        ("基本面", p.get("fundamental")),
        ("技术面", p.get("technical")),
        ("资金面", p.get("capital")),
        ("总结", p.get("summary")),
    ]
    blocks = [
        f"【{title}】\n{body.strip()}"
        for title, body in sections
        if body and body.strip()
    ]
    return "\n\n".join(blocks)


def _pending_buys(day: date, lookback: int = LOOKBACK_DAYS) -> tuple[list[dict], dict]:
    """Still-unscored 增持 records in the `lookback`-day window ending on `day`.

    Scoped to a window rather than a single 变动日期, and to records that have no
    score yet, because both reasons a record can miss its own day are permanent
    otherwise: 东方财富 keeps adding late disclosures to a past 变动日期, and a
    company whose 总市值 quote failed during that day's run only becomes eligible
    once ``refresh_caps`` heals it. Returns (items, skip counts for logging).
    """
    # Never score below the prune cutoff: `day` is the freshest 变动日期, which can
    # be a day behind today, so a plain lookback would reach records the prune step
    # deletes minutes later in the same run.
    start = max(day - timedelta(days=max(lookback, 1) - 1), cutoff_date())
    eff_mktcap = func.coalesce(CnCompany.market_cap, CnTransaction.market_cap)
    unscored = ~(
        select(CnAiScore.change_id)
        .where(CnAiScore.change_id == CnTransaction.change_id)
        .exists()
    )
    stmt = (
        select(CnTransaction, eff_mktcap)
        .outerjoin(CnCompany, CnCompany.code == CnTransaction.code)
        .where(CnTransaction.change_date.between(start, day))
        .where(unscored)
    )

    eligible, skipped = [], {"unknown_cap": 0, "below_floor": 0}
    with SessionLocal() as session:
        for t, mktcap in session.execute(stmt):
            if mktcap is None:
                # Hidden on the page too (it filters on the same COALESCE), so
                # don't pay for a score; the next successful quote makes it eligible.
                skipped["unknown_cap"] += 1
                continue
            if mktcap < MIN_SCORE_MKTCAP:
                skipped["below_floor"] += 1
                continue
            eligible.append(
                {
                    "id": t.change_id,
                    "code": t.code,
                    "company": t.company_name,
                    "exchange": t.exchange,
                    "market_cap": mktcap,
                    "change_date": t.change_date,
                    # 增持 context for the 资金面 (capital-flow) section.
                    "buy_value": t.value,
                    "insider_title": t.insider_title,
                    "change_reason": t.change_reason,
                }
            )

    # Freshest day first, then biggest 增持 — MAX_PICKS truncates the tail, so the
    # records most worth scoring survive. Technicals cost a request each, so they
    # are fetched only for the records that actually go to the model.
    eligible.sort(key=lambda i: (str(i["change_date"]), i["buy_value"] or 0), reverse=True)
    items = eligible[:MAX_PICKS]
    skipped["over_cap"] = len(eligible) - len(items)
    for i in items:
        i["change_date"] = str(i["change_date"])
        i["technicals"] = get_technicals(i["code"], i["exchange"])
    return items, skipped


def _call_gemini(items: list[dict]) -> tuple[dict, str]:
    prompt = (
        _INSTRUCTIONS
        + "\n\n增持记录 (JSON):\n"
        + json.dumps(items, ensure_ascii=False, default=str)
        + "\n\n每一条记录的 id 都要返回一个对应的评分对象。"
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
                time.sleep(2**attempt * 4)
                continue
            if resp.status_code in (429, 500, 503):
                last_exc = requests.HTTPError(f"{resp.status_code} from {model}")
                time.sleep(2**attempt * 4)  # 4s, 8s, 16s
                continue
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text), model
    raise last_exc


def generate(day: date, lookback: int = LOOKBACK_DAYS) -> int:
    """Score every unscored 增持 in the window ending on `day`; store the report.

    `day` also dates the daily report row. Returns the number of picks scored.
    """
    if not API_KEY:
        print("GEMINI_API_KEY not set; skipping A-share AI report.")
        return 0

    init_db()
    items, skipped = _pending_buys(day, lookback)
    if skipped["unknown_cap"]:
        print(
            f"{skipped['unknown_cap']} unscored record(s) have no 总市值 "
            "(quote lookup failed?); they stay unscored until it is known."
        )
    if skipped["below_floor"] or skipped["over_cap"]:
        print(
            f"skipped {skipped['below_floor']} below ¥{MIN_SCORE_MKTCAP / 1e8:.0f}亿"
            f" and deferred {skipped['over_cap']} over the {MAX_PICKS}-pick cap."
        )
    if not items:
        print(f"{day}: no unscored A-share 增持 to score in the last {lookback} day(s).")
        return 0
    print(f"{day}: scoring {len(items)} unscored record(s) from the last {lookback} day(s)…")

    try:
        result, used_model = _call_gemini(items)
    except (requests.HTTPError, requests.RequestException, ValueError, KeyError) as e:
        # Don't fail the pipeline on a transient AI outage; skip today's report.
        print(f"{day}: A-share AI report skipped ({e}).")
        return 0
    # Keep only ids we actually sent: a hallucinated id would land as an orphan
    # score row that no 增持 record ever joins to.
    sent = {i["id"] for i in items}
    by_id = {p["id"]: p for p in result.get("picks", []) if p.get("id") in sent}
    if len(by_id) < len(items):
        # Not fatal: the misses have no score row, so the next run retries them.
        print(f"model returned {len(by_id)}/{len(items)} picks; the rest retry next run.")

    with SessionLocal() as session:
        session.execute(
            sqlite_insert(CnDailyReport)
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
        for change_id, p in by_id.items():
            comment = _format_comment(p)
            session.execute(
                sqlite_insert(CnAiScore)
                .values(
                    change_id=str(change_id),
                    score=p.get("score"),
                    rating=p.get("rating"),
                    comment=comment,
                    created_at=datetime.utcnow(),
                )
                .on_conflict_do_update(
                    index_elements=["change_id"],
                    set_={
                        "score": p.get("score"),
                        "rating": p.get("rating"),
                        "comment": comment,
                    },
                )
            )
        session.commit()
    print(f"{day}: scored {len(by_id)} A-share picks; report stored.")
    return len(by_id)


def main(argv: list[str]) -> None:
    """``python -m scraper.cn_ai_report [YYYY-MM-DD] [lookback_days]``."""
    day = dateparser.parse(argv[0]).date() if argv else date.today()
    lookback = int(argv[1]) if len(argv) > 1 else LOOKBACK_DAYS
    generate(day, lookback)


if __name__ == "__main__":
    main(sys.argv[1:])
