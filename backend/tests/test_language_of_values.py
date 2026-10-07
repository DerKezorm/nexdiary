"""The values a person starts with speak the language of the page, also when the account has no language of its own;
an account made by invitation takes the language its page was shown in."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account

from .conftest import TAB, make_account, new_client


@pytest.mark.parametrize(
    ("headers", "first"),
    [
        ({"X-Nexdiary-Language": "de", "Accept-Language": "en-US,en;q=0.9"}, "Stimmung"),
        ({"Accept-Language": "de-DE,de;q=0.9,en;q=0.8"}, "Stimmung"),
        ({"Accept-Language": "fr-FR,de;q=0.8"}, "Stimmung"),
        ({"X-Nexdiary-Language": "en", "Accept-Language": "de-DE"}, "Mood"),
        ({"Accept-Language": "en-GB"}, "Mood"),
        ({}, "Mood"),
    ],
)
def test_the_starting_values_speak_the_language_of_the_page(headers: dict[str, str], first: str) -> None:
    person = make_account("lea")
    assert not person.language
    with new_client(person) as browser:
        browser.headers.update(headers)
        assert browser.get("/api/values").json()[0]["name"] == first


def test_an_account_from_an_invitation_takes_the_language_of_its_page(client: TestClient, operator: Account) -> None:
    link = client.post("/api/invites", json={"email": "", "days": 7}).json()
    token = link["link"].rsplit("/", 1)[-1]
    with TestClient(client.app, base_url="http://testserver", headers={**TAB, "X-Nexdiary-Language": "de"}) as fresh:
        made = fresh.post(f"/api/invite/{token}", json={"name": "mira", "password": "correct horse battery"})
        assert made.status_code == 200, made.text
        assert made.json()["language"] == "de"
    with SessionLocal() as db:
        assert db.query(Account).filter_by(name="mira").one().language == "de"
