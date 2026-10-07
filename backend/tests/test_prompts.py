"""Writing prompts: six groups in two languages, switched on and off per person, own questions sealed, and a question
of the day that stays the same all day for the same person (the clock set by the test) in every language, moves on
with "another question" for that day only, passes over what was answered today (known by the question's id), and
becomes a note with its question. Every change is a single one, so two tabs never overwrite each other."""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.models import Account
from app.services import prompts, vault

from .conftest import new_client, person

MONDAY = datetime(2026, 10, 5, 18, 0, tzinfo=UTC)
SUNDAY = datetime(2026, 10, 11, 18, 0, tzinfo=UTC)
DEFAULT_IDS = [f"{entry['id']}.{index}" for entry in prompts.SETS[:4] for index in range(len(entry["de"][1]))]


@pytest.fixture
def at(monkeypatch: pytest.MonkeyPatch) -> list[datetime]:
    """The server's clock, set by the test; ``at[0] = ...`` moves it."""
    moment = [MONDAY]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    return moment


def question(client: TestClient) -> dict[str, str] | None:
    return client.get("/api/today").json()["question"]


def text_of(client: TestClient) -> str | None:
    found = question(client)
    return found["text"] if found else None


def german(client: TestClient) -> None:
    client.put("/api/me/language", json={"language": "de"})
    client.put("/api/me/preferences", json={"timezone": "UTC"})


def german_questions() -> set[str]:
    return {text for entry in prompts.SETS for text in entry["de"][1]}


def answer(client: TestClient, asked: dict[str, str], text: str = "eine antwort") -> dict[str, Any]:
    found = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, "prompt": asked["text"],
                                            "prompt_id": asked["id"]})
    assert found.status_code == 201, found.text
    return found.json()


def add_own(client: TestClient, text: str) -> dict[str, Any]:
    return client.post("/api/prompts/own", json={"text": text})


def own_texts(client: TestClient) -> list[str]:
    return [entry["text"] for entry in client.get("/api/prompts").json()["own"]]


def test_the_groups_come_in_both_languages_alike() -> None:
    assert [entry["id"] for entry in prompts.SETS] == ["schoen", "gefuehle", "wuensche", "dank", "menschen",
                                                       "rueckblick"]
    for entry in prompts.SETS:
        assert len(entry["de"][1]) == len(entry["en"][1]) >= 3, entry["id"]
        for text in [entry["de"][0], entry["en"][0], *entry["de"][1], *entry["en"][1]]:
            assert "–" not in text and "—" not in text and len(text) <= prompts.QUESTION_MAX, text
    # The German questions as the mock has them, word for word.
    assert prompts.SETS[0]["de"][1][0] == "Was hat dich heute glücklich gemacht?"
    assert prompts.SETS[5]["de"] == ("Rückblick am Sonntag", ["Was war das Beste an dieser Woche?",
                                                              "Was hast du diese Woche gelernt?",
                                                              "Was nimmst du dir für nächste Woche vor?"])


def test_four_groups_are_on_from_the_start(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    view = client.get("/api/prompts").json()
    assert view["on"] is True and view["own"] == []
    assert [(entry["id"], entry["on"]) for entry in view["sets"]] == [
        ("schoen", True), ("gefuehle", True), ("wuensche", True), ("dank", True), ("menschen", False),
        ("rueckblick", False)]
    assert view["sets"][0]["name"] == "Schöne Momente"
    client.put("/api/me/language", json={"language": "en"})
    assert client.get("/api/prompts").json()["sets"][0]["name"] == "Lovely moments"
    assert text_of(client) in {text for entry in prompts.SETS for text in entry["en"][1]}


def test_the_question_of_the_day_stays_all_day_and_moves_on_the_next(client: TestClient, account: Account,
                                                                     at: list[datetime]) -> None:
    german(client)
    first = question(client)
    assert first and first["text"] in german_questions() and first["id"] in DEFAULT_IDS
    at[0] = MONDAY.replace(hour=23, minute=59)
    assert question(client) == first, "the same all day"
    with new_client(account) as other_browser:
        assert question(other_browser) == first, "on every device"
    at[0] = datetime(2026, 10, 6, 6, 0, tzinfo=UTC)
    assert question(client) != first, "another one tomorrow"


def test_the_question_of_the_day_is_the_same_in_every_language(client: TestClient, account: Account,
                                                               at: list[datetime]) -> None:
    """Without an own language the page's language decides the words, never which question it is."""
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    german_one = client.get("/api/today", headers={"X-Nexdiary-Language": "de"}).json()["question"]
    english_one = client.get("/api/today", headers={"X-Nexdiary-Language": "en"}).json()["question"]
    assert german_one["id"] == english_one["id"] and german_one["text"] != english_one["text"]
    # Answered in German, it is answered in English too.
    answer(client, german_one)
    after = client.get("/api/today", headers={"X-Nexdiary-Language": "en"}).json()["question"]
    assert after["id"] != german_one["id"]


def test_a_note_from_before_the_ids_counts_by_its_words_in_either_language(client: TestClient, account: Account,
                                                                            at: list[datetime]) -> None:
    german(client)
    asked = question(client)
    assert asked is not None
    english = dict(prompts._shipped("en"))[asked["id"]]
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "alt", "prompt": english})
    assert question(client)["id"] != asked["id"]


