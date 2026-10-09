"""A real nexdiary of schema 15 comes to version 16: the data folder in ``fixtures/v15`` was made by the code of that
state (``fixtures/v15/make.py``), with time capsules, their photos, a photo chosen and not closed yet, and a letter in
plain words that look like Markdown. Started on a copy of it in a process of its own (``migration_probe_v16.py``), the
new version keeps every capsule and photo readable for exactly the people it was readable for, the photo moved into the
new table with its files and their seal untouched, the old letter shown as the words it was, and a change of the day
seals every photo anew."""

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

from app.services import vault

from .fixtures.v15.make import fixture_key

FIXTURE = Path(__file__).parent / "fixtures" / "v15"
#: The letter to Tom as it was written then, in plain words.
OLD_WORDS = ("Lieber Tom,\n*das* ist kein Fett und # keine Überschrift.\n- kein Punkt\n1. Platz für dich\n\n"
             "> kein Zitat [kein Link](https://example.com) ![kein Bild](photo:0123)\n\nBis bald \\o/")
#: The same words as Markdown that shows them as they were: every punctuation character escaped, a line end within a
#: paragraph a line break.
AS_MARKDOWN = ("Lieber Tom\\,\\\n\\*das\\* ist kein Fett und \\# keine Überschrift\\.\\\n\\- kein Punkt\\\n"
               "1\\. Platz für dich\n\n"
               "\\> kein Zitat \\[kein Link\\]\\(https\\:\\/\\/example\\.com\\) \\!\\[kein Bild\\]\\(photo\\:0123\\)\n\n"
               "Bis bald \\\\o\\/")


def old_rows() -> dict[str, Any]:
    """What the old database holds, read directly: each capsule's photo with its shape and size, the waiting upload."""
    with closing(sqlite3.connect(FIXTURE / "nexdiary-v15.sqlite")) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 15
        photos = sorted([row[0], row[1], 0, row[2], row[3], row[4]] for row in connection.execute(
            "SELECT uid, photo_uid, photo_width, photo_height, photo_size FROM capsules WHERE photo_uid IS NOT NULL"))
        uploads = [row[0] for row in connection.execute("SELECT uid FROM capsule_uploads")]
        notes = connection.execute("SELECT count(*) FROM notes").fetchone()[0]
    return {"photos": photos, "uploads": uploads, "notes": notes}


@pytest.fixture(scope="module")
def seen(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    folder = tmp_path_factory.mktemp("v15") / "data"
    folder.mkdir()
    shutil.copyfile(FIXTURE / "nexdiary-v15.sqlite", folder / "nexdiary.db")
    shutil.copytree(FIXTURE / "media", folder / "media")
    (folder / "keys").mkdir()
    (folder / "keys" / "master.key").write_bytes(vault._encode(fixture_key()))
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(folder), "NEXDIARY_MEDIA_DIR": str(folder / "media"),
           "NEXDIARY_LOCALES_DIR": str(folder / "locales")}
    env.pop("NEXDIARY_MASTER_KEY_FILE", None)
    run = subprocess.run([sys.executable, "-m", "tests.migration_probe_v16"], cwd=Path(__file__).parent.parent,
                         env=env, capture_output=True, text=True, timeout=300, check=False)
    assert run.returncode == 0, run.stderr[-4000:]
    return dict(json.loads(run.stdout.strip().splitlines()[-1]))


def test_the_schema_comes_to_16_with_nothing_lost(seen: dict[str, Any]) -> None:
    old = old_rows()
    assert seen["version"] == 16 and seen["schema_as_new"] is True
    assert seen["backups"] == 1, "a backup before the step"
    assert seen["photo_rows"] == old["photos"], "each photo moved as it was: its id (its files), shape and size"
    assert len(old["photos"]) == 2
    assert seen["plain"] == [True, True, True], "every letter written before is plain words"
    assert seen["uploads"] == old["uploads"] and len(seen["uploads"]) == 1
    assert seen["notes"] == old["notes"] == 1


def test_before_the_day_the_photos_are_where_they_were_and_nowhere_else(seen: dict[str, Any]) -> None:
    jule = seen["jule_early"]["one"]
    letter = jule["Für Heiligabend"]
    assert letter["text"] == AS_MARKDOWN
    assert len(letter["photos"]) == 1 and letter["photos"][0]["width"] == 64 and letter["photos"][0]["height"] == 48
    assert letter["pictures"] == [[200, "image/webp"], [200, "image/webp"]]
    assert jule["Vorsätze"]["photos"] == [] and jule["Vorsätze"]["text"] == "Mehr draußen sein\\."
    sealed = jule["An mich, in einem Jahr"]
    assert "text" not in sealed and "photos" not in sealed, "sealed for its writer too"
    # Tom and Mia: nothing of the text, the photos or their number.
    for person in ("tom_before", "mia_before"):
        for title, item in seen[person]["one"].items():
            assert "text" not in item and "photos" not in item and item["pictures"] == [], (person, title)
        for item in seen[person]["for_me"].values():
            assert "photos" not in item and "photo" not in item
    assert seen["tom_early"] and set(seen["tom_early"]) == {404}


def test_a_change_after_the_update_writes_markdown_and_seals_every_photo_anew(seen: dict[str, Any]) -> None:
    status, changed = seen["change"]
    assert status == 200, changed
    assert changed["text"] == AS_MARKDOWN, "the escaped words sent back stay the same words"
    assert changed["opens_on"] == "2026-12-25"
    before = {row[1] for row in seen["photo_rows"]}
    after = [photo["id"] for photo in changed["photos"]]
    assert len(after) == 2 and not set(after) & before, "the kept photo sealed anew, the chosen one added"
    assert seen["plain_after"] == [False, True, True]
    assert seen["uploads_after"] == 0
    files = set(seen["media_after"])
    for uid in after:
        assert {uid, uid + ".p"} <= files
    # The old files of the letter's photo are gone, the sealed letter's photo stays.
    letter_uid = changed["id"]
    old_photo = next(row[1] for row in seen["photo_rows"] if row[0] == letter_uid)
    assert old_photo not in files
    assert len(files) == 6, "two photos of the letter to Tom, one of the letter to Jule, each with its smaller copy"


def test_on_their_days_the_people_read_the_letters_and_their_photos(seen: dict[str, Any]) -> None:
    tom = seen["tom_on_the_day"]
    letter = tom["one"]["Für Heiligabend"]
    assert letter["open"] is True and letter["text"] == AS_MARKDOWN
    assert letter["pictures"] == [[200, "image/webp"]] * 4
    listed = tom["for_me"]["Für Heiligabend"]
    assert listed["photos"] == 2 and listed["photo"] == letter["photos"][0]["id"]
    jule = seen["jule_on_the_day"]["one"]["An mich, in einem Jahr"]
    assert jule["text"] == "Wo stehe ich\\?" and jule["pictures"] == [[200, "image/webp"]] * 2
    mia = seen["mia_on_the_day"]["one"]["Vorsätze"]
    assert mia["text"] == "Mehr draußen sein\\." and mia["photos"] == [] and mia["pictures"] == []


def test_the_old_words_are_what_the_escaped_text_says() -> None:
    from app.services.capsules import markdown_of_plain

    assert markdown_of_plain(OLD_WORDS) == AS_MARKDOWN
    assert markdown_of_plain("  eins  \n\n\n  zwei\n   \n drei ") == "eins\n\nzwei\n\ndrei"
