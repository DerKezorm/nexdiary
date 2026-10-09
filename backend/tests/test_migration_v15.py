"""A version 14 database with a diary and a time capsule in it comes to version 15: nothing written is lost, the table
of the family question is there and works, and the migrated database does what a new one does."""

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
from .test_schema import drop_v15, fresh_schema_sql, schema_of


def test_a_v14_database_comes_to_v15_whole_and_keeps_family_answers(client: TestClient, account: Account,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 9, 12, 0, tzinfo=UTC))
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt", "date": "2026-10-08"})
    assert client.put("/api/days/2026-10-08", json={"title": "Kastanien", "text": "Ein langer Tag."}).status_code == 200
    tom = make_account("tom")
    sent = client.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [tom.id], "opens_on": "2026-12-24",
                                              "title": "Für Heiligabend", "text": "Bis bald."})
    assert sent.status_code == 201, sent.text
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v15(connection)
        connection.execute("PRAGMA user_version = 14")
        connection.commit()
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        assert "family_answers" not in tables
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        assert connection.execute("SELECT count(*) FROM family_answers").fetchone() == (0,)
        foreign = connection.execute("PRAGMA foreign_key_list(family_answers)").fetchall()
        assert [(row[2], row[3], row[4], row[6]) for row in foreign] == [("users", "user_id", "id", "CASCADE")]
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # The old data reads as before, and the family question works on the migrated database.
    assert client.get("/api/days/2026-10-08").json()["title"] == "Kastanien"
    assert client.get("/api/capsules").json()["from_me"][0]["title"] == "Für Heiligabend"
    client.put("/api/me/preferences", json={"family": True})
    assert client.put("/api/family/answer", json={"date": "2026-10-09", "text": "Kastanien",
                                                  "note_id": str(uuid.uuid4())}).status_code == 200
    with new_client(tom) as reader:
        reader.put("/api/me/preferences", json={"timezone": "UTC", "family": True})
        card = reader.put("/api/family/answer", json={"date": "2026-10-09", "text": "Suppe",
                                                      "note_id": str(uuid.uuid4())}).json()
        assert [item["text"] for item in card["answers"]] == ["Kastanien"]
    # A step taken is not taken twice.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert client.get("/api/family").json()["mine"]["text"] == "Kastanien"
