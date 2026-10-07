"""Notes, days and values over the API: each person only their own, writes that meet stay whole, limits hold, and
"today" is the person's own. The clock is set by the tests, never read from the wall."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import clock
from app.db import SessionLocal
from app.models import Account, Day, Note, ValueDef
from app.services import diary, vault

from .conftest import make_account, new_client, person

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    """The clock stands at noon on 6 October 2026 (UTC) unless a test moves it."""
    moment = [NOON]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    yield moment


def zone(client: TestClient, name: str) -> None:
    assert client.put("/api/me/preferences", json={"timezone": name}).status_code == 200


def note(client: TestClient, text: str, **extra: Any) -> dict[str, Any]:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, **extra})
    assert answer.status_code == 201, answer.text
    return answer.json()


def count(model: Any) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)


# --- Notes ----------------------------------------------------------------------------------------------------------


def test_a_note_is_kept_listed_changed_and_deleted(client: TestClient, account: Account) -> None:
    zone(client, "Europe/Berlin")
    first = note(client, "  schlecht geschlafen, kaffee doppelt  ")
    assert first["text"] == "schlecht geschlafen, kaffee doppelt" and first["date"] == "2026-10-06"
    assert first["prompt"] is None and first["created_at"] == "2026-10-06T12:00:00+00:00"
    second = note(client, "mit mia kastanien gesammelt!!", prompt="Was war schön?")
    listed = client.get("/api/notes", params={"date": "2026-10-06"}).json()
    assert [item["id"] for item in listed] == [first["id"], second["id"]]
    assert listed[1]["prompt"] == "Was war schön?"
    changed = client.put(f"/api/notes/{first['id']}", json={"text": "doch ganz gut geschlafen"})
    assert changed.status_code == 200 and changed.json()["text"] == "doch ganz gut geschlafen"
    assert changed.json()["updated_at"] is not None
    assert client.delete(f"/api/notes/{first['id']}").status_code == 204
    assert [item["id"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [second["id"]]
    assert client.delete(f"/api/notes/{first['id']}").status_code == 404


def test_the_same_note_sent_twice_is_kept_once(client: TestClient, account: Account) -> None:
    uid = str(uuid.uuid4())
    made = client.post("/api/notes", json={"id": uid, "text": "einmal"})
    again = client.post("/api/notes", json={"id": uid.upper(), "text": " einmal "})
    assert (made.status_code, again.status_code) == (201, 200)
    assert again.json() == made.json(), "the second send returns the note that stands"
    # The same id with another text: refused, never the old note in its place (the browser would drop the new text).
    other = client.post("/api/notes", json={"id": uid, "text": "einmal, dann geändert"})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "note_id_taken"
    assert count(Note) == 1


def test_two_sends_of_one_note_at_the_same_moment_keep_one(account: Account) -> None:
    """A double click: both requests pass the look for an existing note before either inserts."""
    uid = str(uuid.uuid4())
    dek = vault.dek_for(account.id)
    both_looked = threading.Barrier(2, timeout=10)
    original = diary._note_row
    calls: list[int] = []

    def look_then_wait(db: Any, account_id: int, wanted: str) -> Any:
        found = original(db, account_id, wanted)
        calls.append(1)
        if len(calls) <= 2:
            both_looked.wait()
        return found

    results: list[bool] = []
    failed: list[BaseException] = []

    def send() -> None:
        try:
            with SessionLocal() as db:
                results.append(diary.add_note(db, account.id, dek, uid, "2026-10-06", "doppelt geklickt", None)[1])
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever went wrong
            failed.append(exc)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(diary, "_note_row", look_then_wait)
        threads = [threading.Thread(target=send) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    assert failed == []
    assert sorted(results) == [False, True], "one insert, one that found it"
    assert count(Note) == 1


def test_a_note_needs_text_and_a_proper_id_and_stays_within_its_limit(client: TestClient, account: Account) -> None:
    for body, code in (
        ({"id": str(uuid.uuid4()), "text": "   "}, "note_empty"),
        ({"id": str(uuid.uuid4()), "text": "x" * (diary.NOTE_MAX + 1)}, "note_too_long"),
        ({"id": str(uuid.uuid4()), "text": "x" * (diary.NOTE_MAX * 4 + 1)}, "invalid_input"),
        ({"id": "not-a-uuid", "text": "hallo"}, "note_id_invalid"),
        ({"id": str(uuid.uuid4()), "text": "hallo", "extra": 1}, "invalid_input"),
        ({"id": str(uuid.uuid4()), "text": "hallo", "prompt": "?" * (diary.PROMPT_MAX + 1)}, "prompt_too_long"),
    ):
        answer = client.post("/api/notes", json=body)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == code, body
    assert note(client, "x" * diary.NOTE_MAX)["text"] == "x" * diary.NOTE_MAX
    assert count(Note) == 1


def test_a_day_holds_no_more_notes_than_allowed(client: TestClient, account: Account,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(diary, "NOTES_PER_DAY", 2)
    note(client, "eins")
    note(client, "zwei")
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "drei"})
    assert answer.status_code == 409 and answer.json()["detail"]["code"] == "too_many_notes"
    assert note(client, "morgen", date="2026-10-07")["date"] == "2026-10-07"


def test_control_characters_leave_a_note_and_line_breaks_stay(client: TestClient, account: Account) -> None:
    assert note(client, "eins\r\nzwei\x00\x07drei")["text"] == "eins\nzweidrei"


# --- Today and dates ------------------------------------------------------------------------------------------------


def test_today_is_the_date_in_the_person_s_own_time_zone(client: TestClient, account: Account,
                                                        fixed_clock: list[datetime]) -> None:
    fixed_clock[0] = datetime(2026, 10, 6, 23, 30, tzinfo=UTC)
    zone(client, "Europe/Berlin")
    assert client.get("/api/today").json()["date"] == "2026-10-07"
    assert note(client, "nach mitternacht")["date"] == "2026-10-07"
    zone(client, "America/New_York")
    assert client.get("/api/today").json()["date"] == "2026-10-06"
    assert note(client, "noch am abend")["date"] == "2026-10-06"


def test_a_date_after_tomorrow_or_not_a_date_is_refused(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    assert note(client, "morgen schon", date="2026-10-07")["date"] == "2026-10-07"
    for wrong, code in (("2026-10-08", "date_in_future"), ("2026-02-30", "date_invalid"), ("06.10.2026", "date_invalid"),
                        ("1899-12-31", "date_invalid"), ("2026-1-6", "date_invalid")):
        answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "x", "date": wrong})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == code, wrong
        assert client.put(f"/api/days/{wrong}", json={"title": "x"}).status_code in (404, 422), wrong
    assert note(client, "früher", date="2001-01-01")["date"] == "2001-01-01"


def test_today_brings_notes_page_values_and_the_streak(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    for day in ("2026-10-03", "2026-10-04", "2026-10-05"):
        assert client.put(f"/api/days/{day}", json={"text": "ein Tag", "written_by": "self"}).status_code == 200
    # A day with values only is not a written page.
    mood = client.get("/api/values").json()[0]["id"]
    client.put("/api/days/2026-10-02/values", json={"values": {mood: 5}})
    note(client, "heute")
    today = client.get("/api/today").json()
    assert today["date"] == "2026-10-06"
    assert [item["text"] for item in today["notes"]] == ["heute"]
    assert today["day"] is None and today["streak"] == 3
    assert [value["name"] for value in today["values"]][:4] in (
        ["Mood", "Health", "Sleep", "Work day"], ["Stimmung", "Gesundheit", "Schlaf", "Arbeitstag"])
    client.put("/api/days/2026-10-06", json={"text": "heute auch"})
    assert client.get("/api/today").json()["streak"] == 4


# --- Days -----------------------------------------------------------------------------------------------------------


def test_a_day_is_made_changed_in_parts_and_deleted_and_its_notes_stay(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    note(client, "rohe notiz")
    made = client.put("/api/days/2026-10-06", json={"title": "Kastanien und Kopfweh", "text": "Die Nacht war kurz.",
                                                    "tags": ["#Mia", "herbst", "mia", " Draußen  sein "],
                                                    "written_by": "ai"})
    assert made.status_code == 200, made.text
    day = made.json()
    assert day["tags"] == ["mia", "herbst", "draußen sein"] and day["words"] == 4 and day["written_by"] == "ai"
    changed = client.put("/api/days/2026-10-06", json={"text": "Die Nacht war kurz. Der Hund bellte."}).json()
    assert changed["title"] == "Kastanien und Kopfweh", "only the fields sent change"
    assert changed["tags"] == ["mia", "herbst", "draußen sein"]
    assert client.get("/api/days/2026-10-06").json()["text"] == "Die Nacht war kurz. Der Hund bellte."
    listed = client.get("/api/days").json()
    assert listed == [{"date": "2026-10-06", "title": "Kastanien und Kopfweh", "tags": ["mia", "herbst", "draußen sein"],
                       "words": 7, "values": {}, "cover": "illu:baum.abend.herbst", "cover_crop": None,
                       "written_by": "ai",
                       "unreadable": False, "locked": False}]
    assert client.delete("/api/days/2026-10-06").status_code == 204
    assert client.get("/api/days/2026-10-06").status_code == 404
    assert client.delete("/api/days/2026-10-06").status_code == 404
    assert [item["text"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == ["rohe notiz"]


def test_the_list_of_days_goes_back_page_by_page(client: TestClient, account: Account) -> None:
    for day in ("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"):
        client.put(f"/api/days/{day}", json={"title": day})
    first = client.get("/api/days", params={"limit": 2}).json()
    assert [item["date"] for item in first] == ["2026-10-04", "2026-10-03"]
    rest = client.get("/api/days", params={"limit": 2, "before": first[-1]["date"]}).json()
    assert [item["date"] for item in rest] == ["2026-10-02", "2026-10-01"]
    assert client.get("/api/days", params={"limit": 0}).status_code == 422
    assert client.get("/api/days", params={"limit": diary.DAYS_LIST_MAX + 1}).status_code == 422


def test_a_day_keeps_its_limits(client: TestClient, account: Account) -> None:
    for body, code in (
        ({"title": "x" * (diary.TITLE_MAX + 1)}, "title_too_long"),
        ({"text": "x" * (diary.TEXT_MAX + 1)}, "text_too_long"),
        ({"tags": ["x" * (diary.TAG_MAX + 1)]}, "tag_too_long"),
        ({"tags": [f"t{n}" for n in range(diary.TAGS_MAX + 1)]}, "too_many_tags"),
        ({"written_by": "robot"}, "invalid_input"),
        ({"cover": "x"}, "cover_unknown"),
        ({"cover": "illu:mond.abend.herbst"}, "cover_unknown"),
    ):
        answer = client.put("/api/days/2026-10-06", json=body)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == code, body
    assert count(Day) == 0


def test_two_saves_of_a_new_day_at_once_make_one_day_and_lose_neither(account: Account) -> None:
    """Both read "no day yet" before either writes: one inserts, the other reads again and changes what stands."""
    dek = vault.dek_for(account.id)
    both_read = threading.Barrier(2, timeout=10)
    failed: list[BaseException] = []

    def save(patch: dict[str, Any]) -> None:
        waited = [False]

        def apply(content: dict[str, Any]) -> dict[str, Any]:
            if not waited[0]:
                waited[0] = True
                both_read.wait()
            return diary.merge(content, patch)

        try:
            with SessionLocal() as db:
                diary.change_day(db, account.id, dek, "2026-10-06", apply)
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever went wrong
            failed.append(exc)

    threads = [threading.Thread(target=save, args=(patch,)) for patch in ({"title": "Titel"}, {"text": "Text"})]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failed == []
    assert count(Day) == 1
    with SessionLocal() as db:
        day = diary.get_day(db, account.id, dek, "2026-10-06")
    assert day is not None and (day["title"], day["text"]) == ("Titel", "Text"), "no change is lost"


def test_two_changes_of_a_standing_day_at_once_lose_neither(account: Account) -> None:
    dek = vault.dek_for(account.id)
    with SessionLocal() as db:
        diary.change_day(db, account.id, dek, "2026-10-06", lambda content: diary.merge(content, {"title": "alt"}))
    both_read = threading.Barrier(2, timeout=10)

    def save(patch: dict[str, Any]) -> None:
        waited = [False]

        def apply(content: dict[str, Any]) -> dict[str, Any]:
            if not waited[0]:
                waited[0] = True
                both_read.wait()
            return diary.merge(content, patch)

        with SessionLocal() as db:
            diary.change_day(db, account.id, dek, "2026-10-06", apply)

    threads = [threading.Thread(target=save, args=(patch,)) for patch in ({"tags": ["a"]}, {"text": "neu"})]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    with SessionLocal() as db:
        day = diary.get_day(db, account.id, dek, "2026-10-06")
    assert day is not None and (day["title"], day["tags"], day["text"]) == ("alt", ["a"], "neu")


# --- Values ---------------------------------------------------------------------------------------------------------


def test_the_starting_values_come_once_in_the_account_s_language(client: TestClient, account: Account) -> None:
    client.put("/api/me/language", json={"language": "de"})
    first = client.get("/api/values").json()
    assert [(item["name"], item["low"], item["high"], item["active"]) for item in first] == [
        ("Stimmung", "mies", "super", True), ("Gesundheit", "krank", "topfit", True), ("Schlaf", "kaum", "erholt", True),
        ("Arbeitstag", "zäh", "richtig gut", True), ("Beziehung", "schwierig", "innig", False)]
    for item in first:
        assert client.delete(f"/api/values/{item['id']}").status_code == 204
    assert client.get("/api/values").json() == [], "deleted values do not come back"
    with person("tom") as tom:
        english = tom.get("/api/values", headers={"Accept-Language": "en-GB,en;q=0.8"}).json()
        assert english[0]["name"] == "Mood"


def test_the_starting_values_are_laid_out_once_when_two_ask_at_once(account: Account) -> None:
    dek = vault.dek_for(account.id)
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        db.expunge(row)
    start = threading.Barrier(2, timeout=10)

    def ask() -> None:
        start.wait()
        with SessionLocal() as db:
            diary.ensure_values(db, row, dek, "de")

    threads = [threading.Thread(target=ask) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert count(ValueDef) == len(diary.STARTING_VALUES["de"])


def test_values_are_added_changed_ordered_switched_and_deleted(client: TestClient, account: Account) -> None:
    start = client.get("/api/values").json()
    own = client.post("/api/values", json={"name": " Kopfschmerzen ", "low": "keine", "high": "heftig"})
    assert own.status_code == 201
    made = own.json()
    assert (made["name"], made["position"], made["active"]) == ("Kopfschmerzen", len(start), True)
    changed = client.put(f"/api/values/{made['id']}", json={"active": False, "hint": "Seit dem Morgen"}).json()
    assert (changed["name"], changed["active"], changed["hint"]) == ("Kopfschmerzen", False, "Seit dem Morgen")
    order = [made["id"], *[item["id"] for item in start]]
    assert [item["id"] for item in client.put("/api/values/order", json={"ids": order}).json()] == order
    for wrong in ([*order, order[0]], order[1:], [*order[1:], "a" * 24]):
        answer = client.put("/api/values/order", json={"ids": wrong})
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "order_mismatch"
    assert client.delete(f"/api/values/{made['id']}").status_code == 204
    assert made["id"] not in [item["id"] for item in client.get("/api/values").json()]
    for body, code in (({"name": "  "}, "value_name_missing"), ({"name": "x" * (diary.VALUE_NAME_MAX + 1)},
                                                                 "value_name_too_long"),
                       ({"name": "ok", "low": "x" * (diary.VALUE_END_MAX + 1)}, "value_end_too_long")):
        answer = client.post("/api/values", json=body)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == code, body


def test_there_are_no_more_values_than_allowed_even_when_added_at_once(account: Account,
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(diary, "VALUE_DEFS_MAX", 6)
    dek = vault.dek_for(account.id)
    with SessionLocal() as db:
        diary.ensure_values(db, account, dek, "en")
    start = threading.Barrier(4, timeout=10)
    refused: list[int] = []

    def add(number: int) -> None:
        start.wait()
        with SessionLocal() as db:
            try:
                diary.create_value(db, account.id, dek, {"name": f"own {number}"})
            except Exception:  # noqa: BLE001 - counted below
                refused.append(number)

    threads = [threading.Thread(target=add, args=(n,)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert count(ValueDef) == 6 and len(refused) == 3


def test_ratings_of_a_day_are_whole_numbers_of_the_own_values(client: TestClient, account: Account) -> None:
    ids = [item["id"] for item in client.get("/api/values").json()]
    rated = client.put("/api/days/2026-10-06/values", json={"values": {ids[0]: 6, ids[2]: 3}})
    assert rated.status_code == 200 and rated.json()["values"] == {ids[0]: 6, ids[2]: 3}
    again = client.put("/api/days/2026-10-06/values", json={"values": {ids[0]: None, ids[1]: 10}}).json()
    assert again["values"] == {ids[2]: 3, ids[1]: 10}
    for wrong in ({ids[0]: 0}, {ids[0]: 11}, {ids[0]: 5.5}, {ids[0]: "5"}, {ids[0]: True}, {"f" * 24: 5}):
        answer = client.put("/api/days/2026-10-06/values", json={"values": wrong})
        assert answer.status_code == 422, wrong
    with person("tom") as tom:
        foreign = tom.put("/api/days/2026-10-06/values", json={"values": {ids[0]: 5}})
        assert foreign.status_code == 422 and foreign.json()["detail"]["code"] == "value_unknown"
    assert client.get("/api/days/2026-10-06").json()["values"] == {ids[2]: 3, ids[1]: 10}


# --- Search ---------------------------------------------------------------------------------------------------------


def test_the_search_finds_titles_texts_tags_and_notes_whatever_the_case(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    client.put("/api/days/2026-10-04", json={"title": "Sonntag am See", "text": "Das Wasser war kalt.",
                                             "tags": ["draußen"]})
    client.put("/api/days/2026-10-05", json={"title": "Zu viel", "text": "Drei Termine. Die Straße war voll.",
                                             "tags": ["arbeit"]})
    note(client, "MÄDCHEN haben kastanien gesammelt")

    def found(query: str) -> list[tuple[str, str]]:
        answer = client.post("/api/search", json={"q": query})
        assert answer.status_code == 200
        return [(hit["date"], hit["kind"]) for hit in answer.json()["results"]]

    assert found("see") == [("2026-10-04", "title")]
    assert found("WASSER") == [("2026-10-04", "text")]
    assert found("strasse") == [("2026-10-05", "text")], "ß finds ss"
    assert found("mädchen") == [("2026-10-06", "note")]
    assert found("mädchen") == [("2026-10-06", "note")], "an umlaut written in two parts finds the one"
    assert found("DRAUSSEN") == [("2026-10-04", "tag")]
    assert found("nichts davon") == []
    hit = client.post("/api/search", json={"q": "termine"}).json()["results"][0]
    assert "Drei Termine" in hit["snippet"]
    for wrong, code in (("   ", "search_empty"), ("x" * (diary.SEARCH_MAX + 1), "search_too_long")):
        answer = client.post("/api/search", json={"q": wrong})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == code


def test_the_search_has_an_end(client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(diary, "SEARCH_RESULTS", 2)
    for text in ("apfel eins", "apfel zwei", "apfel drei"):
        note(client, text)
    answer = client.post("/api/search", json={"q": "apfel"}).json()
    assert len(answer["results"]) == 2 and answer["more"] is True


# --- Rights ---------------------------------------------------------------------------------------------------------


def test_nobody_reads_changes_or_deletes_what_another_person_wrote(client: TestClient, account: Account) -> None:
    """The operator's diary; a member and then the operator against each other, on every route."""
    zone(client, "UTC")
    own_note = note(client, "geheimnis der betreiberin")
    client.put("/api/days/2026-10-06", json={"title": "Mein Tag", "text": "nur meins", "tags": ["privat"]})
    own_value = client.get("/api/values").json()[0]["id"]
    client.put("/api/days/2026-10-06/values", json={"values": {own_value: 7}})
    member = make_account("tom")
    with new_client(member) as tom:
        zone(tom, "UTC")
        assert tom.get("/api/notes", params={"date": "2026-10-06"}).json() == []
        assert tom.put(f"/api/notes/{own_note['id']}", json={"text": "überschrieben"}).status_code == 404
        assert tom.delete(f"/api/notes/{own_note['id']}").status_code == 404
        assert tom.get("/api/days/2026-10-06").status_code == 404
        assert tom.get("/api/days").json() == []
        assert tom.delete("/api/days/2026-10-06").status_code == 404
        assert tom.put(f"/api/values/{own_value}", json={"name": "fremd"}).status_code == 404
        assert tom.delete(f"/api/values/{own_value}").status_code == 404
        assert tom.post("/api/search", json={"q": "geheimnis"}).json()["results"] == []
        today = tom.get("/api/today").json()
        assert today["notes"] == [] and today["day"] is None
        assert own_value not in [item["id"] for item in today["values"]]
        # The same note id from another person is a note of their own, not the operator's.
        theirs = tom.post("/api/notes", json={"id": own_note["id"], "text": "toms notiz"})
        assert theirs.status_code == 201 and theirs.json()["text"] == "toms notiz"
        tom_note = theirs.json()["id"]
        tom.put("/api/days/2026-10-06", json={"title": "Toms Tag"})
    # And the operator does not reach the member's either.
    assert [item["text"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [
        "geheimnis der betreiberin"]
    assert client.get("/api/days/2026-10-06").json()["title"] == "Mein Tag"
    assert client.post("/api/search", json={"q": "toms"}).json()["results"] == []
    assert client.put(f"/api/notes/{tom_note}", json={"text": "x"}).json()["text"] == "x", "that is the own note"
    with new_client(member) as tom:
        assert [item["text"] for item in tom.get("/api/notes", params={"date": "2026-10-06"}).json()] == ["toms notiz"]
    # No account list or operator route shows what was written.
    accounts = client.get("/api/accounts").text
    assert "geheimnis" not in accounts and "Toms Tag" not in accounts


def test_without_a_session_nothing_of_the_diary_answers(account: Account) -> None:
    with new_client() as stranger:
        for method, path in (("GET", "/api/today"), ("GET", "/api/notes?date=2026-10-06"), ("GET", "/api/days"),
                             ("GET", "/api/values"), ("POST", "/api/search"), ("PUT", "/api/days/2026-10-06")):
            answer = stranger.request(method, path, json={})
            assert answer.status_code == 401, (method, path)


def test_a_change_without_the_tab_header_is_refused(client: TestClient, account: Account) -> None:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "x"},
                         headers={"X-Nexdiary-Client": ""})
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "client_required"
    assert count(Note) == 0


