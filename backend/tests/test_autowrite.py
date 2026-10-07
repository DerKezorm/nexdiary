"""Writing up the day before on its own, in the morning: three bolts (the operator's, the account's, the person's own,
the last one also confirmed), a try once a day whatever comes of it, one request to the model however many planners run,
and a draft that waits: no page, no streak, no statistics, nothing to share, nothing in the journal, until the person
takes it. Always against the stand-in for the model (``test_ai.Model``) and the stand-in of a push service; the clock is
set by the test, never read from the wall."""

# ruff: noqa: F811 - the fixtures are imported from another test module and used by name

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import SessionLocal
from app.models import Account, AutoMark, Day, Draft
from app.services import autowrite, diary, vault

from .conftest import make_account, new_client
from .fake_push import FakePushService
from .test_ai import Model, made_key, model, set_up  # noqa: F401 - the fixture `model` is used by name

DAY = "2026-10-06"
#: 07:00 in Berlin on 2026-10-07 (summer time, UTC+2).
MORNING = datetime(2026, 10, 7, 5, 0, tzinfo=UTC)
Setter = Callable[[datetime], None]


@pytest.fixture
def at(monkeypatch: pytest.MonkeyPatch) -> Setter:
    moment = [MORNING]
    monkeypatch.setattr(clock, "now", lambda: moment[0])

    def set_to(when: datetime) -> None:
        moment[0] = when

    return set_to


def note(client: TestClient, text: str = "mit mia kastanien gesammelt", day: str = DAY) -> None:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, "date": day})
    assert answer.status_code == 201, answer.text


def code(answer: httpx.Response) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]


def switch_on(client: TestClient, **extra: Any) -> httpx.Response:
    return client.put("/api/me/autowrite", json={"on": True, "confirmed": True, **extra})


@pytest.fixture
def ready(client: TestClient, account: Account, model: Model, at: Setter) -> Model:
    """The operator's service and second bolt open, the person in Berlin with a note on the day before and the morning
    writing switched on."""
    set_up(client)
    assert client.put("/api/settings/ai", json={"auto_allowed": True}).status_code == 200
    assert client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
    note(client)
    assert switch_on(client).status_code == 200
    return model


def drafts() -> list[Draft]:
    with SessionLocal() as db:
        return list(db.scalars(select(Draft)))


# --- The bolts ---------------------------------------------------------------------------------------------------------


def test_it_is_off_from_the_start_and_needs_every_bolt(client: TestClient, account: Account, model: Model) -> None:
    assert client.get("/api/auth/me").json()["profile"]["autowrite"] == {"on": False, "time": "07:00", "length": "long"}
    assert client.get("/api/ai").json()["auto_allowed"] is False
    # No service, nothing: the same words as the button.
    assert code(switch_on(client))[1] == "ai_off"
    set_up(client)
    # The operator's second bolt.
    assert code(switch_on(client)) == (403, "ai_auto_off")
    assert client.put("/api/settings/ai", json={"auto_allowed": True}).status_code == 200
    # The person has to confirm where the notes go.
    unconfirmed = client.put("/api/me/autowrite", json={"on": True})
    assert code(unconfirmed) == (422, "autowrite_unconfirmed")
    assert client.put("/api/me/autowrite", json={"on": True, "confirmed": False}).status_code == 422
    # The person's own AI switch.
    assert client.put("/api/me/preferences", json={"ai": False}).status_code == 200
    assert code(switch_on(client)) == (403, "ai_switched_off")
    assert client.put("/api/me/preferences", json={"ai": True}).status_code == 200
    answer = switch_on(client)
    assert answer.status_code == 200 and answer.json() == {"on": True, "time": "07:00", "length": "long"}
    assert client.get("/api/auth/me").json()["profile"]["autowrite"]["on"] is True
    assert model.requests == [], "nothing went out for any of this"


def test_the_account_can_be_denied_the_ai_and_so_the_morning_writing(client: TestClient, account: Account,
                                                                     model: Model) -> None:
    set_up(client)
    client.put("/api/settings/ai", json={"auto_allowed": True})
    with new_client(make_account("ben")) as ben:
        ben_id = next(row["id"] for row in client.get("/api/accounts").json() if row["name"] == "ben")
        assert client.put(f"/api/accounts/{ben_id}/permissions", json={"ai_allowed": False}).status_code == 200
        assert code(switch_on(ben)) == (403, "ai_not_allowed")


