"""Limits a person cannot pass: storage per person over photos and drafts (the operator sets it, counted in the
statement that writes), brakes per minute on uploads, drafts, new days and new notes, and the places for unpacking
pictures (taken before a body is read)."""

from __future__ import annotations

import io
import threading
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from app import clock
from app.config import get_settings
from app.db import SessionLocal
from app.models import Account, Draft, Photo
from app.services import brakes, pictures, quota, settings_service

from .conftest import new_client

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    # The minute of the brakes stands still: a slow machine cannot let it run out in the middle of a test.
    monkeypatch.setattr(clock, "monotonic", lambda: 1000.0)
    yield


def png(seed: int = 0, size: int = 200) -> bytes:
    image = Image.effect_noise((size, size), 40 + seed).convert("RGB")
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def upload(client: TestClient, data: bytes, upload_id: str | None = None) -> object:
    return client.post("/api/photos", params={"upload_id": upload_id or str(uuid.uuid4())}, content=data)


def count(model: object) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)


def set_storage(client: TestClient, gb: float) -> None:
    answer = client.put("/api/settings", json={"storage_per_person_gb": gb})
    assert answer.status_code == 200 and answer.json()["storage_per_person_gb"] == gb


# --- Storage per person ---------------------------------------------------------------------------------------------


def test_storage_per_person_is_five_gb_unless_the_operator_says_otherwise(client: TestClient, account: Account) -> None:
    assert client.get("/api/settings").json()["storage_per_person_gb"] == 5
    with SessionLocal() as db:
        assert quota.limit_bytes(db) == 5 * quota.GB
    set_storage(client, 0)
    with SessionLocal() as db:
        assert quota.limit_bytes(db) is None
    assert client.put("/api/settings", json={"storage_per_person_gb": -1}).status_code == 422


def test_a_photo_past_the_storage_limit_is_refused_and_leaves_no_files(client: TestClient, account: Account) -> None:
    assert upload(client, png(1)).status_code == 201
    with SessionLocal() as db:
        held = quota.used(db, account.id)
    # Room for what is there and a little more, not for another photo of the same kind.
    set_storage(client, (held * 1.5) / quota.GB)
    refused = upload(client, png(2))
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "storage_full"
    assert count(Photo) == 1
    assert len(list(get_settings().media_dir.iterdir())) == 2
    # The limit is each person's own.
    with new_client(_member("bert")) as bert:
        assert upload(bert, png(3)).status_code == 201


def _member(name: str) -> Account:
    from .conftest import make_account

    return make_account(name)


def test_two_uploads_at_once_cannot_pass_the_limit_together(client: TestClient, account: Account) -> None:
    first = png(4)
    assert upload(client, first).status_code == 201
    with SessionLocal() as db:
        held = quota.used(db, account.id)
    set_storage(client, (held * 2.5) / quota.GB)
    start = threading.Barrier(3, timeout=10)
    codes: list[int] = []

    def send(seed: int) -> None:
        with new_client(account) as browser:
            start.wait()
            codes.append(upload(browser, png(seed)).status_code)

    threads = [threading.Thread(target=send, args=(seed,)) for seed in (5, 6, 7)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(codes) == [201, 409, 409]
    with SessionLocal() as db:
        assert quota.used(db, account.id) <= quota.limit_bytes(db)


def test_drafts_count_towards_the_storage_and_replacing_one_does_not_count_it_twice(client: TestClient,
                                                                                    account: Account) -> None:
    text = "x" * 6000
    assert client.put("/api/days/2026-10-06/draft", json={"text": text, "base_revision": -1}).status_code == 200
    with SessionLocal() as db:
        held = quota.used(db, account.id)
        settings_service.save(db, {"storage_per_person_gb": (held + 3000) / quota.GB})
    # The same draft again, a little longer: it replaces itself.
    assert client.put("/api/days/2026-10-06/draft", json={"text": text + "y" * 100, "base_revision": -1}).status_code == 200
    other = client.put("/api/days/2026-10-05/draft", json={"text": text, "base_revision": -1})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "storage_full"
    assert count(Draft) == 1


# --- Brakes ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "code"),
    [("upload", "too_many_uploads"), ("draft", "slow_down_writing"), ("new_day", "slow_down_writing"),
     ("new_note", "slow_down_writing")],
)
def test_a_brake_per_person_and_minute(client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch,
                                       kind: str, code: str) -> None:
    monkeypatch.setitem(brakes.LIMITS, kind, 2)

    def act(number: int) -> object:
        if kind == "upload":
            return upload(client, png(number))
        if kind == "draft":
            return client.put("/api/days/2026-10-06/draft", json={"text": f"t{number}", "base_revision": -1})
        if kind == "new_day":
            return client.put(f"/api/days/2026-10-0{number + 1}", json={"text": "x"})
        return client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": f"n{number}"})

    assert all(act(number).status_code in (200, 201) for number in range(2))
    third = act(2)
    assert third.status_code == 429 and third.json()["detail"]["code"] == code
    assert third.headers["retry-after"] == "60"
    # Another person is not slowed by this one.
    with new_client(_member("bert")) as bert:
        assert bert.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "x"}).status_code == 201


