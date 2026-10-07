"""Notes after midnight, moving a note to the next or the day before, and the days with notes and no page.

The hours from 0:00 to 3:59 in the person's own time zone are "the night": the person says whether their notes belong
to the day before or to the day that began, and the answer holds for every device until 4:00. The clock is set by the
tests, never read from the wall."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import SessionLocal
from app.models import Account, Note, Photo
from app.services import diary, vault

from .conftest import new_client, person
from .test_photos import picture

BERLIN = "Europe/Berlin"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    """Wednesday 7 October 2026, 02:30 in Berlin (CEST, UTC+2) unless a test moves it."""
    moment = [datetime(2026, 10, 7, 0, 30, tzinfo=UTC)]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    yield moment


def zone(client: TestClient, name: str = BERLIN) -> None:
    assert client.put("/api/me/preferences", json={"timezone": name}).status_code == 200


def note(client: TestClient, text: str, **extra: Any) -> dict[str, Any]:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, **extra})
    assert answer.status_code == 201, answer.text
    return answer.json()


def night(client: TestClient) -> dict[str, Any]:
    return client.get("/api/today").json()["night"]


def code(answer: Any) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]


# --- The window -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("utc", "active"),
    [
        (datetime(2026, 10, 5, 21, 59, tzinfo=UTC), False),  # 23:59 on the 5th
        (datetime(2026, 10, 5, 22, 0, tzinfo=UTC), True),  # 00:00 on the 6th
        (datetime(2026, 10, 6, 1, 59, tzinfo=UTC), True),  # 03:59
        (datetime(2026, 10, 6, 2, 0, tzinfo=UTC), False),  # 04:00
        # The night the clocks go forward (29 March 2026, 02:00 becomes 03:00): there is no 02:xx, 03:59 is the end.
        (datetime(2026, 3, 29, 0, 59, tzinfo=UTC), True),  # 01:59 CET
        (datetime(2026, 3, 29, 1, 0, tzinfo=UTC), True),  # 03:00 CEST
        (datetime(2026, 3, 29, 1, 59, tzinfo=UTC), True),  # 03:59 CEST
        (datetime(2026, 3, 29, 2, 0, tzinfo=UTC), False),  # 04:00 CEST
        # The night they go back (25 October 2026, 03:00 becomes 02:00): 02:30 happens twice.
        (datetime(2026, 10, 25, 0, 30, tzinfo=UTC), True),  # 02:30 CEST
        (datetime(2026, 10, 25, 1, 30, tzinfo=UTC), True),  # 02:30 CET
        (datetime(2026, 10, 25, 2, 59, tzinfo=UTC), True),  # 03:59 CET
        (datetime(2026, 10, 25, 3, 0, tzinfo=UTC), False),  # 04:00 CET
    ],
)
def test_the_night_is_from_midnight_to_four_in_the_persons_own_zone(
    client: TestClient, account: Account, fixed_clock: list[datetime], utc: datetime, active: bool
) -> None:
    zone(client)
    fixed_clock[0] = utc
    assert night(client)["active"] is active


def test_the_night_is_the_zone_of_the_person_not_of_the_server(client: TestClient, account: Account,
                                                               fixed_clock: list[datetime]) -> None:
    fixed_clock[0] = datetime(2026, 10, 7, 0, 30, tzinfo=UTC)
    zone(client, BERLIN)
    assert night(client) == {"active": True, "today": "2026-10-07", "yesterday": "2026-10-06", "choice": None}
    zone(client, "America/New_York")  # 20:30 on the 6th
    assert night(client) == {"active": False}
    zone(client, "Asia/Tokyo")  # 09:30
    assert night(client) == {"active": False}
    zone(client, "Pacific/Auckland")  # 13:30
    assert night(client) == {"active": False}
    zone(client, "Europe/London")  # 01:30 BST
    assert night(client)["active"] is True


# --- The answer -------------------------------------------------------------------------------------------------------


def test_before_an_answer_a_note_goes_to_the_day_that_began_and_the_page_asks(client: TestClient, account: Account) -> None:
    zone(client)
    assert night(client)["choice"] is None
    kept = note(client, "kam spät heim")
    assert kept["date"] == "2026-10-07"
    assert client.get("/api/today").json()["date"] == "2026-10-07"


def test_the_answer_decides_where_the_notes_of_the_night_go_on_every_device(client: TestClient, account: Account) -> None:
    zone(client)
    answered = client.put("/api/night", json={"choice": "yesterday"})
    assert answered.status_code == 200
    assert answered.json() == {"active": True, "today": "2026-10-07", "yesterday": "2026-10-06", "choice": "yesterday"}
    # Another browser of the same person, never asked: the same day, and the page it shows is that day.
    with new_client(account) as phone:
        today = phone.get("/api/today").json()
        assert today["date"] == "2026-10-06" and today["night"]["choice"] == "yesterday"
        first = note(phone, "noch vom abend")
        second = note(client, "und noch eins")
        assert first["date"] == second["date"] == "2026-10-06"
        # The photo of a note without a day follows the same answer.
        shot = phone.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true"}, content=picture())
        assert shot.status_code == 201 and shot.json()["date"] == "2026-10-06"
    assert [item["id"] for item in client.get("/api/today").json()["notes"]] == [first["id"], second["id"]]
    # A person may change their mind: the notes already kept stay where they are.
    assert client.put("/api/night", json={"choice": "today"}).json()["choice"] == "today"
    third = note(client, "doch heute")
    assert third["date"] == "2026-10-07"
    assert client.get("/api/today").json()["date"] == "2026-10-07"
    assert [item["id"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [first["id"], second["id"]]


def test_the_answer_ends_at_four_and_does_not_carry_over_to_the_next_night(client: TestClient, account: Account,
                                                                           fixed_clock: list[datetime]) -> None:
    zone(client)
    client.put("/api/night", json={"choice": "yesterday"})
    fixed_clock[0] = datetime(2026, 10, 7, 2, 0, tzinfo=UTC)  # 04:00 in Berlin
    assert night(client) == {"active": False}
    assert note(client, "morgens")["date"] == "2026-10-07"
    assert client.get("/api/today").json()["date"] == "2026-10-07"
    fixed_clock[0] = datetime(2026, 10, 7, 22, 30, tzinfo=UTC)  # the next night, 00:30 on the 8th
    assert night(client)["choice"] is None
    assert note(client, "wieder spät")["date"] == "2026-10-08"
    # An answer "today" of the night before is not an answer of this one, though its day is this night's "yesterday".
    fixed_clock[0] = datetime(2026, 10, 7, 22, 30, tzinfo=UTC)
    client.put("/api/night", json={"choice": "today"})
    assert night(client)["choice"] == "today"
    fixed_clock[0] = datetime(2026, 10, 8, 22, 30, tzinfo=UTC)
    assert night(client) == {"active": True, "today": "2026-10-09", "yesterday": "2026-10-08", "choice": None}
    assert note(client, "wieder eine nacht")["date"] == "2026-10-09"
    # The hour that happens twice when the clocks go back keeps its answer.
    fixed_clock[0] = datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    client.put("/api/night", json={"choice": "yesterday"})
    fixed_clock[0] = datetime(2026, 10, 25, 1, 30, tzinfo=UTC)
    assert night(client)["choice"] == "yesterday" and note(client, "zweite 2:30")["date"] == "2026-10-24"


def test_a_photo_picked_before_the_answer_follows_its_note_to_the_day_of_the_answer(client: TestClient,
                                                                                    account: Account) -> None:
    zone(client)
    # Picked while nobody was asked: it was kept for the day that began.
    shot = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true"}, content=picture()).json()
    assert shot["date"] == "2026-10-07"
    client.put("/api/night", json={"choice": "yesterday"})
    kept = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "mit foto", "photo_id": shot["id"]}).json()
    assert kept["date"] == "2026-10-06"
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == shot["id"])) == "2026-10-06"
    assert [item["id"] for item in client.get("/api/photos", params={"date": "2026-10-06"}).json()] == [shot["id"]]
    assert client.get("/api/photos", params={"date": "2026-10-07"}).json() == []


def test_a_photo_does_not_follow_a_note_out_of_a_locked_day_or_away_from_another_note(client: TestClient,
                                                                                      account: Account) -> None:
    zone(client)
    # The photo belongs to a note of a locked day: it stays, however the other note is made.
    old = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true", "date": "2026-10-04"},
                      content=picture()).json()
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "alt", "date": "2026-10-04", "photo_id": old["id"]})
    assert client.put("/api/days/2026-10-04", json={"title": "Zu", "text": "Ein Tag."}).status_code == 200
    assert client.post("/api/days/2026-10-04/lock").status_code == 200
    again = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "ein anderer tag", "date": "2026-10-05",
                                            "photo_id": old["id"]})
    assert again.status_code == 201
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == old["id"])) == "2026-10-04"
    # Held by another note of its day too: it stays.
    both = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true", "date": "2026-10-02"},
                       content=picture()).json()
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "eins", "date": "2026-10-02", "photo_id": both["id"]})
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "zwei", "date": "2026-10-03", "photo_id": both["id"]})
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == both["id"])) == "2026-10-02"


def test_nobody_is_asked_by_day(client: TestClient, account: Account, fixed_clock: list[datetime]) -> None:
    zone(client)
    fixed_clock[0] = datetime(2026, 10, 7, 10, 0, tzinfo=UTC)
    assert code(client.put("/api/night", json={"choice": "yesterday"})) == (409, "not_night")
    assert night(client) == {"active": False}
    assert note(client, "mittags")["date"] == "2026-10-07"


def test_only_two_answers_exist_and_the_browser_names_no_date(client: TestClient, account: Account) -> None:
    zone(client)
    for body in ({"choice": "tomorrow"}, {"choice": "2026-10-01"}, {"choice": "yesterday", "date": "2026-09-01"}, {}):
        assert client.put("/api/night", json=body).status_code == 422, body
    assert night(client)["choice"] is None


def test_the_answer_of_one_person_is_not_the_answer_of_another(client: TestClient, account: Account) -> None:
    zone(client)
    client.put("/api/night", json={"choice": "yesterday"})
    with person("rita") as rita:
        zone(rita)
        assert night(rita)["choice"] is None
        assert note(rita, "ihre nacht")["date"] == "2026-10-07"


def test_a_date_the_browser_names_still_wins(client: TestClient, account: Account) -> None:
    zone(client)
    client.put("/api/night", json={"choice": "yesterday"})
    assert note(client, "gezielt", date="2026-10-03")["date"] == "2026-10-03"


def test_the_question_of_the_night_is_the_question_of_the_day_it_is_answered_for(client: TestClient,
                                                                                 account: Account) -> None:
    zone(client)
    question = client.get("/api/today").json()["question"]
    client.put("/api/night", json={"choice": "yesterday"})
    asked = client.get("/api/today").json()
    assert asked["date"] == "2026-10-06"
    if question is not None:
        kept = note(client, "meine antwort", prompt=asked["question"]["text"], prompt_id=asked["question"]["id"])
        assert kept["date"] == "2026-10-06"


def test_another_question_in_the_night_is_for_the_day_the_notes_go_to(client: TestClient, account: Account) -> None:
    zone(client)
    client.put("/api/night", json={"choice": "yesterday"})
    first = client.get("/api/today").json()
    assert first["date"] == "2026-10-06" and first["question"] is not None
    other = client.post("/api/prompts/another").json()["question"]
    assert other is not None and other["id"] != first["question"]["id"]
    # The page loaded again shows the question just asked for, not one kept for another day.
    assert client.get("/api/today").json()["question"] == other


# --- Moving a note -----------------------------------------------------------------------------------------------------


def move(client: TestClient, uid: str, direction: str) -> Any:
    return client.post(f"/api/notes/{uid}/move", json={"direction": direction})


def stored(uid: str) -> Any:
    with SessionLocal() as db:
        return db.execute(select(Note).where(Note.uid == uid)).scalar_one()


def test_a_note_moves_to_the_day_before_and_the_day_after_and_is_sealed_anew(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    kept = note(client, "bei mia", date="2026-10-05", prompt="Was war schön?", prompt_id="schoen.0")
    assert move(client, kept["id"], "next").json()["date"] == "2026-10-06"
    moved = move(client, kept["id"], "previous").json()
    assert moved["date"] == "2026-10-05" and moved["text"] == "bei mia" and moved["prompt"] == "Was war schön?"
    assert moved["prompt_id"] == "schoen.0" and moved["updated_at"] is not None
    answer = move(client, kept["id"], "next")
    assert answer.status_code == 200
    dek = vault.dek_for(account.id)
    row = stored(kept["id"])
    assert row.date == "2026-10-06"
    # Sealed for its new day: the old day's binding no longer opens it, the new one does.
    for column, value in (("text", "bei mia"), ("prompt", "Was war schön?"), ("prompt_ref", "schoen.0")):
        blob = {"text": row.text_enc, "prompt": row.prompt_enc, "prompt_ref": row.prompt_ref_enc}[column]
        assert vault.open_text(dek, blob, diary._note_aad(account.id, kept["id"], "2026-10-06", column)) == value
        with pytest.raises(vault.SealError):
            vault.open_text(dek, blob, diary._note_aad(account.id, kept["id"], "2026-10-05", column))
    assert [item["id"] for item in client.get("/api/notes", params={"date": "2026-10-06"}).json()] == [kept["id"]]
    assert client.get("/api/notes", params={"date": "2026-10-05"}).json() == []


def test_a_note_does_not_move_into_the_future_or_out_of_a_note_that_is_not_there(client: TestClient,
                                                                               account: Account) -> None:
    zone(client, "UTC")
    kept = note(client, "heute", date="2026-10-07")
    assert code(move(client, kept["id"], "next")) == (422, "date_in_future")
    assert stored(kept["id"]).date == "2026-10-07"
    assert code(move(client, str(uuid.uuid4()), "next")) == (404, "not_found")
    assert code(move(client, "nonsense", "next")) == (404, "not_found")
    assert client.post(f"/api/notes/{kept['id']}/move", json={"direction": "sideways"}).status_code == 422
    assert client.post(f"/api/notes/{kept['id']}/move", json={"direction": "next", "to": "2026-01-01"}).status_code == 422


def test_a_note_of_another_person_is_not_found_and_stays(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    mine = note(client, "meins", date="2026-10-05")
    with person("rita") as rita:
        assert code(move(rita, mine["id"], "next")) == (404, "not_found")
    assert stored(mine["id"]).date == "2026-10-05"


def test_a_locked_day_neither_gives_nor_takes_a_note(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    inside = note(client, "im verschlossenen", date="2026-10-04")
    outside = note(client, "daneben", date="2026-10-05")
    assert client.put("/api/days/2026-10-04", json={"title": "Vierter", "text": "Ein Tag."}).status_code == 200
    assert client.post("/api/days/2026-10-04/lock").status_code == 200
    # Out of the locked day, and into it.
    assert code(move(client, inside["id"], "next")) == (409, "day_locked")
    assert code(move(client, outside["id"], "previous")) == (409, "day_locked")
    assert stored(inside["id"]).date == "2026-10-04" and stored(outside["id"]).date == "2026-10-05"
    # The days around are free.
    assert move(client, outside["id"], "next").status_code == 200


def test_the_photo_of_a_note_goes_along_unless_something_else_holds_it(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    shot = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true", "date": "2026-10-05"},
                       content=picture()).json()
    kept = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "", "date": "2026-10-05",
                                           "photo_id": shot["id"]}).json()
    second = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "gleiches foto", "date": "2026-10-05",
                                             "photo_id": shot["id"]}).json()
    # Another note of the old day holds it too: it stays, the moved note still shows it.
    assert move(client, kept["id"], "next").json()["photo_id"] == shot["id"]
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == shot["id"])) == "2026-10-05"
    # The last note of the old day that holds it moves: now it goes along, and both notes are on its day.
    assert move(client, second["id"], "next").status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == shot["id"])) == "2026-10-06"
    lone = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true", "date": "2026-10-03"},
                       content=picture()).json()
    solo = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "allein", "date": "2026-10-03",
                                           "photo_id": lone["id"]}).json()
    assert move(client, solo["id"], "next").json()["photo_id"] == lone["id"]
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == lone["id"])) == "2026-10-04"
    assert [item["id"] for item in client.get("/api/photos", params={"date": "2026-10-04"}).json()] == [lone["id"]]


def test_a_full_day_takes_no_more_notes_by_moving(client: TestClient, account: Account,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    zone(client, "UTC")
    monkeypatch.setattr(diary, "NOTES_PER_DAY", 2)
    note(client, "a", date="2026-10-05")
    note(client, "b", date="2026-10-05")
    over = note(client, "c", date="2026-10-04")
    assert code(move(client, over["id"], "next")) == (409, "too_many_notes")
    assert stored(over["id"]).date == "2026-10-04"


# --- Catching up --------------------------------------------------------------------------------------------------------


def test_days_with_notes_and_no_page_are_listed_newest_first_for_the_last_sixty_days(client: TestClient,
                                                                                    account: Account) -> None:
    zone(client, "UTC")
    note(client, "Kastanien gesammelt und dann noch lange gequatscht", date="2026-10-05")
    note(client, "zweite notiz", date="2026-10-05")
    note(client, "alt", date="2026-08-09")  # 59 days before the 7th: still in
    note(client, "zu alt", date="2026-08-07")  # 61 days: out
    note(client, "heute noch offen")  # the day being kept is not among them
    listed = client.get("/api/catch-up").json()
    assert listed == {"count": 2, "days": [
        {"date": "2026-10-05", "notes": 2, "start": "Kastanien gesammelt und dann noch lange gequatscht"},
        {"date": "2026-08-09", "notes": 1, "start": "alt"},
    ]}
    assert client.get("/api/today").json()["catch_up"] == listed


def test_a_day_with_a_page_is_not_in_the_list_but_one_with_only_values_or_tags_is(client: TestClient,
                                                                                 account: Account) -> None:
    zone(client, "UTC")
    for day in ("2026-10-04", "2026-10-05", "2026-10-06"):
        note(client, f"notiz vom {day}", date=day)
    assert client.put("/api/days/2026-10-04", json={"title": "Seite", "text": "Ein Text."}).status_code == 200
    assert client.put("/api/days/2026-10-05", json={"tags": ["herbst"]}).status_code == 200
    assert [item["date"] for item in client.get("/api/catch-up").json()["days"]] == ["2026-10-06", "2026-10-05"]
    # A title alone is a page.
    assert client.put("/api/days/2026-10-05", json={"title": "Nur ein Titel"}).status_code == 200
    assert [item["date"] for item in client.get("/api/catch-up").json()["days"]] == ["2026-10-06"]


def test_only_the_own_days_are_listed(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    note(client, "meine", date="2026-10-05")
    with person("rita") as rita:
        zone(rita, "UTC")
        assert rita.get("/api/catch-up").json() == {"count": 0, "days": []}
        note(rita, "ihre", date="2026-10-04")
        assert [item["date"] for item in rita.get("/api/catch-up").json()["days"]] == ["2026-10-04"]
    assert [item["date"] for item in client.get("/api/catch-up").json()["days"]] == ["2026-10-05"]
    assert new_client().get("/api/catch-up").status_code == 401


def test_the_list_counts_up_to_the_day_being_kept_in_the_night(client: TestClient, account: Account) -> None:
    zone(client)
    note(client, "von gestern", date="2026-10-06")
    assert [item["date"] for item in client.get("/api/catch-up").json()["days"]] == ["2026-10-06"]
    # In the night, answered "yesterday": that day is the one being kept, not one to catch up on.
    client.put("/api/night", json={"choice": "yesterday"})
    assert client.get("/api/catch-up").json()["days"] == []
    assert client.get("/api/today").json()["catch_up"]["count"] == 0


def test_a_photo_only_note_makes_a_day_with_no_start(client: TestClient, account: Account) -> None:
    zone(client, "UTC")
    shot = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "note": "true", "date": "2026-10-05"},
                       content=picture()).json()
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "", "date": "2026-10-05", "photo_id": shot["id"]})
    assert client.get("/api/catch-up").json()["days"] == [{"date": "2026-10-05", "notes": 1, "start": ""}]

