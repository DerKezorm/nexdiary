"""A version 3 database as B2 left it, with two people, sealed notes, days, values, a photo and a draft written through
the app, comes to version 4: nothing written is lost, everything still opens, and sharing works on it, its rows going
with the page they belong to."""

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
from .test_schema import drop_v8, fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "value_defs", "photos", "drafts")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def test_a_v3_database_with_a_diary_comes_to_v4_whole(client: TestClient, account: Account,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 6, 18, 0, tzinfo=UTC))
    ben_row = make_account("ben")
    with new_client(ben_row) as ben:
        for person in (client, ben):
            person.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
        note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt"}).json()
        value = client.get("/api/values").json()[0]
        picture = io.BytesIO()
        Image.new("RGB", (40, 30), (10, 20, 30)).save(picture, "PNG")
        photo = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                            content=picture.getvalue()).json()
        client.put("/api/days/2026-10-05", json={"title": "Kastanien", "text": "Ein **langer** Tag.", "tags": ["herbst"],
                                                 "values": {value["id"]: 8}, "cover": f"photo:{photo['id']}"})
        client.put("/api/days/2026-10-06/draft", json={"text": "halb", "base_revision": -1})
        on_note = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                              content=picture.getvalue()).json()
        client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "", "date": "2026-10-05",
                                        "photo_id": on_note["id"]})
        ben.put("/api/days/2026-10-04", json={"title": "Bens Tag"})
        path = get_settings().database_path
        # Back to what B2 made: the tables of version 4 and later gone, the version 3.
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("DROP INDEX uq_photos_user_asset")
            connection.execute("ALTER TABLE photos DROP COLUMN on_note")
            connection.execute("ALTER TABLE notes DROP COLUMN prompt_ref_enc")
            for table in ("immich_links", "writing_prompts", "hearts", "share_seen", "shares"):
                connection.execute(f"DROP TABLE {table}")
            # And what version 7 brought: the push devices, the reminder marks, the mark of a first sign-in.
            connection.execute("DROP TABLE push_devices")
            drop_v8(connection)
            connection.execute("DROP TABLE reminder_marks")
            connection.execute("ALTER TABLE users DROP COLUMN signed_in_before")
            connection.execute("PRAGMA user_version = 3")
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
            foreign = connection.execute("PRAGMA foreign_key_list(shares)").fetchall()
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.executescript(fresh_schema_sql())
            assert migrated == schema_of(connection)
        assert {(row[2], row[3], row[4], row[6]) for row in foreign} == {
            ("days", "owner_id", "user_id", "CASCADE"), ("days", "day_date", "date", "CASCADE"),
            ("users", "owner_id", "id", "CASCADE"), ("users", "to_user_id", "id", "CASCADE")}
        # A photo a note held is a note's; the others are photos of the day.
        marked = {photo["id"]: photo["on_note"] for photo in client.get("/api/photos?date=2026-10-05").json()}
        assert marked == {photo["id"]: False, on_note["id"]: True}
        # Everything written before opens as before.
        day = client.get("/api/days/2026-10-05").json()
        assert (day["title"], day["text"], day["values"], day["cover"]) == (
            "Kastanien", "Ein **langer** Tag.", {value["id"]: 8}, f"photo:{photo['id']}")
        assert [item["text"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [
            note["text"]]
        assert client.get("/api/days/2026-10-06/draft").json()["text"] == "halb"
        assert ben.get("/api/days/2026-10-04").json()["title"] == "Bens Tag"
        # And sharing works on it, bound to the page.
        account_id = account.id
        shared = client.put("/api/days/2026-10-05/shares", json={"to": [ben_row.id], "with_values": True})
        assert shared.status_code == 200
        seen = ben.get(f"/api/shared/{account_id}/2026-10-05").json()
        assert seen["title"] == "Kastanien" and seen["values"][0]["value"] == 8
        assert ben.get(f"/api/shared/{account_id}/2026-10-05/photos/{photo['id']}").status_code == 200
        assert ben.put(f"/api/shared/{account_id}/2026-10-05/heart").status_code == 200
        assert client.delete("/api/days/2026-10-05").status_code == 204
        assert ben.get(f"/api/shared/{account_id}/2026-10-05").status_code == 404
        with closing(sqlite3.connect(path)) as connection:
            assert connection.execute("SELECT count(*) FROM shares").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM hearts").fetchone()[0] == 0