def test_the_choices_are_checked(client: TestClient, account: Account, model: Model) -> None:
    set_up(client)
    client.put("/api/settings/ai", json={"auto_allowed": True})
    for bad in ({"time": "03:59"}, {"time": "12:00"}, {"time": "7:00"}, {"time": "07:60"}, {"length": "medium"},
                {"on": "yes"}, {"colour": "red"}, {"time": None}):
        assert code(client.put("/api/me/autowrite", json=bad)) == (422, "bad_autowrite"), bad
    good = client.put("/api/me/autowrite", json={"time": "04:00", "length": "short"})
    assert good.status_code == 200 and good.json() == {"on": False, "time": "04:00", "length": "short"}
    assert client.put("/api/me/autowrite", json={"time": "11:59"}).status_code == 200
    # Not by the way of the other preferences.
    assert client.put("/api/me/preferences", json={"autowrite": {"on": True}}).status_code == 422


# --- The planner --------------------------------------------------------------------------------------------------------


def test_the_morning_makes_one_draft_and_nothing_goes_out_before(ready: Model, client: TestClient, at: Setter) -> None:
    at(MORNING - timedelta(seconds=1))
    assert autowrite.run_once() == 0
    at(MORNING)
    assert autowrite.run_once() == 1
    assert len(ready.requests) == 1
    # The same material and rules as the button: the notes of that one day, as data.
    sent = ready.body()["messages"][1]["content"]
    assert "kastanien" in sent and DAY not in sent
    # The rest of the morning and the days after change nothing: the day was tried.
    for minute in range(1, 240):
        at(MORNING + timedelta(minutes=minute))
        assert autowrite.run_once() == 0
    assert len(ready.requests) == 1
    [draft] = drafts()
    assert (draft.date, draft.auto, draft.base_revision) == (DAY, True, -1)
    found = client.get(f"/api/days/{DAY}/draft").json()
    assert found["auto"] is True and found["written_by"] == "ai" and found["ai_length"] == "long"
    assert found["title"] == "Kastanien und Kopfweh" and found["text"].startswith("Die Nacht war kurz.")


def test_a_draft_is_no_page(ready: Model, client: TestClient, at: Setter) -> None:
    assert autowrite.run_once() == 1
    assert client.get(f"/api/days/{DAY}").status_code == 404
    assert client.post("/api/journal", json={}).json()["days"] == []
    assert client.get("/api/catch-up").json() == {"count": 1, "auto": 1, "days": [
        {"date": DAY, "notes": 1, "start": "mit mia kastanien gesammelt", "auto": True}]}
    today = client.get("/api/today").json()
    assert today["streak"] == 0 and today["catch_up"]["auto"] == 1
    with new_client(make_account("ben")) as ben:
        ben_id = next(row["id"] for row in client.get("/api/accounts").json() if row["name"] == "ben")
        # Nothing to share: there is no page.
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_id]}).status_code in (404, 409)
        assert ben.get("/api/shared").json() == []
    stats = client.get("/api/stats").json()
    assert stats["pages"] == 0 and stats["tiles"]["days_total"] == 0 and stats["tiles"]["words"] == 0
    with SessionLocal() as db:
        assert db.scalar(select(Day.id)) is None


def test_taking_the_draft_makes_the_page_written_with_the_ai(ready: Model, client: TestClient, at: Setter) -> None:
    autowrite.run_once()
    draft = client.get(f"/api/days/{DAY}/draft").json()
    saved = client.put(f"/api/days/{DAY}", json={"title": draft["title"], "text": draft["text"], "written_by": "ai",
                                                 "base_revision": draft["base_revision"]})
    assert saved.status_code == 200 and saved.json()["written_by"] == "ai"
    assert client.get(f"/api/days/{DAY}/draft").json() is None, "saving ends the draft"
    assert [item["date"] for item in client.post("/api/journal", json={}).json()["days"]] == [DAY]
    assert client.get("/api/catch-up").json()["count"] == 0
    assert client.get("/api/stats").status_code == 200


def test_throwing_it_away_is_final_for_that_day(ready: Model, client: TestClient, at: Setter) -> None:
    autowrite.run_once()
    assert client.delete(f"/api/days/{DAY}/draft").status_code == 204
    assert drafts() == []
    for minute in range(0, 240, 7):
        at(MORNING + timedelta(minutes=minute))
        assert autowrite.run_once() == 0
    assert len(ready.requests) == 1
    # The next morning it is the next day's turn.
    note(client, "noch eine notiz", "2026-10-07")
    at(MORNING + timedelta(days=1))
    assert autowrite.run_once() == 1
    assert [draft.date for draft in drafts()] == ["2026-10-07"]


