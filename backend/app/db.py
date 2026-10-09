"""SQLite connection, and the schema with its version number.

There is no Alembic. The database carries the version of its schema in SQLite's ``user_version``:

* A new database is made from the models (``create_all``) and gets ``SCHEMA_VERSION``.
* An older one is brought up step by step: ``MIGRATIONS[n]`` takes a database from version ``n - 1`` to ``n``. Before
  the first step a backup is made (the way back if the new version goes wrong); each step runs in a transaction of its
  own and sets the version only when it went through.
* A database from a newer nexdiary than the running one is not touched: the start stops with a message.

Whoever changes a table in ``models.py`` raises ``SCHEMA_VERSION``, writes the step, and records the new schema in
``tests/schema/`` (``test_schema.py`` says how).
"""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Callable, Iterator
from typing import Any

from sqlalchemy import Connection, Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from .config import get_settings
from .models import Base

logger = logging.getLogger("nexdiary.db")

_settings = get_settings()
_settings.data_dir.mkdir(parents=True, exist_ok=True)

#: How long a write waits for another one to finish. Every writer keeps its transactions short; this is the margin
#: for a slow disk, not a wait anybody should see.
BUSY_SECONDS = 15

#: The version of the schema the models describe.
SCHEMA_VERSION = 14


def _v2_diary(connection: Connection) -> None:
    """Version 2: the diary. Data keys per person, days, notes and values, all sealed; a mark on each account whether
    its first values were laid out. Written out as it stood then, not taken from the models, which move on."""
    for statement in (
        "ALTER TABLE users ADD COLUMN values_seeded BOOLEAN DEFAULT 0 NOT NULL",
        (
            "CREATE TABLE user_keys ( user_id INTEGER NOT NULL, wrapped_dek BLOB NOT NULL, "
            "created_at DATETIME NOT NULL, PRIMARY KEY (user_id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        (
            "CREATE TABLE days ( id INTEGER NOT NULL, user_id INTEGER NOT NULL, date VARCHAR(10) NOT NULL, "
            "content_enc BLOB NOT NULL, revision INTEGER NOT NULL, created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL, PRIMARY KEY (id), CONSTRAINT uq_days_user_date UNIQUE (user_id, date), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        (
            "CREATE TABLE notes ( id INTEGER NOT NULL, uid VARCHAR(36) NOT NULL, user_id INTEGER NOT NULL, "
            "date VARCHAR(10) NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME, text_enc BLOB NOT NULL, "
            "prompt_enc BLOB, photo_id VARCHAR(40), PRIMARY KEY (id), "
            "CONSTRAINT uq_notes_user_uid UNIQUE (user_id, uid), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        (
            "CREATE TABLE value_defs ( id INTEGER NOT NULL, uid VARCHAR(32) NOT NULL, user_id INTEGER NOT NULL, "
            "position INTEGER NOT NULL, data_enc BLOB NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (id), "
            "CONSTRAINT uq_value_defs_user_uid UNIQUE (user_id, uid), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE INDEX ix_notes_user_date ON notes (user_id, date)",
        "CREATE INDEX ix_value_defs_user_id ON value_defs (user_id)",
    ):
        connection.exec_driver_sql(statement)


def _v3_photos_and_drafts(connection: Connection) -> None:
    """Version 3: photos (the pictures themselves lie sealed in the media folder) and drafts of the day being written.
    Written out as it stood then, not taken from the models."""
    for statement in (
        (
            "CREATE TABLE photos ( id INTEGER NOT NULL, uid VARCHAR(32) NOT NULL, user_id INTEGER NOT NULL, "
            "date VARCHAR(10) NOT NULL, source VARCHAR(8) NOT NULL, asset_id VARCHAR(64), upload_id VARCHAR(36), "
            "width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, preview_size INTEGER NOT NULL, "
            "created_at DATETIME NOT NULL, PRIMARY KEY (id), CONSTRAINT uq_photos_uid UNIQUE (uid), "
            "CONSTRAINT uq_photos_user_upload UNIQUE (user_id, upload_id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE INDEX ix_photos_user_date ON photos (user_id, date)",
        (
            "CREATE TABLE drafts ( id INTEGER NOT NULL, user_id INTEGER NOT NULL, date VARCHAR(10) NOT NULL, "
            "content_enc BLOB NOT NULL, base_revision INTEGER NOT NULL, updated_at DATETIME NOT NULL, "
            "PRIMARY KEY (id), CONSTRAINT uq_drafts_user_date UNIQUE (user_id, date), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
    ):
        connection.exec_driver_sql(statement)


def _v4_sharing(connection: Connection) -> None:
    """Version 4: sharing single days with others on the server, the heart sent back, and when a share was first
    opened. Nothing of the day is copied. Photos learn whether they were taken for a note: until now that showed only
    in a note holding them, which is what marks them here. Written out as it stood then, not taken from the models."""
    for statement in (
        "ALTER TABLE photos ADD COLUMN on_note BOOLEAN DEFAULT 0 NOT NULL",
        (
            "UPDATE photos SET on_note = 1 WHERE EXISTS (SELECT 1 FROM notes WHERE notes.user_id = photos.user_id "
            "AND notes.photo_id = photos.uid)"
        ),
        (
            "CREATE TABLE shares ( id INTEGER NOT NULL, owner_id INTEGER NOT NULL, day_date VARCHAR(10) NOT NULL, "
            "to_user_id INTEGER NOT NULL, with_values BOOLEAN NOT NULL, with_notes BOOLEAN NOT NULL, "
            "created_at DATETIME NOT NULL, PRIMARY KEY (id), "
            "CONSTRAINT uq_shares_owner_day_to UNIQUE (owner_id, day_date, to_user_id), "
            "FOREIGN KEY(owner_id, day_date) REFERENCES days (user_id, date) ON DELETE CASCADE, "
            "FOREIGN KEY(owner_id) REFERENCES users (id) ON DELETE CASCADE, "
            "FOREIGN KEY(to_user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE INDEX ix_shares_to_user_id ON shares (to_user_id)",
        (
            "CREATE TABLE hearts ( share_id INTEGER NOT NULL, at DATETIME NOT NULL, PRIMARY KEY (share_id), "
            "FOREIGN KEY(share_id) REFERENCES shares (id) ON DELETE CASCADE )"
        ),
        (
            "CREATE TABLE share_seen ( share_id INTEGER NOT NULL, at DATETIME NOT NULL, PRIMARY KEY (share_id), "
            "FOREIGN KEY(share_id) REFERENCES shares (id) ON DELETE CASCADE )"
        ),
    ):
        connection.exec_driver_sql(statement)


def _v5_writing_prompts(connection: Connection) -> None:
    """Version 5: the writing prompts each person chose, sealed; and on a note which question it answers, sealed too.
    Written out as it stood then, not taken from the models."""
    for statement in (
        (
            "CREATE TABLE writing_prompts ( user_id INTEGER NOT NULL, content_enc BLOB NOT NULL, "
            "revision INTEGER NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (user_id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "ALTER TABLE notes ADD COLUMN prompt_ref_enc BLOB",
    ):
        connection.exec_driver_sql(statement)


def _v6_immich(connection: Connection) -> None:
    """Version 6: each person's own Immich, sealed; a photo of Immich taken over twice stays one. Written out as it
    stood then, not taken from the models."""
    for statement in (
        (
            "CREATE TABLE immich_links ( user_id INTEGER NOT NULL, content_enc BLOB NOT NULL, "
            "updated_at DATETIME NOT NULL, PRIMARY KEY (user_id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE UNIQUE INDEX uq_photos_user_asset ON photos (user_id, asset_id)",
    ):
        connection.exec_driver_sql(statement)


def _v7_push(connection: Connection) -> None:
    """Version 7: the devices that get reminders by Web Push, sealed, and the day the last reminder went out for; on
    each account whether it ever signed in (an account seen before has). Written out as it stood then, not taken from
    the models."""
    for statement in (
        "ALTER TABLE users ADD COLUMN signed_in_before BOOLEAN DEFAULT 0 NOT NULL",
        "UPDATE users SET signed_in_before = 1 WHERE last_seen_at IS NOT NULL",
        (
            "CREATE TABLE push_devices ( id INTEGER NOT NULL, uid VARCHAR(32) NOT NULL, user_id INTEGER NOT NULL, "
            "endpoint_key VARCHAR(64) NOT NULL, content_enc BLOB NOT NULL, created_at DATETIME NOT NULL, "
            "last_used_at DATETIME, PRIMARY KEY (id), CONSTRAINT uq_push_devices_uid UNIQUE (uid), "
            "CONSTRAINT uq_push_devices_user_endpoint UNIQUE (user_id, endpoint_key), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE INDEX ix_push_devices_user_id ON push_devices (user_id)",
        (
            "CREATE TABLE reminder_marks ( user_id INTEGER NOT NULL, sent_for VARCHAR(10) NOT NULL, "
            "PRIMARY KEY (user_id), FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
    ):
        connection.exec_driver_sql(statement)


def _v8_security(connection: Connection) -> None:
    """Version 8: sessions get a name for the list of devices, "stay signed in" and a stage (a session right after the
    password that may only set up the second factor); passkeys, and the handle they carry per account. Sessions from
    before were all of the long kind, and full. Written out as it stood then, not taken from the models."""
    for statement in (
        "ALTER TABLE auth_sessions ADD COLUMN uid VARCHAR(32) DEFAULT '' NOT NULL",
        "UPDATE auth_sessions SET uid = lower(hex(randomblob(16)))",
        "CREATE UNIQUE INDEX uq_auth_sessions_uid ON auth_sessions (uid)",
        "ALTER TABLE auth_sessions ADD COLUMN remember BOOLEAN DEFAULT 1 NOT NULL",
        "ALTER TABLE auth_sessions ADD COLUMN stage VARCHAR(8) DEFAULT 'full' NOT NULL",
        "ALTER TABLE users ADD COLUMN passkey_handle VARCHAR(64) DEFAULT '' NOT NULL",
        (
            "CREATE TABLE passkeys ( id INTEGER NOT NULL, uid VARCHAR(32) NOT NULL, user_id INTEGER NOT NULL, "
            "credential_id BLOB NOT NULL, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, "
            "name VARCHAR(64) NOT NULL, created_at DATETIME NOT NULL, last_used_at DATETIME, PRIMARY KEY (id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE UNIQUE INDEX uq_passkeys_uid ON passkeys (uid)",
        "CREATE UNIQUE INDEX uq_passkeys_credential ON passkeys (credential_id)",
        "CREATE INDEX ix_passkeys_user_id ON passkeys (user_id)",
    ):
        connection.exec_driver_sql(statement)


def _v9_recovery(connection: Connection) -> None:
    """Version 9: the links with which a person sets a new password, and the sealed name of an API token (names that
    stand in the clear are sealed when the server starts, once the master key is there). Written out as it stood then,
    not taken from the models."""
    for statement in (
        (
            "CREATE TABLE password_resets ( id INTEGER NOT NULL, account_id INTEGER NOT NULL, "
            "token_hash VARCHAR(64) NOT NULL, created_by INTEGER, created_at DATETIME NOT NULL, "
            "expires_at DATETIME NOT NULL, PRIMARY KEY (id), UNIQUE (token_hash), "
            "FOREIGN KEY(account_id) REFERENCES users (id) ON DELETE CASCADE, "
            "FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL )"
        ),
        "CREATE INDEX ix_password_resets_account_id ON password_resets (account_id)",
        "ALTER TABLE api_tokens ADD COLUMN name_enc BLOB",
    ):
        connection.exec_driver_sql(statement)


def _v10_nights_and_locks(connection: Connection) -> None:
    """Version 10: what the operator allows each account (the AI, Immich; both on for the accounts there are), the
    answer of a person to "which day do the notes of this night belong to", and the lock of a day: a day locked for
    good, with the trigger that keeps its row still. Written out as it stood then, not taken from the models."""
    for statement in (
        "ALTER TABLE users ADD COLUMN ai_allowed BOOLEAN DEFAULT 1 NOT NULL",
        "ALTER TABLE users ADD COLUMN immich_allowed BOOLEAN DEFAULT 1 NOT NULL",
        "ALTER TABLE users ADD COLUMN night_for VARCHAR(10)",
        "ALTER TABLE users ADD COLUMN night_day VARCHAR(10)",
        "ALTER TABLE days ADD COLUMN locked_at DATETIME",
        (
            "CREATE TRIGGER trg_days_locked_stays BEFORE UPDATE ON days WHEN OLD.locked_at IS NOT NULL "
            "BEGIN SELECT RAISE(ABORT, 'day is locked'); END"
        ),
    ):
        connection.exec_driver_sql(statement)


def _v11_automatic_writing(connection: Connection) -> None:
    """Version 11: a draft can be one the automatic writing made (it waits for the person), and each person has a mark
    for the day it last tried for. Written out as it stood then, not taken from the models."""
    for statement in (
        "ALTER TABLE drafts ADD COLUMN auto BOOLEAN DEFAULT 0 NOT NULL",
        (
            "CREATE TABLE auto_marks ( user_id INTEGER NOT NULL, tried_for VARCHAR(10) NOT NULL, "
            "PRIMARY KEY (user_id), FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
    ):
        connection.exec_driver_sql(statement)


def _v12_text_photos(connection: Connection) -> None:
    """Version 12: a photo knows whether it was taken for a picture in the text of a page. Nothing that stands is
    marked: a photo from before was chosen on purpose and stays. Written out as it stood then, not taken from the
    models."""
    connection.exec_driver_sql("ALTER TABLE photos ADD COLUMN for_text BOOLEAN DEFAULT 0 NOT NULL")


def _v13_writing_templates(connection: Connection) -> None:
    """Version 13: the templates each person made for their pages, sealed. Written out as it stood then, not taken from
    the models."""
    connection.exec_driver_sql(
        "CREATE TABLE writing_templates ( user_id INTEGER NOT NULL, content_enc BLOB NOT NULL, "
        "revision INTEGER NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (user_id), "
        "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
    )



def _v14_time_capsules(connection: Connection) -> None:
    """Version 14: time capsules, the key of each sealed for every person who holds it, and the photos chosen for a
    capsule that is not closed yet. Written out as it stood then, not taken from the models."""
    for statement in (
        (
            "CREATE TABLE capsules ( id INTEGER NOT NULL, uid VARCHAR(32) NOT NULL, sender_id INTEGER, "
            "client_id VARCHAR(36) NOT NULL, opens_on VARCHAR(10) NOT NULL, written_on VARCHAR(10) NOT NULL, "
            "sealed BOOLEAN NOT NULL, title_enc BLOB NOT NULL, text_enc BLOB NOT NULL, photo_uid VARCHAR(32), "
            "photo_width INTEGER, photo_height INTEGER, photo_size INTEGER NOT NULL, revision INTEGER NOT NULL, "
            "created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, first_opened_at DATETIME, PRIMARY KEY (id), "
            "CONSTRAINT uq_capsules_uid UNIQUE (uid), "
            "CONSTRAINT uq_capsules_sender_client UNIQUE (sender_id, client_id), "
            "FOREIGN KEY(sender_id) REFERENCES users (id) ON DELETE SET NULL )"
        ),
        (
            "CREATE TABLE capsule_keys ( capsule_id INTEGER NOT NULL, user_id INTEGER NOT NULL, "
            "recipient BOOLEAN NOT NULL, key_enc BLOB NOT NULL, arrival_sent BOOLEAN NOT NULL, "
            "open_sent BOOLEAN NOT NULL, read_at DATETIME, PRIMARY KEY (capsule_id, user_id), "
            "FOREIGN KEY(capsule_id) REFERENCES capsules (id) ON DELETE CASCADE, "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        (
            "CREATE TABLE capsule_uploads ( uid VARCHAR(32) NOT NULL, user_id INTEGER NOT NULL, "
            "upload_id VARCHAR(36) NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, "
            "preview_size INTEGER NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (uid), "
            "CONSTRAINT uq_capsule_uploads_user_upload UNIQUE (user_id, upload_id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE )"
        ),
        "CREATE INDEX ix_capsules_sender_id ON capsules (sender_id)",
        "CREATE INDEX ix_capsule_keys_user_id ON capsule_keys (user_id)",
        "CREATE INDEX ix_capsule_uploads_user_id ON capsule_uploads (user_id)",
    ):
        connection.exec_driver_sql(statement)

#: ``MIGRATIONS[n]`` brings a database from version ``n - 1`` to ``n``. Version 1 is the first schema; it has no step.
MIGRATIONS: dict[int, Callable[[Connection], None]] = {
    2: _v2_diary, 3: _v3_photos_and_drafts, 4: _v4_sharing, 5: _v5_writing_prompts, 6: _v6_immich, 7: _v7_push,
    8: _v8_security, 9: _v9_recovery, 10: _v10_nights_and_locks, 11: _v11_automatic_writing,
    12: _v12_text_photos, 13: _v13_writing_templates, 14: _v14_time_capsules,
}

# No pool with an upper bound: with the default pool the sixteenth concurrent request would block the event
# loop waiting for a connection. Opening a SQLite connection costs a fraction of a millisecond.
engine = create_engine(
    f"sqlite:///{_settings.database_path}",
    connect_args={"check_same_thread": False, "timeout": BUSY_SECONDS},
    poolclass=NullPool,
    # A failed statement names its values in the exception, and exceptions reach the log: never texts or hashes.
    hide_parameters=True,
)


def _wal(cursor: Any) -> None:
    """WAL mode, tried again while another connection holds the database: SQLite does not always wait by itself for
    a change of the journal mode."""
    deadline = time.monotonic() + BUSY_SECONDS
    while True:
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as exc:
            if ("locked" not in str(exc) and "busy" not in str(exc)) or time.monotonic() > deadline:
                raise
            time.sleep(0.05)


@event.listens_for(engine, "connect")
def _pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    # The wait first: switching to WAL needs the database to itself for a moment, and two first starts on an empty
    # folder asked at the same time (one of them broke off with "database is locked").
    cursor.execute(f"PRAGMA busy_timeout={BUSY_SECONDS * 1000}")
    _wal(cursor)
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA synchronous=NORMAL")
    # What is deleted is overwritten, not left in free pages: a deleted data key must be gone from the file, or the
    # diary it sealed could be read again with the master key (``services/vault.py``).
    cursor.execute("PRAGMA secure_delete=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


class SchemaTooNew(RuntimeError):
    """The database was written by a newer nexdiary; this one does not know its tables."""


def schema_version(connection: Connection) -> int:
    return int(connection.execute(text("PRAGMA user_version")).scalar() or 0)


def _set_version(connection: Connection, version: int) -> None:
    # PRAGMA takes no bound parameters; the value is an int from this module, never from outside.
    connection.execute(text(f"PRAGMA user_version = {int(version)}"))


def _schema_engine() -> Engine:
    """An engine for changing the schema, on the same file. Python's sqlite3 opens no transaction before ``CREATE`` or
    ``ALTER`` and so commits each one at once; here every transaction begins with an explicit ``BEGIN``, so a step that
    breaks off leaves nothing behind (SQLAlchemy's recipe for pysqlite). Only for the schema: the everyday engine
    keeps the driver's way, which holds no read lock while a request only reads."""
    schema = create_engine(engine.url, poolclass=NullPool, connect_args={"timeout": BUSY_SECONDS})

    @event.listens_for(schema, "connect")
    def _no_driver_transactions(dbapi_connection: Any, _record: Any) -> None:
        dbapi_connection.isolation_level = None
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute("PRAGMA secure_delete=ON")
        dbapi_connection.execute(f"PRAGMA busy_timeout={BUSY_SECONDS * 1000}")

    @event.listens_for(schema, "begin")
    def _begin(connection: Connection) -> None:
        connection.exec_driver_sql("BEGIN IMMEDIATE")

    return schema


def _has_tables(connection: Connection) -> bool:
    found = connection.execute(text("SELECT count(*) FROM sqlite_master WHERE type = 'table'")).scalar()
    return bool(found)


def init_db() -> None:
    """Makes a new database, or brings an older one up to ``SCHEMA_VERSION``."""
    schema = _schema_engine()
    try:
        _init(schema)
    finally:
        schema.dispose()


def _init(schema: Engine) -> None:
    # Read under the write lock: of two processes starting at once, the second waits here and sees what the first did.
    with schema.begin() as connection:
        fresh = not _has_tables(connection)
        current = schema_version(connection)
        if fresh:
            # One transaction: a start that breaks off in between leaves no tables without a version behind.
            Base.metadata.create_all(connection)
            _set_version(connection, SCHEMA_VERSION)
    if fresh:
        logger.info("Database created schema=%s", SCHEMA_VERSION)
        return
    check_version(current)
    if current < SCHEMA_VERSION:
        # A schema change is the moment a backup is worth most: the way back if the new version goes wrong.
        from .services import backups

        backups.create(kind=backups.UPDATE, note=f"before schema {SCHEMA_VERSION}")
        for target in range(current + 1, SCHEMA_VERSION + 1):
            step = MIGRATIONS.get(target)
            if step is None:
                raise RuntimeError(f"No migration to schema {target}.")
            with schema.begin() as connection:
                # Read again under the lock: another process may have taken this step since the first read. A step
                # that is not idempotent (an added column, moved rows) must never run twice.
                if schema_version(connection) >= target:
                    continue
                step(connection)
                _set_version(connection, target)
            logger.info("Database migrated schema=%s", target)


def check_version(version: int) -> None:
    """A schema this nexdiary can open: made by nexdiary (at least 1), and not by a newer one. ``SchemaTooNew`` else."""
    if version > SCHEMA_VERSION:
        raise SchemaTooNew(
            f"The database has schema {version}, this nexdiary knows up to {SCHEMA_VERSION}. "
            "Start the newer version again, or restore a backup made with this one."
        )
    if version < 1:
        raise SchemaTooNew("The database has no schema version. It was not made by nexdiary.")
