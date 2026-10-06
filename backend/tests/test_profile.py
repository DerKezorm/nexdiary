"""A display name per account: changed by the account itself; the name stays what one signs in with."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models import Account


def test_the_own_display_name_is_set_cleaned_and_taken_back(client: TestClient, account: Account) -> None:
    answer = client.put("/api/me/profile", json={"display_name": "  Tess   Ter  "})
    assert answer.status_code == 200
    assert answer.json()["display_name"] == "Tess Ter"
    assert client.get("/api/auth/me").json()["display_name"] == "Tess Ter"
    # The name to sign in with does not change.
    assert client.get("/api/auth/me").json()["name"] == "tester"
    assert client.put("/api/me/profile", json={"display_name": ""}).json()["display_name"] == ""


def test_a_display_name_is_not_too_long_and_has_no_control_characters(client: TestClient, account: Account) -> None:
    assert client.put("/api/me/profile", json={"display_name": "x" * 80}).status_code == 200
    long = client.put("/api/me/profile", json={"display_name": "x" * 81})
    assert (long.status_code, long.json()["detail"]["code"]) == (422, "display_name_too_long")
    control = client.put("/api/me/profile", json={"display_name": "Tess\nTer"})
    assert (control.status_code, control.json()["detail"]["code"]) == (422, "display_name_invalid")
    assert client.get("/api/auth/me").json()["display_name"] == "x" * 80


def test_light_or_dark_is_kept_with_the_account(client: TestClient, account: Account) -> None:
    assert client.get("/api/auth/me").json()["profile"] == {"mode": "system"}
    saved = client.put("/api/me/preferences", json={"mode": "dark"})
    assert saved.status_code == 200 and saved.json() == {"mode": "dark"}
    assert client.get("/api/auth/me").json()["profile"]["mode"] == "dark"
    for wrong in ({"mode": "sepia"}, {"mode": True}, {"palette": "salbei"}, {"mode": ["dark"]}):
        answer = client.put("/api/me/preferences", json=wrong)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "bad_preference", wrong
    assert client.get("/api/auth/me").json()["profile"]["mode"] == "dark", "a refused value changes nothing"


def test_the_profile_is_the_own_account_s_only(client: TestClient, account: Account) -> None:
    from .conftest import person

    with person("mia") as mia:
        assert mia.put("/api/me/preferences", json={"mode": "light"}).status_code == 200
    assert client.get("/api/auth/me").json()["profile"]["mode"] == "system"
