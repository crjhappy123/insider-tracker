"""Retention-window pruning tests."""
from datetime import date

from scraper import prune as prune_mod


def test_cutoff_is_inclusive_seven_day_window():
    # With a 7-day window and "today" = Sep 2, the oldest kept day is Aug 27.
    assert prune_mod.cutoff_date(date(2026, 9, 2)) == date(2026, 8, 27)


def test_delete_statements_cover_all_three_tables():
    stmts = prune_mod._delete_statements("2026-08-27")
    joined = " ".join(stmts)
    assert "DELETE FROM ai_scores" in joined
    assert "DELETE FROM transactions" in joined
    assert "DELETE FROM daily_reports" in joined
    # AI scores must be removed before their transactions disappear.
    assert stmts[0].startswith("DELETE FROM ai_scores")


def test_cn_prune_also_drops_unfollowed_boards_and_their_leaderboard_rows():
    """Boards we don't follow are dropped regardless of age — leaderboard included."""
    joined = " ".join(prune_mod._market_statements("cn", "2026-09-03"))
    assert "code LIKE '30%'" in joined
    assert "code LIKE '688%'" in joined
    assert "DELETE FROM cn_leaderboard WHERE ticker LIKE '30%'" in joined
    # The US statements must stay age-only.
    assert "LIKE" not in " ".join(prune_mod._market_statements("us", "2026-09-03"))


def test_prune_keeps_in_window_drops_older(seeded_db):
    """Seed rows are filed 2026-08-28; a window ending 2026-09-02 keeps them."""
    from app.db import SessionLocal
    from app.models import Transaction

    result = prune_mod.prune(today=date(2026, 9, 2))
    assert result["cutoff"] == "2026-08-27"
    with SessionLocal() as s:
        assert s.query(Transaction).count() == 2  # both survive

    # A window that starts after the seeded date removes them.
    prune_mod.prune(today=date(2026, 9, 30))
    with SessionLocal() as s:
        assert s.query(Transaction).count() == 0
