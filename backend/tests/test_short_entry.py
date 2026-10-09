"""The short entry ("Heute nur kurz"): one sentence and the first value make the page of today. It counts for the
streak, the weekly goal and the statistics, never as a long page for a shield; only today, only on an empty day (no
notes, no page, no draft; decided in the writing transaction); the first value the person rates (in their order), or
none; pressing twice keeps one page."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.services import covers, diary, short_entry, vault

from .conftest import person

TODAY = "2026-10-09"
NOON = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


@pytest.fixture
def jule(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    with person("jule") as browser:
        assert browser.put("/api/me/preferences", json={"timezone": "UTC"}).status_code == 200
        yield browser


def short(browser: TestClient, text: str, rating: int | None = 3, day: str = TODAY, **more: Any):
    body: dict[str, Any] = {"text": text, "title": "Freitag, 9. Oktober", **more}
    if rating is not None:
        body["rating"] = rating
    return browser.post(f"/api/days/{day}/short", json=body)


def values(browser: TestClient) -> list[dict[str, Any]]:
    return browser.get("/api/values").json()


def test_a_sentence_and_the_mood_make_the_page_of_today(jule: TestClient) -> None:
    mood = values(jule)[0]
    made = short(jule, "Kastanien mit Mia, sonst nur müde.", rating=4)
    assert made.status_code == 200, made.text
    page = made.json()
    assert page["title"] == "Kastanien mit Mia, sonst nur müde."
    assert page["text"] == "Kastanien mit Mia, sonst nur müde."
    assert page["values"] == {mood["id"]: 4}
    assert page["written_by"] == "self"
    assert page["cover"] == covers.suggested_cover(TODAY, []) and page["cover_chosen"] is True


def test_a_long_sentence_leaves_the_title_to_the_date(jule: TestClient) -> None:
    sentence = "Heute war so viel los, dass ich nur noch schlafen will und morgen mehr schreibe."
    assert len(sentence) > short_entry.TITLE_FROM_TEXT
    page = short(jule, sentence).json()
    assert page["title"] == "Freitag, 9. Oktober" and page["text"] == sentence
    # Exactly the limit is still the title.
    with person("tom") as tom:
        tom.put("/api/me/preferences", json={"timezone": "UTC"})
        line = "x" * short_entry.TITLE_FROM_TEXT
        assert short(tom, line).json()["title"] == line


def test_the_short_page_counts_for_the_streak_and_the_week_but_earns_no_shield(jule: TestClient) -> None:
    before = jule.get("/api/today").json()["series"]
    assert (before["today_done"], before["week"]["count"], before["current"]) == (False, 0, 0)
    words = " ".join(["wort"] * 56)
    assert len(words) <= short_entry.TEXT_MAX
    assert short(jule, words).status_code == 200
    after = jule.get("/api/today").json()["series"]
    assert (after["today_done"], after["week"]["count"], after["current"]) == (True, 1, 1)
    assert after["shields"] == 0
    assert jule.get("/api/stats").status_code == 200
    # The floor: a page of 300 words on the day before does earn one.
    long_text = " ".join(["wort"] * 300)
    assert jule.put("/api/days/2026-10-08", json={"text": long_text}).status_code == 200
    assert jule.get("/api/today").json()["series"]["shields"] == 1


def test_only_while_the_day_has_no_page(jule: TestClient) -> None:
    # Ratings and tags alone are no page yet: the short entry keeps them.
    mood = values(jule)[0]
    assert jule.put(f"/api/days/{TODAY}", json={"tags": ["familie"]}).status_code == 200
    page = short(jule, "Kurz und gut.", rating=6).json()
    assert page["tags"] == ["familie"] and page["values"] == {mood["id"]: 6}
    # A page that stands is never written over, and the same press again is the page that stands.
    again = short(jule, "Kurz und gut.", rating=6)
    assert again.status_code == 200 and again.json()["text"] == "Kurz und gut."
    other = short(jule, "Etwas anderes.")
    assert (other.status_code, other.json()["detail"]["code"]) == (409, "day_written")
    assert jule.get(f"/api/days/{TODAY}").json()["text"] == "Kurz und gut."


def test_a_written_page_is_never_replaced(jule: TestClient) -> None:
    assert jule.put(f"/api/days/{TODAY}", json={"title": "Lang", "text": "Ein langer Text."}).status_code == 200
    refused = short(jule, "Nur kurz.")
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "day_written")
    assert jule.get(f"/api/days/{TODAY}").json()["text"] == "Ein langer Text."


def test_only_for_today(jule: TestClient) -> None:
    for day in ("2026-10-08", "2026-10-01"):
        refused = short(jule, "Gestern.", day=day)
        assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "short_only_today")
    assert jule.get("/api/days/2026-10-08").status_code == 404


def test_the_first_value_the_person_rates_counts(jule: TestClient) -> None:
    first, second = values(jule)[0], values(jule)[1]
    assert jule.put(f"/api/values/{first['id']}", json={"active": False}).status_code == 200
    page = short(jule, "Gesund heute.", rating=9).json()
    assert page["values"] == {second["id"]: 9}


def test_without_a_value_only_the_sentence(jule: TestClient) -> None:
    for value in values(jule):
        assert jule.put(f"/api/values/{value['id']}", json={"active": False}).status_code == 200
    page = short(jule, "Nur ein Satz.", rating=None)
    assert page.status_code == 200 and page.json()["values"] == {}


def test_a_rating_is_needed_for_a_value_and_in_range(jule: TestClient) -> None:
    for rating in (None, 0, 11):
        refused = short(jule, "Satz.", rating=rating)
        assert (refused.status_code, refused.json()["detail"]["code"]) == (422, "value_out_of_range"), rating
    assert jule.post(f"/api/days/{TODAY}/short", json={"text": "Satz.", "rating": "5"}).status_code == 422
    assert jule.get(f"/api/days/{TODAY}").status_code == 404


def test_the_sentence_is_needed_and_short(jule: TestClient) -> None:
    empty = short(jule, "   ")
    assert (empty.status_code, empty.json()["detail"]["code"]) == (422, "short_empty")
    long = short(jule, "x" * (short_entry.TEXT_MAX + 1))
    assert (long.status_code, long.json()["detail"]["code"]) == (422, "short_too_long")
    assert short(jule, "x" * short_entry.TEXT_MAX).status_code == 200


def test_a_chosen_cover_is_taken_and_a_strange_one_refused(jule: TestClient) -> None:
    refused = short(jule, "Satz.", cover="illu:nichts.da.hier")
    assert refused.status_code == 422
    chosen = "illu:" + covers.suggest(TODAY, [])[1]
    assert short(jule, "Satz.", cover=chosen).json()["cover"] == chosen


def test_the_sentence_is_read_as_written() -> None:
    assert short_entry.as_paragraph("# Kein *Titel* [hier](x)") == "\\# Kein \\*Titel\\* \\[hier\\](x)"
    assert short_entry.as_paragraph("- keine Liste") == "\\- keine Liste"
    assert short_entry.as_paragraph("1. keine Zahl") == "\\1. keine Zahl"
    assert short_entry.as_paragraph("Ganz normal.") == "Ganz normal."
    # A character reference stays its letters: the reader and the editor show the same.
    assert short_entry.as_paragraph("Tom & Jerry &amp; &#64;") == "Tom \\& Jerry \\&amp; \\&\\#64;"


# --- Only on an empty day ----------------------------------------------------------------------------------------------


def refused_as_not_empty(browser: TestClient) -> None:
    refused = short(browser, "Nur kurz.")
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "short_day_not_empty"), refused.text
    assert browser.get(f"/api/days/{TODAY}").status_code == 404 or not browser.get(f"/api/days/{TODAY}").json()["text"]


def test_a_day_with_notes_is_written_up_not_cut_short(jule: TestClient) -> None:
    note = {"id": str(uuid.uuid4()), "text": "kastanien mit mia"}
    assert jule.post("/api/notes", json=note).status_code == 201
    assert jule.get("/api/today").json()["notes"]
    refused_as_not_empty(jule)
    # The note gone again: the day is empty, and the short entry may come.
    assert jule.delete(f"/api/notes/{note['id']}").status_code == 204
    assert short(jule, "Doch nur kurz.").status_code == 200


def test_a_day_with_a_draft_is_not_cut_short(jule: TestClient) -> None:
    assert jule.put(f"/api/days/{TODAY}/draft", json={"text": "Angefangen", "base_revision": -1}).status_code == 200
    assert jule.get("/api/today").json()["has_draft"] is True
    refused_as_not_empty(jule)
    assert jule.delete(f"/api/days/{TODAY}/draft").status_code == 204
    assert jule.get("/api/today").json()["has_draft"] is False
    assert short(jule, "Doch nur kurz.").status_code == 200


def test_a_title_alone_is_a_page_already(jule: TestClient) -> None:
    assert jule.put(f"/api/days/{TODAY}", json={"title": "Nur ein Titel"}).status_code == 200
    refused = short(jule, "Nur kurz.")
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "day_written")
    assert jule.get(f"/api/days/{TODAY}").json()["title"] == "Nur ein Titel"


def sneak_in(monkeypatch: pytest.MonkeyPatch, what: str) -> list[int]:
    """Between reading the day and writing the short page: a note (another device) or a draft arrives, written and
    committed by a session of its own. The ids of the accounts it happened for."""
    happened: list[int] = []
    real = diary.merge
    account = [0]
    real_save = short_entry.save

    def save(db, account_id, *args):  # type: ignore[no-untyped-def]
        account[0] = account_id
        return real_save(db, account_id, *args)

    def merge_then_sneak(content, patch):  # type: ignore[no-untyped-def]
        if not happened:
            with SessionLocal() as other:
                dek = vault.dek_for(account[0])
                if what == "note":
                    diary.add_note(other, account[0], dek, str(uuid.uuid4()), TODAY, "von unterwegs", None)
                else:
                    diary.save_draft(other, account[0], dek, TODAY,
                                     diary.clean_draft(other, account[0], TODAY, {"text": "angefangen"}), -1)
            happened.append(account[0])
        return real(content, patch)

    monkeypatch.setattr(short_entry, "save", save)
    monkeypatch.setattr(diary, "merge", merge_then_sneak)
    return happened


@pytest.mark.parametrize("what", ["note", "draft"])
def test_a_note_or_draft_between_check_and_write_undoes_the_short_page(jule: TestClient,
                                                                      monkeypatch: pytest.MonkeyPatch,
                                                                      what: str) -> None:
    mood = values(jule)[0]
    assert jule.put(f"/api/days/{TODAY}/values", json={"values": {mood["id"]: 5}}).status_code == 200
    happened = sneak_in(monkeypatch, what)
    refused = short(jule, "Nur kurz.", rating=2)
    assert happened, "the note or draft was not written in between"
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "short_day_not_empty"), refused.text
    # Nothing of the short entry stayed: the rating set before is untouched, no text, the newcomer stands.
    day = jule.get(f"/api/days/{TODAY}").json()
    assert day["text"] == "" and day["title"] == "" and day["values"] == {mood["id"]: 5}
    if what == "note":
        assert [note["text"] for note in jule.get("/api/notes", params={"date": TODAY}).json()] == ["von unterwegs"]
    else:
        assert jule.get(f"/api/days/{TODAY}/draft").json()["text"] == "angefangen"


def test_the_same_press_again_stands_even_after_a_note(jule: TestClient) -> None:
    assert short(jule, "Kurz und gut.").status_code == 200
    note = {"id": str(uuid.uuid4()), "text": "noch was"}
    assert jule.post("/api/notes", json=note).status_code == 201
    # The retry of a press whose reply was lost: the page that stands, not a refusal.
    again = short(jule, "Kurz und gut.")
    assert again.status_code == 200 and again.json()["text"] == "Kurz und gut."
