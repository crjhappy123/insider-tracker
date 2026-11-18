"""YouTuber views: feed parsing, model-output cleanup, and the analysis queue."""
import json
from datetime import date

import pytest
import requests

from app.db import SessionLocal, init_db
from app.models import YtVideo
from scraper import yt_ingest

CHANNEL = {"name": "博主", "channel_id": "UCabc"}

FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns="http://www.w3.org/2005/Atom">
  <title>channel title, not a video</title>
  <entry>
    <yt:videoId>longvideo01</yt:videoId>
    <title>Market recap</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=longvideo01"/>
    <published>2026-10-31T19:30:12+00:00</published>
  </entry>
  <entry>
    <yt:videoId>shortclip01</yt:videoId>
    <title>A short</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/shortclip01"/>
    <published>2026-10-31T20:00:00+00:00</published>
  </entry>
</feed>"""


def _video(video_id, published_at="2026-10-31T19:30:12+00:00", **kw):
    return YtVideo(
        video_id=video_id, channel_id="UCabc", channel_name="博主", title="t",
        published_at=published_at, publish_date=published_at[:10], **kw,
    )


@pytest.fixture()
def empty_videos():
    init_db()
    with SessionLocal() as s:
        s.query(YtVideo).delete()
        s.commit()


def test_parse_feed_reads_videos_and_skips_shorts():
    videos = yt_ingest.parse_feed(FEED, CHANNEL)
    assert [v["video_id"] for v in videos] == ["longvideo01"]
    assert videos[0]["title"] == "Market recap"
    assert videos[0]["channel_name"] == "博主"
    assert videos[0]["publish_date"] == "2026-10-31"


def test_fetch_recent_survives_a_failing_channel_and_drops_old_videos(monkeypatch):
    def fake_rss(channel):
        if channel["name"] == "bad":
            raise requests.ConnectionError("404")
        return yt_ingest.parse_feed(FEED, channel)

    monkeypatch.setattr(yt_ingest, "_fetch_rss", fake_rss)
    monkeypatch.setattr(yt_ingest, "YOUTUBE_API_KEY", None)
    channels = [{"name": "bad", "channel_id": "UCbad"}, CHANNEL]

    videos, failed = yt_ingest.fetch_recent(channels, today=date(2026, 11, 1))
    assert len(videos) == 1
    assert failed == 1
    assert yt_ingest.fetch_recent(channels, today=date(2026, 12, 1)) == ([], 1)


class _FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        return self._payload


def test_fetch_api_falls_back_to_full_uploads_playlist(monkeypatch):
    playlists = []
    item = {
        "snippet": {
            "resourceId": {"videoId": "apivideo001"},
            "title": "API video",
            "publishedAt": "2026-10-31T19:30:12Z",
        }
    }

    def fake_get(url, params, timeout):
        playlists.append(params["playlistId"])
        if params["playlistId"].startswith("UULF"):
            return _FakeResponse(404)
        return _FakeResponse(200, {"items": [item]})

    monkeypatch.setattr(yt_ingest.requests, "get", fake_get)
    videos = yt_ingest._fetch_api(CHANNEL)
    assert playlists == ["UULFabc", "UUabc"]
    assert videos[0]["video_id"] == "apivideo001"
    assert videos[0]["publish_date"] == "2026-10-31"


def test_main_fails_when_every_channel_fails(empty_videos, monkeypatch):
    monkeypatch.setattr(yt_ingest, "load_channels", lambda: [CHANNEL])
    monkeypatch.setattr(yt_ingest, "fetch_recent", lambda channels: ([], 1))
    with pytest.raises(SystemExit):
        yt_ingest.main([])


def test_main_passes_on_a_quiet_day(empty_videos, monkeypatch):
    monkeypatch.setattr(yt_ingest, "load_channels", lambda: [CHANNEL])
    monkeypatch.setattr(yt_ingest, "fetch_recent", lambda channels: ([], 0))
    yt_ingest.main([])


def test_main_fails_when_nothing_could_be_analyzed(empty_videos, monkeypatch):
    videos = yt_ingest.parse_feed(FEED, CHANNEL)
    monkeypatch.setattr(yt_ingest, "load_channels", lambda: [CHANNEL])
    monkeypatch.setattr(yt_ingest, "fetch_recent", lambda channels: (videos, 0))
    monkeypatch.setattr(yt_ingest, "GEMINI_API_KEY", None)
    with pytest.raises(SystemExit):
        yt_ingest.main([])


def test_clean_result_coerces_bad_stances_and_drops_nameless_stocks():
    out = yt_ingest.clean_result(
        {
            "stance": "bullish",
            "summary": " s ",
            "views": "• v",
            "stocks": [
                {
                    "ticker": "nvda", "name": "英伟达", "category": "芯片龙头",
                    "stance": "看多", "price_note": " 199加仓 ", "reason": "r",
                },
                {"ticker": "tsla", "name": "", "stance": "???", "reason": ""},
                {"ticker": "", "name": "", "stance": "看多", "reason": "r"},
            ],
        }
    )
    assert out["stance"] == "中性"
    assert out["summary"] == "s"
    stocks = json.loads(out["stocks"])
    assert [(s["ticker"], s["stance"]) for s in stocks] == [("NVDA", "看多"), ("TSLA", "中性")]
    assert stocks[0]["price_note"] == "199加仓"
    assert stocks[1]["price_note"] == ""


def test_store_is_idempotent_and_keeps_existing_analysis(empty_videos):
    with SessionLocal() as s:
        s.add(_video("v1", stance="看多"))
        s.commit()
    yt_ingest.store_videos(yt_ingest.parse_feed(FEED, CHANNEL))
    yt_ingest.store_videos(
        [{**yt_ingest.parse_feed(FEED, CHANNEL)[0], "video_id": "v1"}]
    )
    with SessionLocal() as s:
        assert s.query(YtVideo).count() == 2
        assert s.get(YtVideo, "v1").stance == "看多"


def test_pending_is_newest_first_and_skips_analyzed_and_exhausted(empty_videos):
    with SessionLocal() as s:
        s.add_all(
            [
                _video("old", "2026-10-29T00:00:00+00:00"),
                _video("new", "2026-10-31T00:00:00+00:00"),
                _video("done", stance="中性"),
                _video("failed", attempts=yt_ingest.MAX_ATTEMPTS),
            ]
        )
        s.commit()
    assert [v.video_id for v in yt_ingest.pending_videos()] == ["new", "old"]


def test_failed_video_counts_an_attempt_but_quota_does_not(empty_videos, monkeypatch):
    with SessionLocal() as s:
        s.add_all(
            [
                _video("a", "2026-10-31T02:00:00+00:00"),
                _video("b", "2026-10-31T01:00:00+00:00"),
                _video("c", "2026-10-31T00:00:00+00:00"),
            ]
        )
        s.commit()

    def fake_call(video):
        if video.video_id == "a":
            raise requests.HTTPError("400")
        raise yt_ingest.QuotaExhausted()

    monkeypatch.setattr(yt_ingest, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(yt_ingest, "_call_gemini", fake_call)

    assert yt_ingest.analyze_pending() == 0
    with SessionLocal() as s:
        assert s.get(YtVideo, "a").attempts == 1
        assert s.get(YtVideo, "b").attempts == 0
        assert s.get(YtVideo, "c").attempts == 0


def test_channel_list_is_valid():
    channels = yt_ingest.load_channels()
    ids = [c["channel_id"] for c in channels]
    assert len(ids) == len(set(ids))
    assert all(i.startswith("UC") and len(i) == 24 for i in ids)
