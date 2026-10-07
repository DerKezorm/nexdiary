"""A version 10 database comes to version 11: nothing written is lost, a draft that stood stays the person's own, the
morning writing has a mark per person to come, and the migrated database does what a new one does."""

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

from .test_migration_v10 import counts
from .test_schema import drop_v11, fresh_schema_sql, schema_of


def test_a_v10_database_comes_to_v11_whole(client: TestClient, account: Account,
                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 12, 0, tzinfo=UTC))
    assert client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt", "date": "2026-10-06"})
    assert client.put("/api/days/2026-10-06/draft", json={"text": "Angefangen", "base_revision": -1}).status_code == 200
    client.put("/api/days/2026-10-05", json={"title": "Kastanien", "text": "Ein langer Tag."})
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v11(connection)
        connection.execute("PRAGMA user_version = 10")
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
        assert connection.execute("SELECT date, auto FROM drafts").fetchall() == [("2026-10-06", 0)]
        assert connection.execute("SELECT count(*) FROM auto_marks").fetchone() == (0,)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall() == [
            ("trg_days_locked_stays",)], "the trigger of the lock came through"
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # What was written reads as before, and the draft is the person's own.
    draft = client.get("/api/days/2026-10-06/draft").json()
    assert draft["text"] == "Angefangen" and draft["auto"] is False
    assert client.get("/api/days/2026-10-05").json()["title"] == "Kastanien"
    assert client.get("/api/catch-up").json() == {"count": 1, "auto": 0, "days": [
        {"date": "2026-10-06", "notes": 1, "start": "mit mia kastanien gesammelt", "auto": False}]}
    # A step taken is not taken twice.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
