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