def test_editing_the_draft_makes_it_the_persons_own(ready: Model, client: TestClient, at: Setter) -> None:
    autowrite.run_once()
    draft = client.get(f"/api/days/{DAY}/draft").json()
    saved = client.put(f"/api/days/{DAY}/draft", json={"title": draft["title"], "text": draft["text"] + " Mehr.",
                                                       "tags": [], "written_by": "ai", "ai_length": "long",
                                                       "base_revision": draft["base_revision"]})
    assert saved.status_code == 200 and saved.json()["auto"] is False
    assert client.get(f"/api/days/{DAY}/draft").json()["auto"] is False
    assert client.get("/api/catch-up").json()["auto"] == 0
    assert client.get("/api/catch-up").json()["count"] == 1, "still a day without a page"


def test_nothing_without_every_bolt(ready: Model, client: TestClient, at: Setter) -> None:
    # The operator's second bolt closed again: the person's choice stays, the planner does nothing.
    assert client.put("/api/settings/ai", json={"auto_allowed": False}).status_code == 200
    assert autowrite.run_once() == 0
    assert client.put("/api/settings/ai", json={"auto_allowed": True}).status_code == 200
    # The person's own AI switch off.
    assert client.put("/api/me/preferences", json={"ai": False}).status_code == 200
    assert autowrite.run_once() == 0
    assert client.put("/api/me/preferences", json={"ai": True}).status_code == 200
    # The operator took the AI from the account.
    with SessionLocal() as db:
        row = db.get(Account, db.scalar(select(Account.id).where(Account.name == "tester")))
        row.ai_allowed = False
        db.commit()
    assert autowrite.run_once() == 0
    # A service that is not complete any more.
    with SessionLocal() as db:
        row = db.get(Account, db.scalar(select(Account.id).where(Account.name == "tester")))
        row.ai_allowed = True
        db.commit()
    assert client.put("/api/settings/ai", json={"model": ""}).status_code == 200
    assert autowrite.run_once() == 0
    assert ready.requests == []
    with SessionLocal() as db:
        assert db.scalar(select(AutoMark.tried_for)) is None, "no try was marked while a bolt was shut"


def test_the_switch_of_the_person_off_means_nothing(ready: Model, client: TestClient, at: Setter) -> None:
    assert client.put("/api/me/autowrite", json={"on": False}).status_code == 200
    assert autowrite.run_once() == 0
    assert ready.requests == []


@pytest.mark.parametrize("prepare", ["page", "draft", "locked", "no notes", "empty notes"])
def test_a_day_that_has_a_page_a_draft_or_no_notes_is_left_alone(ready: Model, client: TestClient, at: Setter,
                                                                 prepare: str) -> None:
    if prepare == "page":
        assert client.put(f"/api/days/{DAY}", json={"title": "Schon da", "text": "Ein Text."}).status_code == 200
    elif prepare == "draft":
        assert client.put(f"/api/days/{DAY}/draft", json={"text": "Angefangen", "base_revision": -1}).status_code == 200
    elif prepare == "locked":
        client.put(f"/api/days/{DAY}", json={"title": "Zu", "text": "Zu."})
        assert client.post(f"/api/days/{DAY}/lock").status_code == 200
    elif prepare == "no notes":
        for found in client.get(f"/api/notes?date={DAY}").json():
            assert client.delete(f"/api/notes/{found['id']}").status_code == 204
    elif prepare == "empty notes":
        with SessionLocal() as db:
            # A day whose only notes cannot be opened has nothing to write from.
            from app.models import Note

            for row in db.scalars(select(Note)):
                row.text_enc = b"damaged"
            db.commit()
    before = len(drafts())
    assert autowrite.run_once() == 0
    assert len(ready.requests) == 0 and len(drafts()) == before


