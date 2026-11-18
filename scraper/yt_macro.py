"""Daily macro report condensed from finance YouTubers' views, for /yt/macro.

Each day's analyzed videos (see yt_ingest) go to Gemini as text — the per-video
stance, summary, key points and stock calls, not the videos themselves — and come
back as one report: the market call, the macro backdrop, sectors, where creators
agree and disagree, risks, and what to watch next. That keeps it cheap: one short
text call per day.

A day is regenerated whenever more of its videos have been analyzed since its
report was written, so uploads analyzed in a later run still make it in.

    python -m scraper.yt_macro               # recent days whose report is missing or stale
    python -m scraper.yt_macro 2026-11-16    # (re)build one day regardless

Requires GEMINI_API_KEY; without it nothing is generated.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta

import requests
from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import YtMacroReport, YtVideo
from scraper import yt_ingest

STANCES = yt_ingest.STANCES
# Days back (from today, UTC) whose reports are kept current. The ingest's own
# lookback is 3 days, so older days stop receiving videos anyway.
LOOKBACK_DAYS = int(os.environ.get("YT_MACRO_LOOKBACK_DAYS") or 3)

_LIST = {"type": "ARRAY", "items": {"type": "STRING"}}
_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "stance": {"type": "STRING"},
        "headline": {"type": "STRING"},
        "market": {"type": "STRING"},
        "macro": {"type": "STRING"},
        "sectors": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "stance": {"type": "STRING"},
                    "note": {"type": "STRING"},
                },
                "required": ["name", "stance", "note"],
            },
        },
        "consensus": _LIST,
        "divergence": _LIST,
        "risks": _LIST,
        "watch": _LIST,
    },
    "required": [
        "stance", "headline", "market", "macro", "sectors",
        "consensus", "divergence", "risks", "watch",
    ],
}

_INSTRUCTIONS = (
    "下面是 {day} 当天 {channels} 位财经博主发布的 {videos} 个视频的观点摘要"
    "（由 AI 从视频中提取）。请把它们汇总成一份当日宏观报告，全部用简体中文。\n"
    "只依据这些摘要，不要加入摘要里没有的信息、数据或你自己的判断。"
    "引用具体观点时写明是哪位博主（如「美投讲美股认为……」）。"
    "博主之间意见不一时如实写出分歧，不要强行统一。没有涉及的内容就留空或返回空数组。\n"
    "- `stance`：博主们对大盘的整体倾向，必须恰好是 看多 / 看空 / 中性 之一。\n"
    "- `headline`：一句话（不超过 40 字）概括当天博主们的核心判断。\n"
    "- `market`：大盘与指数（标普、纳指、道指、小盘股等）的观点，2-4 句。\n"
    "- `macro`：宏观与政策（美联储、利率、通胀、就业、财报季、财政、地缘、汇率、大宗商品等）"
    "的观点，2-4 句。\n"
    "- `sectors`：被讨论的板块或主题（如 AI 算力、半导体、能源），`stance` 为 看多 / 看空 / 中性，"
    "`note` 一句话写理由和提到它的博主。最多 8 个。\n"
    "- `consensus`：多数博主一致的看法，每条一句话，最多 5 条。\n"
    "- `divergence`：博主之间的主要分歧，每条写清谁持什么观点，最多 5 条。\n"
    "- `risks`：博主们提示的风险，最多 5 条。\n"
    "- `watch`：博主们提到接下来要关注的事件、数据或价位，最多 5 条。\n\n"
    "{digest}"
)


def _stock_line(s: dict) -> str:
    label = " ".join(x for x in (s.get("ticker"), s.get("name")) if x)
    price = f"（{s['price_note']}）" if s.get("price_note") else ""
    reason = f"：{s['reason']}" if s.get("reason") else ""
    return f"{label} {s.get('stance') or '中性'}{price}{reason}"


def build_digest(videos: list[YtVideo]) -> str:
    """The day's videos as plain text, one block per video."""
    blocks = []
    for v in videos:
        lines = [
            f"【{v.channel_name}】整体态度：{v.stance}",
            f"标题：{v.title}",
        ]
        if v.summary:
            lines.append(f"核心观点：{v.summary}")
        if v.views:
            lines.append(f"要点：\n{v.views}")
        try:
            stocks = json.loads(v.stocks or "[]")
        except ValueError:
            stocks = []
        if stocks:
            lines.append("个股：" + "；".join(_stock_line(s) for s in stocks))
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def clean_report(result: dict) -> dict:
    """Coerce model output to the shape the page reads; unknown stances become 中性."""

    def text(key: str) -> str:
        return str(result.get(key) or "").strip()

    def items(key: str) -> list[str]:
        return [str(x).strip() for x in result.get(key) or [] if str(x).strip()]

    sectors = [
        {
            "name": str(s.get("name") or "").strip(),
            "stance": s.get("stance") if s.get("stance") in STANCES else "中性",
            "note": str(s.get("note") or "").strip(),
        }
        for s in result.get("sectors") or []
        if isinstance(s, dict) and str(s.get("name") or "").strip()
    ]
    return {
        "stance": result.get("stance") if result.get("stance") in STANCES else "中性",
        "headline": text("headline"),
        "market": text("market"),
        "macro": text("macro"),
        "sectors": sectors,
        "consensus": items("consensus"),
        "divergence": items("divergence"),
        "risks": items("risks"),
        "watch": items("watch"),
    }


