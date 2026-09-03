"""Fetch and parse SEC EDGAR Form 4 (insider trading) filings.

SEC requires a descriptive User-Agent with contact info and rate-limits to
~10 requests/second. Set EDGAR_USER_AGENT to your own name/email.
"""
from __future__ import annotations

import os
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date
from typing import Iterator

import requests

USER_AGENT = os.environ.get(
    "EDGAR_USER_AGENT", "insider-tracker sample-contact@example.com"
)
BASE = "https://www.sec.gov"
# Stay well under SEC's ~10 req/s limit.
REQUEST_DELAY = float(os.environ.get("EDGAR_REQUEST_DELAY", "0.2"))

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})


def _get(url: str, **kwargs) -> requests.Response:
    time.sleep(REQUEST_DELAY)
    resp = _session.get(url, timeout=30, **kwargs)
    resp.raise_for_status()
    return resp


@dataclass
class FilingRef:
    cik: str
    company_name: str
    accession_no: str  # dashed form, e.g. 0000320193-24-000012


@dataclass
class TxnRow:
    accession_no: str
    line_no: int
    issuer_cik: str
    company_name: str
    ticker: str | None
    insider_name: str
    insider_title: str
    trade_date: date | None
    transaction_code: str
    acquired_disposed: str | None
    shares: float | None
    price: float | None
    value: float | None
    shares_owned_after: float | None
    security_title: str | None
    market_cap: float | None = None  # filled in during ingest (company-level)


def daily_form4_filings(day: date) -> list[FilingRef]:
    """List all Form 4 filings from the EDGAR daily master index for `day`.

    Returns empty on weekends/holidays (no index published).
    """
    q = (day.month - 1) // 3 + 1
    url = (
        f"{BASE}/Archives/edgar/daily-index/{day.year}/QTR{q}/"
        f"master.{day:%Y%m%d}.idx"
    )
    try:
        resp = _get(url)
    except requests.HTTPError as e:
        # S3 returns 404 for missing keys, and 403 AccessDenied for a date whose
        # index is not published yet (e.g. the current/future day). Treat both as
        # "no index available".
        if e.response is not None and e.response.status_code in (403, 404):
            return []
        raise

    filings: list[FilingRef] = []
    for line in resp.text.splitlines():
        # Format: CIK|Company Name|Form Type|Date Filed|Filename
        parts = line.split("|")
        if len(parts) != 5 or parts[2].strip() != "4":
            continue
        cik, company, _form, _filed, filename = parts
        # filename: edgar/data/CIK/0000320193-24-000012.txt
        accession = filename.rsplit("/", 1)[-1].replace(".txt", "")
        filings.append(FilingRef(cik.strip(), company.strip(), accession))
    return filings


def _find_ownership_xml_url(cik: str, accession_no: str) -> str | None:
    """Locate the ownership XML document inside a filing folder."""
    acc_nodash = accession_no.replace("-", "")
    folder = f"{BASE}/Archives/edgar/data/{cik}/{acc_nodash}"
    index = _get(f"{folder}/index.json").json()
    items = index.get("directory", {}).get("item", [])
    # Prefer the primary ownership doc; fall back to any .xml that isn't XSLT.
    xmls = [
        it["name"]
        for it in items
        if it["name"].lower().endswith(".xml") and "xslt" not in it["name"].lower()
    ]
    if not xmls:
        return None
    # The ownership doc is often the first/only .xml; keep it simple.
    return f"{folder}/{xmls[0]}"


def _text(node: ET.Element | None, path: str) -> str | None:
    if node is None:
        return None
    el = node.find(path)
    return el.text.strip() if el is not None and el.text else None


def _val(node: ET.Element | None, path: str) -> str | None:
    """Read a <path><value>X</value></path> nested value."""
    return _text(node, f"{path}/value")


def _to_float(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def _to_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _relationship_title(owner: ET.Element) -> str:
    rel = owner.find("reportingOwnerRelationship")
    if rel is None:
        return ""
    parts = []
    if _text(rel, "isDirector") in ("1", "true"):
        parts.append("Dir")
    if _text(rel, "isOfficer") in ("1", "true"):
        title = _text(rel, "officerTitle")
        parts.append(title or "Officer")
    if _text(rel, "isTenPercentOwner") in ("1", "true"):
        parts.append("10%")
    if _text(rel, "isOther") in ("1", "true"):
        parts.append(_text(rel, "otherText") or "Other")
    return ", ".join(parts)


def parse_form4(xml_bytes: bytes, filing: FilingRef) -> list[TxnRow]:
    """Parse non-derivative transactions from a Form 4 ownership document."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    issuer = root.find("issuer")
    issuer_cik = _text(issuer, "issuerCik") or filing.cik
    company = _text(issuer, "issuerName") or filing.company_name
    ticker = _text(issuer, "issuerTradingSymbol")

    owner = root.find("reportingOwner")
    insider_name = _text(owner, "reportingOwnerId/rptOwnerName") or "UNKNOWN"
    insider_title = _relationship_title(owner) if owner is not None else ""

    rows: list[TxnRow] = []
    table = root.find("nonDerivativeTable")
    if table is None:
        return rows

    for i, txn in enumerate(table.findall("nonDerivativeTransaction")):
        shares = _to_float(_val(txn, "transactionAmounts/transactionShares"))
        price = _to_float(_val(txn, "transactionAmounts/transactionPricePerShare"))
        value = shares * price if shares is not None and price is not None else None
        rows.append(
            TxnRow(
                accession_no=filing.accession_no,
                line_no=i,
                issuer_cik=issuer_cik,
                company_name=company,
                ticker=ticker,
                insider_name=insider_name,
                insider_title=insider_title,
                trade_date=_to_date(_val(txn, "transactionDate")),
                transaction_code=_text(txn, "transactionCoding/transactionCode") or "?",
                acquired_disposed=_val(
                    txn, "transactionAmounts/transactionAcquiredDisposedCode"
                ),
                shares=shares,
                price=price,
                value=value,
                shares_owned_after=_to_float(
                    _val(txn, "postTransactionAmounts/sharesOwnedFollowingTransaction")
                ),
                security_title=_val(txn, "securityTitle"),
            )
        )
    return rows


def fetch_filing_transactions(filing: FilingRef) -> list[TxnRow]:
    """Download and parse one Form 4 filing into transaction rows."""
    xml_url = _find_ownership_xml_url(filing.cik, filing.accession_no)
    if not xml_url:
        return []
    xml_bytes = _get(xml_url).content
    return parse_form4(xml_bytes, filing)


def iter_day_transactions(day: date) -> Iterator[TxnRow]:
    """Yield every non-derivative transaction filed on `day`."""
    for filing in daily_form4_filings(day):
        try:
            yield from fetch_filing_transactions(filing)
        except requests.HTTPError:
            continue  # skip individual filing failures; keep the batch going