def test_a_page_saved_in_between_is_never_met_by_a_draft(ready: Model, client: TestClient, at: Setter) -> None:
    """The draft is made only onto the revision that was read: a page saved meanwhile (another tab) wins."""
    with SessionLocal() as db:
        dek = vault.dek_for(db.scalar(select(Account.id).where(Account.name == "tester")))
        account_id = db.scalar(select(Account.id).where(Account.name == "tester"))
    draft = {"title": "t", "text": "x", "tags": [], "cover": None, "written_by": "ai", "ai_length": "long"}
    with SessionLocal() as db:
        assert diary.save_auto_draft(db, account_id, dek, DAY, draft, 0) is False, "no page, but a page was read"
        assert diary.save_auto_draft(db, account_id, dek, DAY, draft, -1) is True
        assert diary.save_auto_draft(db, account_id, dek, DAY, draft, -1) is False, "one draft only"
    other = "2026-10-05"
    client.put(f"/api/days/{other}", json={"title": "da", "text": "da."})
    with SessionLocal() as db:
        assert diary.save_auto_draft(db, account_id, dek, other, draft, -1) is False, "the page appeared meanwhile"
        assert diary.save_auto_draft(db, account_id, dek, other, draft, 0) is True
        assert diary.save_auto_draft(db, account_id, dek, "2026-10-04", draft, -1) is True
    client.put("/api/days/2026-10-03", json={"title": "da", "text": "da."})
    assert client.post("/api/days/2026-10-03/lock").status_code == 200
    with SessionLocal() as db:
        assert diary.save_auto_draft(db, account_id, dek, "2026-10-03", draft, 0) is False, "a locked day"


def test_two_planners_at_once_ask_the_model_once(ready: Model, client: TestClient, at: Setter) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        time.sleep(0.2)
        return ready.write(request)

    ready.answer = slow
    results: list[int] = []
    gate = threading.Barrier(4)

    def run() -> None:
        gate.wait()
        results.append(autowrite.run_once())

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [0, 0, 0, 1]
    assert len([request for request in ready.requests if request.url.path.endswith("completions")]) == 1
    assert len(drafts()) == 1


def test_a_failure_is_not_tried_again_and_says_no_word_of_the_notes(ready: Model, client: TestClient, at: Setter,
                                                                    caplog: pytest.LogCaptureFixture) -> None:
    ready.answer = lambda request: httpx.Response(500, json={"error": "kaputt kastanien"})
    with caplog.at_level("DEBUG"):
        assert autowrite.run_once() == 0
        for minute in range(1, 120):
            at(MORNING + timedelta(minutes=minute))
            assert autowrite.run_once() == 0
    assert len(ready.requests) == 1
    assert drafts() == []
    assert "kastanien" not in caplog.text and "Kopfweh" not in caplog.text
    assert any("Automatic writing did not work" in record.getMessage() for record in caplog.records)
    # The next morning it tries the next day, not the failed one again.
    ready.answer = ready.write
    note(client, "neuer tag", "2026-10-07")
    at(MORNING + timedelta(days=1))
    assert autowrite.run_once() == 1
    assert [draft.date for draft in drafts()] == ["2026-10-07"]


def test_the_catch_up_after_the_time_is_a_few_hours_long(ready: Model, client: TestClient, at: Setter) -> None:
    at(MORNING + autowrite.CATCH_UP)
    assert autowrite.run_once() == 0, "a server that was down all morning leaves the day alone"
    at(MORNING + autowrite.CATCH_UP - timedelta(minutes=1))
    assert autowrite.run_once() == 1


def test_the_time_is_the_persons_own_wall_clock_also_when_the_clocks_change(
    ready: Model, client: TestClient, at: Setter
) -> None:
    # Berlin turns its clocks back on 2026-10-25: 07:00 there is 06:00 UTC afterwards.
    at(datetime(2026, 10, 25, 5, 59, tzinfo=UTC))
    note(client, "am sonntag", "2026-10-24")
    assert autowrite.run_once() == 0
    at(datetime(2026, 10, 25, 6, 0, tzinfo=UTC))
    assert autowrite.run_once() == 1
    assert [draft.date for draft in drafts()] == ["2026-10-24"]
    # And a person far away has their own morning.
    with new_client(make_account("rike")) as rike:
        assert rike.put("/api/me/preferences", json={"timezone": "Asia/Tokyo"}).status_code == 200
        note(rike, "tokyo notiz", "2026-10-24")  # Tokyo is already on the 25th at this moment
        assert switch_on(rike, time="08:00").status_code == 200
        at(datetime(2026, 10, 24, 22, 59, tzinfo=UTC))
        assert autowrite.run_once() == 0
        at(datetime(2026, 10, 24, 23, 0, tzinfo=UTC))
        assert autowrite.run_once() == 1


