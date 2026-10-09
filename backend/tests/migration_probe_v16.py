"""A nexdiary started on the data folder of an older one (schema 15, made by the code of that state, see
``fixtures/v15/make.py``), run as its own process by ``test_migration_v16.py``: the start brings the database up, and
the time capsules it holds are read, opened and changed as the people they belong to would. Prints what it saw as JSON.

The data folder and the master key are put in place by the test; the environment names them.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, datetime
from typing import Any


def main() -> int:
    from fastapi.testclient import TestClient

    from app import clock
    from app.config import get_settings
    from app.db import SessionLocal, init_db
    from app.main import app
    from app.models import Account
    from app.security import SESSION_COOKIE, start_session

    from .test_schema import fresh_schema_sql, schema_of

    moment = [datetime(2026, 10, 10, 10, 0, tzinfo=UTC)]
    clock.now = lambda: moment[0]  # type: ignore[assignment]
    path = get_settings().database_path
    init_db()
    seen: dict[str, Any] = {}
    with closing(sqlite3.connect(path)) as connection:
        seen["version"] = connection.execute("PRAGMA user_version").fetchone()[0]
        with closing(sqlite3.connect(":memory:")) as fresh:
            fresh.executescript(fresh_schema_sql())
            seen["schema_as_new"] = schema_of(connection) == schema_of(fresh)
        seen["photo_rows"] = sorted(list(row) for row in connection.execute(
            "SELECT capsules.uid, capsule_photos.uid, position, width, height, size FROM capsule_photos "
            "JOIN capsules ON capsules.id = capsule_photos.capsule_id"))
        seen["plain"] = [row[0] for row in connection.execute("SELECT plain FROM capsules ORDER BY id")]
        seen["uploads"] = [row[0] for row in connection.execute("SELECT uid FROM capsule_uploads")]
        seen["notes"] = connection.execute("SELECT count(*) FROM notes").fetchone()[0]
        seen["backups"] = len(list((get_settings().data_dir / "backups").glob("*.zip")))

    def browser(name: str) -> TestClient:
        with SessionLocal() as db:
            row = db.query(Account).filter_by(name=name).one()
            token = start_session(db, row, "127.0.0.1", "probe")
        client = TestClient(app, base_url="http://testserver", headers={"X-Nexdiary-Client": "tab-probe0000"})
        client.cookies.set(SESSION_COOKIE, token)
        return client

    def look(client: TestClient) -> dict[str, Any]:
        """Every capsule the person holds, as the person sees it, with the answers of its photo routes."""
        out: dict[str, Any] = {}
        lists = client.get("/api/capsules").json()
        out["for_me"] = {item["title"]: item for item in lists["for_me"]}
        out["from_me"] = {item["title"]: item for item in lists["from_me"]}
        out["one"] = {}
        for item in [*lists["for_me"], *lists["from_me"]]:
            single = client.get(f"/api/capsules/{item['id']}").json()
            pictures = []
            for photo in single.get("photos", []):
                for suffix in ("", "/preview"):
                    answer = client.get(f"/api/capsules/{item['id']}/photos/{photo['id']}{suffix}")
                    pictures.append([answer.status_code, answer.headers.get("content-type", "")])
            single["pictures"] = pictures
            out["one"][item["title"]] = single
        return out

    jule, tom, mia = browser("jule"), browser("tom"), browser("mia")
    ids = {item["title"]: item["id"] for item in jule.get("/api/capsules").json()["from_me"]}
    # Every photo the old database names, asked for directly before its day: nothing for the ones it is for.
    photo_uids = [row[1] for row in seen["photo_rows"]]
    seen["tom_early"] = [tom.get(f"/api/capsules/{uid}/photos/{photo}").status_code
                         for uid in ids.values() for photo in photo_uids]
    seen["jule_early"] = look(jule)
    seen["tom_before"] = look(tom)
    seen["mia_before"] = look(mia)

    # Jule changes the letter to Tom: another day (every photo sealed anew), the photo she chose and never closed
    # added, the text as she was given it (escaped) sent back as it is.
    letter = jule.get(f"/api/capsules/{ids['Für Heiligabend']}").json()
    changed = jule.put(f"/api/capsules/{letter['id']}", json={
        "revision": letter["revision"], "to": [person["id"] for person in letter["to"]], "opens_on": "2026-12-25",
        "title": letter["title"], "text": letter["text"],
        "photos": [photo["id"] for photo in letter["photos"]] + seen["uploads"]})
    seen["change"] = [changed.status_code, changed.json()]
    with closing(sqlite3.connect(path)) as connection:
        seen["plain_after"] = [row[0] for row in connection.execute("SELECT plain FROM capsules ORDER BY id")]
        seen["uploads_after"] = connection.execute("SELECT count(*) FROM capsule_uploads").fetchone()[0]
    seen["media_after"] = sorted(item.name for item in get_settings().media_dir.iterdir())

    for client in (jule, tom, mia):
        client.close()
    # The days come; everybody signs in anew then (a session of months ago would have run out).
    moment[0] = datetime(2026, 12, 25, 10, 0, tzinfo=UTC)
    with browser("tom") as tom:
        seen["tom_on_the_day"] = look(tom)
    moment[0] = datetime(2027, 10, 9, 10, 0, tzinfo=UTC)
    with browser("jule") as jule, browser("mia") as mia:
        seen["jule_on_the_day"] = look(jule)
        seen["mia_on_the_day"] = look(mia)
    sys.stdout.write("\n" + json.dumps(seen, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
