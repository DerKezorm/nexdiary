"""Locking a day for good: only a written day, then nothing of it changes again (text, title, tags, values, cover, notes,
photos, draft, deleting), whatever route asks and whether the lock lands first or in between; sharing stays possible;
the lock cannot be taken back; only deleting the account removes the day."""

from __future__ import annotations

import sqlite3
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import closing
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app import clock
from app.config import get_settings
from app.db import SessionLocal
from app.models import Account, Day, Draft, Note, Photo
from app.services import diary, vault

from .conftest import PASSWORD, make_account, new_client, person
from .test_photos import picture

DAY = "2026-10-06"
OTHER = "2026-10-05"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 12, 0, tzinfo=UTC))
    yield


def code(answer: Any) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]


def note(client: TestClient, body: str, day: str = DAY, **extra: Any) -> dict[str, Any]:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": body, "date": day, **extra})
    assert answer.status_code == 201, answer.text
    return answer.json()


def shot(client: TestClient, day: str = DAY, on_note: bool = False) -> dict[str, Any]:
    answer = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": day,
                                                "note": str(on_note).lower()}, content=picture())
    assert answer.status_code == 201, answer.text
    return answer.json()


def written(client: TestClient, day: str = DAY, **extra: Any) -> dict[str, Any]:
    answer = client.put(f"/api/days/{day}", json={"title": "Kastanien", "text": "Ein langer Tag.", **extra})
    assert answer.status_code == 200, answer.text
    return answer.json()


def lock(client: TestClient, day: str = DAY) -> Any:
    return client.post(f"/api/days/{day}/lock")


def locked_day(client: TestClient) -> dict[str, Any]:
    """A written day with a note, a note with a photo, a photo of the day, a draft nobody saved, locked."""
    kept = note(client, "eine notiz")
    photo = shot(client, on_note=True)
    with_photo = note(client, "mit foto", photo_id=photo["id"])
    free = shot(client)
    written(client, tags=["herbst"], cover=f"photo:{free['id']}")
    assert lock(client).status_code == 200
    return {"note": kept, "with_photo": with_photo, "note_photo": photo, "photo": free}


# --- What can be locked -------------------------------------------------------------------------------------------------


def test_a_written_day_is_locked_and_says_so_everywhere(client: TestClient, account: Account) -> None:
    written(client)
    answered = lock(client)
    assert answered.status_code == 200
    day = answered.json()
    assert day["locked"] is True and day["locked_at"] == "2026-10-07T12:00:00+00:00"
    assert client.get(f"/api/days/{DAY}").json()["locked"] is True
    assert client.get("/api/days").json()[0]["locked"] is True
    assert client.post("/api/journal", json={}).json()["days"][0]["locked"] is True
    assert client.post("/api/search", json={"q": "kastanien"}).json()["days"][DAY]["locked"] is True
    # An open day says it is open.
    written(client, OTHER)
    assert client.get(f"/api/days/{OTHER}").json()["locked"] is False
    assert [item["locked"] for item in client.get("/api/days").json()] == [True, False]


def test_only_a_written_day_can_be_locked(client: TestClient, account: Account) -> None:
    assert code(lock(client)) == (404, "not_found")
    note(client, "nur eine notiz")
    assert code(lock(client)) == (404, "not_found")
    # Values and tags do not make a page; neither does a day that was emptied.
    assert client.put(f"/api/days/{DAY}", json={"tags": ["herbst"]}).status_code == 200
    assert code(lock(client)) == (409, "not_written")
    written(client)
    assert client.put(f"/api/days/{DAY}", json={"title": "", "text": " "}).status_code == 200
    assert code(lock(client)) == (409, "not_written")
    assert client.get(f"/api/days/{DAY}").json()["locked"] is False
    assert code(lock(client, "2030-01-01")) == (422, "date_in_future")
    assert code(lock(client, "nonsense")) == (422, "date_invalid")


def test_a_day_that_does_not_open_is_not_locked_blind(client: TestClient, account: Account) -> None:
    written(client)
    with SessionLocal() as db:
        row = db.execute(select(Day)).scalar_one()
        row.content_enc = b"\x01" + b"x" * 40
        db.commit()
    assert code(lock(client)) == (409, "day_unreadable")


def test_a_day_of_another_person_is_not_found_and_stays_open(client: TestClient, account: Account) -> None:
    written(client)
    with person("rita") as rita:
        assert code(lock(rita)) == (404, "not_found")
        written(rita, DAY)
        assert lock(rita).status_code == 200
    # Hers is locked, mine is not.
    assert client.get(f"/api/days/{DAY}").json()["locked"] is False


