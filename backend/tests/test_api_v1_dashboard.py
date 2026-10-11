"""``GET /api/v1/dashboard``: a few numbers for a dashboard card, as the token's account and nobody else, and never
anything that is written. The clock is set by the test, never read from the wall."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select

from app import __version__, clock
from app.db import SessionLocal
from app.models import Account, UserKey, utcnow
from app.services import apitokens

from .conftest import make_account, new_client

#: Friday 9 October 2026, noon in Berlin.
NOON = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
FIELDS = {"version", "today_written", "streak", "streak_unit", "entries_month", "notes_month", "next_capsule",
          "next_capsule_days"}


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    moment = [NOON]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    apitokens.forget()
    yield moment
    apitokens.forget()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def token_of(client: TestClient) -> str:
    answer = client.post("/api/api-tokens", json={"name": "nexdeck"})
    assert answer.status_code == 201, answer.text
    return str(answer.json()["secret"])


def zone(client: TestClient, name: str = "Europe/Berlin") -> None:
    assert client.put("/api/me/preferences", json={"timezone": name}).status_code == 200


def page(client: TestClient, day: str, text: str = "ein Tag", **extra: Any) -> None:
    answer = client.put(f"/api/days/{day}", json={"text": text, "written_by": "self", **extra})
    assert answer.status_code == 200, answer.text


def note(client: TestClient, text: str, day: str) -> None:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, "date": day})
    assert answer.status_code == 201, answer.text


def capsule(client: TestClient, to: list[int], opens: str, title: str = "Für Heiligabend",
            text: str = "Wir backen Plätzchen.") -> None:
    answer = client.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": to, "opens_on": opens, "title": title,
                                                "text": text, "photos": []})
    assert answer.status_code == 201, answer.text


def read(client: TestClient, token: str) -> dict[str, Any]:
    answer = client.get("/api/v1/dashboard", headers=bearer(token))
    assert answer.status_code == 200, answer.text
    return dict(answer.json())


@pytest.fixture
def ready(client: TestClient, operator: Account) -> str:
    """The operator ``tester`` with a token; API tokens switched on; the Berlin clock."""
    assert client.put("/api/settings", json={"api_tokens_allowed": True}).status_code == 200
    zone(client)
    return token_of(client)


def test_a_new_account_reads_zeros_and_no_capsule(client: TestClient, ready: str) -> None:
    assert read(client, ready) == {"version": __version__, "today_written": False, "streak": 0, "streak_unit": "days",
                                   "entries_month": 0, "notes_month": 0, "next_capsule": None,
                                   "next_capsule_days": None}


def test_the_numbers_of_the_account(client: TestClient, operator: Account, ready: str) -> None:
    # Three days in a row up to today, one earlier in October, one in September (not this month), tomorrow (not yet).
    for day in ("2026-10-07", "2026-10-08", "2026-10-09", "2026-10-02", "2026-09-30", "2026-10-10"):
        page(client, day)
    # A page with a title and no text is no written page.
    assert client.put("/api/days/2026-10-05", json={"title": "Nur ein Titel"}).status_code == 200
    # Notes of today and of 2 October count; one of tomorrow (allowed) and one of September do not.
    for day in ("2026-10-09", "2026-10-09", "2026-10-02", "2026-09-30", "2026-10-10"):
        note(client, "ein Gedanke", day)
    capsule(client, [operator.id], "2027-03-01")
    capsule(client, [operator.id], "2026-12-24")
    # A capsule the operator wrote only for somebody else is none of the operator's own.
    rita = make_account("rita")
    capsule(client, [rita.id], "2026-10-15")
    assert read(client, ready) == {"version": __version__, "today_written": True, "streak": 3, "streak_unit": "days",
                                   "entries_month": 4, "notes_month": 3, "next_capsule": "2026-12-24",
                                   "next_capsule_days": (date(2026, 12, 24) - date(2026, 10, 9)).days}
    assert (date(2026, 12, 24) - date(2026, 10, 9)).days == 76


def test_today_is_open_until_it_is_written_and_a_missed_day_breaks_the_streak(
        client: TestClient, ready: str, fixed_clock: list[datetime]) -> None:
    page(client, "2026-10-07")
    page(client, "2026-10-08")
    now = read(client, ready)
    assert (now["today_written"], now["streak"]) == (False, 2)
    # Two days later yesterday is missed: the streak is broken, today is open again.
    fixed_clock[0] = datetime(2026, 10, 11, 10, 0, tzinfo=UTC)
    now = read(client, ready)
    assert (now["today_written"], now["streak"]) == (False, 0)


def test_a_weekly_goal_counts_weeks_and_says_so(client: TestClient, ready: str) -> None:
    assert client.put("/api/me/preferences", json={"goal": 3}).status_code == 200
    for day in ("2026-10-05", "2026-10-06", "2026-10-07", "2026-09-28", "2026-09-29", "2026-09-30"):
        page(client, day)
    now = read(client, ready)
    assert (now["streak_unit"], now["streak"]) == ("weeks", 2)


def test_the_streak_is_the_one_the_interface_shows(client: TestClient, ready: str) -> None:
    for day in ("2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"):
        page(client, day)
    shown = client.get("/api/today").json()
    now = read(client, ready)
    assert now["streak"] == shown["streak"] == 4
    assert now["today_written"] is shown["series"]["today_done"] is False
    page(client, "2026-10-09")
    shown = client.get("/api/today").json()
    now = read(client, ready)
    assert now["streak"] == shown["streak"] == 5
    assert now["today_written"] is shown["series"]["today_done"] is True


def test_the_day_follows_the_time_zone_of_the_account(client: TestClient, ready: str,
                                                      fixed_clock: list[datetime]) -> None:
    # 23:30 on 31 October in UTC is already November in Berlin: "today" and the month follow the account's zone.
    fixed_clock[0] = datetime(2026, 10, 31, 23, 30, tzinfo=UTC)
    page(client, "2026-11-01")
    now = read(client, ready)
    assert (now["today_written"], now["entries_month"]) == (True, 1)
    zone(client, "America/New_York")
    now = read(client, ready)
    assert (now["today_written"], now["entries_month"]) == (False, 0)


def test_another_account_changes_nothing(client: TestClient, operator: Account, ready: str) -> None:
    page(client, "2026-10-09")
    note(client, "meins", "2026-10-09")
    capsule(client, [operator.id], "2026-12-24")
    before = read(client, ready)
    assert (before["streak"], before["entries_month"], before["notes_month"]) == (1, 1, 1)
    rita = make_account("rita")
    with new_client(rita) as other:
        zone(other)
        for day in ("2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"):
            page(other, day)
        for _ in range(3):
            note(other, "ritas gedanke", "2026-10-09")
        capsule(other, [rita.id], "2026-10-20")
        assert read(client, ready) == before
        # Her own token reads her own numbers, not the operator's.
        mine = read(other, token_of(other))
        assert (mine["streak"], mine["entries_month"], mine["notes_month"], mine["next_capsule"]) == (
            4, 4, 3, "2026-10-20")


def test_a_capsule_sent_to_the_account_counts_by_its_day_only_and_a_blocked_sender_s_does_not(
        client: TestClient, operator: Account, ready: str) -> None:
    capsule(client, [operator.id], "2026-12-24")
    rita = make_account("rita")
    with new_client(rita) as other:
        zone(other)
        # One she sent to the operator; one only for herself, which is none of the operator's.
        capsule(other, [operator.id], "2026-11-11", title="Von Rita", text="Rita schreibt")
        capsule(other, [rita.id], "2026-10-10")
        now = read(client, ready)
        assert (now["next_capsule"], now["next_capsule_days"]) == ("2026-11-11", 33)
    with SessionLocal() as db:
        row = db.get(Account, rita.id)
        assert row is not None
        row.blocked_at = utcnow()
        db.commit()
    assert read(client, ready)["next_capsule"] == "2026-12-24"


def test_a_capsule_that_opened_is_no_longer_the_next_one(client: TestClient, operator: Account, ready: str,
                                                         fixed_clock: list[datetime]) -> None:
    capsule(client, [operator.id], "2026-10-20")
    capsule(client, [operator.id], "2026-12-24")
    assert read(client, ready)["next_capsule"] == "2026-10-20"
    # Midnight of the day in Berlin (UTC+2) is 22:00 UTC the evening before.
    fixed_clock[0] = datetime(2026, 10, 19, 21, 59, tzinfo=UTC)
    assert read(client, ready)["next_capsule"] == "2026-10-20"
    fixed_clock[0] = datetime(2026, 10, 19, 22, 0, tzinfo=UTC)
    now = read(client, ready)
    assert (now["next_capsule"], now["next_capsule_days"]) == ("2026-12-24", 65)


def test_nothing_that_is_written_leaves(client: TestClient, operator: Account, ready: str) -> None:
    marks = ["Geheimtext-Alpha", "Titel-Beta", "Notiz-Gamma", "Kapseltitel-Delta", "Kapseltext-Epsilon",
             "Schlagwort-Zeta", "Heiligabend-Eta"]
    mood = client.get("/api/values").json()[0]
    page(client, "2026-10-09", marks[0], title=marks[1], tags=[marks[5]])
    assert client.put("/api/days/2026-10-09/values", json={"values": {mood["id"]: 9}}).status_code == 200
    note(client, marks[2], "2026-10-09")
    capsule(client, [operator.id], "2026-12-24", title=marks[3], text=marks[4])
    rita = make_account("rita")
    with new_client(rita) as other:
        zone(other)
        capsule(other, [operator.id], "2026-11-11", title=marks[6], text=marks[6])
    answer = client.get("/api/v1/dashboard", headers=bearer(ready))
    assert answer.status_code == 200
    assert set(answer.json()) == FIELDS
    for mark in (*marks, mood["name"], "rita", "tester"):
        assert mark not in answer.text, mark
    assert all(isinstance(value, str | int | bool | None) for value in answer.json().values())


def test_the_walls_of_the_other_routes_hold_here_too(client: TestClient, ready: str) -> None:
    path = "/api/v1/dashboard"
    # No token, a wrong one, one that is no bearer token: nothing.
    for headers in ({}, bearer("nxa_" + "x" * 43), bearer("not-a-token"), {"Authorization": ready}):
        with new_client() as bare:
            answer = bare.get(path, headers=headers)
            assert answer.status_code == 401 and answer.json()["detail"]["code"] == "token_invalid", headers
    # The session of the browser counts for nothing; a token in the address is no token.
    assert client.get(path).status_code == 401
    assert client.get(path, params={"token": ready}).status_code == 401
    # A web page is refused before anything else, also with a good token.
    answer = client.get(path, headers={**bearer(ready), "Origin": "https://example.com"})
    assert answer.status_code == 403 and answer.json()["detail"]["code"] == "origin_refused"
    # Only reading.
    assert client.post(path, headers=bearer(ready)).status_code == 405
    # The operator switches the tokens off: none reads.
    assert client.put("/api/settings", json={"api_tokens_allowed": False}).status_code == 200
    answer = client.get(path, headers=bearer(ready))
    assert answer.status_code == 401 and answer.json()["detail"]["code"] == "api_off"


def test_the_brake_holds_here_too(client: TestClient, ready: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(apitokens, "PER_MINUTE", 2)
    assert client.get("/api/v1/dashboard", headers=bearer(ready)).status_code == 200
    assert client.get("/api/v1/dashboard", headers=bearer(ready)).status_code == 200
    slow = client.get("/api/v1/dashboard", headers=bearer(ready))
    assert slow.status_code == 429 and slow.headers["retry-after"] == "60"
    assert slow.json()["detail"]["code"] == "slow_down"


def test_reading_makes_no_data_key(client: TestClient, operator: Account, ready: str) -> None:
    # Making the token made a key; with none, asking still makes none (the API only reads).
    with SessionLocal() as db:
        db.execute(delete(UserKey).where(UserKey.user_id == operator.id))
        db.commit()
    assert read(client, ready)["streak"] == 0
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UserKey).where(UserKey.user_id == operator.id)) == 0
