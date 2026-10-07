"""The keys that seal the diary, and the sealing itself.

* **The master key** is 32 random bytes in a file (``<data_dir>/keys/master.key``, or ``NEXDIARY_MASTER_KEY_FILE``),
  made at the first start, only the owner's. It is never in the database, never in the log and never in a backup: a
  backup without it cannot be read, not even by the operator.
* **Every person has a data key** of their own (32 bytes), wrapped with the master key and kept in ``user_keys``.
  Deleting that row (with the account) makes everything the person wrote unreadable for good.
* **Every field is sealed on its own** with AES-256-GCM and a fresh 96-bit nonce. The associated data binds it to the
  person, the table, the column and the row: a sealed text copied to another row or another person does not open.

The format of a sealed value is ``version (1 byte) | nonce (12 bytes) | ciphertext with tag``; the version leaves room
for a later rotation.

This protects against looking into the database or a backup. Whoever holds the whole server (the database and the
master key) can read everything; that is said in the interface too.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .. import private
from ..config import get_settings
from ..models import UserKey, utcnow

logger = logging.getLogger("nexdiary.vault")

FORMAT = 1
NONCE_BYTES = 12
KEY_BYTES = 32
#: The first line of the master key file: says what the file is to whoever finds it in a folder.
HEADER = "nexdiary master key, version 1. Keep it apart from the backups; without it they cannot be read."
#: How long a start waits for a master key file another start is writing at the same moment.
WAIT_FOR_OTHER_SECONDS = 3.0

_lock = threading.Lock()
_master: bytes | None = None


class MasterKeyError(RuntimeError):
    """The master key is missing while data keys exist, unreadable, or does not fit them. nexdiary does not start."""


class SealError(Exception):
    """A sealed value did not open: damaged, or moved to a place it does not belong."""


# --- The master key -------------------------------------------------------------------------------------------------


def default_key_folder() -> Path:
    return get_settings().data_dir / "keys"


def master_key_path() -> Path:
    return get_settings().master_key_file or default_key_folder() / "master.key"


def _inside(path: Path, folder: Path | None) -> bool:
    if folder is None:
        return False
    try:
        return path.is_relative_to(folder.resolve())
    except OSError:
        return False


def check_place(path: Path) -> None:
    """The master key must not lie where a backup, an upload or the language files reach: anywhere in the data folder
    but its own ``keys/``, in the media or the language folder. ``MasterKeyError`` else."""
    settings = get_settings()
    resolved = path.resolve()
    keys = default_key_folder().resolve()
    if _inside(resolved, keys):
        return
    for folder in (settings.media_dir, settings.locales_dir, settings.data_dir / "backups", settings.data_dir):
        if _inside(resolved, folder):
            raise MasterKeyError(
                f"The master key {path} lies in {folder}, where backups or uploads reach it. Keep it in "
                f"{keys} or outside the data folder (NEXDIARY_MASTER_KEY_FILE)."
            )


def _encode(key: bytes) -> bytes:
    return f"{HEADER}\n{base64.b64encode(key).decode('ascii')}\n".encode("ascii")


def _decode(raw: bytes) -> bytes | None:
    """The key in a file, or None when the file is not (yet) a whole key file."""
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return None
    if len(lines) != 2 or lines[0] != HEADER:
        return None
    try:
        key = base64.b64decode(lines[1], validate=True)
    except (binascii.Error, ValueError):
        return None
    return key if len(key) == KEY_BYTES else None


def _read(path: Path) -> bytes:
    """The key in the file; waits a moment for another start that is writing it right now."""
    deadline = time.monotonic() + WAIT_FOR_OTHER_SECONDS
    while True:
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise MasterKeyError(f"The master key file {path} cannot be read ({exc.strerror}).") from exc
        key = _decode(raw)
        if key is not None:
            return key
        if time.monotonic() >= deadline:
            raise MasterKeyError(
                f"The master key file {path} is damaged. Put back the copy you kept; without it the diaries cannot be "
                "read."
            )
        time.sleep(0.05)


def _create(path: Path) -> bytes:
    """A new key, put in place only if no other start was quicker: the file is written whole under a name of its own
    and then linked to its place, which fails when the place is taken. ``os.replace`` would overwrite a key another
    start already uses. Where the file system has no links, the file is created exclusively and written at once; a
    reader that comes in between waits for it (``_read``)."""
    folder = path.parent
    folder.mkdir(parents=True, exist_ok=True)
    # Only nexdiary's own folder is narrowed: a folder the operator chose for the key may hold other things.
    if folder.resolve() == default_key_folder().resolve():
        private.tighten(folder)
    key = secrets.token_bytes(KEY_BYTES)
    temporary = folder / f".{path.name}.{os.getpid()}-{time.time_ns()}.part"
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_encode(key))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            return _read(path)
        except OSError:
            # No hard links here (some network shares): exclusive creation instead.
            try:
                descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
            except FileExistsError:
                return _read(path)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(_encode(key))
                handle.flush()
                os.fsync(handle.fileno())
    finally:
        temporary.unlink(missing_ok=True)
    private.tighten(path)
    logger.warning("A new master key was made in %s. Keep a copy apart from the backups.", path)
    return key


def _wrapped_count() -> int:
    from ..db import SessionLocal

    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(UserKey)) or 0)


def _first_wrapped() -> tuple[int, bytes] | None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        row = db.execute(select(UserKey.user_id, UserKey.wrapped_dek).limit(1)).first()
    return (row[0], row[1]) if row else None


def master() -> bytes:
    """The master key, loaded once. Made only where no data key exists yet: a missing key next to wrapped data keys
    would otherwise be replaced by a new one silently, and every diary would be lost."""
    global _master
    if _master is not None:
        return _master
    with _lock:
        if _master is not None:
            return _master
        path = master_key_path()
        check_place(path)
        if path.exists():
            key = _read(path)
        else:
            if _wrapped_count():
                raise MasterKeyError(
                    f"The master key {path} is missing, but the database holds sealed diaries. nexdiary does not make "
                    "a new one, that would lose them all. Put back keys/master.key: from a copy of the data folder, or "
                    "the file the operator saved under Settings, Server, Backups, Save master key "
                    "(nexdiary-master.key, renamed to master.key). Or set NEXDIARY_MASTER_KEY_FILE to where the "
                    "file is."
                )
            key = _create(path)
        private.tighten(path)
        first = _first_wrapped()
        if first is not None:
            try:
                _unwrap(key, *first)
            except SealError as exc:
                raise MasterKeyError(
                    f"The master key {path} does not fit the database: its data keys do not open with it. Put back the "
                    "master key that belongs to this database."
                ) from exc
        _master = key
        return key


def startup() -> None:
    """At the start, after the schema: the master key is there and fits, or the start stops here with the reason."""
    try:
        master()
    except MasterKeyError as exc:
        logger.critical("%s", exc)
        raise


def export() -> bytes:
    """The master key file as this server uses it, for the operator to keep apart from the backups ("Save master
    key"): put back as ``keys/master.key``, it opens the backups of this server, here or on a new one."""
    return _encode(master())


def forget() -> None:
    """Drops the key from memory (tests; a restore that brings another database)."""
    global _master
    with _lock:
        _master = None


# --- Data keys ------------------------------------------------------------------------------------------------------


def _aesgcm_seal(key: bytes, data: bytes, aad: bytes) -> bytes:
    nonce = secrets.token_bytes(NONCE_BYTES)
    return bytes([FORMAT]) + nonce + AESGCM(key).encrypt(nonce, data, aad)


def _aesgcm_open(key: bytes, sealed: bytes, aad: bytes) -> bytes:
    if len(sealed) < 1 + NONCE_BYTES + 16 or sealed[0] != FORMAT:
        raise SealError("not a sealed value of a known format")
    try:
        return AESGCM(key).decrypt(sealed[1 : 1 + NONCE_BYTES], sealed[1 + NONCE_BYTES :], aad)
    except InvalidTag as exc:
        raise SealError("the sealed value does not open here") from exc


def _dek_aad(user_id: int) -> bytes:
    return f"nexdiary|user_keys|{int(user_id)}".encode()


def _wrap(master_key: bytes, user_id: int, dek: bytes) -> bytes:
    return _aesgcm_seal(master_key, dek, _dek_aad(user_id))


def _unwrap(master_key: bytes, user_id: int, wrapped: bytes) -> bytes:
    return _aesgcm_open(master_key, wrapped, _dek_aad(user_id))


def dek_for(user_id: int) -> bytes:
    """The person's data key, made at the first need. In a session of its own and before the caller writes anything:
    two first notes at the same moment insert at most one key (the second insert finds the first and does nothing),
    and both read the one that stands."""
    from ..db import SessionLocal

    key = master()
    with SessionLocal() as db:
        wrapped = db.scalar(select(UserKey.wrapped_dek).where(UserKey.user_id == user_id))
        if wrapped is None:
            fresh = _wrap(key, user_id, secrets.token_bytes(KEY_BYTES))
            db.execute(
                sqlite_insert(UserKey)
                .values(user_id=user_id, wrapped_dek=fresh, created_at=utcnow())
                .on_conflict_do_nothing(index_elements=[UserKey.user_id])
            )
            db.commit()
            wrapped = db.scalar(select(UserKey.wrapped_dek).where(UserKey.user_id == user_id))
        if wrapped is None:
            # The account was deleted in between.
            raise SealError("no data key for this account")
    return _unwrap(key, user_id, wrapped)


def dek_of(user_id: int) -> bytes:
    """The data key of a person who has one; never makes one. For reading what somebody else shared: a share stands
    only on a page that was sealed, so the key is there, and a missing one is an error, not a reason to make one."""
    from ..db import SessionLocal

    key = master()
    with SessionLocal() as db:
        wrapped = db.scalar(select(UserKey.wrapped_dek).where(UserKey.user_id == user_id))
    if wrapped is None:
        raise SealError("no data key for this account")
    return _unwrap(key, user_id, wrapped)


# --- Fields ---------------------------------------------------------------------------------------------------------


def aad(user_id: int, table: str, column: str, row: str) -> bytes:
    """What a sealed field is bound to: the person, the table, the column and the row."""
    return f"nexdiary|{int(user_id)}|{table}|{column}|{row}".encode()


def seal(dek: bytes, data: bytes, bound: bytes) -> bytes:
    return _aesgcm_seal(dek, data, bound)


def open_sealed(dek: bytes, sealed: bytes, bound: bytes) -> bytes:
    return _aesgcm_open(dek, sealed, bound)


def seal_text(dek: bytes, text: str, bound: bytes) -> bytes:
    return seal(dek, text.encode("utf-8"), bound)


def open_text(dek: bytes, sealed: bytes, bound: bytes) -> str:
    return open_sealed(dek, sealed, bound).decode("utf-8")


def seal_json(dek: bytes, value: Any, bound: bytes) -> bytes:
    return seal(dek, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), bound)


def open_json(dek: bytes, sealed: bytes, bound: bytes) -> Any:
    return json.loads(open_sealed(dek, sealed, bound).decode("utf-8"))


def shred_leftovers() -> None:
    """After a data key was deleted: the write-ahead log still holds the pages as they were, the key among them. A
    checkpoint writes them into the database (where ``secure_delete`` has overwritten the deleted rows) and empties
    the log. Best effort: a reader that holds an old snapshot leaves the log for the next checkpoint."""
    from ..db import engine

    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:  # noqa: BLE001 - never fail the deletion over this
        logger.warning("The write-ahead log could not be emptied after deleting an account; the next checkpoint will")
