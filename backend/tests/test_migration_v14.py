"""A version 13 database with a diary in it comes to version 14: nothing written is lost, the tables of the time
capsules are there and work, and the migrated database does what a new one does."""

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
from .test_migration_v10 import counts
from .test_schema import drop_v14, fresh_schema_sql, schema_of


def test_a_v13_database_comes_to_v14_whole_and_keeps_time_capsules(client: TestClient, account: Account,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 9, 12, 0, tzinfo=UTC))
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt", "date": "2026-10-08"})
    assert client.put("/api/days/2026-10-08", json={"title": "Kastanien", "text": "Ein langer Tag."}).status_code == 200
    sections = [{"heading": "Was nehme ich mit?", "question": ""}]
    assert client.put("/api/templates", json={"templates": [{"name": "Mitnehmen", "sections": sections}],
                                              "default": None, "revision": -1}).status_code == 200
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v14(connection)
        connection.execute("PRAGMA user_version = 13")
        connection.commit()
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        assert not any(name.startswith("capsule") for name in tables)
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        for table in ("capsules", "capsule_keys", "capsule_uploads"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,), table  # noqa: S608
        foreign = connection.execute("PRAGMA foreign_key_list(capsules)").fetchall()
        assert [(row[2], row[3], row[4], row[6]) for row in foreign] == [("users", "sender_id", "id", "SET NULL")]
        keys = sorted((row[2], row[3], row[4], row[6]) for row in connection.execute(
            "PRAGMA foreign_key_list(capsule_keys)").fetchall())
        assert keys == [("capsules", "capsule_id", "id", "CASCADE"), ("users", "user_id", "id", "CASCADE")]
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # The old data reads as before, and capsules work on the migrated database.
    assert client.get("/api/days/2026-10-08").json()["title"] == "Kastanien"
    assert client.get("/api/templates").json()["templates"][0]["name"] == "Mitnehmen"
    tom = make_account("tom")
    sent = client.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [tom.id], "opens_on": "2026-12-24",
                                              "title": "Für Heiligabend", "text": "Bis bald."})
    assert sent.status_code == 201, sent.text
    with new_client(tom) as reader:
        assert reader.get("/api/capsules").json()["for_me"][0]["title"] == "Für Heiligabend"
    # A step taken is not taken twice.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert client.get("/api/capsules").json()["from_me"][0]["title"] == "Für Heiligabend"
