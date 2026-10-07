"""Reminders: once at the person's own time in their own time zone, also on the days summer time begins and ends;
not on a day with a note when the person chose so; after a pause of so many days, once in so many days; never twice,
not from two rounds at once and not after a restart. The clock is set by the test, never read from the wall."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.models import Account, ReminderMark
from app.services import prompts, reminders

from .conftest import make_account, new_client
from .fake_push import FakePushService

Setter = Callable[[datetime], None]


@pytest.fixture
def at(monkeypatch: pytest.MonkeyPatch) -> Callable[[datetime], None]:
    """Sets the server's clock."""
    moment = [datetime(2026, 10, 7, 4, 0, tzinfo=UTC)]
    monkeypatch.setattr(clock, "now", lambda: moment[0])

    def set_to(when: datetime) -> None:
        moment[0] = when

    return set_to


def ready(client: TestClient, fake: FakePushService, zone: str = "Europe/Berlin", **reminder: object) -> None:
    """A person in ``zone`` with one device and the reminder given (the clock stands early in the morning)."""
    assert client.put("/api/me/preferences", json={"timezone": zone}).status_code == 200
    answer = client.put("/api/me/reminder", json={"mode": "daily", "time": "20:30", **reminder})
    assert answer.status_code == 200, answer.text
    assert client.post("/api/push/devices", json=fake.device().subscription()).status_code == 201


def note(client: TestClient, day: str, text: str = "kurz notiert") -> None:
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, "date": day}).status_code == 201


def minutes(start: datetime, end: datetime) -> list[datetime]:
    out = []
    while start < end:
        out.append(start)
        start += timedelta(minutes=1)
    return out


def test_the_reminder_comes_once_at_the_persons_own_time(client: TestClient, account: Account,
                                                         push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service)
    # Berlin in October is UTC+2: 20:30 there is 18:30 here.
    assert reminders.run_once(datetime(2026, 10, 7, 18, 29, 59, tzinfo=UTC)) == 0
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC)) == 1
    for moment in minutes(datetime(2026, 10, 7, 18, 30, tzinfo=UTC), datetime(2026, 10, 8, 18, 30, tzinfo=UTC)):
        assert reminders.run_once(moment) == 0, moment
    assert reminders.run_once(datetime(2026, 10, 8, 18, 30, tzinfo=UTC)) == 1
    assert len(push_service.received) == 2
    message = push_service.received[0].message
    assert message["body"].startswith("Wie war dein Tag?") or message["body"].startswith("How was your day?")
    assert (message["url"], message["desk"], message["tag"]) == ("/schnell", "/", "reminder")


def test_people_in_other_zones_are_reminded_at_their_own_clock(client: TestClient, account: Account,
                                                               push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service, "America/New_York", time="07:15")
    with new_client(make_account("rike")) as rike:
        ready(rike, push_service, "Asia/Tokyo", time="07:15")
    sent: dict[str, datetime] = {}
    day = minutes(datetime(2026, 10, 7, 0, 0, tzinfo=UTC), datetime(2026, 10, 8, 0, 0, tzinfo=UTC))
    for moment in day:
        before = len(push_service.received)
        reminders.run_once(moment)
        for came in push_service.received[before:]:
            sent[came.device] = moment
    # Tokyo is UTC+9 (07:15 there is 22:15 the day before here), New York in October UTC-4.
    assert sorted(sent.values()) == [datetime(2026, 10, 7, 11, 15, tzinfo=UTC), datetime(2026, 10, 7, 22, 15, tzinfo=UTC)]


def every_minute_of(day: datetime) -> int:
    return sum(reminders.run_once(moment) for moment in minutes(day, day + timedelta(days=1)))


def test_on_the_day_summer_time_begins_a_time_that_does_not_exist_comes_once_right_after(
    client: TestClient, account: Account, push_service: FakePushService, at: Setter
) -> None:
    at(datetime(2026, 3, 28, 12, 0, tzinfo=UTC))
    # On 29 March 2026 the clocks in Berlin go from 02:00 straight to 03:00: 02:30 never happens.
    ready(client, push_service, time="02:30")
    sent: list[datetime] = []
    for moment in minutes(datetime(2026, 3, 28, 22, 0, tzinfo=UTC), datetime(2026, 3, 29, 22, 0, tzinfo=UTC)):
        if reminders.run_once(moment):
            sent.append(moment)
    # 01:00 UTC is 03:00 summer time, the first minute past 02:30 on the clock.
    assert sent == [datetime(2026, 3, 29, 1, 0, tzinfo=UTC)]


