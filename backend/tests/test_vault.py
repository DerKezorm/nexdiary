"""The keys: one master key, made once and never twice; a start that would lose the diaries stops instead; data keys
per person, made once; and a sealed field opens only where it was sealed."""

from __future__ import annotations

import os
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.config import get_settings
from app.db import SessionLocal
from app.models import Account, Note, UserKey
from app.services import vault

from .conftest import make_account, new_client


@pytest.fixture
def key_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A master key of its own for the test, in a folder of its own; the run's key is back afterwards."""
    kept = vault._master
    path = tmp_path / "keys" / "master.key"
    monkeypatch.setattr(get_settings(), "master_key_file", path)
    vault.forget()
    yield path
    vault.forget()
    vault._master = kept


def test_the_master_key_is_made_once_whole_and_only_the_owner_s(key_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The key in nexdiary's own folder, the case of every default install: that folder is narrowed to the owner.
    monkeypatch.setattr(vault, "default_key_folder", lambda: key_file.parent)
    key = vault.master()
    assert len(key) == vault.KEY_BYTES and key_file.is_file()
    assert vault._decode(key_file.read_bytes()) == key
    if os.name != "nt":
        assert key_file.stat().st_mode & 0o777 == 0o600
        assert key_file.parent.stat().st_mode & 0o777 == 0o700
    vault.forget()
    assert vault.master() == key, "the next start reads the same key"
    assert [path.name for path in key_file.parent.iterdir()] == ["master.key"], "no temporary file is left"


def test_two_starts_at_once_make_one_master_key(key_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Both find no key and both make one; the second to finish takes the first one's, never its own."""
    both_made = threading.Barrier(2, timeout=10)
    original = vault._encode

    def encode_then_wait(key: bytes) -> bytes:
        both_made.wait()
        return original(key)

    monkeypatch.setattr(vault, "_encode", encode_then_wait)
    got: list[bytes] = []

    def start() -> None:
        got.append(vault._create(key_file))

    threads = [threading.Thread(target=start) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(got) == 2 and got[0] == got[1]
    assert vault._decode(key_file.read_bytes()) == got[0]


def test_making_a_master_key_never_replaces_one_that_stands(key_file: Path) -> None:
    """A start that found no key, and a key that appeared since (another start was quicker): the one that stands is
    taken, the file is not touched."""
    standing = os.urandom(vault.KEY_BYTES)
    key_file.parent.mkdir(parents=True)
    key_file.write_bytes(vault._encode(standing))
    assert vault._create(key_file) == standing
    assert vault._decode(key_file.read_bytes()) == standing
    assert [path.name for path in key_file.parent.iterdir()] == ["master.key"]


def test_a_missing_master_key_next_to_sealed_diaries_stops_the_start(key_file: Path, account: Account) -> None:
    vault.master()
    vault.dek_for(account.id)
    key_file.unlink()
    vault.forget()
    with pytest.raises(vault.MasterKeyError, match="missing"):
        vault.startup()
    assert not key_file.exists(), "no new key was made in its place"


def test_a_master_key_that_does_not_fit_stops_the_start(key_file: Path, account: Account) -> None:
    vault.master()
    vault.dek_for(account.id)
    key_file.write_bytes(vault._encode(os.urandom(vault.KEY_BYTES)))
    vault.forget()
    with pytest.raises(vault.MasterKeyError, match="does not fit"):
        vault.startup()


def test_a_damaged_master_key_file_stops_the_start(key_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vault, "WAIT_FOR_OTHER_SECONDS", 0.1)
    key_file.parent.mkdir(parents=True)
    key_file.write_bytes(b"half a key")
    with pytest.raises(vault.MasterKeyError, match="damaged"):
        vault.startup()


def test_a_server_started_with_a_missing_key_says_why(key_file: Path, account: Account) -> None:
    from app.main import app

    vault.master()
    vault.dek_for(account.id)
    key_file.unlink()
    vault.forget()
    with pytest.raises(vault.MasterKeyError), TestClient(app):
        pass


def test_each_person_gets_one_data_key_even_when_two_first_notes_come_at_once(
    key_file: Path, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first request finds no key and makes one, but is slow to store it; meanwhile a second request makes its key,
    stores it and already seals with it. The first must then take the stored key, never put its own in its place."""
    first_in = threading.Event()
    second_done = threading.Event()
    original = vault._wrap
    calls: list[int] = []

    def wrap_slowly_the_first_time(master: bytes, user_id: int, dek: bytes) -> bytes:
        calls.append(1)
        if len(calls) == 1:
            first_in.set()
            assert second_done.wait(10)
        return original(master, user_id, dek)

    monkeypatch.setattr(vault, "_wrap", wrap_slowly_the_first_time)
    keys: dict[str, bytes] = {}

    def first() -> None:
        keys["first"] = vault.dek_for(account.id)

    slow = threading.Thread(target=first)
    slow.start()
    assert first_in.wait(10)
    keys["second"] = vault.dek_for(account.id)
    second_done.set()
    slow.join()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UserKey)) == 1
    assert keys["first"] == keys["second"], "both seal with the key that stands"
    assert vault.dek_for(account.id) == keys["second"]
    other = make_account("tom")
    monkeypatch.setattr(vault, "_wrap", original)
    assert vault.dek_for(other.id) != keys["second"], "a key per person"


def test_a_sealed_value_opens_only_where_it_was_sealed() -> None:
    dek = os.urandom(32)
    bound = vault.aad(1, "days", "content", "2026-10-06")
    sealed = vault.seal_text(dek, "Kastanien", bound)
    assert sealed[0] == vault.FORMAT and b"Kastanien" not in sealed
    assert vault.open_text(dek, sealed, bound) == "Kastanien"
    assert vault.seal_text(dek, "Kastanien", bound) != sealed, "a fresh nonce every time"
    for elsewhere in (vault.aad(2, "days", "content", "2026-10-06"), vault.aad(1, "days", "content", "2026-10-05"),
                      vault.aad(1, "notes", "text", "2026-10-06")):
        with pytest.raises(vault.SealError):
            vault.open_text(dek, sealed, elsewhere)
    with pytest.raises(vault.SealError):
        vault.open_text(os.urandom(32), sealed, bound)
    with pytest.raises(vault.SealError):
        vault.open_text(dek, bytes([2]) + sealed[1:], bound)
    with pytest.raises(vault.SealError):
        vault.open_text(dek, sealed[:-1] + bytes([sealed[-1] ^ 1]), bound)


def _seal_of(note_id: str) -> bytes:
    with SessionLocal() as db:
        sealed = db.scalar(select(Note.text_enc).where(Note.uid == note_id))
    assert sealed is not None
    return sealed


def test_a_sealed_text_moved_to_another_person_or_note_does_not_open(client: TestClient, account: Account) -> None:
    """Somebody with write access to the database copies one person's note over another's: the server answers an
    error, never the other person's text."""
    own = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "nur fuer mich"}).json()
    second = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "zweite"}).json()
    member = make_account("tom")
    with new_client(member) as tom:
        theirs = tom.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "toms text"}).json()
        with SessionLocal() as db:
            db.execute(update(Note).where(Note.uid == theirs["id"]).values(text_enc=_seal_of(own["id"])))
            db.commit()
        moved = tom.get("/api/notes", params={"date": theirs["date"]})
        assert moved.status_code == 200 and "nur fuer mich" not in moved.text
        assert [item["unreadable"] for item in moved.json()] == [True]
    with SessionLocal() as db:
        db.execute(update(Note).where(Note.uid == second["id"]).values(text_enc=_seal_of(own["id"])))
        db.commit()
    within = client.get("/api/notes", params={"date": own["date"]}).json()
    assert [(item["text"], item["unreadable"]) for item in within] == [("nur fuer mich", False), ("", True)]


