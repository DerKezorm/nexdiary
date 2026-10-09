"""The family question: only who joined takes part, the others' answers come out only after the own one (on every
way), leaving takes the answers along, blocked accounts vanish, the question is the same for everybody on the same
date whatever the time zone, an answer is a note of the day with its question, and answering twice at once keeps one
answer and one note."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import clock
from app.db import SessionLocal
from app.models import Account, FamilyAnswer
from app.services import family

from .conftest import PASSWORD, make_account, new_client

NOON = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
DAY = "2026-10-09"


@pytest.fixture
def at_noon(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    """The clock of the server, settable by the test (``moment[0] = ...``)."""
    moment = [NOON]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    yield moment


def joined(name: str, zone: str = "UTC") -> TestClient:
    browser = new_client(make_account(name))
    assert browser.put("/api/me/preferences", json={"timezone": zone, "family": True}).status_code == 200
    return browser


def answer(browser: TestClient, words: str, day: str = DAY, note_id: str | None = None):
    return browser.put("/api/family/answer", json={"date": day, "text": words, "note_id": note_id or str(uuid.uuid4())})


def count(model: type, **where: object) -> int:
    with SessionLocal() as db:
        query = select(func.count()).select_from(model)
        for key, value in where.items():
            query = query.where(getattr(model, key) == value)
        return int(db.scalar(query) or 0)


def account_id(browser: TestClient) -> int:
    return int(browser.get("/api/auth/me").json()["id"])


# --- Who takes part -------------------------------------------------------------------------------------------------


def test_nobody_takes_part_from_the_start_and_who_has_not_joined_sees_and_answers_nothing(at_noon: list[datetime]) -> None:
    tom = joined("tom")
    assert answer(tom, "Kürbissuppe").status_code == 200
    with new_client(make_account("jule")) as jule:
        jule.put("/api/me/preferences", json={"timezone": "UTC"})
        assert jule.get("/api/auth/me").json()["profile"]["family"] is False
        looked = jule.get("/api/family")
        assert (looked.status_code, looked.json()["detail"]["code"]) == (403, "family_not_joined")
        today = jule.get("/api/today").json()
        assert today["family"] is None
        refused = answer(jule, "Apfel")
        assert (refused.status_code, refused.json()["detail"]["code"]) == (403, "family_not_joined")
        assert jule.request("DELETE", "/api/family/answer", params={"date": DAY}).status_code == 403
        # Nothing of tom's answer, not even his name, on any way.
        for text in (looked.text, refused.text, jule.get("/api/today").text):
            assert "Kürbissuppe" not in text and "tom" not in text
    assert count(FamilyAnswer) == 1


def test_the_hint_shows_once_somebody_else_joined_and_goes_for_good(at_noon: list[datetime]) -> None:
    with new_client(make_account("jule")) as jule:
        assert jule.get("/api/today").json()["family_hint"] is False
        tom = joined("tom")
        assert jule.get("/api/today").json()["family_hint"] is True
        assert jule.put("/api/me/preferences", json={"family_hint": False}).status_code == 200
        assert jule.get("/api/today").json()["family_hint"] is False
        # Joining makes the card, never the hint.
        assert jule.put("/api/me/preferences", json={"family": True, "family_hint": True}).status_code == 200
        assert jule.get("/api/today").json()["family_hint"] is False
        assert jule.get("/api/today").json()["family"]["question"]["id"] == family.question_of(DAY)
        tom.close()


def test_a_person_alone_sees_the_card_and_nobody_else(at_noon: list[datetime]) -> None:
    with joined("jule") as jule:
        make_account("tom")
        card = jule.get("/api/family").json()
        assert [person["name"] for person in card["people"]] == ["jule"]
        assert card["mine"] is None and card["answers"] is None


# --- The others' answers only after the own -------------------------------------------------------------------------


def test_the_answers_of_the_others_come_out_only_after_the_own(at_noon: list[datetime]) -> None:
    tom, ruth, mia, jule = joined("tom"), joined("ruth"), joined("mia"), joined("jule")
    assert answer(tom, "Die Kürbissuppe von gestern.").status_code == 200
    assert answer(ruth, "Ein Apfel vom alten Baum.").status_code == 200
    before = jule.get("/api/family")
    card = before.json()
    assert card["mine"] is None and card["answers"] is None
    assert {person["name"]: person["answered"] for person in card["people"]} == {
        "tom": True, "ruth": True, "mia": False, "jule": False}
    # Nothing of what they wrote, on every way to the day: the card, today, and the notes.
    for text in (before.text, jule.get("/api/today").text, jule.get("/api/notes", params={"date": DAY}).text):
        assert "Kürbissuppe" not in text and "Apfel" not in text
    after = answer(jule, "Kastanien, geröstet.")
    assert after.status_code == 200
    card = after.json()
    assert card["mine"]["text"] == "Kastanien, geröstet."
    assert [(item["from"], item["text"]) for item in card["answers"]] == [
        (account_id(tom), "Die Kürbissuppe von gestern."), (account_id(ruth), "Ein Apfel vom alten Baum.")]
    assert jule.get("/api/today").json()["family"]["answers"] == card["answers"]
    # Mia, who has not answered yet, still sees nothing; taking the own answer back hides them again.
    assert mia.get("/api/family").json()["answers"] is None
    back = jule.request("DELETE", "/api/family/answer", params={"date": DAY})
    assert back.status_code == 200 and back.json()["answers"] is None and back.json()["mine"] is None
    assert "Kürbissuppe" not in jule.get("/api/family").text
    for browser in (tom, ruth, mia, jule):
        browser.close()


def test_leaving_takes_the_answers_along_and_coming_back_brings_none(at_noon: list[datetime]) -> None:
    tom, jule = joined("tom"), joined("jule")
    answer(tom, "Kürbissuppe")
    answer(jule, "Kastanien")
    assert len(jule.get("/api/family").json()["answers"]) == 1
    assert tom.put("/api/me/preferences", json={"family": False}).status_code == 200
    assert count(FamilyAnswer, user_id=account_id(tom)) == 0
    card = jule.get("/api/family").json()
    assert card["answers"] == [] and "tom" not in [person["name"] for person in card["people"]]
    assert "Kürbissuppe" not in jule.get("/api/family").text
    # The note his answer became stays his.
    assert any(note["text"] == "Kürbissuppe" for note in tom.get("/api/notes", params={"date": DAY}).json())
    assert tom.put("/api/me/preferences", json={"family": True}).status_code == 200
    assert jule.get("/api/family").json()["answers"] == []
    tom.close()
    jule.close()


def test_a_blocked_account_vanishes_from_the_card(client: TestClient, operator: Account,
                                                 at_noon: list[datetime]) -> None:
    tom, jule = joined("tom"), joined("jule")
    answer(tom, "Kürbissuppe")
    answer(jule, "Kastanien")
    tom_id = account_id(tom)
    assert client.post(f"/api/accounts/{tom_id}/block", json={"current_password": PASSWORD}).status_code == 204
    card = jule.get("/api/family").json()
    assert card["answers"] == [] and tom_id not in [person["id"] for person in card["people"]]
    assert client.post(f"/api/accounts/{tom_id}/unblock", json={"current_password": PASSWORD}).status_code == 204
    assert [item["text"] for item in jule.get("/api/family").json()["answers"]] == ["Kürbissuppe"]
    tom.close()
    jule.close()


def test_a_deleted_account_takes_its_answers_along(client: TestClient, operator: Account,
                                                   at_noon: list[datetime]) -> None:
    tom = joined("tom")
    answer(tom, "Kürbissuppe")
    tom_id = account_id(tom)
    tom.close()
    assert client.request("DELETE", f"/api/accounts/{tom_id}", json={"current_password": PASSWORD}).status_code == 204
    assert count(FamilyAnswer) == 0


def test_the_operator_has_no_way_in(client: TestClient, operator: Account, at_noon: list[datetime]) -> None:
    tom = joined("tom")
    answer(tom, "Kürbissuppe")
    for path in ("/api/family", "/api/today", "/api/accounts"):
        assert "Kürbissuppe" not in client.get(path).text
    assert client.get("/api/family").status_code == 403
    tom.close()


# --- The answer -----------------------------------------------------------------------------------------------------


def test_an_answer_is_a_note_of_the_day_with_its_question_and_changes_with_it(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    question = jule.get("/api/family").json()["question"]
    note_id = str(uuid.uuid4())
    assert answer(jule, "Kastanien", note_id=note_id).status_code == 200
    # The same press again: one answer, one note.
    assert answer(jule, "Kastanien", note_id=note_id).status_code == 200
    notes = jule.get("/api/notes", params={"date": DAY}).json()
    assert [(note["id"], note["text"], note["prompt"], note["prompt_id"]) for note in notes] == [
        (note_id, "Kastanien", question["text"], question["id"])]
    # Changed the same day, with another id from a reloaded page: the answer and its note change, nothing is added.
    changed = answer(jule, "Kastanien und Tee")
    assert changed.json()["mine"]["text"] == "Kastanien und Tee"
    notes = jule.get("/api/notes", params={"date": DAY}).json()
    assert [(note["id"], note["text"]) for note in notes] == [(note_id, "Kastanien und Tee")]
    # Taken back: the note stays.
    jule.request("DELETE", "/api/family/answer", params={"date": DAY})
    assert [note["text"] for note in jule.get("/api/notes", params={"date": DAY}).json()] == ["Kastanien und Tee"]
    assert count(FamilyAnswer) == 0
    jule.close()


def test_a_deleted_note_stays_deleted_when_the_answer_changes(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    note_id = str(uuid.uuid4())
    answer(jule, "Kastanien", note_id=note_id)
    assert jule.delete(f"/api/notes/{note_id}").status_code == 204
    assert answer(jule, "Tee").json()["mine"]["text"] == "Tee"
    assert jule.get("/api/notes", params={"date": DAY}).json() == []
    jule.close()


def test_an_answer_has_words_and_a_limit_and_is_for_today_only(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    empty = answer(jule, "   ")
    assert (empty.status_code, empty.json()["detail"]["code"]) == (422, "answer_empty")
    long = answer(jule, "x" * (family.ANSWER_MAX + 1))
    assert (long.status_code, long.json()["detail"]["code"]) == (422, "answer_too_long")
    assert answer(jule, "x" * family.ANSWER_MAX).status_code == 200
    for other in ("2026-10-08", "2026-10-10"):
        late = answer(jule, "gestern", day=other)
        assert (late.status_code, late.json()["detail"]["code"]) == (409, "family_day_over")
        gone = jule.request("DELETE", "/api/family/answer", params={"date": other})
        assert gone.status_code == 409
    bad = jule.put("/api/family/answer", json={"date": DAY, "text": "a", "note_id": "nope"})
    assert bad.status_code == 422
    assert count(FamilyAnswer) == 1
    jule.close()


def test_a_locked_day_keeps_the_answer_without_a_note(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    assert jule.put(f"/api/days/{DAY}", json={"title": "Fertig", "text": "Ein Tag."}).status_code == 200
    assert jule.post(f"/api/days/{DAY}/lock").status_code == 200
    assert answer(jule, "Kastanien").status_code == 200
    assert jule.get("/api/notes", params={"date": DAY}).json() == []
    assert jule.get("/api/family").json()["mine"]["text"] == "Kastanien"
    jule.close()


def test_answering_twice_at_once_keeps_one_answer_and_one_note(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    jule_id = account_id(jule)
    start = threading.Barrier(4, timeout=10)
    codes: list[int] = []
    row = make_account_row(jule_id)

    def tap(words: str) -> None:
        with new_client(row) as browser:
            start.wait()
            codes.append(answer(browser, words).status_code)

    threads = [threading.Thread(target=tap, args=(words,)) for words in ("Tee", "Kakao", "Tee", "Saft")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert codes == [200, 200, 200, 200], codes
    assert count(FamilyAnswer) == 1
    notes = jule.get("/api/notes", params={"date": DAY}).json()
    assert len(notes) == 1
    # The note says what the answer says.
    assert notes[0]["text"] == jule.get("/api/family").json()["mine"]["text"]
    jule.close()


def make_account_row(account: int) -> Account:
    with SessionLocal() as db:
        row = db.get(Account, account)
        assert row is not None
        db.expunge(row)
    return row


# --- The question ---------------------------------------------------------------------------------------------------


def test_the_same_question_for_everybody_on_the_same_date_across_time_zones(at_noon: list[datetime]) -> None:
    # 23:30 in UTC: in Berlin it is the next day already, in New York still the evening before.
    at_noon[0] = datetime(2026, 10, 9, 23, 30, tzinfo=UTC)
    berlin, new_york = joined("jule", "Europe/Berlin"), joined("tom", "America/New_York")
    early, late = berlin.get("/api/family").json(), new_york.get("/api/family").json()
    assert (early["date"], late["date"]) == ("2026-10-10", "2026-10-09")
    assert early["question"]["id"] == family.question_of("2026-10-10")
    assert late["question"]["id"] == family.question_of("2026-10-09")
    assert early["question"]["id"] != late["question"]["id"]
    # Jule answers for her 10 October; Tom on his 9 October sees nothing of it, even after his own answer.
    assert answer(berlin, "Frühstück", day="2026-10-10").status_code == 200
    assert answer(new_york, "Abendbrot", day="2026-10-09").json()["answers"] == []
    # Twelve hours later both are on the 10th: the same question, and her answer opens after his.
    at_noon[0] = datetime(2026, 10, 10, 15, 0, tzinfo=UTC)
    card = new_york.get("/api/family").json()
    assert card["question"]["id"] == early["question"]["id"] and card["answers"] is None
    assert card["people"][0]["answered"] is True
    assert [item["text"] for item in answer(new_york, "Pfannkuchen", day="2026-10-10").json()["answers"]] == [
        "Frühstück"]
    berlin.close()
    new_york.close()


def test_the_question_comes_in_each_persons_language_with_the_same_id(at_noon: list[datetime]) -> None:
    jule = joined("jule")
    tom = joined("tom")
    tom.put("/api/me/language", json={"language": "en"})
    jule.put("/api/me/language", json={"language": "de"})
    german, english = jule.get("/api/family").json()["question"], tom.get("/api/family").json()["question"]
    assert german["id"] == english["id"]
    index = int(german["id"].split(".")[1])
    assert (german["text"], english["text"]) == family.QUESTIONS[index]
    jule.close()
    tom.close()


def test_the_days_walk_through_every_question_before_one_comes_again() -> None:
    start = date(2026, 1, 1)
    days = [(start + timedelta(days=offset)).isoformat() for offset in range(len(family.QUESTIONS))]
    assert len({family.question_of(day) for day in days}) == len(family.QUESTIONS)
    assert family.question_of("2026-10-09") == family.question_of("2026-10-09")


def test_the_questions_are_many_light_and_in_both_languages() -> None:
    assert len(family.QUESTIONS) >= 60
    for german, english in family.QUESTIONS:
        assert german.endswith("?") and english.endswith("?"), (german, english)
        for words in (german, english):
            assert "–" not in words and "—" not in words and len(words) <= 120
    assert len({german for german, _ in family.QUESTIONS}) == len(family.QUESTIONS)
    assert len({english for _, english in family.QUESTIONS}) == len(family.QUESTIONS)
