"""API/filter tests using a seeded temp DB — no network."""


def test_homepage_renders(client, seeded_db):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "AAPL" in resp.text


def test_default_is_buys_only(client, seeded_db):
    """No side param → only the buy (AAPL); the MSFT sale is hidden."""
    resp = client.get("/api/transactions")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["ticker"] == "AAPL"


def test_show_sells_includes_sales(client, seeded_db):
    resp = client.get("/api/transactions?show_sells=1")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_empty_min_value_is_ignored(client, seeded_db):
    """Regression: blank form field ("") must not 422."""
    resp = client.get("/api/transactions?min_value=&ticker=&insider=&code=&show_sells=1")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_min_value_filter(client, seeded_db):
    resp = client.get("/api/transactions?min_value=1000000")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["ticker"] == "AAPL"


def test_min_value_with_commas(client, seeded_db):
    resp = client.get("/api/transactions?min_value=1,000,000")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_ticker_filter_case_insensitive(client, seeded_db):
    # MSFT is a sale, so it needs show_sells to appear.
    resp = client.get("/api/transactions?ticker=msft&show_sells=1")
    assert len(resp.json()) == 1
    assert resp.json()[0]["ticker"] == "MSFT"


def test_code_filter(client, seeded_db):
    assert len(client.get("/api/transactions?code=P").json()) == 1
    # S is a sale; hidden by default, shown with show_sells.
    assert len(client.get("/api/transactions?code=S").json()) == 0
    assert len(client.get("/api/transactions?code=S&show_sells=1").json()) == 1


def test_min_market_cap_filter(client, seeded_db):
    # AAPL is $3T, MSFT is $50M; a $100M floor keeps only AAPL.
    resp = client.get("/api/transactions?min_market_cap=100000000")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["ticker"] == "AAPL"
    assert data[0]["market_cap"] == 3_000_000_000_000


def test_insider_substring(client, seeded_db):
    resp = client.get("/api/transactions?insider=cook")
    assert len(resp.json()) == 1
    assert resp.json()[0]["insider_name"] == "COOK TIMOTHY D"
