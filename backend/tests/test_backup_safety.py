"""What a restore takes from an archive: only a database this nexdiary can start with, only plain file names inside the
media folder, and never more bytes than a backup may hold, counted while reading. Every archive here is small."""

from __future__ import annotations

import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, text

from app import db as database
from app.models import Account
from app.services import backups

from .conftest import PASSWORD

#: A name the backup list takes for one of its own.
NAME = "nexdiary-2020-01-01-000000.zip"


def made_here() -> dict[str, bytes]:
    """The entries of a real backup of the test database."""
    path = backups.create(kind=backups.MANUAL)
    with zipfile.ZipFile(path) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    path.unlink()
    return entries


def write_archive(entries: dict[str, bytes], name: str = NAME) -> str:
    (backups.folder() / name).unlink(missing_ok=True)
    with zipfile.ZipFile(backups.folder() / name, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry, data in entries.items():
            archive.writestr(entry, data)
    return name


def with_schema(database_bytes: bytes, version: int, tmp_path: Path) -> bytes:
    copy = tmp_path / "copy.db"
    copy.write_bytes(database_bytes)
    with sqlite3.connect(copy) as connection:
        connection.execute(f"PRAGMA user_version = {version}")
    connection.close()
    return copy.read_bytes()


def with_media(entries: dict[str, bytes], files: dict[str, bytes]) -> dict[str, bytes]:
    import hashlib

    manifest = json.loads(entries[backups.MANIFEST])
    manifest["media"] = {name: [len(data), hashlib.sha256(data).hexdigest()] for name, data in files.items()}
    out = {**entries, backups.MANIFEST: json.dumps(manifest).encode()}
    out.update({backups.MEDIA_PREFIX + name: data for name, data in files.items()})
    return out


@pytest.fixture(autouse=True)
def no_pending() -> None:
    import shutil

    shutil.rmtree(backups.pending_folder(), ignore_errors=True)


def test_a_backup_from_a_newer_nexdiary_is_not_restored(client: TestClient, operator: Account, tmp_path: Path) -> None:
    entries = made_here()
    entries[backups.DATABASE_ENTRY] = with_schema(entries[backups.DATABASE_ENTRY], database.SCHEMA_VERSION + 98,
                                                  tmp_path)
    name = write_archive(entries)
    brief = client.post(f"/api/backups/{name}/check").json()
    assert brief["schema"] == database.SCHEMA_VERSION + 98
    assert brief["database_ok"] is False and brief["usable"] is False and brief["too_new"] is True
    refused = client.post(f"/api/backups/{name}/restore", json={"password": PASSWORD})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "backup_too_new"
    assert not backups.pending_folder().exists(), "nothing laid out for the next start"


def test_a_database_without_a_version_is_not_restored(client: TestClient, operator: Account, tmp_path: Path) -> None:
    entries = made_here()
    entries[backups.DATABASE_ENTRY] = with_schema(entries[backups.DATABASE_ENTRY], 0, tmp_path)
    brief = backups.check(write_archive(entries))
    assert (brief.schema, brief.usable) == (0, False)


def test_an_older_schema_is_taken_and_brought_up_at_the_start(
    client: TestClient, operator: Account, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entries = made_here()
    name = write_archive(entries)

    def step(connection: Connection) -> None:
        connection.execute(text("CREATE TABLE probe_later (id INTEGER PRIMARY KEY)"))

    monkeypatch.setattr(database, "SCHEMA_VERSION", database.SCHEMA_VERSION + 1)
    monkeypatch.setitem(database.MIGRATIONS, database.SCHEMA_VERSION, step)
    brief = backups.check(name)
    assert brief.usable and brief.schema == database.SCHEMA_VERSION - 1
    # What the start after the restore does with it, on a file of its own.
    restored = tmp_path / "restored.db"
    restored.write_bytes(entries[backups.DATABASE_ENTRY])
    engine = create_engine(f"sqlite:///{restored}")
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(backups, "create", lambda **_kwargs: restored)
    database.init_db()
    engine.dispose()
    with sqlite3.connect(restored) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == database.SCHEMA_VERSION
        assert connection.execute("SELECT count(*) FROM sqlite_master WHERE name = 'probe_later'").fetchone()[0] == 1
    connection.close()


@pytest.mark.parametrize("escaping", ["../../escaped", "/escaped", "..\\escaped", "sub/escaped", "C:escaped"])
def test_a_media_name_that_leaves_the_folder_is_never_unpacked(
    client: TestClient, operator: Account, tmp_path: Path, escaping: str
) -> None:
    name = write_archive(with_media(made_here(), {escaping: b"not a photo"}))
    assert backups.check(name).usable is False
    with pytest.raises(backups.BackupError):
        backups.stage_restore(name)
    data = backups.folder().parent
    found = [path for path in data.rglob("*escaped*")]
    assert found == [], found


def test_an_archive_that_unpacks_to_more_than_a_backup_may_hold_is_refused(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Zeros pack to almost nothing: a few hundred bytes in the archive, kilobytes when read."""
    monkeypatch.setattr(backups, "SECRET_MAX", 64)
    entries = made_here()
    entries[backups.SECRET_ENTRY] = b"\0" * 4096
    name = write_archive(entries)
    assert (backups.folder() / name).stat().st_size < 64 * 1024
    with pytest.raises(backups.BackupError) as refused:
        backups.stage_restore(name)
    assert refused.value.code == "backup_too_large"
    assert not backups.pending_folder().exists()

    monkeypatch.setattr(backups, "MEDIA_ENTRY_MAX", 1000)
    name = write_archive(with_media(made_here(), {"photo00001": b"\0" * 5000}))
    with pytest.raises(backups.BackupError) as refused:
        backups.check(name)
    assert refused.value.code == "backup_too_large"


def test_the_whole_counts_too(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    entries = made_here()
    monkeypatch.setattr(backups, "RESTORE_MAX", len(entries[backups.DATABASE_ENTRY]) + 3000)
    name = write_archive(with_media(entries, {f"photo0000{n}": b"\0" * 1000 for n in range(5)}))
    with pytest.raises(backups.BackupError) as refused:
        backups.stage_restore(name)
    assert refused.value.code == "backup_too_large"


def test_two_backups_in_the_same_second_get_names_of_their_own(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    monkeypatch.setattr(backups, "_stamp", lambda _moment: "2020-01-01-000000")
    start = threading.Barrier(2)
    made: list[Path] = []
    failed: list[BaseException] = []

    def one() -> None:
        start.wait()
        try:
            made.append(backups.create(kind=backups.MANUAL))
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever went wrong
            failed.append(exc)

    threads = [threading.Thread(target=one) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failed == []
    assert len({path.name for path in made}) == 2
    for path in made:
        with zipfile.ZipFile(path) as archive:
            assert backups.MANIFEST in archive.namelist()
        path.unlink()


def test_check_reads_a_database_it_was_handed_whole(client: TestClient, operator: Account) -> None:
    """The control for the tests above: the archive as made is usable."""
    brief = backups.check(write_archive(made_here()))
    assert brief.usable and brief.schema == database.SCHEMA_VERSION


def test_a_backup_sealed_with_another_master_key_is_not_restored(client: TestClient, operator: Account) -> None:
    """A backup of another server: its data keys do not open with this server's master key. Restored, nexdiary would
    not start any more; the check says so and the restore refuses."""
    import os
    import uuid

    from app.services import vault

    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "vom alten server"}).status_code == 201
    name = backups.create(kind=backups.MANUAL).name
    assert backups.check(name).usable, "on its own server it fits"
    kept = vault._master
    vault._master = os.urandom(vault.KEY_BYTES)
    try:
        brief = client.post(f"/api/backups/{name}/check").json()
        assert brief["other_master_key"] is True and brief["usable"] is False and brief["database_ok"] is True
        refused = client.post(f"/api/backups/{name}/restore", json={"password": PASSWORD})
        assert refused.status_code == 400 and refused.json()["detail"]["code"] == "backup_other_master_key"
        assert not backups.pending_folder().exists(), "nothing laid out for the next start"
    finally:
        vault._master = kept


def test_a_backup_without_any_data_key_fits_every_server(client: TestClient, operator: Account) -> None:
    import os

    from app.services import vault

    name = backups.create(kind=backups.MANUAL).name
    kept = vault._master
    vault._master = os.urandom(vault.KEY_BYTES)
    try:
        brief = backups.check(name)
        assert brief.usable and not brief.other_master_key
    finally:
        vault._master = kept
