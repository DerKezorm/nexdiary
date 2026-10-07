"""What the operator allows each account: the AI and Immich, on for everybody from the start. The routes that use them
are tested where they live (``test_ai``, ``test_immich``); here the switch itself."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.models import Account

from .conftest import new_client, person


def listed(client: TestClient) -> dict[str, dict[str, Any]]:
    return {row["name"]: row for row in client.get("/api/accounts").json()}


def test_every_account_is_allowed_both_from_the_start(client: TestClient, operator: Account) -> None:
    with person("ben"):
        rows = listed(client)
    assert all(row["ai_allowed"] is True and row["immich_allowed"] is True for row in rows.values())
    assert client.get("/api/auth/me").json()["ai_allowed"] is True


def test_the_operator_takes_one_away_and_gives_it_back_and_only_the_fields_sent_change(client: TestClient,
                                                                                       operator: Account) -> None:
    with person("ben") as ben:
        ben_id = listed(client)["ben"]["id"]
        answered = client.put(f"/api/accounts/{ben_id}/permissions", json={"ai_allowed": False})
        assert answered.status_code == 200 and answered.json() == {"ai_allowed": False, "immich_allowed": True}
        assert client.put(f"/api/accounts/{ben_id}/permissions", json={"immich_allowed": False}).json() == {
            "ai_allowed": False, "immich_allowed": False}
        assert client.put(f"/api/accounts/{ben_id}/permissions", json={}).json() == {
            "ai_allowed": False, "immich_allowed": False}
        me = ben.get("/api/auth/me").json()
        assert (me["ai_allowed"], me["immich_allowed"]) == (False, False)
        assert listed(client)["tester"]["ai_allowed"] is True
        assert client.put(f"/api/accounts/{ben_id}/permissions", json={"ai_allowed": True, "immich_allowed": True}
                          ).json() == {"ai_allowed": True, "immich_allowed": True}


@pytest.mark.parametrize("body", [{"ai_allowed": "no"}, {"ai_allowed": 2}, {"admin": True}, {"ai_allowed": [True]}])
def test_nothing_but_the_two_switches_is_taken(client: TestClient, operator: Account, body: dict[str, Any]) -> None:
    with person("ben"):
        ben_id = listed(client)["ben"]["id"]
        assert client.put(f"/api/accounts/{ben_id}/permissions", json=body).status_code == 422
        assert listed(client)["ben"]["ai_allowed"] is True


def test_a_member_cannot_change_it_not_even_for_themselves(client: TestClient, operator: Account) -> None:
    with person("ben") as ben:
        ben_id = listed(client)["ben"]["id"]
        for target in (ben_id, operator.id):
            denied = ben.put(f"/api/accounts/{target}/permissions", json={"ai_allowed": False})
            assert (denied.status_code, denied.json()["detail"]["code"]) == (403, "operator_only")
        assert new_client().put(f"/api/accounts/{ben_id}/permissions", json={}).status_code == 401
    assert listed(client)["tester"]["ai_allowed"] is True


def test_a_missing_account_is_not_found(client: TestClient, operator: Account) -> None:
    assert client.put("/api/accounts/9999/permissions", json={"ai_allowed": False}).status_code == 404


def test_the_change_is_said_in_the_log_without_anything_else(client: TestClient, operator: Account,
                                                            caplog: pytest.LogCaptureFixture) -> None:
    with person("ben"):
        ben_id = listed(client)["ben"]["id"]
        with caplog.at_level("WARNING", logger="nexdiary.auth"):
            client.put(f"/api/accounts/{ben_id}/permissions", json={"ai_allowed": False})
    assert any("Permissions changed name=ben ai_allowed=no" in record.getMessage() for record in caplog.records)
