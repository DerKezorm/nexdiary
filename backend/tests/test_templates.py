"""Templates for the pages: kept per person and sealed like the diary (a word in a name, a heading or a question is in
no file in the clear), checked at the edges, never seen or changed by anybody else, and replaced as a whole onto the
revision that was read: a stale save is refused, two saves at the same moment never both land."""

from __future__ import annotations

import secrets
import sqlite3
import threading
import zipfile
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import get_settings
from app.db import SessionLocal
from app.models import Account
from app.services import backups, quota

from .conftest import PASSWORD, make_account, new_client, person

LOOKING_BACK = {"name": "Tagesrückblick", "sections": [
    {"heading": "Was war heute los?", "question": "Was ist passiert?"},
    {"heading": "Was war schön?", "question": ""},
]}


def put(client: TestClient, listed: list[dict[str, Any]], default: str | None = None, revision: int = -1) -> Any:
    return client.put("/api/templates", json={"templates": listed, "default": default, "revision": revision})


def saved(client: TestClient, listed: list[dict[str, Any]], default: str | None = None, revision: int = -1) -> Any:
    answer = put(client, listed, default, revision)
    assert answer.status_code == 200, answer.text
    return answer.json()


def code(answer: Any) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]


def test_there_are_no_templates_from_the_start(client: TestClient, account: Account) -> None:
    assert client.get("/api/templates").json() == {"templates": [], "default": None, "revision": -1}


def test_templates_are_saved_whole_and_read_back_with_an_id_each(client: TestClient, account: Account) -> None:
    first = saved(client, [LOOKING_BACK, {"name": "Arbeitstag", "sections": [{"heading": "Was lief gut?"}]}])
    assert first["revision"] == 0 and first["default"] is None
    ids = [entry["id"] for entry in first["templates"]]
    assert len(set(ids)) == 2 and all(len(entry) == 12 and int(entry, 16) >= 0 for entry in ids)
    assert first["templates"][0]["sections"] == LOOKING_BACK["sections"]
    assert first["templates"][1]["sections"] == [{"heading": "Was lief gut?", "question": ""}]
    assert client.get("/api/templates").json() == first
    # Replaced as a whole, the ids of the ones kept stay, a revision on.
    again = saved(client, [{**first["templates"][1], "name": "Büro"}], default=ids[1], revision=0)
    assert again["revision"] == 1 and again["default"] == ids[1]
    assert [(entry["id"], entry["name"]) for entry in again["templates"]] == [(ids[1], "Büro")]
    assert client.get("/api/templates").json() == again


def test_what_comes_in_is_cleaned(client: TestClient, account: Account) -> None:
    answer = saved(client, [{"name": "  Mein\nTag \x07 ", "sections": [
        {"heading": "  ## Was war los? ##  ", "question": " Zeile eins\nZeile zwei "},
        {"heading": "# Dank", "question": ""},
        {"heading": "C#", "question": ""},
        {"heading": "Zwei\nZeilen", "question": ""},
    ]}])
    entry = answer["templates"][0]
    assert entry["name"] == "Mein Tag"
    assert [(part["heading"], part["question"]) for part in entry["sections"]] == [
        ("Was war los?", "Zeile eins Zeile zwei"), ("Dank", ""), ("C#", ""), ("Zwei Zeilen", "")]


