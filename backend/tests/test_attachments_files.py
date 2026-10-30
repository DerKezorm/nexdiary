"""The files of attachments around them: the sweep of the media folder, deleting an account, a backup and its
restore, and that nothing of an attachment lies in the clear anywhere."""

from __future__ import annotations

import io
import os
import secrets
import shutil
import time
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.config import get_settings
from app.db import SessionLocal
from app.models import Account, Attachment
from app.services import attachments, backups, media_sweep, photos, vault

from . import media_samples as samples
from .conftest import DATA_DIR, MEDIA, PASSWORD, make_account, new_client, sign_in
from .test_attachments import DAY, link, media_files, send
from .test_nothing_in_the_clear import every_file, found_in

HOUR = 3600


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 22, 10, 0, tzinfo=UTC))


def age(path: Path, seconds: float, now: float) -> None:
    os.utime(path, (now - seconds, now - seconds))


def test_the_sweep_takes_old_work_folders_and_files_no_attachment_names(client: TestClient, account: Account) -> None:
    now = time.time()
    pdf = send(client, samples.pdf(), "pdf").json()
    for path in MEDIA.iterdir():
        age(path, 3 * HOUR, now)
    kept = set(media_files())
    old = MEDIA / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
    old.mkdir()
    (old / "in").write_bytes(b"plain video")
    age(old / "in", 2 * HOUR, now)
    age(old, 2 * HOUR, now)
    young = MEDIA / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
    young.mkdir()
    (young / "in").write_bytes(b"still coming")
    age(young, 2 * HOUR, now)
    orphan = MEDIA / secrets.token_hex(16)
    orphan.write_bytes(b"x")
    age(orphan, 2 * HOUR, now)
    assert media_sweep.sweep(now) == 2
    assert not old.exists() and young.exists() and not orphan.exists()
    assert set(media_files()) == kept | {young.name}
    assert client.get(f"/api/attachments/{pdf['id']}").status_code == 200
    # A work folder of an upload still running is never taken, however old.
    shutil.rmtree(young)
    with photos.writing():
        busy = MEDIA / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
        busy.mkdir()
        (busy / "in").write_bytes(b"x")
        assert media_sweep.sweep(time.time() + 10 * HOUR) == 0
        assert busy.exists()


