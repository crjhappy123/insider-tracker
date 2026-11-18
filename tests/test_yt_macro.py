"""Macro report: which days need (re)building, the digest sent, and output cleanup."""
import json
from datetime import date

import pytest

from app.db import SessionLocal, init_db
from app.models import YtMacroReport, YtVideo
from scraper import yt_ingest, yt_macro


def _video(video_id, day, stance="看多", channel="UCa", **kw):
    return YtVideo(
        video_id=video_id, channel_id=channel, channel_name=f"博主{channel[-1]}",
        title=f"标题 {video_id}", published_at=f"{day}T12:00:00+00:00",
        publish_date=day, stance=stance, **kw,
    )


@pytest.fixture()
def empty_db():
    init_db()
    with SessionLocal() as s:
        s.query(YtVideo).delete()
        s.query(YtMacroReport).delete()
        s.commit()


def test_days_needing_report_skips_up_to_date_and_old_days(empty_db):
    with SessionLocal() as s:
        s.add_all(
            [
                _video("a", "2026-11-16"),
                _video("b", "2026-11-16", channel="UCb"),
                _video("c", "2026-11-17"),
                _video("pending", "2026-11-17", stance=None),  # not analyzed yet
                _video("old", "2026-11-01"),
            ]
        )
        # 11-16 already has a report built from both its videos.
        s.add(YtMacroReport(report_date="2026-11-16", video_count=2))
        s.commit()
    assert yt_macro.days_needing_report(today=date(2026, 11, 17)) == ["2026-11-17"]


def test_a_day_is_rebuilt_once_more_videos_are_analyzed(empty_db):
    with SessionLocal() as s:
        s.add_all([_video("a", "2026-11-16"), _video("b", "2026-11-16", channel="UCb")])
        s.add(YtMacroReport(report_date="2026-11-16", video_count=1))
        s.commit()
    assert yt_macro.days_needing_report(today=date(2026, 11, 16)) == ["2026-11-16"]


def test_digest_carries_each_videos_view_and_stock_calls():
    stocks = [{"ticker": "NVDA", "name": "英伟达", "stance": "看多", "price_note": "199加仓",
               "reason": "算力需求"}]
    video = _video("a", "2026-11-16", summary="科技股还会涨", views="• 降息预期升温",
                   stocks=json.dumps(stocks, ensure_ascii=False))
    digest = yt_macro.build_digest([video])
    assert "【博主a】整体态度：看多" in digest
    assert "科技股还会涨" in digest
    assert "• 降息预期升温" in digest
    assert "NVDA 英伟达 看多（199加仓）：算力需求" in digest


def test_clean_report_coerces_stances_and_drops_blanks():
    out = yt_macro.clean_report(
        {
            "stance": "bullish",
            "headline": " 科技领涨 ",
            "sectors": [
                {"name": "半导体", "stance": "看多", "note": "n"},
                {"name": "能源", "stance": "??", "note": ""},
                {"name": " ", "stance": "看多", "note": "nameless"},
            ],
            "consensus": ["一致看好 AI", " "],
            "risks": None,
        }
    )
    assert out["stance"] == "中性"
    assert out["headline"] == "科技领涨"
    assert [(s["name"], s["stance"]) for s in out["sectors"]] == [("半导体", "看多"), ("能源", "中性")]
    assert out["consensus"] == ["一致看好 AI"]
    assert out["risks"] == []
    assert out["market"] == ""


def test_generate_stores_the_report_with_its_video_count(empty_db, monkeypatch):
    with SessionLocal() as s:
        s.add_all([_video("a", "2026-11-16"), _video("b", "2026-11-16", channel="UCb")])
        s.commit()
    sent = {}

    def fake_generate(body, timeout):
        sent["prompt"] = body["contents"][0]["parts"][0]["text"]
        return {"stance": "看多", "headline": "h", "market": "m", "consensus": ["c"]}, "m1"

    monkeypatch.setattr(yt_ingest, "generate_json", fake_generate)
    assert yt_macro.generate("2026-11-16") is True
    assert "2 位财经博主发布的 2 个视频" in sent["prompt"]
    with SessionLocal() as s:
        row = s.get(YtMacroReport, "2026-11-16")
        assert (row.stance, row.headline, row.video_count, row.model) == ("看多", "h", 2, "m1")
        content = json.loads(row.content)
        assert content["market"] == "m"
        assert content["consensus"] == ["c"]
        assert "stance" not in content


def test_generate_skips_a_day_without_analyzed_videos(empty_db, monkeypatch):
    monkeypatch.setattr(yt_ingest, "generate_json", lambda body, timeout: pytest.fail("called"))
    assert yt_macro.generate("2026-11-16") is False


def test_main_without_api_key_does_nothing(empty_db, monkeypatch):
    monkeypatch.setattr(yt_ingest, "GEMINI_API_KEY", None)
    monkeypatch.setattr(yt_ingest, "generate_json", lambda body, timeout: pytest.fail("called"))
    yt_macro.main([])