def test_locking_twice_is_one_lock_and_nothing_undoes_it(client: TestClient, account: Account) -> None:
    written(client)
    first = lock(client).json()
    second = lock(client).json()
    assert second["locked_at"] == first["locked_at"] and second["revision"] == first["revision"]
    for method in ("put", "delete", "patch"):
        assert getattr(client, method)(f"/api/days/{DAY}/lock").status_code in (404, 405)
    # No field of the day writes the lock, however it is asked for.
    for body in ({"locked": False}, {"locked_at": None}, {"title": "x", "locked": False}):
        assert client.put(f"/api/days/{DAY}", json=body).status_code == 422
    assert client.get(f"/api/days/{DAY}").json()["locked"] is True


def test_the_database_itself_keeps_a_locked_row_still(client: TestClient, account: Account) -> None:
    written(client)
    lock(client)
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        for statement in ("UPDATE days SET locked_at = NULL", "UPDATE days SET content_enc = x'00'",
                          "UPDATE days SET revision = revision + 1", "UPDATE days SET updated_at = created_at"):
            with pytest.raises(sqlite3.DatabaseError, match="locked"):
                connection.execute(statement)
        # An open day is not held.
    written(client, OTHER)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("UPDATE days SET revision = revision + 1 WHERE date = ?", (OTHER,))
        connection.commit()


# --- Nothing changes -------------------------------------------------------------------------------------------------


def test_every_route_that_changes_the_day_is_refused(client: TestClient, account: Account) -> None:
    state = locked_day(client)
    before = client.get(f"/api/days/{DAY}").json()
    refused = [
        client.put(f"/api/days/{DAY}", json={"text": "anders"}),
        client.put(f"/api/days/{DAY}", json={"title": "Neu"}),
        client.put(f"/api/days/{DAY}", json={"tags": []}),
        client.put(f"/api/days/{DAY}", json={"cover": "illu:baum.abend.herbst"}),
        client.put(f"/api/days/{DAY}", json={"cover": None}),
        client.put(f"/api/days/{DAY}", json={"written_by": "ai"}),
        client.put(f"/api/days/{DAY}", json={"text": "anders", "base_revision": before["revision"]}),
        client.put(f"/api/days/{DAY}/values", json={"values": {}}),
        client.delete(f"/api/days/{DAY}"),
        client.put(f"/api/days/{DAY}/draft", json={"text": "entwurf", "base_revision": before["revision"]}),
        client.delete(f"/api/days/{DAY}/draft"),
        client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "neu", "date": DAY}),
        client.put(f"/api/notes/{state['note']['id']}", json={"text": "geändert"}),
        client.delete(f"/api/notes/{state['note']['id']}"),
        client.delete(f"/api/notes/{state['with_photo']['id']}"),
        client.post(f"/api/notes/{state['note']['id']}/move", json={"direction": "previous"}),
        client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY}, content=picture()),
        client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY, "note": "true"},
                    content=picture()),
        client.delete(f"/api/photos/{state['photo']['id']}"),
        client.delete(f"/api/photos/{state['note_photo']['id']}"),
    ]
    assert [(answer.status_code, answer.json()["detail"]["code"]) for answer in refused] == [(409, "day_locked")] * len(refused)
    # Nothing moved: the page, the notes, the photos are as they were.
    after = client.get(f"/api/days/{DAY}").json()
    assert after == before
    assert [item["id"] for item in client.get("/api/notes", params={"date": DAY}).json()] == [
        state["note"]["id"], state["with_photo"]["id"]]
    assert {item["id"] for item in client.get("/api/photos", params={"date": DAY}).json()} == {
        state["photo"]["id"], state["note_photo"]["id"]}
    with SessionLocal() as db:
        assert db.scalar(select(text("count(*)")).select_from(Draft)) == 0


def test_a_note_sent_again_after_the_lock_is_the_note_that_stands(client: TestClient, account: Account) -> None:
    kept = note(client, "ein doppelklick")
    written(client)
    lock(client)
    again = client.post("/api/notes", json={"id": kept["id"], "text": "ein doppelklick", "date": DAY})
    assert again.status_code == 200 and again.json()["id"] == kept["id"]
    other = client.post("/api/notes", json={"id": kept["id"], "text": "ein anderer text", "date": DAY})
    assert code(other) == (409, "note_id_taken")