def test_on_the_day_summer_time_ends_a_time_that_happens_twice_comes_once(
    client: TestClient, account: Account, push_service: FakePushService, at: Setter
) -> None:
    at(datetime(2026, 10, 24, 12, 0, tzinfo=UTC))
    # On 25 October 2026 the clocks in Berlin go from 03:00 back to 02:00: 02:30 happens at 00:30 and at 01:30 UTC.
    ready(client, push_service, time="02:30")
    sent: list[datetime] = []
    for moment in minutes(datetime(2026, 10, 24, 22, 0, tzinfo=UTC), datetime(2026, 10, 25, 23, 0, tzinfo=UTC)):
        if reminders.run_once(moment):
            sent.append(moment)
    assert sent == [datetime(2026, 10, 25, 0, 30, tzinfo=UTC)]


def test_a_server_that_was_down_at_the_time_sends_it_late_but_not_the_next_morning(
    client: TestClient, account: Account, push_service: FakePushService, at: Setter
) -> None:
    ready(client, push_service)
    assert reminders.run_once(datetime(2026, 10, 7, 20, 29, tzinfo=UTC)) == 1, "an hour and 59 minutes late"
    ready_again = datetime(2026, 10, 8, 20, 30, tzinfo=UTC)
    assert reminders.run_once(ready_again) == 0, "two hours late: left alone"


def test_not_on_a_day_with_a_note_when_the_person_chose_so(client: TestClient, account: Account,
                                                           push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service, skip_if_written=True)
    note(client, "2026-10-06")
    note(client, "2026-10-07")
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC)) == 0
    assert reminders.run_once(datetime(2026, 10, 8, 18, 30, tzinfo=UTC)) == 1, "the note of yesterday does not count"
    client.put("/api/me/reminder", json={"skip_if_written": False})
    at(datetime(2026, 10, 9, 8, 0, tzinfo=UTC))
    note(client, "2026-10-09")
    assert reminders.run_once(datetime(2026, 10, 9, 18, 30, tzinfo=UTC)) == 1


def test_a_page_counts_as_written_too(client: TestClient, account: Account, push_service: FakePushService,
                                      at: Setter) -> None:
    ready(client, push_service, skip_if_written=True)
    assert client.put("/api/days/2026-10-07", json={"title": "Herbst"}).status_code == 200
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC)) == 0


def test_after_a_pause_once_in_so_many_days_while_it_lasts(client: TestClient, account: Account,
                                                           push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service, mode="pause", days=3)
    note(client, "2026-10-04")
    sent = []
    for day in range(5, 15):
        if reminders.run_once(datetime(2026, 10, day, 18, 30, tzinfo=UTC)):
            sent.append(day)
    # Nothing written since the 4th: on the 7th three days without, then every three days.
    assert sent == [7, 10, 13]
    assert push_service.received[0].message["body"].startswith(("Seit 3 Tagen", "Nothing written for 3 days"))
    assert push_service.received[1].message["body"].startswith(("Seit 6 Tagen", "Nothing written for 6 days"))
    at(datetime(2026, 10, 14, 8, 0, tzinfo=UTC))
    note(client, "2026-10-14")
    assert reminders.run_once(datetime(2026, 10, 16, 18, 30, tzinfo=UTC)) == 0
    assert reminders.run_once(datetime(2026, 10, 17, 18, 30, tzinfo=UTC)) == 1


def test_never_means_never_and_without_a_device_or_blocked_nothing_goes(client: TestClient, account: Account,
                                                                        push_service: FakePushService,
                                                                        at: Setter) -> None:
    ready(client, push_service, mode="never")
    with new_client(make_account("rike")) as rike:
        rike.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
        rike.put("/api/me/reminder", json={"mode": "daily", "time": "20:30"})
    blocked = make_account("ben")
    with new_client(blocked) as ben:
        ready(ben, push_service)
    with SessionLocal() as db:
        row = db.get(Account, blocked.id)
        assert row is not None
        row.blocked_at = datetime(2026, 10, 1, tzinfo=UTC)
        db.commit()
    assert every_minute_of(datetime(2026, 10, 7, 0, 0, tzinfo=UTC)) == 0
    assert push_service.received == []


