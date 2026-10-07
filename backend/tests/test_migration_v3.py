"""A version 2 database as B1 left it, with sealed notes, a day and values written through the app, comes to version 3:
nothing written is lost, everything still opens, and the new photos and drafts work on it."""

from __future__ import annotations

import io
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import clock
from app import db as database
from app.config import get_settings
from app.models import Account
from app.services import backups

from .test_schema import fresh_schema_sql, schema_of


def test_a_v2_database_with_a_diary_comes_to_v3_whole(client: TestClient, account: Account,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 6, 18, 0, tzinfo=UTC))
    client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt"}).json()
    value = client.get("/api/values").json()[0]
    client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag.", "tags": ["herbst"],
                                             "values": {value["id"]: 8}, "written_by": "self"})
    path = get_settings().database_path
    # Back to what B1 made: the tables of version 3 and later gone, the version 2.
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("ALTER TABLE notes DROP COLUMN prompt_ref_enc")
        for later in ("writing_prompts", "hearts", "share_seen", "shares"):
            connection.execute(f"DROP TABLE {later}")
        connection.execute("DROP TABLE photos")
        connection.execute("DROP TABLE drafts")
        connection.execute("PRAGMA user_version = 2")
        connection.commit()
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    # Everything written before opens as before.
    day = client.get("/api/days/2026-10-06").json()
    assert (day["title"], day["text"], day["tags"], day["values"]) == ("Kastanien", "Ein langer Tag.", ["herbst"],
                                                                      {value["id"]: 8})
    assert day["cover"] == "illu:baum.abend.herbst" and day["revision"] == 0
    assert [item["text"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [note["text"]]
    # And the new parts work on it.
    picture = io.BytesIO()
    Image.new("RGB", (40, 30), (10, 20, 30)).save(picture, "PNG")
    photo = client.post("/api/photos", params={"upload_id": str(uuid.uuid4())}, content=picture.getvalue())
    assert photo.status_code == 201
    assert client.put("/api/days/2026-10-06", json={"cover": f"photo:{photo.json()['id']}",
                                                    "base_revision": 0}).json()["cover_chosen"] is True
    assert client.put("/api/days/2026-10-06/draft", json={"text": "weiter", "base_revision": 1}).status_code == 200