def test_deleting_an_account_takes_its_diary_and_its_key(client: TestClient, account: Account) -> None:
    member = make_account("tom")
    with new_client(member) as tom:
        tom.get("/api/values")
        note(tom, "weg damit")
        tom.put("/api/days/2026-10-06", json={"title": "bald weg"})
    with SessionLocal() as db:
        from app.models import UserKey

        assert db.get(UserKey, member.id) is not None
    deleted = client.request("DELETE", f"/api/accounts/{member.id}", json={"current_password": "correct horse battery"})
    assert deleted.status_code == 204
    with SessionLocal() as db:
        from app.models import UserKey

        assert db.get(UserKey, member.id) is None
        for model in (Note, Day, ValueDef):
            assert db.scalar(select(func.count()).select_from(model).where(model.user_id == member.id)) == 0


def test_times_stay_in_the_clear_only_to_the_second(client: TestClient, account: Account,
                                                    fixed_clock: list[datetime]) -> None:
    fixed_clock[0] = datetime(2026, 10, 6, 12, 0, 7, 654321, tzinfo=UTC)
    made = note(client, "mit mikrosekunden")
    assert made["created_at"] == "2026-10-06T12:00:07+00:00"
    client.put(f"/api/notes/{made['id']}", json={"text": "geändert"})
    client.put("/api/days/2026-10-06", json={"title": "Tag"})
    client.post("/api/values", json={"name": "Eigener"})
    import sqlite3

    from app.config import get_settings

    connection = sqlite3.connect(get_settings().database_path)
    try:
        stamps = [value for query in ("SELECT created_at, updated_at FROM notes", "SELECT created_at, updated_at FROM days",
                                      "SELECT created_at, created_at FROM value_defs")
                  for row in connection.execute(query) for value in row]
    finally:
        connection.close()
    assert stamps and all(value.endswith(".000000") for value in stamps), stamps


