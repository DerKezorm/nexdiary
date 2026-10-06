"""API tokens and ``/api/v1``: programs read as the token's account, never more, and only read."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account, ApiToken, utcnow
from app.services import apitokens

from .conftest import make_account, new_client


@pytest.fixture(autouse=True)
def fresh_brake() -> Iterator[None]:
    apitokens.forget()
    yield
    apitokens.forget()


def switch_on(client: TestClient) -> None:
    assert client.put("/api/settings", json={"api_tokens_allowed": True}).status_code == 200


def make_token(client: TestClient, **body: object) -> str:
    answer = client.post("/api/api-tokens", json={"name": "nexdeck", **body})
    assert answer.status_code == 201, answer.text
    return str(answer.json()["secret"])


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_closed_until_the_operator_opens_it_and_never_for_a_web_page(client: TestClient, operator: Account) -> None:
    assert client.post("/api/api-tokens", json={"name": "x"}).json()["detail"]["code"] == "api_off"
    switch_on(client)
    token = make_token(client)
    assert token.startswith("nxa_")
    assert client.get("/api/v1/me", headers=bearer(token)).json()["name"] == "tester"
    assert client.get("/api/v1/me", headers={**bearer(token), "Origin": "https://example.com"}).status_code == 403
    assert client.put("/api/settings", json={"api_tokens_allowed": False}).status_code == 200
    assert client.get("/api/v1/me", headers=bearer(token)).json()["detail"]["code"] == "api_off"


def test_a_session_is_no_token_and_a_token_makes_no_tokens(client: TestClient, operator: Account) -> None:
    switch_on(client)
    token = make_token(client)
    # The browser's session counts for nothing under /api/v1.
    assert client.get("/api/v1/me").status_code == 401
    with TestClient(client.app, base_url="http://testserver", headers={"X-Nexdiary-Client": "program-tab"}) as bare:
        assert bare.get("/api/api-tokens", headers=bearer(token)).status_code == 401
        assert bare.post("/api/api-tokens", headers=bearer(token), json={"name": "more"}).status_code == 401


def test_tokens_only_read(client: TestClient, operator: Account) -> None:
    switch_on(client)
    assert client.post("/api/api-tokens", json={"name": "n8n", "level": "write"}).status_code == 422
    assert client.get("/api/v1/me", headers=bearer(make_token(client))).json()["level"] == "read"


def test_a_token_speaks_for_its_own_account_only(client: TestClient, operator: Account) -> None:
    switch_on(client)
    rita = make_account("rita")
    with new_client(rita) as own:
        token = make_token(own)
        assert own.get("/api/v1/me", headers=bearer(token)).json()["name"] == "rita"
        listed = own.get("/api/api-tokens").json()["tokens"]
        assert [item["name"] for item in listed] == ["nexdeck"]
    # The operator sees that rita has a token, never its secret, and cannot delete it as its own.
    every = client.get("/api/admin/api-tokens").json()
    assert [(item["account"], item["prefix"]) for item in every] == [("rita", token[:8])]
    assert all(token not in str(item) for item in every)
    assert client.delete(f"/api/api-tokens/{every[0]['id']}").status_code == 404
    assert client.get("/api/api-tokens").json()["tokens"] == []


def test_run_out_blocked_or_deleted_tokens_answer_like_none(client: TestClient, operator: Account) -> None:
    switch_on(client)
    late = make_token(client, days=30)
    blocked = make_token(client)
    gone = make_token(client)
    with SessionLocal() as db:
        row = db.query(ApiToken).filter(ApiToken.token_hash == apitokens.digest(late)).one()
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    ids = {item["prefix"]: item["id"] for item in client.get("/api/api-tokens").json()["tokens"]}
    assert client.post(f"/api/admin/api-tokens/{ids[blocked[:8]]}/block").status_code == 200
    assert client.delete(f"/api/api-tokens/{ids[gone[:8]]}").status_code == 204
    for token in (late, blocked, gone, "nxa_" + "x" * 43, "not-a-token"):
        assert client.get("/api/v1/me", headers=bearer(token)).json()["detail"]["code"] == "token_invalid"
    assert client.post("/api/api-tokens", json={"name": "x", "days": 7}).status_code == 422


def test_a_token_slows_down_at_its_rate(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    switch_on(client)
    token = make_token(client)
    monkeypatch.setattr(apitokens, "PER_MINUTE", 2)
    assert client.get("/api/v1/me", headers=bearer(token)).status_code == 200
    assert client.get("/api/v1/me", headers=bearer(token)).status_code == 200
    slow = client.get("/api/v1/me", headers=bearer(token))
    assert slow.status_code == 429 and slow.headers["retry-after"] == "60"


def test_a_blocked_account_reads_nothing_with_its_token(client: TestClient, operator: Account) -> None:
    switch_on(client)
    anna = make_account("anna")
    with new_client() as browser:
        from .conftest import sign_in

        sign_in(browser, anna)
        token = make_token(browser)
    with new_client() as program:
        assert program.get("/api/v1/me", headers=bearer(token)).status_code == 200
        with SessionLocal() as db:
            db.get(Account, anna.id).blocked_at = utcnow()  # type: ignore[union-attr]
            db.commit()
        assert program.get("/api/v1/me", headers=bearer(token)).status_code == 401
