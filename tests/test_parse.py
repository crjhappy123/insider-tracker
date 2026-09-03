"""Parsing tests for Form 4 XML — no network."""
from datetime import date

from scraper.edgar import FilingRef, parse_form4

# Minimal but schema-accurate Form 4 ownership document.
SAMPLE = b"""<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214156</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>CEO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-08-27</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>S</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>150.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>"""

FILING = FilingRef(cik="320193", company_name="Apple Inc.", accession_no="acc-x")


def test_parse_core_fields():
    rows = parse_form4(SAMPLE, FILING)
    assert len(rows) == 1
    r = rows[0]
    assert r.ticker == "AAPL"
    assert r.company_name == "Apple Inc."
    assert r.insider_name == "COOK TIMOTHY D"
    assert r.insider_title == "Dir, CEO"


def test_transaction_code_not_value_wrapped():
    """Regression: transactionCode is a direct text node, not <value>-wrapped."""
    r = parse_form4(SAMPLE, FILING)[0]
    assert r.transaction_code == "S"  # would be "?" if parsed via /value


def test_amounts_and_computed_value():
    r = parse_form4(SAMPLE, FILING)[0]
    assert r.shares == 1000
    assert r.price == 150.50
    assert r.value == 150500.0  # shares * price
    assert r.acquired_disposed == "D"
    assert r.shares_owned_after == 50000
    assert r.trade_date == date(2026, 8, 27)


def test_empty_or_bad_xml_is_safe():
    assert parse_form4(b"not xml", FILING) == []
    assert parse_form4(b"<ownershipDocument></ownershipDocument>", FILING) == []