def test_the_night_notes_put_on_yesterday_are_part_of_it(ready: Model, client: TestClient, at: Setter) -> None:
    """Notes of the night after midnight that the person put on yesterday are dated yesterday: they are in the draft."""
    at(datetime(2026, 10, 7, 0, 30, tzinfo=UTC))  # 02:30 in Berlin
    assert client.put("/api/night", json={"choice": "yesterday"}).status_code == 200
    note(client, "nach mitternacht noch gelesen", DAY)
    at(MORNING)
    assert autowrite.run_once() == 1
    sent = ready.body()["messages"][1]["content"]
    assert "nach mitternacht noch gelesen" in sent and "kastanien" in sent


def test_the_notice_that_a_draft_waits_names_no_word_of_it(ready: Model, client: TestClient, at: Setter,
                                                          push_service: FakePushService) -> None:
    assert client.post("/api/push/devices", json=push_service.device().subscription()).status_code == 201
    assert autowrite.run_once() == 1
    [received] = push_service.received
    assert received.message["body"] in (autowrite.TEXTS["de"], autowrite.TEXTS["en"])
    everything = str(received.message).lower()
    assert "kastanien" not in everything and "kopfweh" not in everything and "mia" not in everything
    assert received.message["url"] == f"/tag/{DAY}/schreiben"


def test_a_blocked_account_and_an_account_without_a_device_are_no_trouble(ready: Model, client: TestClient,
                                                                         at: Setter) -> None:
    with SessionLocal() as db:
        row = db.get(Account, db.scalar(select(Account.id).where(Account.name == "tester")))
        row.blocked_at = clock.now()
        db.commit()
    assert autowrite.run_once() == 0
    assert ready.requests == []


def test_the_draft_is_sealed_like_the_page(ready: Model, client: TestClient, at: Setter) -> None:
    from pathlib import Path

    from app.config import get_settings

    assert autowrite.run_once() == 1
    path = get_settings().database_path
    with SessionLocal() as db:
        db.connection().exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    raw = b"".join(Path(path).read_bytes() for path in (path, path.with_name(path.name + "-wal")) if path.exists())
    assert b"Kastanien und Kopfweh" not in raw and b"Am Abend habe ich" not in raw


def test_the_morning_writing_has_a_limit_of_its_own(ready: Model, client: TestClient, at: Setter) -> None:
    """Pressing the button as often as is allowed does not use up the morning writing, and the reverse."""
    from app.services import ai

    for _ in range(ai.PER_MINUTE):
        assert client.post("/api/ai/formulate", json={"date": DAY, "length": "short"}).status_code in (200, 429)
    ai.pace.forget()
    assert autowrite.run_once() == 1


def test_the_service_itself_keeps_the_second_bolt_not_only_the_planner(ready: Model, client: TestClient,
                                                                       at: Setter) -> None:
    """Whatever asks the service in the morning's name goes through ``formulate(automatic=True)``: it asks the
    operator's second bolt and the permission of the account itself, and a person pressing the button is not held up by
    the first."""
    from fastapi import HTTPException

    from app.services import ai

    with SessionLocal() as db:
        account_id = db.scalar(select(Account.id).where(Account.name == "tester"))
        notes = diary.list_notes(db, account_id, vault.dek_for(account_id), DAY)
    assert client.put("/api/settings/ai", json={"auto_allowed": False}).status_code == 200
    with SessionLocal() as db, pytest.raises(HTTPException) as refused:
        ai.formulate(db, account_id, True, notes, diary.zone_of(db.get(Account, account_id)), "long", automatic=True)
    assert (refused.value.status_code, refused.value.detail["code"]) == (403, "ai_auto_off")
    assert ready.requests == []
    # The button of the person works while the bolt is closed.
    assert client.post("/api/ai/formulate", json={"date": DAY, "length": "short"}).status_code == 200
    assert len(ready.requests) == 1
    # The account's permission holds for the automatic way as for the manual one.
    assert client.put("/api/settings/ai", json={"auto_allowed": True}).status_code == 200
    with SessionLocal() as db:
        row = db.get(Account, account_id)
        row.ai_allowed = False
        db.commit()
    with SessionLocal() as db, pytest.raises(HTTPException) as denied:
        ai.formulate(db, account_id, True, notes, diary.zone_of(db.get(Account, account_id)), "long", automatic=True)
    assert denied.value.detail["code"] == "ai_not_allowed"
    assert len(ready.requests) == 1
