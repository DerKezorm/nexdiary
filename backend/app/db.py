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
SCHEMA_VERSION = 1

#: ``MIGRATIONS[n]`` brings a database from version ``n - 1`` to ``n``. Version 1 is the first schema; it has no step.
MIGRATIONS: dict[int, Callable[[Connection], None]] = {}

# No pool with an upper bound: with the default pool the sixteenth concurrent request would block the event
# loop waiting for a connection. Opening a SQLite connection costs a fraction of a millisecond.
engine = create_engine(
    f"sqlite:///{_settings.database_path}",
    connect_args={"check_same_thread": False, "timeout": BUSY_SECONDS},
    poolclass=NullPool,
    # A failed statement names its values in the exception, and exceptions reach the log: never texts or hashes.
    hide_parameters=True,
)


@event.listens_for(engine, "connect")
def _pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute(f"PRAGMA busy_timeout={BUSY_SECONDS * 1000}")
    cursor.execute("PRAGMA synchronous=NORMAL")
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
