"""Nothing a person writes lies in the clear: not in the database file with its ``-wal`` and ``-shm``, not in a backup,
not in the log. A word made for this run goes into every field there is, and then every byte is searched for it, in
UTF-8 and UTF-16, in its own case and in lower and upper case. A backup is unreadable without the master key and comes
back whole on the same server."""

from __future__ import annotations

import io
import secrets
import shutil
import sqlite3
import uuid
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.models import Account
from app.services import backups, logs, vault

from .conftest import DATA_DIR, PASSWORD, sign_in


def forms(word: str) -> list[bytes]:
    """Every way the word could stand in a file."""
    out: list[bytes] = []
    for variant in {word, word.lower(), word.upper(), word.casefold()}:
        for encoding in ("utf-8", "utf-16-le", "utf-16-be"):
            out.append(variant.encode(encoding))
    return out


def found_in(data: bytes, word: str) -> bool:
    return any(form in data for form in forms(word))


@pytest.fixture
def word() -> str:
    # Letters in both cases, made now: no file can hold it by chance, and the case variants differ.
    return "Qx" + secrets.token_hex(6) + "Zy"


@pytest.fixture
def deep_log() -> Iterator[None]:
    """The most detailed log there is, so that nothing is hidden by a quiet level."""
    logs.set_mode("trace", 30)
    yield
    logs.set_mode(logs.DEFAULT_MODE)


@pytest.fixture
def journal_kept() -> Iterator[None]:
    """A connection held open for the whole test: SQLite empties and deletes the ``-wal`` when the last connection
    closes, and every request closes its own. Held open, the journal keeps every page written, as on a busy server."""
    connection = sqlite3.connect(get_settings().database_path)
    connection.execute("SELECT count(*) FROM users").fetchone()
    yield
    connection.close()


def write_everywhere(client: TestClient, word: str) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": f"heute {word} gesehen",
                                           "prompt": f"Frage {word}?"}).status_code == 201
    value = client.post("/api/values", json={"name": f"Wert {word}", "low": f"tief {word}", "high": f"hoch {word}",
                                             "hint": f"Hinweis {word}"})
    assert value.status_code == 201
    day = client.put("/api/days/2026-10-05", json={"title": f"Titel {word}", "text": f"Text mit {word} darin.",
                                                   "tags": [f"tag{word}"], "values": {value.json()["id"]: 7}})
    assert day.status_code == 200
    # A search, a change and a deletion: none of them may leave the word behind either.
    assert client.post("/api/search", json={"q": word}).json()["results"]
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": f"kurz {word}"}).json()
    client.put(f"/api/notes/{note['id']}", json={"text": f"geändert {word}"})
    client.delete(f"/api/notes/{note['id']}")


def every_file(folder: Path) -> Iterator[Path]:
    for path in folder.rglob("*"):
        if path.is_file():
            yield path


def test_the_database_its_journal_and_the_log_hold_no_word_in_the_clear(
    client: TestClient, account: Account, word: str, deep_log: None, journal_kept: None
) -> None:
    write_everywhere(client, word)
    database = get_settings().database_path
    side_files = [database.with_name(database.name + suffix) for suffix in ("-wal", "-shm")]
    assert database.is_file() and side_files[0].is_file(), "the journal is searched too, while it holds pages"
    assert side_files[0].stat().st_size > 0
    for path in [database, *side_files]:
        assert not found_in(path.read_bytes(), word), path.name
    # And everything else in the data folder: the log above all, the keys, the media.
    searched = 0
    for path in every_file(Path(DATA_DIR)):
        if path.suffix == ".zip":
            continue
        searched += 1
        assert not found_in(path.read_bytes(), word), path
    assert logs.log_file().stat().st_size > 0 and searched > 3
    # Floor: the word is really there, readable through the API.
    assert word in client.get("/api/days/2026-10-05").text


