"""Estimate market cap from free SEC data (no third-party API key).

market cap ≈ shares outstanding (SEC XBRL dei:EntityCommonStockSharesOutstanding)
            × recent share price (the Form 4 transaction price).

The share price on a Form 4 is a real recent execution price, so this is a solid
approximation for a coarse threshold like "> $100M". It is an estimate, not a
real-time quote.
"""
from __future__ import annotations

import requests

from scraper.edgar import _get, BASE  # reuse the rate-limited session

# Cache shares-outstanding per CIK for the lifetime of a run.
_shares_cache: dict[str, float | None] = {}


def shares_outstanding(cik: str) -> float | None:
    """Most recent common shares outstanding for a CIK, or None if unavailable."""
    key = str(int(cik))  # normalize "0000320193" / "320193"
    if key in _shares_cache:
        return _shares_cache[key]

    url = (
        f"https://data.sec.gov/api/xbrl/companyconcept/"
        f"CIK{int(cik):010d}/dei/EntityCommonStockSharesOutstanding.json"
    )
    value: float | None = None
    try:
        data = _get(url).json()
        units = data.get("units", {}).get("shares", [])
        if units:
            latest = max(units, key=lambda x: x.get("end", ""))
            value = float(latest["val"])
    except (requests.HTTPError, ValueError, KeyError):
        value = None  # not all filers report this concept

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
