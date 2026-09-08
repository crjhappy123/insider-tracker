"""A-share (/cn) ingest tests. No network: the Eastmoney client is stubbed."""
from datetime import date

import pytest

from app.db import SessionLocal, init_db
from app.models import CnCompany, CnTransaction
from scraper import cn_ingest
from scraper.cn_eastmoney import exchange_from_code, exchange_of, secid


def _record(**over):
    """One 董监高持股变动 record shaped like the Eastmoney API returns."""
    rec = {
        "SECURITY_CODE": "600826",
        "DERIVE_SECURITY_CODE": "600826.SH",
        "SECURITY_NAME": "兰生股份",
        "CHANGE_DATE": "2026-09-07 00:00:00",
        "PERSON_NAME": "陈小宏",
        "POSITION_NAME": "董事长",
        "PERSON_DSE_RELATION": "本人",
        "CHANGE_SHARES": 10000,
        "AVERAGE_PRICE": 7.71,
        "CHANGE_AMOUNT": 77100,
        "CHANGE_REASON": "集中竞价",
        "CHANGE_RATIO": 0.0014,
        "CHANGE_AFTER_HOLDNUM": 20000,
        "GGEID": 273000001461189370,
    }
    rec.update(over)
    return rec


@pytest.fixture()
def stub_eastmoney(monkeypatch):
    """Patch the API client so ingest_day runs offline. Yields a config dict."""
    cfg = {"records": [], "quotes": {}}
    monkeypatch.setattr(cn_ingest, "holding_changes", lambda day: cfg["records"])
    monkeypatch.setattr(cn_ingest, "quotes", lambda pairs: cfg["quotes"])
    init_db()
    with SessionLocal() as s:
        s.query(CnTransaction).delete()
        s.query(CnCompany).delete()
        s.commit()
    return cfg


def _quote(cap):
    return {"name": "兰生股份", "last_price": 7.83, "market_cap": cap, "float_market_cap": cap}


# --- secid / exchange mapping -------------------------------------------------


def test_exchange_from_code_puts_beijing_920_before_shanghai_9():
    # 920xxx is 北交所 but also starts with "9", which would otherwise read as 上交所.
    assert exchange_from_code("920252") == "BJ"
    assert exchange_from_code("600826") == "SH"
    assert exchange_from_code("900901") == "SH"
    assert exchange_from_code("000035") == "SZ"
    assert exchange_from_code("300806") == "SZ"


def test_secid_prefixes_shanghai_1_everything_else_0():
    assert secid("600826", "SH") == "1.600826"
    assert secid("000035", "SZ") == "0.000035"
    assert secid("920252", "BJ") == "0.920252"
    # No exchange given -> inferred from the code, so 北交所 still maps to 0.
    assert secid("920252") == "0.920252"


def test_exchange_of_prefers_the_derive_code_suffix():
    assert exchange_of("920252.BJ", "920252") == "BJ"
    assert exchange_of(None, "600826") == "SH"


# --- ingest filtering ---------------------------------------------------------


def test_only_increases_are_ingested(stub_eastmoney):
    stub_eastmoney["records"] = [
        _record(),  # 增持
        _record(GGEID=2, CHANGE_SHARES=-500, CHANGE_AMOUNT=-3855),  # 减持
    ]
    stub_eastmoney["quotes"] = {"600826": _quote(5.6e9)}
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 1
    with SessionLocal() as s:
        rows = s.query(CnTransaction).all()
        assert len(rows) == 1
        assert rows[0].shares == 10000
        assert rows[0].value == 77100


def test_block_trades_are_skipped(stub_eastmoney):
    """大宗交易 is negotiated, not an open-market buy, so it carries less signal."""
    stub_eastmoney["records"] = [_record(CHANGE_REASON="大宗交易")]
    stub_eastmoney["quotes"] = {"600826": _quote(5.6e9)}
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 0


def test_small_caps_are_skipped_but_unknown_caps_are_kept(stub_eastmoney):
    stub_eastmoney["records"] = [
        _record(GGEID=1),
        _record(GGEID=2, SECURITY_CODE="000001", DERIVE_SECURITY_CODE="000001.SZ",
                PERSON_NAME="张三"),
    ]
    # 600826 is far below the ¥10亿 floor; 000001 has no quote at all.
    stub_eastmoney["quotes"] = {"600826": _quote(1e8)}
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 1
    with SessionLocal() as s:
        rows = s.query(CnTransaction).all()
        assert [r.code for r in rows] == ["000001"]
        assert rows[0].market_cap is None  # unknown, rendered as "—"


def test_duplicate_disclosures_collapse_and_merge_titles(stub_eastmoney):
    """One purchase disclosed once per related 董监高 must not double-count 增持额."""
    stub_eastmoney["records"] = [
        _record(GGEID=1, PERSON_NAME="南通乾创投资有限公司", POSITION_NAME="董事长"),
        _record(GGEID=2, PERSON_NAME="南通乾创投资有限公司", POSITION_NAME="董事,副总裁"),
    ]
    stub_eastmoney["quotes"] = {"600826": _quote(5.6e9)}
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 1
    with SessionLocal() as s:
        rows = s.query(CnTransaction).all()
        assert len(rows) == 1
        assert rows[0].value == 77100  # not 154200
        # The dropped record's only extra information was its 职务.
        assert rows[0].insider_title == "董事长 / 董事,副总裁"


def test_reingesting_a_day_is_idempotent(stub_eastmoney):
    stub_eastmoney["records"] = [_record()]
    stub_eastmoney["quotes"] = {"600826": _quote(5.6e9)}
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 1
    assert cn_ingest.ingest_day(date(2026, 9, 7)) == 0
    with SessionLocal() as s:
        assert s.query(CnTransaction).count() == 1


def test_ingest_upserts_company_market_cap(stub_eastmoney):
    stub_eastmoney["records"] = [_record()]
    stub_eastmoney["quotes"] = {"600826": _quote(5.6e9)}
    cn_ingest.ingest_day(date(2026, 9, 7))
    with SessionLocal() as s:
        co = s.get(CnCompany, "600826")
        assert co.market_cap == 5.6e9
        assert co.exchange == "SH"
        assert co.last_price == 7.83


def test_an_empty_day_writes_nothing(stub_eastmoney):
    assert cn_ingest.ingest_day(date(2026, 9, 5)) == 0  # 周六, no disclosures