def test_the_locked_day_can_still_be_read_and_shared_and_the_share_taken_back(client: TestClient,
                                                                              account: Account) -> None:
    locked_day(client)
    rita = make_account("rita")
    assert client.get(f"/api/days/{DAY}").status_code == 200
    assert client.get("/api/notes", params={"date": DAY}).status_code == 200
    shared = client.put(f"/api/days/{DAY}/shares", json={"to": [rita.id], "with_values": False, "with_notes": True})
    assert shared.status_code == 200, shared.text
    with new_client(rita) as other:
        assert other.get(f"/api/shared/{account.id}/{DAY}").status_code == 200
        assert other.put(f"/api/shared/{account.id}/{DAY}/heart").status_code in (200, 201, 204)
    assert client.put(f"/api/days/{DAY}/shares", json={"to": [], "with_values": False, "with_notes": False}
                      ).status_code == 200
    with new_client(rita) as other:
        assert other.get(f"/api/shared/{account.id}/{DAY}").status_code == 404


def test_the_days_around_stay_open(client: TestClient, account: Account) -> None:
    locked_day(client)
    written(client, OTHER)
    assert note(client, "neben dran", OTHER)["date"] == OTHER
    assert client.put(f"/api/days/{OTHER}", json={"text": "noch zu ändern"}).status_code == 200
    assert client.delete(f"/api/days/{OTHER}").status_code == 204
    assert shot(client, OTHER)["date"] == OTHER


def test_the_day_being_kept_cannot_take_a_note_once_it_is_locked(client: TestClient, account: Account) -> None:
    assert client.put("/api/me/preferences", json={"timezone": "UTC"}).status_code == 200
    today = "2026-10-07"
    written(client, today)
    lock(client, today)
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "noch eine"})
    assert code(answer) == (409, "day_locked")
    upload = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true"}, content=picture())
    assert code(upload) == (409, "day_locked")


def test_deleting_the_account_still_removes_a_locked_day(client: TestClient, operator: Account) -> None:
    rita = make_account("rita")
    with new_client(rita) as own:
        written(own)
        note(own, "eine notiz")
        shot(own)
        assert lock(own).status_code == 200
    gone = client.request("DELETE", f"/api/accounts/{rita.id}", json={"current_password": PASSWORD})
    assert gone.status_code == 204, gone.text
    with SessionLocal() as db:
        assert db.scalar(select(text("count(*)")).select_from(Day).where(Day.user_id == rita.id)) == 0
        assert db.scalar(select(text("count(*)")).select_from(Note).where(Note.user_id == rita.id)) == 0
        assert db.scalar(select(text("count(*)")).select_from(Photo).where(Photo.user_id == rita.id)) == 0


def test_a_draft_ends_with_the_lock(client: TestClient, account: Account) -> None:
    page = written(client)
    assert client.put(f"/api/days/{DAY}/draft", json={"text": "halb fertig", "base_revision": page["revision"]}
                      ).status_code == 200
    assert client.get(f"/api/days/{DAY}/draft").json() is not None
    lock(client)
    assert client.get(f"/api/days/{DAY}/draft").json() is None


# --- The lock lands between the check and the write ---------------------------------------------------------------------


def lock_elsewhere(day: str = DAY) -> None:
    """Another device locks the day: its own session, committed before the caller goes on."""
    with SessionLocal() as db:
        found = db.execute(select(Account)).scalars().first()
        assert found is not None
        diary.lock_day(db, found.id, vault.dek_for(found.id), day)


def after_the_check(monkeypatch: pytest.MonkeyPatch, nth: int = 1) -> None:
    """The lock comes right after the ``nth`` check of a day (the courtesy before the statement that writes; a photo is
    checked twice, by the route and again before it is kept): only the statement itself can still stop the write."""
    original = diary.ensure_open
    seen: list[int] = []

    def checked(db: Any, account_id: int, day: str) -> None:
        original(db, account_id, day)
        seen.append(1)
        if len(seen) == nth:
            lock_elsewhere(day)

    monkeypatch.setattr(diary, "ensure_open", checked)


