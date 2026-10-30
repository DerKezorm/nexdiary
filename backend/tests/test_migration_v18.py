"""A real nexdiary 0.10.0 (schema 17) comes to version 18: the data folder in ``fixtures/v17`` was made by the code of
that state (``fixtures/v17/make.py``) with a written day, a photo, a note and a locked day. Started on a copy of it in a
process of its own (``migration_probe_v18.py``), the new version keeps every day, photo and note as it was, has the
table of attachments with its triggers as a new database has them, takes attachments on the open day and none on the
locked one."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from app.db import SCHEMA_VERSION
from app.services import vault

from .fixtures.v17.make import NOTE_TEXT, OPEN_TEXT, fixture_key

FIXTURE = Path(__file__).parent / "fixtures" / "v17"


@pytest.fixture(scope="module")
def seen(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    folder = tmp_path_factory.mktemp("v17") / "data"
    folder.mkdir()
    shutil.copyfile(FIXTURE / "nexdiary-v17.sqlite", folder / "nexdiary.db")
    shutil.copytree(FIXTURE / "media", folder / "media")
    (folder / "keys").mkdir()
    (folder / "keys" / "master.key").write_bytes(vault._encode(fixture_key()))
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(folder), "NEXDIARY_MEDIA_DIR": str(folder / "media"),
           "NEXDIARY_LOCALES_DIR": str(folder / "locales")}
    env.pop("NEXDIARY_MASTER_KEY_FILE", None)
    run = subprocess.run([sys.executable, "-m", "tests.migration_probe_v18"], cwd=Path(__file__).parent.parent,
                         env=env, capture_output=True, text=True, timeout=300, check=False)
    assert run.returncode == 0, run.stderr[-4000:]
    return dict(json.loads(run.stdout.strip().splitlines()[-1]))


def test_the_fixture_is_of_schema_17() -> None:
    with closing(sqlite3.connect(FIXTURE / "nexdiary-v17.sqlite")) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 17
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "attachments" not in tables and {"days", "photos", "notes"} <= tables


def test_the_schema_comes_to_18_as_a_new_database_has_it(seen: dict[str, Any]) -> None:
    assert seen["version"] == SCHEMA_VERSION and seen["schema_as_new"] is True
    assert seen["triggers_as_new"] is True
    assert {"trg_attachments_locked_insert", "trg_attachments_locked_delete", "trg_attachments_locked_move",
            "trg_days_locked_stays"} <= set(seen["triggers"])
    assert seen["indexes"] == ["ix_attachments_status", "ix_attachments_user_date"]
    assert seen["attachments"] == 0
    assert len(seen["backups"]) == 1, "a backup before the step: the way back to 0.10"


def test_what_was_there_stays_and_attachments_come_to_the_open_day_only(seen: dict[str, Any]) -> None:
    assert seen["open_day"]["text"] == OPEN_TEXT and seen["open_day"]["attachments"] == []
    assert seen["locked_day"] is True
    assert seen["photos"] == [[200, 200]]
    assert seen["notes"] == [NOTE_TEXT]
    assert seen["link"] == [201, "Fest"]
    assert seen["pdf"] == [201, True]
    assert seen["locked_link"] == [409, "day_locked"]
    assert seen["storage"] == {"attachments": 2, "kinds": ["audio", "pdf", "photos", "video"]}
