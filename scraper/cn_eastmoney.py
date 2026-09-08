"""东方财富 (Eastmoney) free-endpoint client for the A-share side of the site.

Three endpoints, no API key required:

* ``holding_changes(day)`` — 董监高持股变动明细 (report ``RPT_EXECUTIVE_HOLD_DETAILS``),
  the A-share analogue of a Form 4. This is the same feed 东方财富's own
  数据中心 page renders, so it is public disclosure data, not scraped HTML.
* ``quotes(codes)`` — batched 总市值 / 流通市值 / 最新价 per 股票代码.
* ``daily_closes(code)`` — ~1y of adjusted daily closes, for leaderboard entry
  and current prices plus the technical indicators fed to the AI.

Every function tolerates failure (returns ``None`` / an empty result) so a
transient outage degrades the page rather than failing the pipeline.
"""
from __future__ import annotations

import time
from datetime import date

import requests

_DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get"
_QUOTE_LIST = "https://push2.eastmoney.com/api/qt/ulist.np/get"
_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (a-share insider tracker)",
    "Referer": "https://data.eastmoney.com/",
}
_TIMEOUT = 30
_PAGE_SIZE = 500  # a full day is ~50 records, so one page is normally enough

# Eastmoney's "secid" market prefix. 上交所 = 1; 深交所 and 北交所 = 0.
_MARKET_PREFIX = {"SH": "1", "SZ": "0", "BJ": "0"}

# code -> {iso date: close}, cached per process (the ingest touches a code once
# but the AI + leaderboard steps ask for the same codes again).
_history_cache: dict[str, dict[str, float] | None] = {}
_technicals_cache: dict[str, dict | None] = {}


def secid(code: str, exchange: str | None = None) -> str:
    """Eastmoney secid, e.g. ("600826", "SH") -> "1.600826".

    Falls back to inferring the exchange from the code when it isn't supplied.
    """
    prefix = _MARKET_PREFIX.get((exchange or "").upper())
    if prefix is None:
        prefix = _MARKET_PREFIX[exchange_from_code(code)]
    return f"{prefix}.{code}"


def exchange_from_code(code: str) -> str:
    """Infer the exchange from a 股票代码 alone.

    北交所 must be tested first: its 920xxx range also starts with "9", which
    otherwise looks like a 上交所 B 股 code.
    """
    if code.startswith(("920", "4", "8")):
        return "BJ"
    if code.startswith(("6", "9")):
        return "SH"
    return "SZ"


def exchange_of(derive_code: str | None, code: str) -> str:
    """"600826.SH" -> "SH"; falls back to the code range when absent."""
    if derive_code and "." in derive_code:
        return derive_code.rsplit(".", 1)[1].upper()
    return exchange_from_code(code)


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def _get_json(url: str, params: dict, tries: int = 5) -> dict | None:
    """GET + parse JSON, retrying with backoff. Returns None if all tries fail.

    Eastmoney's push2 hosts return sporadic 502s under load — the same request
    fails and then succeeds seconds later — so a couple of retries turn a lost
    day of market caps into a short pause.
    """
    for attempt in range(tries):
        try:
            resp = requests.get(url, params=params, headers=_HEADERS, timeout=_TIMEOUT)
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(0.6 * 2**attempt)  # 0.6s, 1.2s, 2.4s, 4.8s
                continue
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError):
            time.sleep(0.6 * 2**attempt)
    return None


def holding_changes(day: date) -> list[dict]:
    """All 董监高持股变动 records whose 变动日期 is ``day`` (both 增持 and 减持).

    Callers filter by direction; ingest keeps only ``CHANGE_SHARES > 0``.
    Returns [] on an empty day (weekend/holiday) or a transient failure.
    """
    rows: list[dict] = []
    page = 1
    while True:
        params = {
            "reportName": "RPT_EXECUTIVE_HOLD_DETAILS",
            "columns": "ALL",
            "pageNumber": page,
            "pageSize": _PAGE_SIZE,
            "sortColumns": "CHANGE_DATE",
            "sortTypes": -1,
            "filter": f"(CHANGE_DATE='{day.isoformat()}')",
            "source": "WEB",
            "client": "WEB",
        }
        payload = _get_json(_DATACENTER, params)
        if payload is None:
            break
        # An empty day returns success=true with result=None and message 返回数据为空.
        result = payload.get("result")
        if not result or not result.get("data"):
            break
        rows.extend(result["data"])
        if page >= int(result.get("pages") or 1):
            break
        page += 1
        time.sleep(0.3)  # be gentle
    return rows


