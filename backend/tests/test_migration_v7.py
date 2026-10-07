"""A version 6 database as B5 left it comes to version 7: nothing written is lost, an account that signed in before
counts as signed in (its next sign-in from a new browser is news), one that never did does not, and Web Push and the
reminders work on it."""

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
from app.services import backups, reminders

from .conftest import make_account
from .fake_push import FakePushService
from .test_schema import fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "value_defs", "photos", "drafts", "shares", "hearts",
          "writing_prompts", "immich_links")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def test_a_v6_database_comes_to_v7_whole(client: TestClient, account: Account, push_service: FakePushService,
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 6, 0, tzinfo=UTC))
    client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt"})
    client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag."})
    never = make_account("rike")
    path = get_settings().database_path
    # Back to what B5 made: the tables and the column of version 7 gone, the version 6.
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DROP TABLE push_devices")
        connection.execute("DROP TABLE reminder_marks")
        connection.execute("ALTER TABLE users DROP COLUMN signed_in_before")
        connection.execute("PRAGMA user_version = 6")
        connection.commit()
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION == 7
        migrated = schema_of(connection)
        marks = dict(connection.execute("SELECT name, signed_in_before FROM users").fetchall())
        foreign = {table: connection.execute(f"PRAGMA foreign_key_list({table})").fetchall()
                   for table in ("push_devices", "reminder_marks")}
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    assert marks == {"tester": 1, never.name: 0}
    for found in foreign.values():
        assert {(row[2], row[3], row[4], row[6]) for row in found} == {("users", "user_id", "id", "CASCADE")}
    # Everything still opens, and Web Push and the reminders work on the migrated database.
    assert client.get("/api/days/2026-10-06").json()["title"] == "Kastanien"
    assert client.post("/api/push/devices", json=push_service.device().subscription()).status_code == 201
    client.put("/api/me/reminder", json={"mode": "daily", "time": "20:30", "skip_if_written": False})
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC)) == 1
    assert reminders.run_once(datetime(2026, 10, 7, 18, 31, tzinfo=UTC)) == 0
