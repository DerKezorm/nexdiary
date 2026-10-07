"""A version 11 database comes to version 12: nothing written is lost, no photo that stands is marked as taken for the
text (each was chosen on purpose and stays), and the migrated database does what a new one does."""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import clock
from app import db as database
from app.config import get_settings
from app.models import Account
from app.services import backups

from .test_migration_v10 import counts
from .test_photos import picture
from .test_schema import drop_v12, fresh_schema_sql, schema_of


def test_a_v11_database_comes_to_v12_whole_and_marks_no_photo(client: TestClient, account: Account,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    moment = [datetime(2026, 10, 7, 12, 0, tzinfo=UTC)]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    shots = [client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-06"},
                         content=picture()).json()["id"] for _ in range(2)]
    text = f"Ein Tag\n\n![Mia](photo:{shots[0]})"
    assert client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": text}).status_code == 200
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v12(connection)
        connection.execute("PRAGMA user_version = 11")
        connection.commit()
        assert "for_text" not in [row[1] for row in connection.execute("PRAGMA table_info(photos)")]
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        assert connection.execute("SELECT count(*) FROM photos WHERE for_text = 0").fetchone() == (2,)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall() == [
            ("trg_days_locked_stays",)], "the trigger of the lock came through"
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # The photos from before stay whatever is saved: the one not in the text too.
    moment[0] += timedelta(hours=1)
    assert client.put("/api/days/2026-10-06", json={"text": "Ohne Bilder"}).status_code == 200
    assert {photo["id"]: photo["for_text"] for photo in client.get("/api/photos?date=2026-10-06").json()} == {
        shots[0]: False, shots[1]: False}
    # A photo for the text can be taken now.
    taken = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-06", "text": "true"},
                        content=picture())
    assert taken.status_code == 201 and taken.json()["for_text"] is True
    # A step taken is not taken twice.
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