def test_two_rounds_at_the_same_moment_send_one(client: TestClient, account: Account,
                                                push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service)
    moment = datetime(2026, 10, 7, 18, 30, tzinfo=UTC)
    counts: list[int] = []
    start = threading.Barrier(8)

    def one() -> None:
        start.wait()
        counts.append(reminders.run_once(moment))

    threads = [threading.Thread(target=one) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(counts) == [0] * 7 + [1]
    assert len(push_service.received) == 1


def test_a_restart_in_the_same_minute_sends_no_second(client: TestClient, account: Account,
                                                      push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service)
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, 5, tzinfo=UTC)) == 1
    # A new server process knows only the database.
    from app import db as database

    database.engine.dispose()
    assert reminders.run_once(datetime(2026, 10, 7, 18, 30, 40, tzinfo=UTC)) == 0
    with SessionLocal() as db:
        mark = db.get(ReminderMark, account.id)
        assert mark is not None and mark.sent_for == "2026-10-07"
    assert len(push_service.received) == 1


def test_switching_it_on_after_its_time_does_not_remind_at_once(client: TestClient, account: Account,
                                                                push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service, mode="never")
    at(datetime(2026, 10, 7, 19, 0, tzinfo=UTC))
    client.put("/api/me/reminder", json={"mode": "daily", "time": "20:30"})
    assert reminders.run_once(datetime(2026, 10, 7, 19, 1, tzinfo=UTC)) == 0
    assert reminders.run_once(datetime(2026, 10, 8, 18, 30, tzinfo=UTC)) == 1
    # Moved to later the same evening, it comes that evening.
    at(datetime(2026, 10, 9, 17, 0, tzinfo=UTC))
    client.put("/api/me/reminder", json={"time": "21:00"})
    assert reminders.run_once(datetime(2026, 10, 9, 19, 0, tzinfo=UTC)) == 1


def test_the_question_of_the_day_comes_along_only_when_chosen(client: TestClient, account: Account,
                                                              push_service: FakePushService, at: Setter) -> None:
    client.put("/api/me/language", json={"language": "de"})
    for group in prompts.SET_IDS:
        assert client.put(f"/api/prompts/sets/{group}", json={"on": False}).status_code == 200
    assert client.post("/api/prompts/own", json={"text": "Wofür war heute Zeit?"}).status_code == 201
    ready(client, push_service, with_prompt=False)
    reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC))
    client.put("/api/me/reminder", json={"with_prompt": True})
    reminders.run_once(datetime(2026, 10, 8, 18, 30, tzinfo=UTC))
    assert push_service.bodies() == ["Wie war dein Tag?", "Wie war dein Tag? Heute gefragt: Wofür war heute Zeit?"]


def test_each_device_hears_it_in_its_own_language(client: TestClient, account: Account,
                                                  push_service: FakePushService, at: Setter) -> None:
    ready(client, push_service, with_prompt=False)
    english = push_service.device()
    assert client.post("/api/push/devices", json=english.subscription(),
                       headers={"X-Nexdiary-Language": "en"}).status_code == 201
    german = push_service.device()
    assert client.post("/api/push/devices", json=german.subscription(),
                       headers={"X-Nexdiary-Language": "de"}).status_code == 201
    reminders.run_once(datetime(2026, 10, 7, 18, 30, tzinfo=UTC))
    by_device = {came.device: came.message["body"] for came in push_service.received}
    assert by_device[english.endpoint.rsplit("/", 1)[-1]] == "How was your day?"
    assert by_device[german.endpoint.rsplit("/", 1)[-1]] == "Wie war dein Tag?"


def test_the_choice_is_checked_and_kept_with_the_profile(client: TestClient, account: Account, at: Setter) -> None:
    assert client.get("/api/auth/me").json()["profile"]["reminder"] == reminders.DEFAULT
    for bad in ({"mode": "weekly"}, {"time": "24:00"}, {"time": "7:5"}, {"days": 0}, {"days": 31}, {"days": True},
                {"with_prompt": "yes"}, {"skip_if_written": 1}, {"other": 1}):
        answer = client.put("/api/me/reminder", json=bad)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "bad_reminder", bad
    saved = client.put("/api/me/reminder", json={"mode": "pause", "days": 4, "time": "07:05"}).json()
    assert saved == {**reminders.DEFAULT, "mode": "pause", "days": 4, "time": "07:05"}
    # Another choice of the profile keeps it.
    client.put("/api/me/preferences", json={"mode": "dark"})
    assert client.get("/api/auth/me").json()["profile"]["reminder"] == saved
    assert client.put("/api/me/preferences", json={"reminder": {"mode": "never"}}).status_code == 422