def test_changing_a_day_that_exists_is_no_new_day(client: TestClient, account: Account,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(brakes.LIMITS, "new_day", 1)
    assert client.put("/api/days/2026-10-06", json={"text": "a"}).status_code == 200
    for word in ("b", "c", "d"):
        assert client.put("/api/days/2026-10-06", json={"text": word}).status_code == 200
    assert client.put("/api/days/2026-10-05", json={"text": "a"}).status_code == 429


# --- Unpacking ------------------------------------------------------------------------------------------------------


def test_pictures_are_unpacked_one_at_a_time_by_default_and_never_larger_than_36_mp() -> None:
    assert get_settings().decode_slots == 1 and pictures.slots() == 1
    assert pictures.MAX_PIXELS <= 36_000_000


def test_when_every_place_is_taken_an_upload_is_turned_away_before_its_body_is_read(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pictures, "WAITING", 0)
    read: list[int] = []
    original = pictures.read_body

    async def counting(request: object) -> bytes:
        read.append(1)
        return await original(request)

    monkeypatch.setattr(pictures, "read_body", counting)
    with pictures.admitted():
        answer = upload(client, png(8))
        assert answer.status_code == 503 and answer.json()["detail"]["code"] == "busy"
        assert answer.headers["retry-after"] == "5"
        avatar = client.put("/api/auth/avatar", content=png(9))
        assert avatar.status_code == 503
    assert read == []
    assert upload(client, png(8)).status_code == 201 and read == [1]


# --- Texts count towards the storage (B10) ---------------------------------------------------------------------------------


def set_room(held_plus: int) -> None:
    """The limit: what one person holds now (every account here holds the same) and ``held_plus`` bytes more."""
    with SessionLocal() as db:
        settings_service.save(db, {"storage_per_person_gb": held_plus / quota.GB})


def test_days_notes_values_and_own_questions_count_as_the_bytes_of_their_sealed_texts(
    client: TestClient, account: Account
) -> None:
    with SessionLocal() as db:
        empty = quota.used(db, account.id)
    assert client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag. " * 40}).status_code == 200
    with SessionLocal() as db:
        after_day = quota.used(db, account.id)
    assert after_day > empty + 600
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia " * 50}).status_code == 201
    with SessionLocal() as db:
        after_note = quota.used(db, account.id)
    assert after_note > after_day + 400
    assert client.post("/api/values", json={"name": "Garten", "low": "kahl", "high": "bunt"}).status_code in (200, 201)
    with SessionLocal() as db:
        after_value = quota.used(db, account.id)
    assert after_value > after_note
    assert client.post("/api/prompts/own", json={"text": "Was war heute schön?"}).status_code in (200, 201)
    with SessionLocal() as db:
        assert quota.used(db, account.id) > after_value
    # Somebody else's texts are somebody else's.
    with new_client(_member("bert")) as bert:
        bert.put("/api/days/2026-10-06", json={"text": "x" * 5000})
    with SessionLocal() as db:
        assert quota.used(db, account.id) > after_value
        assert quota.used(db, account.id) < after_value + 2000


def test_a_page_past_the_storage_limit_is_refused_and_leaves_the_page_as_it_was(
    client: TestClient, account: Account
) -> None:
    assert client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "kurz"}).status_code == 200
    before = client.get("/api/days/2026-10-06").json()
    with SessionLocal() as db:
        set_room(quota.used(db, account.id) + 2000)
    refused = client.put("/api/days/2026-10-06", json={"text": "x" * 5000})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "storage_full"
    assert client.get("/api/days/2026-10-06").json() == before, "nothing of it was kept"
    # A new day, a note, a value: the same.
    assert client.put("/api/days/2026-10-05", json={"text": "x" * 5000}).status_code == 409
    assert client.get("/api/days/2026-10-05").status_code == 404
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "y" * 4000})
    assert note.status_code == 409 and note.json()["detail"]["code"] == "storage_full"
    assert client.get("/api/notes", params={"date": "2026-10-06"}).json() == []
    # What fits still goes in.
    assert client.put("/api/days/2026-10-06", json={"text": "etwas mehr"}).status_code == 200
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "klein"}).status_code == 201


