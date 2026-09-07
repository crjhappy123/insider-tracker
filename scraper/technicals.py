"""Fetch lightweight technical indicators from the free Yahoo chart API.

Used to give the AI commentary a read on each stock's technical posture
(trend vs. moving averages, distance from 52-week range, recent momentum).
No API key required. Failures are tolerated (returns None).
"""
from __future__ import annotations

import time

import requests

_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
_HEADERS = {"User-Agent": "Mozilla/5.0 (insider-tracker)"}
_cache: dict[str, dict | None] = {}
# ticker -> {iso_date: close} over the last year (or None if unavailable).
_history_cache: dict[str, dict[str, float] | None] = {}


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def daily_closes(ticker: str | None) -> dict[str, float] | None:
    """Map of ISO date -> daily close over ~1y, or None if unavailable.

    Backs the leaderboard's entry price (close on the first-added date) and its
    current price (the most recent close). Cached per ticker for the process.
    """
    if not ticker:
        return None
    if ticker in _history_cache:
        return _history_cache[ticker]

    closes: dict[str, float] | None = None
    try:
        time.sleep(0.15)  # be gentle with Yahoo
        r = requests.get(
            _CHART.format(ticker=ticker),
            params={"range": "1y", "interval": "1d"},
            headers=_HEADERS,
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()["chart"]["result"][0]
        stamps = data["timestamp"]
        vals = data["indicators"]["quote"][0]["close"]
        closes = {
            time.strftime("%Y-%m-%d", time.gmtime(ts)): round(c, 2)
            for ts, c in zip(stamps, vals)
            if c is not None
        } or None
    except (requests.RequestException, KeyError, ValueError, IndexError):
        closes = None

    _history_cache[ticker] = closes
    return closes


def close_on(ticker: str | None, day: str) -> float | None:
    """Close on `day` (ISO), falling back to the nearest prior trading day."""
    closes = daily_closes(ticker)
    if not closes:
        return None
    if day in closes:
        return closes[day]
    prior = [d for d in closes if d <= day]
    return closes[max(prior)] if prior else None


def latest_close(ticker: str | None) -> float | None:
    """Most recent available close for `ticker`, or None."""
    closes = daily_closes(ticker)
    if not closes:
        return None
    return closes[max(closes)]


def get_technicals(ticker: str | None) -> dict | None:
    """Return a compact technicals dict for `ticker`, or None if unavailable."""
    if not ticker:
        return None
    if ticker in _cache:
        return _cache[ticker]

    result = None
    try:
        time.sleep(0.15)  # be gentle with Yahoo
        r = requests.get(
            _CHART.format(ticker=ticker),
            params={"range": "1y", "interval": "1d"},
            headers=_HEADERS,
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()["chart"]["result"][0]
        closes = [c for c in data["indicators"]["quote"][0]["close"] if c is not None]
        if len(closes) >= 30:
            last = closes[-1]
            hi, lo = max(closes), min(closes)
            result = {
                "last": round(last, 2),
                "ma50": round(_mean(closes[-50:]), 2),
                "ma200": round(_mean(closes[-200:]), 2) if len(closes) >= 200 else None,
                "pct_from_52w_high": round((last / hi - 1) * 100, 1),
                "pct_from_52w_low": round((last / lo - 1) * 100, 1),
                "ret_1m_pct": round((last / closes[-21] - 1) * 100, 1)
                if len(closes) >= 21
                else None,
                "ret_3m_pct": round((last / closes[-63] - 1) * 100, 1)
                if len(closes) >= 63
                else None,
            }
    except (requests.RequestException, KeyError, ValueError, IndexError, ZeroDivisionError):
        result = None

    _cache[ticker] = result
    return result