def test_the_edges(client: TestClient, account: Account) -> None:
    section = {"heading": "H", "question": ""}
    # Exactly as much as may be: 12 sections, a name of 60, a heading of 120, a question of 300, 20 templates.
    top = saved(client, [{"name": "n" * 60, "sections": [
        {"heading": f"{'h' * 118}{index:02d}", "question": "q" * 300} for index in range(12)]}])
    assert len(top["templates"][0]["sections"]) == 12
    many = [{"name": f"Vorlage {index}", "sections": [section]} for index in range(20)]
    assert put(client, many, revision=0).status_code == 200
    revision = client.get("/api/templates").json()["revision"]
    # One more than may be.
    for bad, expected in (
        (many + [{"name": "zu viel", "sections": [section]}], (422, None)),
        ([{"name": "x", "sections": []}], (422, "template_sections")),
        ([{"name": "x", "sections": [{"heading": f"H{index}", "question": ""} for index in range(13)]}], (422, None)),
        ([{"name": "x" * 61, "sections": [section]}], (422, "template_name_too_long")),
        ([{"name": "  ", "sections": [section]}], (422, "template_name_empty")),
        ([{"name": "x", "sections": [{"heading": "h" * 121, "question": ""}]}], (422, "template_heading_too_long")),
        ([{"name": "x", "sections": [{"heading": " ## ", "question": ""}]}], (422, "template_heading_empty")),
        ([{"name": "x", "sections": [{"heading": "", "question": ""}]}], (422, "template_heading_empty")),
        ([{"name": "x", "sections": [{"heading": "h", "question": "q" * 301}]}], (422, "question_too_long")),
        ([{"name": "x", "sections": [{"heading": "Dank", "question": ""}, {"heading": " dank ", "question": ""}]}],
         (422, "template_heading_twice")),
        ([{"name": "x", "sections": [{"heading": "Dank", "question": ""}, {"heading": "**Dank**", "question": ""}]}],
         (422, "template_heading_twice")),
    ):
        answer = put(client, bad, revision=revision)
        assert answer.status_code == expected[0], bad
        if expected[1]:
            assert code(answer)[1] == expected[1], bad
    # Extra fields, the wrong kinds, an id nobody made.
    assert put(client, [{"name": "x", "sections": [section], "colour": "red"}], revision=revision).status_code == 422
    assert client.put("/api/templates", json={"templates": [], "revision": revision, "extra": 1}).status_code == 422
    assert client.put("/api/templates", json={"templates": "x", "revision": revision}).status_code == 422
    assert client.put("/api/templates", json={"templates": [], "revision": "0"}).status_code == 422
    assert client.put("/api/templates", json={"templates": [], "revision": -2}).status_code == 422
    assert code(put(client, [{"id": secrets.token_hex(6), "name": "x", "sections": [section]}],
                    revision=revision)) == (422, "template_unknown")
    # None of the refusals changed anything.
    assert client.get("/api/templates").json()["revision"] == revision


def test_the_default_must_be_one_of_the_templates(client: TestClient, account: Account) -> None:
    first = saved(client, [LOOKING_BACK])
    wanted = first["templates"][0]["id"]
    assert code(put(client, first["templates"], default=secrets.token_hex(6), revision=0)) == (422, "template_unknown")
    assert code(put(client, first["templates"], default="none", revision=0)) == (422, "template_unknown")
    assert saved(client, first["templates"], default=wanted, revision=0)["default"] == wanted
    # The default goes with its template.
    assert saved(client, [], default=None, revision=1) == {"templates": [], "default": None, "revision": 2}
    with person("ben") as ben:
        other = saved(ben, [LOOKING_BACK])["templates"][0]["id"]
    assert code(put(client, first["templates"], default=other, revision=2)) == (422, "template_unknown")


def test_a_stale_save_is_refused_and_changes_nothing(client: TestClient, account: Account) -> None:
    saved(client, [LOOKING_BACK])
    other_tab = new_client(account)
    with other_tab:
        saved(other_tab, [{"name": "Aus dem anderen Tab", "sections": [{"heading": "A"}]}], revision=0)
        refused = put(client, [{"name": "Aus dem ersten Tab", "sections": [{"heading": "B"}]}], revision=0)
        assert code(refused) == (409, "templates_changed")
    assert [entry["name"] for entry in client.get("/api/templates").json()["templates"]] == ["Aus dem anderen Tab"]
    # The first save with "nothing there yet" is refused where something is, and the other way round.
    assert code(put(client, [LOOKING_BACK], revision=-1)) == (409, "templates_changed")
    with person("ben") as ben:
        assert code(put(ben, [LOOKING_BACK], revision=0)) == (409, "templates_changed")
        assert ben.get("/api/templates").json()["templates"] == []