def test_a_question_id_must_be_one(client: TestClient, account: Account, at: list[datetime]) -> None:
    for wrong in ("../x", "schoen", "own.zz", "x" * 30):
        answered = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "t", "prompt": "Frage?",
                                                   "prompt_id": wrong})
        assert answered.status_code == 422, wrong
    # An id without the words it was shown with is refused too.
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "t", "prompt_id": "schoen.0"}
                       ).status_code == 422


def test_people_get_their_own_order(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    with person("ben") as ben:
        german(ben)
        mine, his = [], []
        for day in range(1, 8):
            at[0] = datetime(2026, 9, day, 12, 0, tzinfo=UTC)
            mine.append(question(client)["id"])
            his.append(question(ben)["id"])
        assert mine != his


def test_another_question_is_kept_for_the_day_only(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    first = question(client)
    second = client.post("/api/prompts/another").json()["question"]
    assert second and second != first
    assert question(client) == second, "kept for the day"
    third = client.post("/api/prompts/another").json()["question"]
    assert third not in (first, second)
    # The order is the person's own, and the day picks its place in it; a move counts for its day only.
    order = prompts._ordered(account.id, DEFAULT_IDS)
    monday = date(2026, 10, 5).toordinal()
    assert [first["id"], second["id"], third["id"]] == [order[(monday + shift) % len(order)] for shift in range(3)]
    at[0] = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    assert question(client)["id"] == order[(monday + 1) % len(order)], "Tuesday starts at its own place"
    # Moving on on Tuesday starts from Tuesday's own place, not from Monday's two moves.
    assert client.post("/api/prompts/another").json()["question"]["id"] == order[(monday + 2) % len(order)]


def test_two_tabs_asking_for_another_question_at_once_both_count(client: TestClient, account: Account,
                                                                 at: list[datetime]) -> None:
    german(client)
    start = question(client)
    pool = client.get("/api/prompts/pool", params={"date": "2026-10-05"}).json()["questions"]
    barrier = threading.Barrier(2)

    def ask() -> None:
        with new_client(account) as tab:
            barrier.wait(5)
            tab.post("/api/prompts/another")

    threads = [threading.Thread(target=ask) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert pool[0]["id"] == start["id"]
    assert question(client)["id"] == pool[2]["id"], "both moves counted"


def test_the_answer_becomes_a_note_with_its_question(client: TestClient, account: Account,
                                                     at: list[datetime]) -> None:
    german(client)
    asked = question(client)
    note = answer(client, asked, "kastanien mit mia")
    assert note["prompt"] == asked["text"] and note["prompt_id"] == asked["id"]
    notes = client.get("/api/today").json()["notes"]
    assert [(entry["text"], entry["prompt"]) for entry in notes] == [("kastanien mit mia", asked["text"])]
    # Answered: today asks the next one, and the pool for writing puts the answered one behind the others.
    assert question(client) not in (asked, None)
    pool = client.get("/api/prompts/pool", params={"date": "2026-10-05"}).json()["questions"]
    assert pool[0]["id"] == question(client)["id"] and pool[-1]["id"] == asked["id"] and pool[-1]["answered"]


def test_when_every_question_is_answered_there_is_none(client: TestClient, account: Account,
                                                       at: list[datetime]) -> None:
    german(client)
    for set_id in ("schoen", "gefuehle", "wuensche", "dank"):
        client.put(f"/api/prompts/sets/{set_id}", json={"on": False})
    add_own(client, "Die eine Frage?")
    asked = question(client)
    assert asked["text"] == "Die eine Frage?" and asked["id"].startswith("own.")
    answer(client, asked)
    assert question(client) is None
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None and prompts.question_for(db, row) is None


def test_a_change_meeting_another_is_written_again_onto_it(client: TestClient, account: Account,
                                                           at: list[datetime],
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    """Between reading the choice and writing it back, another tab changes it: written only onto the revision it
    was read from, the change is made again on what stands, and neither is lost."""
    add_own(client, "Erste?")
    real = prompts._row
    raced: list[bool] = []

    def racing(db: Any, account_id: int) -> Any:
        found = real(db, account_id)
        if not raced:
            raced.append(True)
            with SessionLocal() as other:
                prompts.switch(other, account_id, vault.dek_for(account_id), False)
        return found

    monkeypatch.setattr(prompts, "_row", racing)
    assert add_own(client, "Zweite?").status_code == 201
    view = client.get("/api/prompts").json()
    assert raced and view["on"] is False and own_texts(client) == ["Erste?", "Zweite?"]


def test_two_tabs_adding_questions_at_once_keep_both(client: TestClient, account: Account,
                                                     at: list[datetime]) -> None:
    barrier = threading.Barrier(3)

    def change(do: Any) -> None:
        with new_client(account) as tab:
            barrier.wait(5)
            assert do(tab).status_code in (200, 201)

    work = [lambda tab: add_own(tab, "Aus Tab eins?"), lambda tab: add_own(tab, "Aus Tab zwei?"),
            lambda tab: tab.put("/api/prompts/sets/menschen", json={"on": True})]
    threads = [threading.Thread(target=change, args=(do,)) for do in work]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(own_texts(client)) == ["Aus Tab eins?", "Aus Tab zwei?"]
    assert "menschen" in [entry["id"] for entry in client.get("/api/prompts").json()["sets"] if entry["on"]]


def test_switched_off_there_is_no_question(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    assert client.put("/api/prompts", json={"on": False}).json()["on"] is False
    assert question(client) is None
    assert client.get("/api/prompts/pool", params={"date": "2026-10-05"}).json() == {"questions": []}
    assert client.post("/api/prompts/another").json() == {"question": None}
    client.put("/api/prompts", json={"on": True})
    for set_id in ("schoen", "gefuehle", "wuensche", "dank"):
        client.put(f"/api/prompts/sets/{set_id}", json={"on": False})
    assert question(client) is None
    add_own(client, "Was hat dich heute überrascht?")
    assert text_of(client) == "Was hat dich heute überrascht?"


def test_groups_and_own_questions_change_one_at_a_time(client: TestClient, account: Account,
                                                       at: list[datetime]) -> None:
    german(client)
    for set_id in ("schoen", "gefuehle", "wuensche"):
        client.put(f"/api/prompts/sets/{set_id}", json={"on": False})
    assert [e["id"] for e in client.get("/api/prompts").json()["sets"] if e["on"]] == ["dank"]
    first = add_own(client, "  Was hat Mia gesagt?  ")
    assert first.status_code == 201
    assert add_own(client, "Was hat Mia gesagt?").json()["own"] == first.json()["own"], "the same words stay one"
    add_own(client, "Wo war ich\nheute?")
    own = client.get("/api/prompts").json()["own"]
    assert [entry["text"] for entry in own] == ["Was hat Mia gesagt?", "Wo war ich heute?"]
    assert all(entry["id"].startswith("own.") for entry in own) and own[0]["id"] != own[1]["id"]
    pool = client.get("/api/prompts/pool", params={"date": "2026-10-05"}).json()["questions"]
    dank = prompts.SETS[3]["de"][1]
    assert sorted(entry["text"] for entry in pool) == sorted([*dank, "Was hat Mia gesagt?", "Wo war ich heute?"])
    removed = client.delete(f"/api/prompts/own/{own[0]['id']}")
    assert [entry["text"] for entry in removed.json()["own"]] == ["Wo war ich heute?"]
    assert client.delete(f"/api/prompts/own/{own[0]['id']}").status_code == 200, "gone already: nothing changes"
    with new_client(account) as again:
        assert [entry["text"] for entry in again.get("/api/prompts").json()["own"]] == ["Wo war ich heute?"]
    client.put("/api/prompts", json={"on": False})
    assert own_texts(client) == ["Wo war ich heute?"]


def test_wrong_choices_are_refused(client: TestClient, account: Account, at: list[datetime]) -> None:
    assert client.put("/api/prompts/sets/piraten", json={"on": True}).json()["detail"]["code"] == "prompt_set_unknown"
    assert add_own(client, "x" * (prompts.QUESTION_MAX + 1)).json()["detail"]["code"] == "question_too_long"
    assert add_own(client, "   ").json()["detail"]["code"] == "question_empty"
    for number in range(prompts.OWN_MAX):
        assert add_own(client, f"Frage {number}?").status_code == 201
    too_many = add_own(client, "Noch eine?")
    assert (too_many.status_code, too_many.json()["detail"]["code"]) == (409, "too_many_questions")
    for wrong in ({"sets": ["dank"]}, {"own": ["x"]}, {"on": "ja"}, {}):
        assert client.put("/api/prompts", json=wrong).status_code == 422, wrong


def test_the_own_questions_are_the_own_person_s_only(client: TestClient, account: Account,
                                                     at: list[datetime]) -> None:
    german(client)
    add_own(client, "Jules eigene Frage?")
    own_id = client.get("/api/prompts").json()["own"][0]["id"]
    with person("ben") as ben:
        german(ben)
        assert ben.get("/api/prompts").json()["own"] == []
        assert "Jules eigene Frage?" not in [entry["text"] for entry in ben.get(
            "/api/prompts/pool", params={"date": "2026-10-05"}).json()["questions"]]
        assert text_of(ben) in german_questions()
        ben.delete(f"/api/prompts/own/{own_id}")
    assert own_texts(client) == ["Jules eigene Frage?"]


def test_the_sunday_group_has_its_day(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    sunday = set(prompts.SETS[5]["de"][1])
    for set_id in ("gefuehle", "wuensche", "dank"):
        client.put(f"/api/prompts/sets/{set_id}", json={"on": False})
    client.put("/api/prompts/sets/rueckblick", json={"on": True})
    at[0] = SUNDAY
    assert text_of(client) in sunday
    assert client.get("/api/prompts/pool", params={"date": "2026-10-11"}).json()["questions"][0]["text"] in sunday
    for day in range(5, 11):
        at[0] = datetime(2026, 10, day, 12, 0, tzinfo=UTC)
        assert text_of(client) not in sunday
        assert not sunday & {entry["text"] for entry in client.get(
            "/api/prompts/pool", params={"date": f"2026-10-{day:02d}"}).json()["questions"]}


def test_the_pool_for_writing_starts_with_the_question_of_the_day(client: TestClient, account: Account,
                                                                  at: list[datetime]) -> None:
    german(client)
    pool = client.get("/api/prompts/pool", params={"date": "2026-10-05"}).json()["questions"]
    assert pool[0]["id"] == question(client)["id"]
    assert sorted(entry["text"] for entry in pool) == sorted(text for entry in prompts.SETS[:4]
                                                            for text in entry["de"][1])
    assert client.get("/api/prompts/pool", params={"date": "2030-01-01"}).json()["detail"]["code"] == "date_in_future"


def test_a_reminder_can_bring_the_question_of_the_day(client: TestClient, account: Account,
                                                      at: list[datetime]) -> None:
    german(client)
    asked = question(client)
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        assert prompts.question_for(db, row) == asked
        assert prompts.question_for(db, row, date(2026, 10, 5)) == asked


def test_the_question_a_note_answers_is_sealed(client: TestClient, account: Account, at: list[datetime]) -> None:
    german(client)
    asked = question(client)
    answer(client, asked)
    from app.models import Note

    with SessionLocal() as db:
        stored = db.query(Note.prompt_ref_enc).one()[0]
    assert stored and asked["id"].encode() not in stored


def test_answered_is_known_by_the_id_even_when_the_words_changed(client: TestClient, account: Account,
                                                                 at: list[datetime]) -> None:
    """A note keeps which question it answers; words written with another wording of it still count."""
    german(client)
    asked = question(client)
    answer(client, {"id": asked["id"], "text": "Eine ältere Fassung der Frage?"})
    assert question(client)["id"] != asked["id"]