def test_the_sweep_keeps_the_file_and_still_of_a_video_that_a_row_names(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    item = send(client, samples.h264_mp4(), "video").json()
    now = time.time()
    for path in MEDIA.iterdir():
        age(path, 5 * HOUR, now)
    before = set(media_files())
    assert len(before) == 2 and item["id"] + ".p" in before
    assert media_sweep.sweep(now) == 0
    assert set(media_files()) == before
    # The row goes in a crash: both go.
    with SessionLocal() as db:
        db.query(Attachment).delete()
        db.commit()
    assert media_sweep.sweep(now) == 2 and media_files() == []


def test_a_failure_after_the_file_was_sealed_leaves_no_file_and_no_work_folder(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_args: Any, **_kwargs: Any) -> int:
        assert media_files(), "the sealed file is there when the row is written"
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(attachments, "_insert", broken)
    with TestClient(client.app, headers=client.headers, cookies=client.cookies, raise_server_exceptions=False) as other:
        answer = send(other, samples.pdf(), "pdf")
    assert answer.status_code == 500
    assert media_files() == []
    with SessionLocal() as db:
        assert db.query(Attachment).count() == 0
    assert not [path for path in MEDIA.iterdir() if path.name.startswith(attachments.WORK_PREFIX)]


def test_deleting_an_account_takes_its_attachments_and_their_files(client: TestClient, account: Account) -> None:
    jule = make_account("jule")
    with new_client(jule) as browser:
        assert send(browser, samples.pdf("jule"), "pdf").status_code == 201
        assert link(browser, "https://example.com/jule").status_code == 201
        assert browser.put(f"/api/days/{DAY}", json={"title": "Fest", "text": "So."}).status_code == 200
        assert browser.post(f"/api/days/{DAY}/lock").status_code == 200
    mine = send(client, samples.pdf("meins"), "pdf").json()
    assert len(media_files()) == 2
    gone = client.request("DELETE", f"/api/accounts/{jule.id}", json={"current_password": PASSWORD})
    assert gone.status_code == 204, gone.text
    with SessionLocal() as db:
        assert [row.uid for row in db.query(Attachment)] == [mine["id"]]
    assert len(media_files()) == 1
    assert client.get(f"/api/attachments/{mine['id']}").status_code == 200


def test_a_backup_carries_the_attachments_and_brings_them_back(client: TestClient, account: Account) -> None:
    data = samples.pdf("Sicherung")
    pdf = send(client, data, "pdf", name="Programm.pdf").json()
    kept = link(client, "https://example.com/sicherung", "Karten").json()
    made = backups.create(kind=backups.MANUAL)
    with SessionLocal() as db:
        file_id = db.query(Attachment).filter_by(uid=pdf["id"]).one().file_id
    with zipfile.ZipFile(made) as unpacked:
        assert backups.MEDIA_PREFIX + file_id in unpacked.namelist()
        assert not any(attachments.WORK_PREFIX in entry for entry in unpacked.namelist())
    assert client.delete(f"/api/attachments/{pdf['id']}").status_code == 204
    assert client.delete(f"/api/attachments/{kept['id']}").status_code == 204
    assert media_files() == []
    shutil.rmtree(backups.pending_folder(), ignore_errors=True)
    backups.stage_restore(made.name)
    assert backups.apply_pending()
    vault.forget()
    vault.startup()
    sign_in(client, account)
    back = client.get("/api/attachments", params={"date": DAY}).json()["attachments"]
    assert [(item["id"], item["name"]) for item in back] == [(pdf["id"], "Programm.pdf"), (kept["id"], "Karten")]
    assert client.get(f"/api/attachments/{pdf['id']}").content == data
    assert back[1]["url"] == "https://example.com/sicherung"


def test_the_limits_of_unpacking_hold_the_largest_video_there_may_be() -> None:
    from app.services import sealed_file

    largest = sealed_file.sealed_size(attachments.VIDEO_MAX_MB * 1024 * 1024)
    assert backups.MEDIA_ENTRY_MAX >= largest
    assert backups.RESTORE_MAX >= 100 * backups.MEDIA_ENTRY_MAX


def test_nothing_of_an_attachment_lies_in_the_clear(client: TestClient, account: Account) -> None:
    """A word in the name of a file, in the bytes of a PDF, in the address and the title of a link, and (with ffmpeg)
    in the tags of a sound: neither the raw database, nor the media folder, nor the log, nor a backup holds it."""
    word = "Qa" + secrets.token_hex(6) + "Zb"
    assert send(client, samples.pdf(f"Inhalt {word}"), "pdf", name=f"Datei {word}.pdf").status_code == 201
    assert link(client, f"https://example.com/{word}?q={word}", f"Titel {word}").status_code == 201
    if attachments.media_tools.available():
        assert send(client, samples.mp3(title=word), "audio", name=f"Ton {word}").status_code == 201
    assert client.post("/api/search", json={"q": word}).json()["results"]
    assert word in client.get("/api/attachments", params={"date": DAY}).text
    # The share of the day, read by the one it is for.
    rike = make_account("rike")
    assert client.put(f"/api/days/{DAY}", json={"title": "Tag", "text": "Text."}).status_code == 200
    assert client.put(f"/api/days/{DAY}/shares", json={"to": [rike.id], "with_values": False,
                                                      "with_notes": False}).status_code == 200
    owner = client.get("/api/auth/me").json()["id"]
    with new_client(rike) as reader:
        shared = reader.get(f"/api/shared/{owner}/{DAY}").json()["attachments"]
        assert word in str(shared)
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{shared[0]['id']}").status_code == 200
    searched = 0
    for path in every_file(Path(DATA_DIR)):
        if path.suffix == ".zip":
            continue
        searched += 1
        assert not found_in(path.read_bytes(), word), path
    assert searched > 3
    name = client.post("/api/backups", json={"note": ""}).json()["name"]
    archive = client.post(f"/api/backups/{name}/download", json={"password": PASSWORD}).content
    with zipfile.ZipFile(io.BytesIO(archive)) as unpacked:
        for entry in unpacked.namelist():
            assert not found_in(unpacked.read(entry), word), entry
    database = get_settings().database_path
    assert not found_in(database.read_bytes(), word)


def test_an_upload_that_breaks_off_leaves_no_plain_file(client: TestClient, account: Account) -> None:
    def chunks() -> Any:
        yield b"%PDF-1.4\n"
        yield b"x" * 10_000
        raise ConnectionError("the browser went away")

    with pytest.raises(ConnectionError):
        client.post("/api/attachments", params={"upload_id": str(uuid.uuid4()), "kind": "pdf", "date": DAY},
                    content=chunks())
    assert media_files() == []
