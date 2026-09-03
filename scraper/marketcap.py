"""Estimate market cap from free SEC data (no third-party API key).

market cap ≈ shares outstanding × recent share price (the Form 4 price).

Share counts come from the SEC XBRL `companyfacts` endpoint. We try several
concepts in priority order because many filers — especially multi-class issuers
like Ameresco (Class A/B) — never report the plain cover-page
`dei:EntityCommonStockSharesOutstanding` without dimensions, so that concept
alone leaves big gaps. Weighted-average diluted/basic share counts are a solid
consolidated proxy when the cover-page figure is absent.
"""
from __future__ import annotations

from datetime import date, timedelta

import requests

from scraper.edgar import _get  # reuse the rate-limited, UA-set session

# Tried in order; first usable value wins. (taxonomy, concept)
_SHARE_CONCEPTS = [
    ("dei", "EntityCommonStockSharesOutstanding"),  # cover page: true outstanding
    ("us-gaap", "CommonStockSharesOutstanding"),
    ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"),
    ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"),
    ("us-gaap", "CommonStockSharesIssued"),  # last resort; often stale
]

# Ignore share counts older than this — a 2009 figure is worse than no figure.
MAX_AGE_DAYS = 730

_shares_cache: dict[str, float | None] = {}


def _latest_usable(entries: list[dict]) -> float | None:
    """Newest non-stale share count from one concept's unit series.

    Several entries can share an `end` date (e.g. a quarterly and a
    year-to-date weighted average). They are alternative measures of the same
    thing, not components — so take the max, never the sum, which would double
    count.
    """
    dated = [e for e in entries if e.get("end") and e.get("val")]
    if not dated:
        return None
    newest = max(e["end"] for e in dated)
    try:
        if date.fromisoformat(newest) < date.today() - timedelta(days=MAX_AGE_DAYS):
            return None  # stale
    except ValueError:
        return None
    same_period = [float(e["val"]) for e in dated if e["end"] == newest]
    best = max(same_period) if same_period else None
    return best if best and best > 0 else None


def shares_outstanding(cik: str) -> float | None:
    """Best available share count for a CIK, or None if SEC reports none."""
    key = str(int(cik))  # normalize "0000320193" / "320193"
    if key in _shares_cache:
        return _shares_cache[key]

    value: float | None = None
    try:
        facts = (
            _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(cik):010d}.json")
            .json()
            .get("facts", {})
        )
        for taxonomy, concept in _SHARE_CONCEPTS:
            units = facts.get(taxonomy, {}).get(concept, {}).get("units", {})
            for entries in units.values():  # normally just "shares"
                value = _latest_usable(entries)
                if value:
                    break
            if value:
                break
    except (requests.RequestException, ValueError, KeyError):
        value = None

    _shares_cache[key] = value
    return value


def estimate_market_cap(cik: str, price: float | None) -> float | None:
    """shares_outstanding(cik) * price, or None if either input is missing."""
    if not price or price <= 0:
        return None
    shares = shares_outstanding(cik)
    if not shares:
        return None
    return shares * price
