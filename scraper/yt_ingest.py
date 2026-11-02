"""Track what finance YouTubers said today, for the /yt page.

Lists each channel in ``yt_channels.json``, stores videos published in the last
YT_LOOKBACK_DAYS, and asks Gemini to watch each new one and extract its market view
and stock calls. Gemini reads the public YouTube URL directly, so there is no
transcript scraping (which YouTube blocks from datacenter IPs).

Listing uses the YouTube Data API when YOUTUBE_API_KEY is set. Without it we fall
back to the keyless RSS feed, which intermittently returns 404/500 for live channels
(worse from datacenter IPs) — hence the retries.

Requires GEMINI_API_KEY for analysis. If unset, videos are stored but not analyzed,
and the page (which only shows analyzed videos) stays empty.

    python -m scraper.yt_ingest
"""
from __future__ import annotations

import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from dateutil import parser as dateparser
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db import SessionLocal, init_db
from app.models import YtVideo
from scraper.cn_ai_report import ENDPOINT, FALLBACK_MODELS, MODEL

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY")
CHANNELS_PATH = Path(__file__).with_name("yt_channels.json")

# `or` so an empty env value from CI falls back to the default too.
LOOKBACK_DAYS = int(os.environ.get("YT_LOOKBACK_DAYS") or 3)
# Gemini's free tier allows 8 hours of YouTube video a day. Newest go first, and
# anything over the cap is picked up by the next run.
MAX_VIDEOS = int(os.environ.get("YT_MAX_VIDEOS") or 8)
# Give up on a video after this many failures (private, members-only, a scheduled
# live that never aired…) so it can't hold a slot in every future run.
MAX_ATTEMPTS = 3
RSS_RETRIES = 4

STANCES = ("看多", "看空", "中性")
ATOM = "{http://www.w3.org/2005/Atom}"
YT_NS = "{http://www.youtube.com/xml/schemas/2015}"

_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "stance": {"type": "STRING"},
        "summary": {"type": "STRING"},
        "views": {"type": "STRING"},
        "stocks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "ticker": {"type": "STRING"},
                    "name": {"type": "STRING"},
                    "category": {"type": "STRING"},
                    "stance": {"type": "STRING"},
                    "price_note": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                },
                "required": ["ticker", "name", "category", "stance", "price_note", "reason"],
            },
        },
    },
    "required": ["stance", "summary", "views", "stocks"],
}

_INSTRUCTIONS = (
    "这是财经博主「{channel}」发布的视频，标题是「{title}」。请看完视频，"
    "提取博主本人表达的观点。全部内容用简体中文回答。\n"
    "只记录视频里实际说过的内容，不要补充你自己的判断，也不要根据标题猜测。"
    "没有讲到的内容不要写。\n"
    "- `stance`：博主对大盘的整体态度，必须恰好是 看多 / 看空 / 中性 三者之一。"
    "没有明确表态时选 中性。\n"
    "- `summary`：一句话概括这期视频的核心观点。\n"
    "- `views`：2-4 条要点，每行一个，以 '• ' 开头。\n"
    "- `stocks`：博主明确表达了看法的个股或 ETF。`ticker` 写股票代码（不确定就留空），"
    "`name` 写名称，`category` 写不超过 6 个字的标的类型（如 芯片龙头、云与AI龙头），"
    "`stance` 必须是 看多 / 看空 / 中性 之一，`reason` 用一句话写博主的核心理由。"
    "`price_note` 写博主实际说出的价位（如 现价204、199加仓、目标600、挂单315），"
    "没有说价位就留空，绝不要自己估算。"
    "只是顺带提到、没有表态的不要列。没有就返回空数组。"
)


def load_channels() -> list[dict]:
    return json.loads(CHANNELS_PATH.read_text(encoding="utf-8"))


def _video(channel: dict, video_id: str, title: str, published: str) -> dict:
    published_at = dateparser.parse(published)
    return {
        "video_id": video_id,
        "channel_id": channel["channel_id"],
        "channel_name": channel["name"],
        "title": title,
        "published_at": published_at.isoformat(),
        "publish_date": published_at.date().isoformat(),
    }


def parse_feed(xml: str, channel: dict) -> list[dict]:
    """Videos from a channel's Atom feed, without Shorts (too short to hold a view)."""
    videos = []
    for entry in ET.fromstring(xml).iter(f"{ATOM}entry"):
        link = entry.find(f"{ATOM}link")
        if link is not None and "/shorts/" in link.get("href", ""):
            continue
        videos.append(
            _video(
                channel,
                entry.findtext(f"{YT_NS}videoId"),
                entry.findtext(f"{ATOM}title") or "",
                entry.findtext(f"{ATOM}published"),
            )
        )
    return videos


def _fetch_rss(channel: dict) -> list[dict]:
    url = "https://www.youtube.com/feeds/videos.xml"
    last_exc = None
    for attempt in range(RSS_RETRIES):
        try:
            resp = requests.get(url, params={"channel_id": channel["channel_id"]}, timeout=30)
            resp.raise_for_status()
            return parse_feed(resp.text, channel)
        except requests.RequestException as e:
            last_exc = e
            time.sleep(2**attempt * 2)
    raise last_exc


