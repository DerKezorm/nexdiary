"""A version 7 database as B6 left it comes to version 8: nothing written is lost, the sessions from before go on (as
long ones, full, each with a name of its own for the list of devices), and accounts without a second factor, the
operator first, set one up at their next sign-in without locking themselves out."""

from __future__ import annotations

import sqlite3
import time
import uuid
from contextlib import closing

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app import db as database
from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Account, Setting
from app.services import backups, totp

from .conftest import PASSWORD, TAB, make_account, sign_in
from .test_schema import drop_v8, fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "value_defs", "photos", "drafts", "shares", "hearts",
          "writing_prompts", "immich_links", "push_devices", "reminder_marks", "auth_sessions")


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def test_a_v7_database_comes_to_v8_whole_and_nobody_is_locked_out(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit mia kastanien gesammelt"})
    client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag."})
    member = make_account("rike")
    other = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(other, member)
    path = get_settings().database_path
    with closing(sqlite3.connect(path)) as connection:
        drop_v8(connection)
        connection.execute("PRAGMA user_version = 7")
        connection.commit()
    # As B6 knew it: the switch never stored, so the new default (on) holds from now on.
    with SessionLocal() as db:
        db.execute(delete(Setting).where(Setting.key == "two_factor_required"))
        db.commit()
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost, no session ended"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION
        migrated = schema_of(connection)
        sessions = connection.execute("SELECT uid, remember, stage FROM auth_sessions").fetchall()
        foreign = connection.execute("PRAGMA foreign_key_list(passkeys)").fetchall()
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    assert sessions and all(len(uid) == 32 and remember == 1 and stage == "full" for uid, remember, stage in sessions)
    assert len({uid for uid, _remember, _stage in sessions}) == len(sessions)
    assert {(row[2], row[3], row[4], row[6]) for row in foreign} == {("users", "user_id", "id", "CASCADE")}

    # The sessions from before still open, but only the setup now: the operator asks for a second factor.
    me = client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["second_factor_setup_required"] is True
    assert client.get("/api/days/2026-10-06").status_code == 403
    # The operator sets it up from the account page with the password, and is back in.
    seed = client.post("/api/auth/totp/begin").json()["secret"]
    confirmed = client.post("/api/auth/totp/confirm",
                            json={"code": totp.code_at(seed, time.time()), "password": PASSWORD})
    assert confirmed.status_code == 200, confirmed.text
    assert client.get("/api/days/2026-10-06").json()["title"] == "Kastanien"
    # A member signs in anew and is led to the setup right after the password.
    fresh = TestClient(app, base_url="http://testserver", headers=TAB)
    signed = fresh.post("/api/auth/login", json={"name": "rike", "password": PASSWORD})
    assert signed.status_code == 200 and signed.json()["session_stage"] == "setup"
    assert other.get("/api/auth/sessions").status_code == 403