def test_a_backup_holds_no_word_in_the_clear_and_no_master_key(client: TestClient, account: Account,
                                                                  word: str) -> None:
    write_everywhere(client, word)
    name = client.post("/api/backups", json={"note": ""}).json()["name"]
    archive = client.post(f"/api/backups/{name}/download", json={"password": PASSWORD}).content
    master = vault.master()
    master_text = vault.master_key_path().read_bytes()
    with zipfile.ZipFile(io.BytesIO(archive)) as unpacked:
        names = unpacked.namelist()
        assert backups.DATABASE_ENTRY in names
        assert not any("keys" in entry or "master" in entry for entry in names)
        for entry in names:
            data = unpacked.read(entry)
            assert not found_in(data, word), entry
            assert master not in data and master_text not in data, entry
            assert master_text.splitlines()[1] not in data, entry


def test_a_backup_cannot_be_read_without_the_master_key_and_comes_back_on_the_same_server(
    client: TestClient, account: Account, word: str, tmp_path: Path
) -> None:
    write_everywhere(client, word)
    made = backups.create(kind=backups.MANUAL)
    copy = tmp_path / "from-the-backup.db"
    with zipfile.ZipFile(made) as unpacked:
        copy.write_bytes(unpacked.read(backups.DATABASE_ENTRY))
    connection = sqlite3.connect(copy)
    try:
        user_id, wrapped = connection.execute("SELECT user_id, wrapped_dek FROM user_keys").fetchone()
        uid, day, sealed = connection.execute("SELECT uid, date, text_enc FROM notes").fetchone()
    finally:
        connection.close()
    bound = vault.aad(user_id, "notes", "text", f"{uid}|{day}")
    # Another server, another master key: the data key does not open, so nothing does.
    with pytest.raises(vault.SealError):
        vault._unwrap(secrets.token_bytes(vault.KEY_BYTES), user_id, wrapped)
    # This server's key opens it.
    assert word in vault.open_text(vault._unwrap(vault.master(), user_id, wrapped), sealed, bound)

    # The note goes, the backup comes back at the next start, the note with it.
    notes = client.get("/api/notes", params={"date": day}).json()
    for item in notes:
        assert client.delete(f"/api/notes/{item['id']}").status_code == 204
    assert client.get("/api/notes", params={"date": day}).json() == []
    shutil.rmtree(backups.pending_folder(), ignore_errors=True)
    backups.stage_restore(made.name)
    assert backups.apply_pending()
    vault.forget()
    vault.startup()
    sign_in(client, account)
    restored = client.get("/api/notes", params={"date": day}).json()
    assert [item["text"] for item in restored] == [f"heute {word} gesehen"]
    assert client.get("/api/days/2026-10-05").json()["title"] == f"Titel {word}"


def test_a_deleted_account_leaves_neither_its_key_nor_its_texts_in_the_files(
    client: TestClient, account: Account, journal_kept: None
) -> None:
    """Crypto-shredding: after the account is deleted, the bytes of its wrapped data key and of a sealed text are
    nowhere in the database, its journal or the shared memory file, not even in free pages."""
    from .conftest import make_account, new_client

    member = make_account("tom")
    with new_client(member) as tom:
        tom.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "toms geheimnis"})
    connection = sqlite3.connect(get_settings().database_path)
    try:
        wrapped = connection.execute("SELECT wrapped_dek FROM user_keys WHERE user_id = ?", (member.id,)).fetchone()[0]
        sealed = connection.execute("SELECT text_enc FROM notes WHERE user_id = ?", (member.id,)).fetchone()[0]
    finally:
        connection.close()
    deleted = client.request("DELETE", f"/api/accounts/{member.id}", json={"current_password": PASSWORD})
    assert deleted.status_code == 204
    database = get_settings().database_path
    for path in (database, database.with_name(database.name + "-wal"), database.with_name(database.name + "-shm")):
        data = path.read_bytes() if path.exists() else b""
        assert bytes(wrapped) not in data, path.name
        assert bytes(sealed) not in data, path.name
