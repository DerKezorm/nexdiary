"""Writing a day up: the draft is kept while typing and comes back after a reload, a save from a second device does
not silently overwrite a newer page, a double click saves once, and the cover is always one that can be drawn."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import clock
from app.db import SessionLocal
from app.models import Account, Day, Draft

from .conftest import new_client, person

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
DATE = "2026-10-06"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    moment = [NOON]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    yield moment


def count(model: Any) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)


def save(client: TestClient, base: int, **fields: Any) -> Any:
    return client.put(f"/api/days/{DATE}", json={"base_revision": base, **fields})


# --- Drafts ---------------------------------------------------------------------------------------------------------


def test_a_draft_is_kept_comes_back_and_ends_with_the_save(client: TestClient, account: Account,
                                                          fixed_clock: list[datetime]) -> None:
    nothing = client.get(f"/api/days/{DATE}/draft")
    assert nothing.status_code == 200 and nothing.json() is None
    kept = client.put(f"/api/days/{DATE}/draft", json={"title": "Kastanien", "text": "Die Nacht war kurz.",
                                                       "tags": ["Herbst"], "cover": "illu:wald.abend.herbst",
                                                       "base_revision": -1})
    assert kept.status_code == 200
    back = client.get(f"/api/days/{DATE}/draft").json()
    assert back == {"title": "Kastanien", "text": "Die Nacht war kurz.", "tags": ["herbst"],
                    "cover": "illu:wald.abend.herbst", "base_revision": -1, "updated_at": NOON.isoformat()}
    # A draft is not a page: the day is not written yet, the streak does not count it.
    assert client.get(f"/api/days/{DATE}").status_code == 404
    assert client.get("/api/today").json()["streak"] == 0
    # Typing on: the draft is replaced, not added to.
    client.put(f"/api/days/{DATE}/draft", json={"text": "Die Nacht war kurz. Der Hund bellte.", "base_revision": -1})
    assert count(Draft) == 1
    day = save(client, -1, title="Kastanien", text="Die Nacht war kurz. Der Hund bellte.", written_by="self")
    assert day.status_code == 200 and day.json()["revision"] == 0
    assert client.get(f"/api/days/{DATE}/draft").json() is None and count(Draft) == 0


def test_a_change_without_text_keeps_the_draft(client: TestClient, account: Account) -> None:
    client.put(f"/api/days/{DATE}/draft", json={"text": "halb fertig", "base_revision": -1})
    assert client.put(f"/api/days/{DATE}", json={"tags": ["arbeit"]}).status_code == 200
    assert client.get(f"/api/days/{DATE}/draft").json()["text"] == "halb fertig"
    assert client.delete(f"/api/days/{DATE}/draft").status_code == 204
    assert count(Draft) == 0


def test_a_draft_keeps_the_limits_of_a_page_and_only_known_covers(client: TestClient, account: Account) -> None:
    for body, code in (
        ({"text": "x" * 100_001, "base_revision": -1}, "text_too_long"),
        ({"title": "x" * 201, "base_revision": -1}, "title_too_long"),
        ({"cover": "illu:mond.abend.herbst", "base_revision": -1}, "cover_unknown"),
        ({"cover": "photo:" + "a" * 32, "base_revision": -1}, "not_found"),
        ({"text": "x"}, "invalid_input"),
        ({"text": "x", "base_revision": -2}, "invalid_input"),
    ):
        answer = client.put(f"/api/days/{DATE}/draft", json=body)
        assert answer.json()["detail"]["code"] == code, body
    assert count(Draft) == 0


def test_a_draft_is_only_its_writers(client: TestClient, account: Account) -> None:
    client.put(f"/api/days/{DATE}/draft", json={"text": "nur meins", "base_revision": -1})
    with person("bert") as bert:
        assert bert.get(f"/api/days/{DATE}/draft").json() is None
        assert bert.delete(f"/api/days/{DATE}/draft").status_code == 204
    assert client.get(f"/api/days/{DATE}/draft").json()["text"] == "nur meins"


# --- Two devices, two clicks ----------------------------------------------------------------------------------------


def test_a_newer_page_from_another_device_is_not_overwritten_unseen(client: TestClient, account: Account) -> None:
    first = save(client, -1, text="Vom Handy.").json()
    assert first["revision"] == 0
    # The laptop started from "no page" and saves later: refused, with the revision that stands.
    late = save(client, -1, text="Vom Laptop.")
    assert late.status_code == 409 and late.json()["detail"] == {
        "code": "day_changed", "message": "This day was changed meanwhile.", "revision": 0}
    assert client.get(f"/api/days/{DATE}").json()["text"] == "Vom Handy."
    # Having seen it, the laptop saves onto it on purpose.
    onto = save(client, 0, text="Vom Laptop, mit Absicht.")
    assert onto.status_code == 200 and onto.json()["revision"] == 1
    # A page deleted meanwhile is a change too.
    assert client.delete(f"/api/days/{DATE}").status_code == 204
    assert save(client, 1, text="x").json()["detail"]["revision"] == -1


def test_a_double_click_on_save_writes_once(client: TestClient, account: Account) -> None:
    start = threading.Barrier(2, timeout=10)
    codes: list[int] = []

    def click() -> None:
        with new_client(account) as browser:
            start.wait()
            codes.append(save(browser, -1, text="Einmal gespeichert.", written_by="self").status_code)

    threads = [threading.Thread(target=click) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(codes) == [200, 409]
    assert count(Day) == 1
    assert client.get(f"/api/days/{DATE}").json()["revision"] == 0


def test_without_a_base_revision_changes_go_on_as_before(client: TestClient, account: Account) -> None:
    """Ratings and tags from "Today" change only their own fields and need no revision."""
    save(client, -1, text="Ein Text.")
    assert client.put(f"/api/days/{DATE}", json={"tags": ["arbeit"]}).json()["revision"] == 1
    assert client.get(f"/api/days/{DATE}").json()["text"] == "Ein Text."


# --- Covers ---------------------------------------------------------------------------------------------------------


def test_a_day_always_shows_a_cover_and_keeps_the_chosen_one(client: TestClient, account: Account) -> None:
    day = save(client, -1, text="Urlaub!", tags=["urlaub"]).json()
    assert day["cover"] == "illu:strand.abend.herbst" and day["cover_chosen"] is False
    chosen = client.put(f"/api/days/{DATE}", json={"cover": "illu:leuchtturm.nacht.winter"}).json()
    assert chosen["cover"] == "illu:leuchtturm.nacht.winter" and chosen["cover_chosen"] is True
    assert client.put(f"/api/days/{DATE}", json={"tags": ["arbeit"]}).json()["cover"] == "illu:leuchtturm.nacht.winter"
    back = client.put(f"/api/days/{DATE}", json={"cover": None}).json()
    assert back["cover"] == "illu:stadt.abend.herbst" and back["cover_chosen"] is False
    listed = client.get("/api/days").json()
    assert listed[0]["cover"] == "illu:stadt.abend.herbst"


def test_any_save_from_the_writing_page_ends_the_draft(client: TestClient, account: Account) -> None:
    """Only the title changed here: the save carries no text, the draft ends all the same."""
    save(client, -1, text="Ein Text.")
    client.put(f"/api/days/{DATE}/draft", json={"title": "Neu", "text": "Ein Text.", "base_revision": 0})
    assert save(client, 0, title="Neu").status_code == 200
    assert client.get(f"/api/days/{DATE}/draft").json() is None
