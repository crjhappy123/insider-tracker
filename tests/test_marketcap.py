"""Share-count selection tests (no network)."""
from datetime import date, timedelta

from scraper.marketcap import _latest_usable


def _iso(days_ago: int) -> str:
    return (date.today() - timedelta(days=days_ago)).isoformat()


def test_picks_newest_end_date():
    entries = [
        {"end": _iso(400), "val": 100},
        {"end": _iso(30), "val": 250},
    ]
    assert _latest_usable(entries) == 250


def test_same_end_date_takes_max_not_sum():
    """Quarterly and YTD weighted averages share an end date; summing double counts."""
    entries = [
        {"end": _iso(30), "val": 52_987_000},  # quarterly
        {"end": _iso(30), "val": 53_835_000},  # year-to-date
    ]
    assert _latest_usable(entries) == 53_835_000


def test_rejects_stale_values():
    """A 2009-era share count is worse than no value at all."""
    assert _latest_usable([{"end": "2009-12-31", "val": 60_000_000}]) is None


def test_handles_empty_and_malformed():
    assert _latest_usable([]) is None
    assert _latest_usable([{"val": 100}]) is None  # no end date
    assert _latest_usable([{"end": "not-a-date", "val": 100}]) is None
    assert _latest_usable([{"end": _iso(10), "val": 0}]) is None  # zero shares
