"""Makes the data folders of a nexdiary at schema 16 (release 0.6.0) with its one sign-in provider, for
``test_migration_v17.py``. Not run by the tests: it needs the code of that state, not the current one.

    git archive v0.6.0 backend | tar -x -C <folder>
    cd <folder>/backend
    python <this file> <empty folder>

It writes two databases through 0.6.0's own code: ``nexdiary-v16.sqlite`` (the switch "the provider checks the second
factor" off, as from the start) and ``nexdiary-v16-trusted.sqlite`` (on). Copy both here. The master key and the
server secret are not kept: they follow from ``fixture_key()`` and ``fixture_secret()`` (``test_migration_v17.py``
puts them in place), so no key lies in the repository. No ``.db`` file goes into a commit (``test_basics.py``).

In each: the operator jule (password), alex (password, linked: subject ``person-alex``), olga (through the provider
only: ``person-olga``), tom (password, never linked); a page of the day for alex, olga and tom; the provider as 0.6.0's
authentik button wrote it (named "authentik", the issuer with its slash).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

ISSUER = "https://sso.example.com/application/o/nexdiary/"
CLIENT_ID = "nexdiary-fixture"
DAY = "2026-10-08"
PAGES = {"alex": "Alex schreibt vom Apfelbaum.", "olga": "Olga schreibt vom Birnbaum.",
         "tom": "Tom schreibt vom Kirschbaum."}


def fixture_key() -> bytes:
    """The master key of the fixture: derived from a phrase, never written down."""
    return hashlib.sha256(b"nexdiary fixture of schema 16").digest()


def fixture_secret() -> str:
    """The server secret of the fixture (it seals the client secret): derived from a phrase, never written down."""
    return hashlib.sha256(b"nexdiary fixture of schema 16, the server").hexdigest()


def fixture_client_secret() -> str:
    """The provider's client secret in the fixture: derived from a phrase."""
    return hashlib.sha256(b"nexdiary fixture of schema 16, the client").hexdigest()[:40]


def make(folder: Path, trusted: bool) -> None:
    from fastapi.testclient import TestClient

    from app import clock
    from app.db import SessionLocal, init_db
    from app.main import app
    from app.models import MEMBER, OPERATOR, SIGN_IN_OIDC, Account
    from app.security import SESSION_COOKIE, encrypt_secret, hash_password, start_session
    from app.services import settings_service

    init_db()
    clock.now = lambda: datetime(2026, 10, 8, 10, 0, tzinfo=UTC)  # type: ignore[assignment]
    with SessionLocal() as db:
        settings_service.save(db, {
            "two_factor_required": False,
            "oidc_issuer": ISSUER,
            "oidc_client_id": CLIENT_ID,
            "oidc_client_secret_enc": encrypt_secret(fixture_client_secret()),
            "oidc_provider_name": "authentik",
            "oidc_auto_create": False,
            "oidc_second_factor_by_provider": trusted,
        })
        for name, role, subject in (("jule", OPERATOR, ""), ("alex", MEMBER, "person-alex"),
                                    ("olga", MEMBER, "person-olga"), ("tom", MEMBER, "")):
            row = Account(name=name, role=role, oidc_subject=subject)
            if name == "olga":
                row.sign_in = SIGN_IN_OIDC
                row.email = "olga@example.com"
            else:
                row.password_hash = hash_password("fixture password " + name)
            db.add(row)
        db.commit()
    for name, text in PAGES.items():
        with SessionLocal() as db:
            row = db.query(Account).filter_by(name=name).one()
            token = start_session(db, row, "127.0.0.1", "fixture")
        client = TestClient(app, base_url="http://testserver", headers={"X-Nexdiary-Client": "tab-fixture00"})
        client.cookies.set(SESSION_COOKIE, token)
        assert client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
        answer = client.put(f"/api/days/{DAY}", json={"text": text})
        assert answer.status_code == 200, answer.text
        client.close()
    with closing(sqlite3.connect(folder / "nexdiary.db")) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 16
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("PRAGMA journal_mode=DELETE")


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    trusted = len(sys.argv) > 2 and sys.argv[2] == "trusted"
    folder = out / ("trusted" if trusted else "asked")
    folder.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "NEXDIARY_DATA_DIR": str(folder),
        "NEXDIARY_MEDIA_DIR": str(folder / "media"),
        "NEXDIARY_LOCALES_DIR": str(folder / "locales"),
        "NEXDIARY_DISABLE_BACKGROUND": "1",
        "NEXDIARY_FRONTEND_DIST": str(folder / "no-frontend"),
        "NEXDIARY_SECRET_KEY": fixture_secret(),
        "NEXDIARY_ARGON2_TIME": "1",
        "NEXDIARY_ARGON2_MEMORY_KIB": "1024",
        "NEXDIARY_ARGON2_PARALLELISM": "1",
        "NEXDIARY_UPDATE_URL": "http://127.0.0.1:9/releases/latest",
    })
    from app.services import vault

    (folder / "keys").mkdir(exist_ok=True)
    (folder / "keys" / "master.key").write_bytes(vault._encode(fixture_key()))
    make(folder, trusted)
    target = out / ("nexdiary-v16-trusted.sqlite" if trusted else "nexdiary-v16.sqlite")
    shutil.copyfile(folder / "nexdiary.db", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