def analyzed_videos(day: str) -> list[YtVideo]:
    stmt = (
        select(YtVideo)
        .where(YtVideo.publish_date == day, YtVideo.stance.is_not(None))
        .order_by(YtVideo.published_at)
    )
    with SessionLocal() as session:
        return list(session.scalars(stmt))


def days_needing_report(today: date | None = None) -> list[str]:
    """Recent days with analyzed videos whose report is missing or built from fewer."""
    cutoff = ((today or date.today()) - timedelta(days=LOOKBACK_DAYS - 1)).isoformat()
    with SessionLocal() as session:
        counts = session.execute(
            select(YtVideo.publish_date, func.count())
            .where(YtVideo.stance.is_not(None), YtVideo.publish_date >= cutoff)
            .group_by(YtVideo.publish_date)
        ).all()
        built = dict(
            session.execute(
                select(YtMacroReport.report_date, YtMacroReport.video_count).where(
                    YtMacroReport.report_date >= cutoff
                )
            ).all()
        )
    return sorted(day for day, n in counts if built.get(day) != n)


def generate(day: str) -> bool:
    """Build and store `day`'s report; False when there is nothing to build it from."""
    videos = analyzed_videos(day)
    if not videos:
        print(f"{day}: no analyzed videos.")
        return False
    prompt = _INSTRUCTIONS.format(
        day=day,
        channels=len({v.channel_id for v in videos}),
        videos=len(videos),
        digest=build_digest(videos),
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
            "temperature": 0.3,
        },
    }
    result, model = yt_ingest.generate_json(body, timeout=180)
    report = clean_report(result)
    row = {
        "report_date": day,
        "stance": report.pop("stance"),
        "headline": report.pop("headline"),
        "content": json.dumps(report, ensure_ascii=False),
        "video_count": len(videos),
        "model": model,
        "created_at": datetime.utcnow(),
    }
    with SessionLocal() as session:
        session.merge(YtMacroReport(**row))
        session.commit()
    print(f"{day}: report built from {len(videos)} video(s) with {model}.")
    return True


def main(argv: list[str]) -> None:
    init_db()
    if not yt_ingest.GEMINI_API_KEY:
        print("GEMINI_API_KEY not set; skipping macro reports.")
        return
    days = argv or days_needing_report()
    if not days:
        print("Every recent macro report is up to date.")
        return
    failed = 0
    for day in days:
        try:
            generate(day)
        except yt_ingest.QuotaExhausted:
            # Usually spent by the video analysis just before; not a broken run.
            print("Gemini quota exhausted; remaining reports wait for the next run.")
            return
        except (requests.RequestException, ValueError, KeyError, IndexError) as e:
            print(f"{day}: report failed ({e}).")
            failed += 1
    if failed == len(days):
        sys.exit("No macro report could be built.")


if __name__ == "__main__":
    main(sys.argv[1:])
