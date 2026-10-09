"""Makes the data folder of a nexdiary at schema 15 (release state 5f2556c) with time capsules in it, for
``test_migration_v16.py``. Not run by the tests: it needs the code of that state, not the current one.

    git archive 5f2556c backend | tar -x -C <folder>
    cd <folder>/backend
    python <this file> <empty folder>

Then copy ``nexdiary.db`` of that folder here as ``nexdiary-v15.sqlite`` (no ``.db`` file goes into a commit,
``test_basics.py``), and its ``media/``. The master key is not kept: it follows from ``fixture_key()``
(``test_migration_v16.py`` writes it into place before the start), so no key lies in the repository.
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


def fixture_key() -> bytes:
    """The master key of the fixture: derived from a phrase, never written down."""
    return hashlib.sha256(b"nexdiary fixture of schema 15").digest()


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
    from app.db import SessionLocal, init_db
    from app.main import app
    from app.models import MEMBER, Account, Setting
    from app.security import SESSION_COOKIE, hash_password, start_session

    init_db()
    clock.now = lambda: datetime(2026, 10, 9, 10, 0, tzinfo=UTC)  # type: ignore[assignment]
    with SessionLocal() as db:
        db.add(Setting(key="two_factor_required", value=False))
        db.commit()

    def browser(name: str) -> TestClient:
        with SessionLocal() as db:
            row = Account(name=name, role=MEMBER, password_hash=hash_password("fixture password " + name))
            db.add(row)
            db.commit()
            token = start_session(db, row, "127.0.0.1", "fixture")
        client = TestClient(app, base_url="http://testserver", headers={"X-Nexdiary-Client": "tab-fixture00"})
        client.cookies.set(SESSION_COOKIE, token)
        assert client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
        return client

    def picture(colour: tuple[int, int, int]) -> bytes:
        out = io.BytesIO()
        Image.new("RGB", (64, 48), colour).save(out, "JPEG")
        return out.getvalue()

    def upload(client: TestClient, colour: tuple[int, int, int]) -> str:
        answer = client.post("/api/capsules/photos", params={"upload_id": str(uuid.uuid4())}, content=picture(colour))
        assert answer.status_code == 201, answer.text
        return str(answer.json()["id"])

    jule, tom, mia = browser("jule"), browser("tom"), browser("mia")
    ids = {name: client.get("/api/auth/me").json()["id"] for name, client in (("jule", jule), ("tom", tom), ("mia", mia))}

    def close(to: list[int], opens: str, title: str, text: str, photo: str | None) -> None:
        answer = jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": to, "opens_on": opens, "title": title,
                                                  "text": text, "photo": photo})
        assert answer.status_code == 201, answer.text

    # A letter in plain words that look like Markdown: they must stay words after the update.
    close([ids["tom"]], "2026-12-24", "Für Heiligabend",
          "Lieber Tom,\n*das* ist kein Fett und # keine Überschrift.\n- kein Punkt\n1. Platz für dich\n\n"
          "> kein Zitat [kein Link](https://example.com) ![kein Bild](photo:0123)\n\nBis bald \\o/", upload(jule, (200, 60, 60)))
    close([ids["jule"]], "2027-10-09", "An mich, in einem Jahr", "Wo stehe ich?", upload(jule, (60, 200, 60)))
    close([ids["jule"], ids["mia"]], "2026-11-01", "Vorsätze", "Mehr draußen sein.", None)
    upload(jule, (60, 60, 200))  # chosen, not closed yet
    assert jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "kastanien", "date": "2026-10-09"}
                     ).status_code in (200, 201)
    for client in (jule, tom, mia):
        client.close()
    with closing(sqlite3.connect(folder / "nexdiary.db")) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 15
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("PRAGMA journal_mode=DELETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