def test_a_note_deleted_while_it_is_changed_is_not_found(client: TestClient, account: Account,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    """Another tab deletes the note between the look and the change: the change answers 404, not a server error."""
    made = note(client, "gleich weg")
    original = diary._note_row
    calls: list[int] = []

    def look_then_lose(db: Any, account_id: int, uid: str) -> Any:
        found = original(db, account_id, uid)
        calls.append(1)
        if len(calls) == 1:
            with SessionLocal() as other:
                other.query(Note).filter(Note.uid == uid).delete()
                other.commit()
        return found

    monkeypatch.setattr(diary, "_note_row", look_then_lose)
    answer = client.put(f"/api/notes/{made['id']}", json={"text": "zu spät"})
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "not_found"
    assert count(Note) == 0


def _break(model: Any, column: str, where: Any) -> None:
    from sqlalchemy import update

    with SessionLocal() as db:
        db.execute(update(model).where(where).values({column: b"\x01" + b"x" * 40}))
        db.commit()


def test_an_unreadable_entry_is_marked_and_passed_over_and_can_be_deleted(client: TestClient,
                                                                          account: Account) -> None:
    zone(client, "UTC")
    good = note(client, "lesbar apfel")
    broken = note(client, "kaputt apfel")
    client.put("/api/days/2026-10-05", json={"title": "gestern apfel", "text": "ein Tag"})
    client.put("/api/days/2026-10-04", json={"title": "vorgestern apfel", "text": "noch einer"})
    value = client.post("/api/values", json={"name": "Wird kaputt"}).json()
    _break(Note, "text_enc", Note.uid == broken["id"])
    _break(Day, "content_enc", Day.date == "2026-10-04")
    _break(ValueDef, "data_enc", ValueDef.uid == value["id"])
    listed = client.get("/api/notes", params={"date": "2026-10-06"})
    assert listed.status_code == 200
    by_id = {item["id"]: item for item in listed.json()}
    assert by_id[good["id"]]["text"] == "lesbar apfel" and by_id[good["id"]]["unreadable"] is False
    assert by_id[broken["id"]]["unreadable"] is True and by_id[broken["id"]]["text"] == ""
    days = client.get("/api/days").json()
    assert [(item["date"], item["unreadable"]) for item in days] == [("2026-10-05", False), ("2026-10-04", True)]
    assert client.get("/api/days/2026-10-04").json()["unreadable"] is True
    refused = client.put("/api/days/2026-10-04", json={"title": "drüber"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "day_unreadable"
    found = client.post("/api/search", json={"q": "apfel"}).json()["results"]
    assert sorted((hit["date"], hit["kind"]) for hit in found) == [("2026-10-05", "title"), ("2026-10-06", "note")]
    today = client.get("/api/today")
    assert today.status_code == 200
    values = {item["id"]: item for item in client.get("/api/values").json()}
    assert values[value["id"]]["unreadable"] is True and values[value["id"]]["active"] is False
    # Deleting works for each of them.
    assert client.delete(f"/api/notes/{broken['id']}").status_code == 204
    assert client.delete("/api/days/2026-10-04").status_code == 204
    assert client.delete(f"/api/values/{value['id']}").status_code == 204
    assert client.get("/api/days").json()[0]["date"] == "2026-10-05"
    # And the log names the table, never a text.
    from app.services import logs

    text = logs.log_file().read_text(encoding="utf-8")
    assert "A sealed value did not open table=notes" in text and "apfel" not in text


def test_a_search_runs_once_at_a_time_per_person_and_has_a_rate(client: TestClient, account: Account,
                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(diary, "SEARCHES_PER_MINUTE", 3)
    note(client, "birne")
    for _ in range(3):
        assert client.post("/api/search", json={"q": "birne"}).status_code == 200
    stopped = client.post("/api/search", json={"q": "birne"})
    assert stopped.status_code == 429 and stopped.json()["detail"]["code"] == "search_slow_down"
    with person("tom") as tom:
        assert tom.post("/api/search", json={"q": "birne"}).status_code == 200, "the brake is per person"
    diary.forget_searches()
    started = threading.Event()
    release = threading.Event()
    original = diary.search

    def slow(*args: Any) -> dict[str, Any]:
        started.set()
        assert release.wait(10)
        return original(*args)

    monkeypatch.setattr(diary, "search", slow)
    answers: list[int] = []
    first = threading.Thread(target=lambda: answers.append(client.post("/api/search", json={"q": "birne"}).status_code))
    first.start()
    assert started.wait(10)
    with new_client(account) as second_tab:
        busy = second_tab.post("/api/search", json={"q": "birne"})
    release.set()
    first.join()
    assert busy.status_code == 429 and busy.json()["detail"]["code"] == "search_busy"
    assert answers == [200]