def test_two_saves_at_the_same_moment_never_both_land(client: TestClient, account: Account) -> None:
    saved(client, [LOOKING_BACK])
    barrier = threading.Barrier(2)
    results: list[int] = []

    def save(name: str) -> None:
        with new_client(account) as tab:
            barrier.wait(5)
            results.append(put(tab, [{"name": name, "sections": [{"heading": "A"}]}], revision=0).status_code)

    threads = [threading.Thread(target=save, args=(name,)) for name in ("Eins", "Zwei")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(results) == [200, 409], "one landed, the other was told to read again"
    assert client.get("/api/templates").json()["revision"] == 1


def test_two_first_saves_at_the_same_moment_never_both_land(client: TestClient, account: Account) -> None:
    barrier = threading.Barrier(2)
    results: list[int] = []

    def save(name: str) -> None:
        with new_client(account) as tab:
            barrier.wait(5)
            results.append(put(tab, [{"name": name, "sections": [{"heading": "A"}]}]).status_code)

    threads = [threading.Thread(target=save, args=(name,)) for name in ("Eins", "Zwei")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(results) == [200, 409]
    assert client.get("/api/templates").json()["revision"] == 0


def test_nobody_sees_or_changes_the_templates_of_another(client: TestClient, account: Account) -> None:
    mine = saved(client, [LOOKING_BACK])
    with person("ben") as ben:
        assert ben.get("/api/templates").json() == {"templates": [], "default": None, "revision": -1}
        # Not by their id either.
        assert code(put(ben, mine["templates"], revision=-1)) == (422, "template_unknown")
        assert ben.get("/api/templates").json()["templates"] == []
        saved(ben, [{"name": "Bens", "sections": [{"heading": "X"}]}])
    assert client.get("/api/templates").json() == mine
    with TestClient(client.app, base_url="http://testserver", headers={"X-Nexdiary-Client": "bare-tab"}) as bare:
        assert bare.get("/api/templates").status_code == 401
        assert put(bare, [LOOKING_BACK]).status_code == 401


def test_a_token_for_programs_does_not_reach_them(client: TestClient, operator: Account) -> None:
    assert client.put("/api/settings", json={"api_tokens_allowed": True}).status_code == 200
    token = client.post("/api/api-tokens", json={"name": "nexdeck"}).json()["secret"]
    saved(client, [LOOKING_BACK])
    with TestClient(client.app, base_url="http://testserver", headers={"X-Nexdiary-Client": "program-tab"}) as bare:
        headers = {"Authorization": f"Bearer {token}"}
        assert bare.get("/api/templates", headers=headers).status_code == 401
        assert bare.get("/api/v1/templates", headers=headers).status_code == 404


def test_nothing_is_stored_in_the_clear(client: TestClient, account: Account) -> None:
    word = "Qx" + secrets.token_hex(6) + "Zy"
    saved(client, [{"name": f"Name {word}", "sections": [{"heading": f"Kopf {word}", "question": f"Frage {word}?"}]}])
    database = get_settings().database_path
    # Keep the journal while it is looked at: every page written is still in it.
    keep = sqlite3.connect(database)
    try:
        keep.execute("SELECT count(*) FROM users").fetchone()
        stored = keep.execute("SELECT content_enc FROM writing_templates").fetchone()[0]
        assert isinstance(stored, bytes) and len(stored) > 30
        for path in (database, database.with_name(database.name + "-wal")):
            if path.is_file():
                data = path.read_bytes()
                for variant in (word, word.lower(), word.upper()):
                    for encoding in ("utf-8", "utf-16-le"):
                        assert variant.encode(encoding) not in data, path.name
    finally:
        keep.close()
    # It is read through the API, so the word is really kept.
    assert word in client.get("/api/templates").text


def test_a_value_that_does_not_open_reads_as_none_and_can_be_replaced(client: TestClient, account: Account) -> None:
    saved(client, [LOOKING_BACK])
    with SessionLocal() as db:
        db.execute(text("UPDATE writing_templates SET content_enc = :junk"), {"junk": secrets.token_bytes(64)})
        db.commit()
    assert client.get("/api/templates").json() == {"templates": [], "default": None, "revision": 0}
    assert saved(client, [LOOKING_BACK], revision=0)["revision"] == 1


def test_the_account_going_takes_its_templates_along_and_a_backup_holds_them(client: TestClient, account: Account,
                                                                              tmp_path: Path) -> None:
    member = make_account("rike")
    with new_client(member) as rike:
        saved(rike, [LOOKING_BACK])
    made = backups.create(kind=backups.MANUAL)
    copy = tmp_path / "from-the-backup.db"
    with zipfile.ZipFile(made) as unpacked:
        copy.write_bytes(unpacked.read(backups.DATABASE_ENTRY))
    connection = sqlite3.connect(copy)
    try:
        assert connection.execute("SELECT count(*) FROM writing_templates").fetchone()[0] == 1
    finally:
        connection.close()
    deleted = client.request("DELETE", f"/api/accounts/{member.id}", json={"current_password": PASSWORD})
    assert deleted.status_code == 204, deleted.text
    with SessionLocal() as db:
        assert db.execute(text("SELECT count(*) FROM writing_templates")).scalar() == 0


def test_the_templates_count_for_the_storage_of_the_person(client: TestClient, account: Account) -> None:
    with SessionLocal() as db:
        before = quota.used(db, account.id)
    saved(client, [LOOKING_BACK])
    with SessionLocal() as db:
        after = quota.used(db, account.id)
    assert after > before
    # A person at the limit cannot grow them, and nothing is written.
    assert client.put("/api/settings", json={"storage_per_person_gb": 0.0000001}).status_code == 200
    big = [{"name": "Gross", "sections": [{"heading": f"H{index}", "question": "q" * 300} for index in range(12)]}]
    refused = put(client, big, revision=0)
    assert code(refused) == (409, "storage_full")
    assert [entry["name"] for entry in client.get("/api/templates").json()["templates"]] == ["Tagesrückblick"]
