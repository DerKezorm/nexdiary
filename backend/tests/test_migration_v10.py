"""A version 9 database as B9 left it comes to version 10: nothing written is lost, every account is allowed the AI and
Immich as before, the days already written can be locked, and the lock is held by the database itself."""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app import clock
from app import db as database
from app.config import get_settings
from app.models import Account
from app.services import backups

from .conftest import make_account, new_client
from .test_schema import drop_v10, fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "photos", "drafts", "shares", "auth_sessions")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def test_a_v9_database_comes_to_v10_whole_and_its_days_can_be_locked(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 12, 0, tzinfo=UTC))
    assert client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt", "date": "2026-10-06"})
    client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag."})
    client.put("/api/days/2026-10-05", json={"tags": ["nur-ein-tag"]})
    rita = make_account("rita")
    with new_client(rita) as other:
        other.put("/api/days/2026-10-06", json={"title": "Ritas Tag", "text": "Etwas Eigenes."})
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v10(connection)
        connection.execute("PRAGMA user_version = 9")
        connection.commit()
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        # Everybody there was is allowed both, nobody has answered for a night, no day is locked.
        assert connection.execute("SELECT count(*) FROM users WHERE ai_allowed = 1 AND immich_allowed = 1 "
                                  "AND night_for IS NULL AND night_day IS NULL").fetchone() == (2,)
        assert connection.execute("SELECT count(*) FROM days WHERE locked_at IS NOT NULL").fetchone() == (0,)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall() == [
            ("trg_days_locked_stays",)]
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # What was written reads as before, and the migrated database does what the new one does.
    assert client.get("/api/days/2026-10-06").json()["title"] == "Kastanien"
    assert client.get("/api/ai").json()["allowed"] is True
    assert client.post("/api/days/2026-10-05/lock").status_code == 409, "a day of tags only is not a page"
    locked = client.post("/api/days/2026-10-06/lock")
    assert locked.status_code == 200 and locked.json()["locked"] is True
    assert client.put("/api/days/2026-10-06", json={"text": "zu spät"}).json()["detail"]["code"] == "day_locked"
    with closing(sqlite3.connect(path)) as connection, pytest.raises(sqlite3.DatabaseError, match="locked"):
        connection.execute("UPDATE days SET locked_at = NULL")
    with new_client(rita) as other:
        assert other.get("/api/days/2026-10-06").json()["locked"] is False
    assert client.put("/api/night", json={"choice": "today"}).json()["detail"]["code"] == "not_night"
    # Taking a step twice is not done: a second start changes nothing.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