def quotes(codes_with_exchange: list[tuple[str, str | None]]) -> dict[str, dict]:
    """Batched quote lookup: 股票代码 -> {name, last_price, market_cap, float_market_cap}.

    Eastmoney accepts many secids per call, so a whole day costs one request.
    Codes it doesn't recognise are simply absent from the result.
    """
    out: dict[str, dict] = {}
    unique = list(dict.fromkeys(codes_with_exchange))
    # 100 per request keeps the URL well inside limits.
    for i in range(0, len(unique), 100):
        _quote_chunk(unique[i : i + 100], out)
        time.sleep(0.2)
    return out


def _quote_chunk(chunk: list[tuple[str, str | None]], out: dict[str, dict]) -> None:
    """Fetch one batch of quotes into ``out``; halve and recurse if it fails.

    A whole chunk failing after retries is usually one unquotable secid (a newly
    listed or delisted code) poisoning the batch, so splitting recovers the rest
    instead of losing every market cap in the batch.
    """
    if not chunk:
        return
    payload = _get_json(
        _QUOTE_LIST,
        {
            "secids": ",".join(secid(c, e) for c, e in chunk),
            # f12 代码, f14 名称, f2 最新价(×100), f20 总市值, f21 流通市值
            "fields": "f12,f14,f2,f20,f21",
        },
    )
    if payload is None:
        if len(chunk) == 1:
            return  # this single code is unquotable; leave its cap NULL
        mid = len(chunk) // 2
        _quote_chunk(chunk[:mid], out)
        _quote_chunk(chunk[mid:], out)
        return

    for row in (payload.get("data") or {}).get("diff") or []:
        code = row.get("f12")
        if not code:
            continue
        price, cap, fcap = row.get("f2"), row.get("f20"), row.get("f21")
        out[code] = {
            "name": row.get("f14"),
            # f2 is the price in 分; "-" when the stock is suspended/delisted.
            "last_price": round(price / 100, 2) if isinstance(price, (int, float)) else None,
            "market_cap": cap if isinstance(cap, (int, float)) else None,
            "float_market_cap": fcap if isinstance(fcap, (int, float)) else None,
        }


def daily_closes(code: str | None, exchange: str | None = None) -> dict[str, float] | None:
    """Map of ISO date -> 前复权 daily close over ~1.5y, or None if unavailable.

    Adjusted (``fqt=1``) so a dividend/split between entry and today doesn't show
    up as a fake loss on the leaderboard.
    """
    if not code:
        return None
    if code in _history_cache:
        return _history_cache[code]

    time.sleep(0.3)  # be gentle; the kline host rate-limits bursts with 502s
    payload = _get_json(
        _KLINE,
        {
            "secid": secid(code, exchange),
            "klt": "101",  # daily
            "fqt": "1",  # 前复权
            "beg": "0",
            "end": "20500101",
            "lmt": "400",
            "fields1": "f1,f2,f3",
            "fields2": "f51,f53",  # date, close
        },
    )
    closes: dict[str, float] | None = None
    if payload is not None:
        closes = {}
        for line in (payload.get("data") or {}).get("klines") or []:
            parts = line.split(",")
            if len(parts) >= 2:
                try:
                    closes[parts[0]] = round(float(parts[1]), 2)
                except ValueError:
                    continue
        closes = closes or None

    _history_cache[code] = closes
    return closes


def close_on(code: str | None, day: str, exchange: str | None = None) -> float | None:
    """Close on ``day`` (ISO), falling back to the nearest prior trading day."""
    closes = daily_closes(code, exchange)
    if not closes:
        return None
    if day in closes:
        return closes[day]
    prior = [d for d in closes if d <= day]
    return closes[max(prior)] if prior else None


def latest_close(code: str | None, exchange: str | None = None) -> float | None:
    """Most recent available close for ``code``, or None."""
    closes = daily_closes(code, exchange)
    if not closes:
        return None
    return closes[max(closes)]


def get_technicals(code: str | None, exchange: str | None = None) -> dict | None:
    """Compact technicals dict for ``code`` (same shape as the US side's)."""
    if not code:
        return None
    if code in _technicals_cache:
        return _technicals_cache[code]

    result = None
    closes_map = daily_closes(code, exchange)
    if closes_map and len(closes_map) >= 30:
        series = [closes_map[d] for d in sorted(closes_map)]
        last = series[-1]
        window = series[-250:]  # ~52 weeks of A-share trading days
        hi, lo = max(window), min(window)
        try:
            result = {
                "last": round(last, 2),
                "ma50": round(_mean(series[-50:]), 2),
                "ma200": round(_mean(series[-200:]), 2) if len(series) >= 200 else None,
                "pct_from_52w_high": round((last / hi - 1) * 100, 1),
                "pct_from_52w_low": round((last / lo - 1) * 100, 1),
                "ret_1m_pct": round((last / series[-21] - 1) * 100, 1)
                if len(series) >= 21
                else None,
                "ret_3m_pct": round((last / series[-63] - 1) * 100, 1)
                if len(series) >= 63
                else None,
            }
        except ZeroDivisionError:
            result = None

    _technicals_cache[code] = result
    return result