def _fetch_api(channel: dict) -> list[dict]:
    # A channel's uploads live in a playlist derived from its id: UULF is long-form
    # videos only, UU is everything (used if the UULF playlist isn't available).
    tail = channel["channel_id"][2:]
    for prefix in ("UULF", "UU"):
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/playlistItems",
            params={
                "part": "snippet",
                "playlistId": prefix + tail,
                "maxResults": 15,
                "key": YOUTUBE_API_KEY,
            },
            timeout=30,
        )
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        return [
            _video(
                channel,
                item["snippet"]["resourceId"]["videoId"],
                item["snippet"]["title"],
                item["snippet"]["publishedAt"],
            )
            for item in resp.json().get("items", [])
        ]
    return []


def fetch_recent(channels: list[dict], today: date | None = None) -> list[dict]:
    """Videos from the lookback window. One failing channel doesn't stop the rest."""
    cutoff = ((today or date.today()) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    fetch = _fetch_api if YOUTUBE_API_KEY else _fetch_rss
    videos = []
    for channel in channels:
        try:
            found = fetch(channel)
        except requests.RequestException as e:
            print(f"{channel['name']}: listing failed ({e}).")
            continue
        recent = [v for v in found if v["publish_date"] >= cutoff]
        print(f"{channel['name']}: {len(recent)} recent video(s).")
        videos.extend(recent)
    return videos


def store_videos(videos: list[dict]) -> None:
    if not videos:
        return
    with SessionLocal() as session:
        for v in videos:
            session.execute(
                sqlite_insert(YtVideo)
                .values(**v, created_at=datetime.utcnow())
                .on_conflict_do_nothing(index_elements=["video_id"])
            )
        session.commit()


def pending_videos() -> list[YtVideo]:
    """Unanalyzed videos, newest first, capped to bound cost per run."""
    stmt = (
        select(YtVideo)
        .where(YtVideo.stance.is_(None), YtVideo.attempts < MAX_ATTEMPTS)
        .order_by(YtVideo.published_at.desc())
        .limit(MAX_VIDEOS)
    )
    with SessionLocal() as session:
        return list(session.scalars(stmt))


class QuotaExhausted(Exception):
    """Every model returned 429, so later videos would fail the same way."""


def _call_gemini(video: YtVideo) -> tuple[dict, str]:
    body = {
        "contents": [
            {
                "parts": [
                    {"fileData": {"fileUri": f"https://www.youtube.com/watch?v={video.video_id}"}},
                    {"text": _INSTRUCTIONS.format(channel=video.channel_name, title=video.title)},
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
            "temperature": 0.2,
            # Talking-head videos: the speech carries the content, not the pixels.
            "mediaResolution": "MEDIA_RESOLUTION_LOW",
        },
    }
    models = list(dict.fromkeys([MODEL] + FALLBACK_MODELS))
    last_status = None
    for model in models:
        for attempt in range(3):
            try:
                resp = requests.post(
                    ENDPOINT.format(model=model),
                    params={"key": GEMINI_API_KEY},
                    json=body,
                    timeout=600,
                )
            except (requests.Timeout, requests.ConnectionError):
                last_status = None
                time.sleep(2**attempt * 4)
                continue
            last_status = resp.status_code
            if resp.status_code in (429, 500, 503):
                time.sleep(2**attempt * 4)
                continue
            # Anything else (e.g. 400 for a private video) won't improve on retry.
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text), model
    if last_status == 429:
        raise QuotaExhausted()
    raise requests.RequestException(f"all models failed, last status {last_status}")


def clean_result(result: dict) -> dict:
    """Coerce model output to what the page expects; unknown stances become 中性."""
    stocks = [
        {
            "ticker": (s.get("ticker") or "").strip().upper(),
            "name": (s.get("name") or "").strip(),
            "category": (s.get("category") or "").strip(),
            "stance": s.get("stance") if s.get("stance") in STANCES else "中性",
            "price_note": (s.get("price_note") or "").strip(),
            "reason": (s.get("reason") or "").strip(),
        }
        for s in result.get("stocks") or []
        if s.get("ticker") or s.get("name")
    ]
    return {
        "stance": result.get("stance") if result.get("stance") in STANCES else "中性",
        "summary": (result.get("summary") or "").strip(),
        "views": (result.get("views") or "").strip(),
        "stocks": json.dumps(stocks, ensure_ascii=False),
    }


def analyze_pending() -> int:
    """Analyze queued videos; returns how many succeeded."""
    if not GEMINI_API_KEY:
        print("GEMINI_API_KEY not set; skipping video analysis.")
        return 0
    videos = pending_videos()
    print(f"Analyzing {len(videos)} video(s)…")
    done = 0
    for video in videos:
        video_id = video.video_id
        try:
            result, model = _call_gemini(video)
            values = {**clean_result(result), "model": model}
            done += 1
        except QuotaExhausted:
            # Not this video's fault, so it keeps its attempts for the next run.
            print("Gemini quota exhausted; the rest wait for the next run.")
            break
        except (requests.RequestException, ValueError, KeyError, IndexError) as e:
            print(f"{video_id}: analysis failed ({e}).")
            values = {"attempts": video.attempts + 1}
        with SessionLocal() as session:
            session.query(YtVideo).filter_by(video_id=video_id).update(values)
            session.commit()
    print(f"Analyzed {done}/{len(videos)} video(s).")
    return done


def main(argv: list[str]) -> None:
    init_db()
    store_videos(fetch_recent(load_channels()))
    analyze_pending()


if __name__ == "__main__":
    main(sys.argv[1:])
