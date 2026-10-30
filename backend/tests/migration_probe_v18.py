"""A nexdiary started on the data folder of 0.10.0 (schema 17, made by the code of that state, see
``fixtures/v17/make.py``), run as its own process by ``test_migration_v18.py``: the start brings the database up, then
jule reads her days, her photo and her note, attaches a link and a PDF to the open day and tries the locked one. Prints
what it saw as JSON.

The data folder and the master key are put in place by the test; the environment names them.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
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

    from .fixtures.v17.make import LOCKED_DAY, OPEN_DAY
    from .test_schema import fresh_schema_sql, schema_of

    clock.now = lambda: datetime(2026, 10, 30, 10, 0, tzinfo=UTC)  # type: ignore[assignment]
    path = get_settings().database_path
    init_db()
    seen: dict[str, Any] = {}
    with closing(sqlite3.connect(path)) as connection:
        seen["version"] = connection.execute("PRAGMA user_version").fetchone()[0]
        with closing(sqlite3.connect(":memory:")) as fresh:
            fresh.executescript(fresh_schema_sql())
            seen["schema_as_new"] = schema_of(connection) == schema_of(fresh)
            wanted = sorted(row[0] for row in fresh.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'"))
        seen["triggers"] = sorted(row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger'"))
        seen["triggers_as_new"] = seen["triggers"] == wanted
        seen["indexes"] = sorted(row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachments' "
            "AND name NOT LIKE 'sqlite_%'"))
        seen["attachments"] = connection.execute("SELECT count(*) FROM attachments").fetchone()[0]
    seen["backups"] = sorted(item.name for item in (get_settings().data_dir / "backups").glob("*.zip"))

    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="jule").one()
        token = start_session(db, row, "127.0.0.1", "probe")
    with TestClient(app, base_url="http://testserver", headers={"X-Nexdiary-Client": "tab-probe0000"}) as jule:
        jule.cookies.set(SESSION_COOKIE, token)
        day = jule.get(f"/api/days/{OPEN_DAY}").json()
        seen["open_day"] = {"title": day.get("title"), "text": day.get("text"), "attachments": day.get("attachments")}
        seen["locked_day"] = jule.get(f"/api/days/{LOCKED_DAY}").json().get("locked")
        photos = jule.get("/api/photos", params={"date": OPEN_DAY}).json()
        seen["photos"] = [[jule.get(f"/api/photos/{photo['id']}{part}").status_code for part in ("", "/preview")]
                          for photo in photos]
        seen["notes"] = [note["text"] for note in jule.get("/api/notes", params={"date": OPEN_DAY}).json()]
        made = jule.post("/api/attachments/link", json={"date": OPEN_DAY, "url": "https://example.com/fest",
                                                        "title": "Fest", "upload_id": str(uuid.uuid4())})
        seen["link"] = [made.status_code, made.json().get("name")]
        pdf = b"%PDF-1.4\n% nexdiary probe\n%%EOF\n"
        sent = jule.post("/api/attachments", params={"date": OPEN_DAY, "kind": "pdf", "name": "Programm.pdf",
                                                     "upload_id": str(uuid.uuid4())}, content=pdf)
        seen["pdf"] = [sent.status_code, jule.get(f"/api/attachments/{sent.json()['id']}").content == pdf]
        refused = jule.post("/api/attachments/link", json={"date": LOCKED_DAY, "url": "https://example.com/x",
                                                           "upload_id": str(uuid.uuid4())})
        seen["locked_link"] = [refused.status_code, refused.json()["detail"]["code"]]
        storage = jule.get("/api/photos/storage").json()
        seen["storage"] = {"attachments": storage["attachments"], "kinds": sorted(storage["by_kind"])}
    sys.stdout.write("\n" + json.dumps(seen, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
