"""Makes the data folder of a nexdiary at schema 17 (release 0.10.0, ``38e9ca2``) with a written day, a photo, notes and
a locked day, for ``test_migration_v18.py``. Not run by the tests: it needs the code of that state, not the current
one.

    git archive 38e9ca2 backend | tar -x -C <folder>
    cd <folder>/backend
    python <this file> <empty folder>

Then copy ``nexdiary.db`` of that folder here as ``nexdiary-v17.sqlite`` (no ``.db`` file goes into a commit,
``test_basics.py``), and its ``media/``. The master key is not kept: it follows from ``fixture_key()``
(``test_migration_v18.py`` writes it into place before the start), so no key lies in the repository.

In it: jule with the page of ``OPEN_DAY`` (``OPEN_TEXT``), a photo of that day and a note on it, and the page of
``LOCKED_DAY``, locked for good.
"""

from __future__ import annotations

import hashlib
import io
import os
import sqlite3
import sys
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

OPEN_DAY = "2026-10-20"
OPEN_TEXT = "Am Fluss entlang, die Kastanien fallen."
LOCKED_DAY = "2026-10-21"
NOTE_TEXT = "kastanien sammeln"


def fixture_key() -> bytes:
    """The master key of the fixture: derived from a phrase, never written down."""
    return hashlib.sha256(b"nexdiary fixture of schema 17").digest()


def main() -> int:
    folder = Path(sys.argv[1]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "NEXDIARY_DATA_DIR": str(folder),
        "NEXDIARY_MEDIA_DIR": str(folder / "media"),
        "NEXDIARY_LOCALES_DIR": str(folder / "locales"),
        "NEXDIARY_DISABLE_BACKGROUND": "1",
        "NEXDIARY_FRONTEND_DIST": str(folder / "no-frontend"),
        "NEXDIARY_SECRET_KEY": "fixture-secret-" + uuid.uuid4().hex,
        "NEXDIARY_ARGON2_TIME": "1",
        "NEXDIARY_ARGON2_MEMORY_KIB": "1024",
        "NEXDIARY_ARGON2_PARALLELISM": "1",
        "NEXDIARY_UPDATE_URL": "http://127.0.0.1:9/releases/latest",
    })
    from app.services import vault

    (folder / "keys").mkdir(exist_ok=True)
    (folder / "keys" / "master.key").write_bytes(vault._encode(fixture_key()))

    from fastapi.testclient import TestClient
    from PIL import Image

    from app import clock
    from app.db import SCHEMA_VERSION, SessionLocal, init_db
    from app.main import app
    from app.models import MEMBER, Account, Setting
    from app.security import SESSION_COOKIE, hash_password, start_session

    assert SCHEMA_VERSION == 17, "run this with the code of 38e9ca2"
    init_db()
    clock.now = lambda: datetime(2026, 10, 22, 10, 0, tzinfo=UTC)  # type: ignore[assignment]
    with SessionLocal() as db:
        db.add(Setting(key="two_factor_required", value=False))
        db.commit()
        row = Account(name="jule", role=MEMBER, password_hash=hash_password("fixture password jule"))
        db.add(row)
        db.commit()
        token = start_session(db, row, "127.0.0.1", "fixture")
    jule = TestClient(app, base_url="http://testserver", headers={"X-Nexdiary-Client": "tab-fixture00"})
    jule.cookies.set(SESSION_COOKIE, token)
    assert jule.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200

    out = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 122, 82)).save(out, "JPEG")
    answer = jule.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": OPEN_DAY}, content=out.getvalue())
    assert answer.status_code == 201, answer.text
    assert jule.put(f"/api/days/{OPEN_DAY}", json={"title": "Herbst", "text": OPEN_TEXT}).status_code == 200
    answer = jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": NOTE_TEXT, "date": OPEN_DAY})
    assert answer.status_code in (200, 201), answer.text
    assert jule.put(f"/api/days/{LOCKED_DAY}", json={"title": "Fest", "text": "Für immer so."}).status_code == 200
    assert jule.post(f"/api/days/{LOCKED_DAY}/lock").status_code == 200
    jule.close()
    with closing(sqlite3.connect(folder / "nexdiary.db")) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 17
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("PRAGMA journal_mode=DELETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