def test_a_note_changed_past_the_limit_is_refused_and_a_shorter_one_is_not(client: TestClient, account: Account) -> None:
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "z" * 3000}).json()
    with SessionLocal() as db:
        set_room(quota.used(db, account.id) + 500)
    longer = client.put(f"/api/notes/{note['id']}", json={"text": "z" * 4900})
    assert longer.status_code == 409 and longer.json()["detail"]["code"] == "storage_full"
    assert client.get("/api/notes", params={"date": note["date"]}).json()[0]["text"] == "z" * 3000
    # A person above a lowered limit can still make a page shorter.
    with SessionLocal() as db:
        set_room(1000)
    assert client.put(f"/api/notes/{note['id']}", json={"text": "z" * 1000}).status_code == 200
    assert client.put(f"/api/notes/{note['id']}", json={"text": "z" * 2000}).status_code == 409


def test_writes_of_texts_at_the_same_moment_cannot_pass_the_limit_together(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(brakes.LIMITS, "new_note", 100)
    with SessionLocal() as db:
        set_room(quota.used(db, account.id) + 2700)
    start = threading.Barrier(6, timeout=10)
    codes: list[int] = []

    def send(number: int) -> None:
        with new_client(account) as browser:
            start.wait()
            answer = browser.post("/api/notes", json={"id": str(uuid.uuid4()), "text": f"{number}" * 1000})
            codes.append(answer.status_code)

    threads = [threading.Thread(target=send, args=(number,)) for number in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert 1 <= codes.count(201) <= 2 and codes.count(201) + codes.count(409) == 6, codes
    with SessionLocal() as db:
        assert quota.used(db, account.id) <= quota.limit_bytes(db)  # type: ignore[operator]


def test_values_and_own_questions_stop_at_the_limit_too(client: TestClient, account: Account) -> None:
    created = client.post("/api/values", json={"name": "Garten", "low": "kahl", "high": "bunt"})
    assert created.status_code == 201
    value_id = created.json()["id"]
    assert client.post("/api/prompts/own", json={"text": "Was war heute schön?"}).status_code == 201
    with SessionLocal() as db:
        set_room(quota.used(db, account.id) + 60)
    big = {"name": "N" * 40, "low": "l" * 30, "high": "h" * 30, "hint": "i" * 80}
    refused = client.post("/api/values", json=big)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "storage_full"
    changed = client.put(f"/api/values/{value_id}", json=big)
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "storage_full"
    own = client.post("/api/prompts/own", json={"text": "Wer hat dich heute zum Lachen gebracht, und worüber genau? " * 3})
    assert own.status_code == 409 and own.json()["detail"]["code"] == "storage_full"
    assert [item["name"] for item in client.get("/api/values").json()].count("N" * 40) == 0
    assert len(client.get("/api/prompts").json()["own"]) == 1
    # What fits still goes in.
    assert client.put(f"/api/values/{value_id}", json={"name": "Gärtchen"}).status_code == 200
