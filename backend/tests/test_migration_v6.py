"""A version 5 database as B4 left it, with a diary, photos and writing prompts, comes to version 6: nothing written is
lost, everything still opens, and Immich works on it: a link per person, and a photo taken twice stays one."""

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

TABLES = ("users", "user_keys", "days", "notes", "value_defs", "photos", "drafts", "shares", "hearts",
          "writing_prompts")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def indexes(connection: sqlite3.Connection) -> dict[str, int]:
    return {row[1]: row[2] for row in connection.execute("PRAGMA index_list(photos)")}


def test_a_v5_database_with_a_diary_comes_to_v6_whole(client: TestClient, account: Account,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 6, 18, 0, tzinfo=UTC))
    client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt"})
    picture = io.BytesIO()
    Image.new("RGB", (40, 30), (10, 20, 30)).save(picture, "PNG")
    uploads = [client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                           content=picture.getvalue()).json() for _ in range(2)]
    client.put("/api/days/2026-10-05", json={"title": "Kastanien", "cover": f"photo:{uploads[0]['id']}"})
    assert client.post("/api/prompts/own", json={"text": "Was war schön?"}).status_code == 201
    path = get_settings().database_path
    # Back to what B4 made: the table and the index of version 6 gone, the version 5.
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DROP INDEX uq_photos_user_asset")
        connection.execute("DROP TABLE immich_links")
        connection.execute("PRAGMA user_version = 5")
        connection.commit()
        assert "uq_photos_user_asset" not in indexes(connection)
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION == 6
        migrated = schema_of(connection)
        assert indexes(connection)["uq_photos_user_asset"] == 1, "unique"
        foreign = connection.execute("PRAGMA foreign_key_list(immich_links)").fetchall()
        # Two uploads without an asset stand side by side under the unique index: NULL is never equal.
        assert connection.execute("SELECT count(*) FROM photos WHERE asset_id IS NULL").fetchone()[0] == 2
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    assert {(row[2], row[3], row[4], row[6]) for row in foreign} == {("users", "user_id", "id", "CASCADE")}
    day = client.get("/api/days/2026-10-05").json()
    assert (day["title"], day["cover"]) == ("Kastanien", f"photo:{uploads[0]['id']}")
    assert client.get(f"/api/photos/{uploads[1]['id']}").status_code == 200
    assert client.get("/api/immich").json() == {"allowed": False, "connected": False}
    another = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                          content=picture.getvalue())
    assert another.status_code == 201
