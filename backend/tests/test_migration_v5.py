"""A version 4 database as B3 left it, with a diary, a photo, a draft and a shared day, comes to version 5: nothing
written is lost, everything still opens, and the writing prompts work on it."""

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

from .conftest import make_account, new_client
from .test_schema import fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "value_defs", "photos", "drafts", "shares", "hearts")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def test_a_v4_database_with_a_diary_comes_to_v5_whole(client: TestClient, account: Account,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 6, 18, 0, tzinfo=UTC))
    ben_row = make_account("ben")
    with new_client(ben_row) as ben:
        for person in (client, ben):
            person.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
        note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt",
                                               "prompt": "Was hat dich heute glücklich gemacht?"}).json()
        value = client.get("/api/values").json()[0]
        picture = io.BytesIO()
        Image.new("RGB", (40, 30), (10, 20, 30)).save(picture, "PNG")
        photo = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                            content=picture.getvalue()).json()
        client.put("/api/days/2026-10-05", json={"title": "Kastanien", "text": "Ein **langer** Tag.", "tags": ["herbst"],
                                                 "values": {value["id"]: 8}, "cover": f"photo:{photo['id']}",
                                                 "written_by": "ai"})
        client.put("/api/days/2026-10-06/draft", json={"text": "halb", "base_revision": -1})
        assert client.put("/api/days/2026-10-05/shares", json={"to": [ben_row.id], "with_values": False,
                                                              "with_notes": True}).status_code == 200
        owner = client.get("/api/auth/me").json()["id"]
        assert ben.put(f"/api/shared/{owner}/2026-10-05/heart").status_code == 200
        path = get_settings().database_path
        # Back to what B3 made: the table of version 5 gone, the version 4.
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("DROP INDEX uq_photos_user_asset")
            connection.execute("DROP TABLE immich_links")
            connection.execute("DROP TABLE writing_prompts")
            connection.execute("ALTER TABLE notes DROP COLUMN prompt_ref_enc")
            connection.execute("PRAGMA user_version = 4")
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
            foreign = connection.execute("PRAGMA foreign_key_list(writing_prompts)").fetchall()
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.executescript(fresh_schema_sql())
            assert migrated == schema_of(connection)
        assert {(row[2], row[3], row[4], row[6]) for row in foreign} == {("users", "user_id", "id", "CASCADE")}
        # Everything written still opens.
        day = client.get("/api/days/2026-10-05").json()
        assert (day["title"], day["text"], day["written_by"], day["values"]) == (
            "Kastanien", "Ein **langer** Tag.", "ai", {value["id"]: 8})
        assert client.get("/api/days/2026-10-06/draft").json()["text"] == "halb"
        notes = client.get("/api/notes", params={"date": "2026-10-06"}).json()
        assert [(entry["id"], entry["prompt"]) for entry in notes] == [(note["id"],
                                                                         "Was hat dich heute glücklich gemacht?")]
        assert ben.get(f"/api/shared/{owner}/2026-10-05").json()["title"] == "Kastanien"
        # The writing prompts work on the migrated database, and an account deleted takes its choice along.
        assert client.post("/api/prompts/own", json={"text": "Neu?"}).status_code == 201
        assert ben.put("/api/prompts", json={"on": False}).status_code == 200
        assert client.get("/api/today").json()["question"]
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT count(*) FROM writing_prompts").fetchone()[0] == 2
