"""The sweep of the media folder: files no row names, older than an hour, go; everything a row names stays, also when
it is old, and so does whatever may still be waiting for its row (young, or written by an operation still running).
Only names of the media folder's own form are touched."""

from __future__ import annotations

import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db import SessionLocal
from app.models import Account, CapsulePhoto
from app.services import media_sweep, photos

from .conftest import MEDIA
from .test_capsules import jpeg

HOUR = 3600


def lay(name: str, age: float, now: float) -> Path:
    path = MEDIA / name
    path.write_bytes(secrets.token_bytes(64))
    os.utime(path, (now - age, now - age))
    return path


def age_everything(now: float, age: float = 3 * HOUR) -> None:
    for path in MEDIA.iterdir():
        os.utime(path, (now - age, now - age))


def names() -> set[str]:
    return {path.name for path in MEDIA.iterdir()}


def test_old_files_without_a_row_go_and_nothing_else(client: TestClient, account: Account) -> None:
    now = time.time()
    photo = client.post("/api/photos", params={"upload_id": str(uuid.uuid4())}, content=jpeg())
    assert photo.status_code == 201, photo.text
    chosen = client.post("/api/capsules/photos", params={"upload_id": str(uuid.uuid4())}, content=jpeg()).json()["id"]
    me = client.get("/api/auth/me").json()["id"]
    sealed = client.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [me], "opens_on": "2060-12-24",
                                                "title": "x", "text": "y",
                                                "photos": [client.post("/api/capsules/photos",
                                                                       params={"upload_id": str(uuid.uuid4())},
                                                                       content=jpeg()).json()["id"]]})
    assert sealed.status_code == 201, sealed.text
    age_everything(now)
    kept = names()
    assert len(kept) == 6 and {chosen, chosen + ".p", photo.json()["id"]} <= kept
    orphan = secrets.token_hex(16)
    lay(orphan, 2 * HOUR, now)
    lay(orphan + ".p", 2 * HOUR, now)
    young = secrets.token_hex(16)
    lay(young, 30 * 60, now)
    part = lay(f".{secrets.token_hex(16)}.123-456.part", 2 * HOUR, now)
    fresh_part = lay(f".{secrets.token_hex(16)}.123-789.part", 60, now)
    for other in ("README", "notes.txt", "x" * 50, "short"):
        lay(other, 5 * HOUR, now)
    assert media_sweep.sweep(now) == 3
    assert names() == kept | {young, fresh_part.name, "README", "notes.txt", "x" * 50, "short"}
    assert not part.exists()
    # A second round finds nothing more.
    assert media_sweep.sweep(now) == 0


def test_a_photo_whose_row_went_in_a_crash_goes_with_its_smaller_copy(client: TestClient, account: Account) -> None:
    now = time.time()
    me = client.get("/api/auth/me").json()["id"]
    chosen = client.post("/api/capsules/photos", params={"upload_id": str(uuid.uuid4())}, content=jpeg()).json()["id"]
    made = client.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [me], "opens_on": "2060-12-24",
                                              "title": "x", "text": "y", "photos": [chosen]})
    assert made.status_code == 201
    age_everything(now)
    before = names()
    with SessionLocal() as db:
        lost = db.scalars(delete(CapsulePhoto).returning(CapsulePhoto.uid)).all()
        db.commit()
    assert len(lost) == 1
    assert media_sweep.sweep(now) == 2
    assert names() == before - {lost[0], lost[0] + ".p"}


def test_files_of_an_operation_still_writing_stay_however_old(monkeypatch: pytest.MonkeyPatch) -> None:
    """A capsule with many photos writes them all before its transaction: while it runs, nothing younger than its
    start goes, also past the hour."""
    now = time.time()
    waiting = secrets.token_hex(16)
    lay(waiting, 2 * HOUR, now)
    before_it = secrets.token_hex(16)
    lay(before_it, 4 * HOUR, now)
    monkeypatch.setitem(photos._writing, -1, now - 3 * HOUR)
    assert photos.oldest_writing() == now - 3 * HOUR
    assert media_sweep.sweep(now) == 1
    assert names() == {waiting}
    monkeypatch.delitem(photos._writing, -1)
    assert media_sweep.sweep(now) == 1


def test_the_marker_holds_while_the_operation_runs_and_goes_after() -> None:
    seen: list[float | None] = []

    @photos.writes
    def operation() -> None:
        seen.append(photos.oldest_writing())

    start = time.time()
    operation()
    assert seen[0] is not None and seen[0] >= start - 1
    assert photos.oldest_writing() is None


def test_a_row_written_since_the_first_look_keeps_its_file(monkeypatch: pytest.MonkeyPatch) -> None:
    now = time.time()
    uid = secrets.token_hex(16)
    lay(uid, 2 * HOUR, now)
    real = media_sweep._named
    calls: list[int] = []

    def late_row(db: Any, uids: Any) -> set[str]:
        calls.append(1)
        # The first look sees nothing; by the second, a transaction has written the row.
        return set() if len(calls) == 1 else {uid} | real(db, uids)

    monkeypatch.setattr(media_sweep, "_named", late_row)
    assert media_sweep.sweep(now) == 0
    assert names() == {uid}


@pytest.mark.skipif(os.name == "nt", reason="links need rights on Windows")
def test_a_link_is_never_followed_or_removed(tmp_path: Path) -> None:
    now = time.time()
    outside = tmp_path / "elsewhere"
    outside.write_bytes(b"keep")
    link = MEDIA / secrets.token_hex(16)
    link.symlink_to(outside)
    os.utime(link, (now - 5 * HOUR, now - 5 * HOUR), follow_symlinks=False)
    assert media_sweep.sweep(now) == 0
    assert link.is_symlink() and outside.read_bytes() == b"keep"
