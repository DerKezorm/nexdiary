"""A version 8 database as B7 left it comes to version 9: nothing written is lost, the links to set a new password can be
made, and the names of API tokens that stand in the clear are sealed when the server starts; the operator never sees
what a person called their token."""

from __future__ import annotations

import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from app import db as database
from app.config import get_settings
from app.db import SessionLocal
from app.models import Account, ApiToken
from app.services import apitokens, backups, settings_service

from .conftest import PASSWORD, make_account, new_client
from .test_schema import drop_v9, fresh_schema_sql, schema_of

TABLES = ("users", "user_keys", "days", "notes", "api_tokens", "auth_sessions", "passkeys")
SECRET_NAME = "kellerkarte-mit-rosen"
OTHER_NAME = "dachbodenschluessel-mit-efeu"


def counts(path: object) -> dict[str, int]:
    with closing(sqlite3.connect(path)) as connection:  # type: ignore[arg-type]
        return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608 - constants
                for table in TABLES}


def raw_bytes() -> bytes:
    path = get_settings().database_path
    return b"".join(candidate.read_bytes() for candidate in (path, path.with_name(path.name + "-wal"))
                    if candidate.exists())


def test_a_v8_database_comes_to_v9_whole_and_its_token_names_are_sealed_at_the_start(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag."})
    rita = make_account("rita")
    with new_client(rita) as own:
        assert own.post("/api/api-tokens", json={"name": SECRET_NAME}).status_code == 201
    assert client.post("/api/api-tokens", json={"name": "nexdeck"}).status_code == 201
    path = get_settings().database_path
    # As B7 knew it: the names in the clear, the new table and column not there, the version 8.
    with closing(sqlite3.connect(path)) as connection:
        # As the server's own connections have it; without, this test's rewriting would leave copies of its own.
        connection.execute("PRAGMA secure_delete = ON")
        connection.execute("UPDATE api_tokens SET name = 'nexdeck' WHERE account_id = ?", (account.id,))
        connection.execute("UPDATE api_tokens SET name = ? WHERE account_id = ?", (SECRET_NAME, rita.id))
        connection.execute("UPDATE api_tokens SET name_enc = NULL")
        drop_v9(connection)
        connection.execute("PRAGMA user_version = 8")
        connection.commit()
    before = counts(path)
    made: list[str] = []
    monkeypatch.setattr(backups, "create", lambda **kwargs: made.append(kwargs.get("note", "")) or path)
    database.init_db()
    assert made == [f"before schema {database.SCHEMA_VERSION}"]
    assert counts(path) == before, "no row lost"
    with closing(sqlite3.connect(path)) as connection:
        assert int(connection.execute("PRAGMA user_version").fetchone()[0]) == database.SCHEMA_VERSION == 9
        migrated = schema_of(connection)
        legacy = dict(connection.execute("SELECT account_id, name FROM api_tokens").fetchall())
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript(fresh_schema_sql())
        assert migrated == schema_of(connection)
    assert legacy[rita.id] == SECRET_NAME, "the step itself seals nothing: the master key is not at hand there"
    # Until the start seals them, the names still read.
    # (a client entered with ``with`` would run the start of the app, which seals the names: not yet)
    own = new_client(rita)
    assert [item["name"] for item in own.get("/api/api-tokens").json()["tokens"]] == [SECRET_NAME]

    shredded: list[int] = []
    monkeypatch.setattr(apitokens.vault, "shred_leftovers", lambda: shredded.append(1))
    assert apitokens.seal_legacy_names() == 2
    assert shredded == [1], "the write-ahead log is emptied, so that no old page keeps a name"
    assert apitokens.seal_legacy_names() == 0, "once"
    assert shredded == [1]
    monkeypatch.undo()
    with closing(sqlite3.connect(path)) as connection:
        rows = connection.execute("SELECT name, name_enc IS NOT NULL FROM api_tokens").fetchall()
    assert rows == [("", 1), ("", 1)]
    assert SECRET_NAME.encode() not in raw_bytes() and b"nexdeck" not in raw_bytes(), "overwritten, in the log too"
    with new_client(rita) as own:
        assert [item["name"] for item in own.get("/api/api-tokens").json()["tokens"]] == [SECRET_NAME]
    assert [item["name"] for item in client.get("/api/api-tokens").json()["tokens"]] == ["nexdeck"]
    # The operator sees whose token it is and its first characters, never its name.
    every = client.get("/api/admin/api-tokens").json()
    assert len(every) == 2 and all("name" not in item for item in every) and SECRET_NAME not in str(every)
    # The links to set a new password work on the migrated database.
    link = client.post(f"/api/accounts/{rita.id}/reset-link", json={"current_password": PASSWORD})
    assert link.status_code == 200 and "/reset/" in link.json()["link"]


def test_a_sealed_name_is_bound_to_its_token_and_its_person(client: TestClient, account: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    rita = make_account("rita")
    with new_client(rita) as own:
        own.post("/api/api-tokens", json={"name": OTHER_NAME})
    client.post("/api/api-tokens", json={"name": "nexdeck"})
    assert OTHER_NAME.encode() not in raw_bytes()
    with SessionLocal() as db:
        mine, hers = (db.query(ApiToken).filter_by(account_id=owner.id).one() for owner in (account, rita))
        assert mine.name == "" and mine.name_enc and hers.name == "" and hers.name_enc
        # Moved to another token or another person, a sealed name does not open: it reads empty, never as theirs.
        mine.name_enc, hers.name_enc = hers.name_enc, mine.name_enc
        db.commit()
    assert [item["name"] for item in client.get("/api/api-tokens").json()["tokens"]] == [""]
    with new_client(rita) as own:
        assert [item["name"] for item in own.get("/api/api-tokens").json()["tokens"]] == [""]


def test_a_sealed_name_moved_to_another_token_of_the_same_person_does_not_open(
    client: TestClient, account: Account
) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    client.post("/api/api-tokens", json={"name": "first"})
    client.post("/api/api-tokens", json={"name": "second"})
    assert [item["name"] for item in client.get("/api/api-tokens").json()["tokens"]] == ["first", "second"]
    with SessionLocal() as db:
        one, two = db.query(ApiToken).filter_by(account_id=account.id).order_by(ApiToken.id).all()
        one.name_enc, two.name_enc = two.name_enc, one.name_enc
        db.commit()
    assert [item["name"] for item in client.get("/api/api-tokens").json()["tokens"]] == ["", ""]