def test_a_save_that_meets_the_lock_in_between_is_refused_and_writes_nothing(client: TestClient, account: Account,
                                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    page = written(client)
    real = diary.merge

    def merging(content: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
        lock_elsewhere()
        return real(content, patch)

    monkeypatch.setattr(diary, "merge", merging)
    answer = client.put(f"/api/days/{DAY}", json={"text": "zu spät"})
    assert code(answer) == (409, "day_locked")
    monkeypatch.undo()
    assert client.get(f"/api/days/{DAY}").json()["text"] == page["text"]


def test_a_page_emptied_between_the_check_and_the_lock_is_not_locked(client: TestClient, account: Account,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    """The mark is set onto the revision whose page was seen to be a page: another device that saves meanwhile makes
    the lock look again."""
    written(client)
    real = diary.has_page
    emptied: list[int] = []

    def checking(content: dict[str, Any] | None) -> bool:
        found = real(content)
        if not emptied:
            emptied.append(1)
            with SessionLocal() as db:
                diary.change_day(db, account.id, vault.dek_for(account.id), DAY,
                                 lambda page: {**page, "title": "", "text": ""})
        return found

    monkeypatch.setattr(diary, "has_page", checking)
    assert code(lock(client)) == (409, "not_written")
    monkeypatch.undo()
    assert client.get(f"/api/days/{DAY}").json()["locked"] is False


def writes_between(name: str) -> Callable[[TestClient, dict[str, Any]], Any]:
    def add(client: TestClient, _state: dict[str, Any]) -> Any:
        return client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "zu spät", "date": DAY})

    def change(client: TestClient, state: dict[str, Any]) -> Any:
        return client.put(f"/api/notes/{state['note']['id']}", json={"text": "zu spät"})

    def delete(client: TestClient, state: dict[str, Any]) -> Any:
        return client.delete(f"/api/notes/{state['note']['id']}")

    def draft(client: TestClient, state: dict[str, Any]) -> Any:
        return client.put(f"/api/days/{DAY}/draft", json={"text": "zu spät", "base_revision": state["revision"]})

    def photo(client: TestClient, _state: dict[str, Any]) -> Any:
        return client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY}, content=picture())

    def remove(client: TestClient, state: dict[str, Any]) -> Any:
        return client.delete(f"/api/photos/{state['photo']['id']}")

    def move(client: TestClient, state: dict[str, Any]) -> Any:
        return client.post(f"/api/notes/{state['note']['id']}/move", json={"direction": "next"})

    return {"add": add, "change": change, "delete": delete, "draft": draft, "photo": photo, "remove": remove,
            "move": move}[name]


@pytest.mark.parametrize("name", ["add", "change", "delete", "draft", "photo", "remove", "move"])
def test_a_write_that_meets_the_lock_in_between_is_refused_by_the_statement_itself(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    page = written(client)
    state = {"note": note(client, "vorher"), "photo": shot(client), "revision": page["revision"]}
    before = {
        "notes": sorted(item["id"] for item in client.get("/api/notes", params={"date": DAY}).json()),
        "photos": sorted(item["id"] for item in client.get("/api/photos", params={"date": DAY}).json()),
    }
    # The photo meets the lock after the route's check and the check of the service, the only ones before its statement.
    after_the_check(monkeypatch, nth=2 if name == "photo" else 1)
    answer = writes_between(name)(client, state)
    assert code(answer) == (409, "day_locked"), answer.text
    monkeypatch.undo()
    assert client.get(f"/api/days/{DAY}").json()["locked"] is True
    assert sorted(item["id"] for item in client.get("/api/notes", params={"date": DAY}).json()) == before["notes"]
    assert sorted(item["id"] for item in client.get("/api/photos", params={"date": DAY}).json()) == before["photos"]
    assert client.get("/api/notes", params={"date": DAY}).json()[0]["text"] == "vorher"
    with SessionLocal() as db:
        assert db.scalar(select(text("count(*)")).select_from(Draft)) == 0


def test_saving_and_locking_at_the_same_time_leave_the_last_save_that_was_answered(client: TestClient,
                                                                                  account: Account) -> None:
    written(client)
    answered: list[str] = []
    stop = threading.Event()
    refused: list[tuple[int, str]] = []

    def saving() -> None:
        with new_client(account) as mine:
            for index in range(400):
                if stop.is_set() and refused:
                    break
                body = f"fassung {index}"
                got = mine.put(f"/api/days/{DAY}", json={"text": body})
                if got.status_code == 200:
                    answered.append(body)
                else:
                    refused.append(code(got))
                    break

    def locking() -> None:
        with new_client(account) as other:
            while len(answered) < 3:
                pass
            assert lock(other).status_code == 200
            stop.set()

    threads = [threading.Thread(target=saving), threading.Thread(target=locking)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    final = client.get(f"/api/days/{DAY}").json()
    assert final["locked"] is True
    # Every save that was answered "yes" is in the day, the last of them is the text that stands, and the first no was
    # the lock.
    assert final["text"] == answered[-1]
    assert refused == [(409, "day_locked")]