def test_a_day_moved_to_another_date_does_not_open(client: TestClient, account: Account) -> None:
    from app.models import Day

    client.put("/api/days/2026-10-05", json={"title": "gestern"})
    client.put("/api/days/2026-10-04", json={"title": "vorgestern"})
    with SessionLocal() as db:
        sealed = db.scalar(select(Day.content_enc).where(Day.date == "2026-10-05"))
        db.execute(update(Day).where(Day.date == "2026-10-04").values(content_enc=sealed))
        db.commit()
    answer = client.get("/api/days/2026-10-04")
    assert answer.status_code == 200 and "gestern" not in answer.text and answer.json()["unreadable"] is True


def test_the_master_key_never_lies_where_backups_or_uploads_reach(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    kept = vault._master
    try:
        for place in (settings.media_dir / "master.key", settings.data_dir / "backups" / "master.key",
                      settings.locales_dir / "master.key", settings.data_dir / "master.key",
                      settings.data_dir / "logs" / "master.key"):
            monkeypatch.setattr(settings, "master_key_file", place)
            vault.forget()
            with pytest.raises(vault.MasterKeyError, match="where backups or uploads reach"):
                vault.startup()
            assert not place.exists(), place
        for place in (settings.data_dir / "keys" / "other.key", tmp_path / "elsewhere" / "master.key"):
            monkeypatch.setattr(settings, "master_key_file", place)
            vault.forget()
            vault.startup()
            assert place.is_file()
    finally:
        vault.forget()
        vault._master = kept


def test_only_the_own_key_folder_is_narrowed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A folder the operator chose for the key may hold other things; nexdiary narrows only the file there."""
    narrowed: list[Path] = []
    monkeypatch.setattr(vault.private, "tighten", lambda path: narrowed.append(Path(path).resolve()))
    chosen = tmp_path / "secrets" / "master.key"
    vault._create(chosen)
    assert chosen.parent.resolve() not in narrowed and chosen.resolve() in narrowed
    narrowed.clear()
    own = vault.default_key_folder() / f"probe-{os.getpid()}.key"
    try:
        vault._create(own)
        assert vault.default_key_folder().resolve() in narrowed
    finally:
        own.unlink(missing_ok=True)


def test_a_backup_never_packs_the_master_key_even_when_it_looks_like_a_media_file(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    import zipfile

    from app.services import backups

    disguised = get_settings().media_dir / "abcdefgh12345"
    disguised.write_bytes(vault._encode(vault.master()))
    monkeypatch.setattr(vault, "master_key_path", lambda: disguised)
    made = backups.create(kind=backups.MANUAL)
    with zipfile.ZipFile(made) as archive:
        assert backups.MEDIA_PREFIX + "abcdefgh12345" not in archive.namelist()
        assert all(vault.master() not in archive.read(name) for name in archive.namelist())


def test_three_first_starts_at_once_on_an_empty_folder_all_come_up(tmp_path: Path) -> None:
    """Three processes start on the same empty data folder at the same moment, several times over: each one makes or
    finds the schema and the master key, none breaks off with "database is locked", and there is one key."""
    import subprocess
    import sys
    import time

    script = (
        "import os, sys, time\n"
        "start = float(sys.argv[1])\n"
        "from app.db import init_db\n"
        "from app.services import vault\n"
        "while time.time() < start: pass\n"
        "init_db()\n"
        "print(vault.master().hex())\n"
    )
    backend = Path(__file__).parent.parent
    for round_ in range(6):
        folder = tmp_path / f"round-{round_}"
        env = {**os.environ, "NEXDIARY_DATA_DIR": str(folder)}
        env.pop("NEXDIARY_MASTER_KEY_FILE", None)
        start = time.time() + 3
        runs = [subprocess.Popen([sys.executable, "-c", script, str(start)], cwd=backend, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
        outputs = [run.communicate(timeout=120) for run in runs]
        for run, (_out, err) in zip(runs, outputs, strict=True):
            assert run.returncode == 0, err[-2000:]
        assert len({out.strip() for out, _err in outputs}) == 1, "one master key"


@pytest.mark.skipif(os.name == "nt", reason="file modes are a POSIX matter")
def test_a_folder_the_operator_chose_for_the_key_keeps_its_mode(key_file: Path) -> None:
    key_file.parent.mkdir(parents=True)
    os.chmod(key_file.parent, 0o755)
    vault.master()
    assert key_file.stat().st_mode & 0o777 == 0o600
    assert key_file.parent.stat().st_mode & 0o777 == 0o755, "a folder the operator chose may hold other things"
