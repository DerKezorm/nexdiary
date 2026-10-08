"""A version 12 database with a diary in it comes to version 13: nothing written is lost, the table for the templates
is there and works, and the migrated database does what a new one does."""

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
from .test_schema import drop_v13, fresh_schema_sql, schema_of


def test_a_v12_database_comes_to_v13_whole_and_keeps_templates(client: TestClient, account: Account,
                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 8, 12, 0, tzinfo=UTC))
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt", "date": "2026-10-07"})
    assert client.put("/api/days/2026-10-07", json={"title": "Kastanien", "text": "Ein langer Tag."}).status_code == 200
    assert client.post("/api/prompts/own", json={"text": "Was nehme ich mit?"}).status_code == 201
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v13(connection)
        connection.execute("PRAGMA user_version = 12")
        connection.commit()
        assert "writing_templates" not in [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")]
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        assert connection.execute("SELECT count(*) FROM writing_templates").fetchone() == (0,)
        assert connection.execute("SELECT count(*) FROM writing_prompts").fetchone() == (1,), "the prompts stayed"
        foreign = connection.execute("PRAGMA foreign_key_list(writing_templates)").fetchall()
        assert [(row[2], row[3], row[4], row[6]) for row in foreign] == [("users", "user_id", "id", "CASCADE")]
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # The old data reads as before, and the templates work on the migrated database.
    assert client.get("/api/days/2026-10-07").json()["title"] == "Kastanien"
    assert client.get("/api/templates").json() == {"templates": [], "default": None, "revision": -1}
    sections = [{"heading": "Was nehme ich mit?", "question": ""}]
    kept = client.put("/api/templates", json={"templates": [{"name": "Mitnehmen", "sections": sections}],
                                              "default": None, "revision": -1})
    assert kept.status_code == 200 and kept.json()["revision"] == 0
    # A step taken is not taken twice.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert client.get("/api/templates").json()["templates"][0]["name"] == "Mitnehmen"
