"""The statistics: every rule with fixed days and a clock that stands still, only the own days, nothing for programs
or for somebody who is not signed in, pages that do not open are passed over, and 3,000 days in good time."""

from __future__ import annotations

import io
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import update

from app import clock
from app.db import SessionLocal
from app.models import Account, Day
from app.services import apitokens, brakes, diary, stats, streaks, vault

from .conftest import person

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
TODAY = date(2026, 10, 6)  # a Tuesday


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    yield


def d(offset: int) -> date:
    """The day ``offset`` days before the fixed today."""
    return TODAY - timedelta(days=offset)


def page(day: date, *, written: bool = True, values: dict[str, int] | None = None, tags: tuple[str, ...] = (),
         ai: bool = False, words: int = 3, title: str = "") -> stats.Page:
    return stats.Page(day=day, written=written, words=words if written else 0, tags=tags, values=values or {},
                      by_ai=ai, title=title)


def seed(who: Account, days: dict[str, dict[str, Any]]) -> None:
    """Pages straight into the database, sealed as the app seals them (3,000 of them through the routes would take
    minutes)."""
    dek = vault.dek_for(who.id)
    now = clock.now()
    with SessionLocal() as db:
        for day, content in days.items():
            full = {**diary.empty_day(), **content}
            db.add(Day(user_id=who.id, date=day, revision=0, created_at=now, updated_at=now,
                       content_enc=vault.seal_json(dek, full, diary._day_aad(who.id, day))))
        db.commit()


def value_ids(client: TestClient) -> dict[str, str]:
    return {item["name"]: item["id"] for item in client.get("/api/values").json()}


def setup(client: TestClient) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})


def get(client: TestClient) -> dict[str, Any]:
    answer = client.get("/api/stats")
    assert answer.status_code == 200, answer.text
    return answer.json()


# --- The rules, with fixed days -------------------------------------------------------------------------------------


def streak(days: set[date], goal: int = 7) -> dict[str, Any]:
    return streaks.compute({day: 3 for day in days}, TODAY, goal)


def test_the_streak_counts_written_days_in_a_row_and_waits_for_today() -> None:
    done = {d(0), d(1), d(2), d(4)}
    assert streak(done)["current"] == 3 and streak(done)["today_done"] is True
    open_today = {d(1), d(2), d(3), d(5)}
    found = streak(open_today)
    assert found["current"] == 3 and found["today_done"] is False
    # Yesterday missing as well: the streak is over.
    assert streak({d(2), d(3)})["current"] == 0
    found = streak(set())
    assert (found["current"], found["longest"], found["longest_end"], found["today_done"]) == (0, 0, None, False)


def test_the_longest_streak_takes_the_later_of_equal_runs() -> None:
    days = {d(40), d(39), d(38), d(20), d(19), d(18), d(10)}
    found = streak(days)
    assert found["longest"] == 3 and found["longest_end"] == d(18).isoformat()
    longer = days | {d(41)}
    assert streak(longer)["longest_end"] == d(38).isoformat()
    assert streak(longer)["longest"] == 4


def test_a_year_before_keeps_the_calendar_day_and_meets_a_leap_day_with_the_28th() -> None:
    assert stats.year_before(date(2026, 10, 6)) == date(2025, 10, 6)
    assert stats.year_before(date(2028, 2, 29)) == date(2027, 2, 28)
    assert stats.year_before(date(2028, 3, 1)) == date(2027, 3, 1)
    assert stats.year_before(date(2029, 2, 28)) == date(2028, 2, 28)


def test_the_seven_day_mean_skips_missing_days_and_reaches_back_before_the_span() -> None:
    pages = [page(d(0), values={"m": 8}), page(d(1), values={"m": 4}), page(d(3), values={"m": 6}),
             page(d(179), values={"m": 10}), page(d(180), values={"m": 2}), page(d(60), values={"x": 9})]
    found = stats.series(pages, "m", TODAY)
    assert len(found["values"]) == stats.SERIES_DAYS and len(found["means"]) == stats.SERIES_DAYS
    assert found["values"][-1] == 8 and found["values"][-2] == 4 and found["values"][-3] is None
    # Today: 8, 4, (gap), 6 inside the week; the gaps are not zeros.
    assert found["means"][-1] == 6.0
    # Yesterday: 4 and 6 (and nothing else in its week); the day after it, 2 days ago, sees only the 6.
    assert found["means"][-2] == 5.0 and found["means"][-3] == 6.0
    # The first day of the span sees the day before it (value 2) in its own week.
    assert found["values"][0] == 10 and found["means"][0] == 6.0
    # A week without a single rating has no mean; a value of another id is not in it.
    assert found["means"][-12] is None and found["values"][-61] is None
    assert found["mean"] == {"30": 6.0, "90": 6.0, "180": 7.0}
    # The window is seven days: the day six days back is in it, the one seven days back is not.
    edge = stats.series([page(d(0), values={"m": 8}), page(d(6), values={"m": 2}), page(d(7), values={"m": 10})], "m", TODAY)
    assert edge["means"][-1] == 5.0
    nothing = stats.series([], "m", TODAY)
    assert set(nothing["values"]) == {None} and set(nothing["means"]) == {None} and set(nothing["mean"].values()) == {None}


def test_the_best_weekday_is_said_only_with_enough_days_on_two_weekdays() -> None:
    # Mondays (3 days) average 5, Tuesdays (3 days) average 8, a Wednesday with one 10 is too thin to count.
    mondays = [page(date(2026, 9, 7) + timedelta(weeks=n), values={"m": 5}) for n in range(3)]
    tuesdays = [page(date(2026, 9, 8) + timedelta(weeks=n), values={"m": 8}) for n in range(3)]
    thin = [page(date(2026, 9, 9), values={"m": 10})]
    found = stats.weekdays(mondays + tuesdays + thin, "m")
    assert found["best"] == 1
    assert found["days"][0] == {"n": 3, "mean": 5.0} and found["days"][2] == {"n": 1, "mean": 10.0}
    assert found["days"][6] == {"n": 0, "mean": None}
    # Two days on a weekday are too few to make it the best, however high they are.
    two = [page(date(2026, 9, 10), values={"m": 10}), page(date(2026, 9, 17), values={"m": 10})]
    assert stats.weekdays(mondays + tuesdays + two, "m")["best"] == 1
    # One weekday alone does not make a "best".
    assert stats.weekdays(mondays, "m")["best"] is None
    # Equal means: the earlier weekday.
    equal = [page(date(2026, 9, 9) + timedelta(weeks=n), values={"m": 8}) for n in range(3)]
    assert stats.weekdays(tuesdays + equal, "m")["best"] == 1
    assert stats.weekdays([], "m")["best"] is None and stats.weekdays(mondays, None)["days"][0]["n"] == 0


def test_a_comparison_needs_five_days_on_each_side() -> None:
    for small, expect in ((4, None), (5, "tag")):
        with_tag = [page(d(n), values={"m": 8}, tags=("sport",)) for n in range(small)]
        without = [page(d(20 + n), values={"m": 6}) for n in range(5)]
        rows = [row for row in stats.together(with_tag + without, "m", []) if row["kind"] == "tag"]
        assert (rows[0]["kind"] if rows else None) == expect
    # Both sides at five: the figures.
    rows = stats.together([page(d(n), values={"m": 8}, tags=("sport",)) for n in range(5)]
                          + [page(d(20 + n), values={"m": 6}) for n in range(5)], "m", [])
    tag = next(row for row in rows if row["kind"] == "tag")
    assert tag == {"kind": "tag", "tag": "sport", "a_n": 5, "b_n": 5, "a_mean": 8.0, "b_mean": 6.0, "diff": 2.0,
                   "similar": False}


def test_together_compares_values_the_weekend_and_tags_and_calls_a_small_difference_similar() -> None:
    pages = []
    # Ten weekdays and ten weekend days; sleep 8 on half of each, 4 on the other half.
    day = date(2026, 8, 3)  # a Monday
    for n in range(28):
        current = day + timedelta(days=n)
        sleep = 7 if n % 2 == 0 else 6
        mood = (7 if sleep >= 7 else 5) + (1 if current.weekday() >= 5 else 0)
        pages.append(page(current, values={"m": mood, "s": sleep}, tags=("a",) if n % 4 == 0 else ()))
    rows = stats.together(pages, "m", [("m", "Mood"), ("s", "Sleep")])
    kinds = [row["kind"] for row in rows]
    assert kinds[0] == "value" and rows[0]["name"] == "Sleep" and "weekend" in kinds
    assert not any(row["kind"] == "value" and row["name"] == "Mood" for row in rows), "a value is not set against itself"
    sleep_row = rows[0]
    assert sleep_row["a_n"] == 14 and sleep_row["b_n"] == 14 and sleep_row["a_mean"] > sleep_row["b_mean"]
    assert sleep_row["similar"] is False
    # Equal means on both sides of a tag are similar, with a difference of nothing.
    close = [page(d(n), values={"m": 6}, tags=("t",)) for n in range(5)] + [page(d(10 + n), values={"m": 6}) for n in range(5)]
    tag = next(row for row in stats.together(close, "m", []) if row["kind"] == "tag")
    assert tag["similar"] is True and tag["diff"] == 0.0
    near = [page(d(n), values={"m": 6}, tags=("t",)) for n in range(5)] + [page(d(10 + n), values={"m": 6 if n else 5}) for n in range(5)]
    assert next(row for row in stats.together(near, "m", []) if row["kind"] == "tag")["similar"] is True
    just = [page(d(n), values={"m": 6}, tags=("t",)) for n in range(5)] + [page(d(10 + n), values={"m": 6 if n > 1 else 5}) for n in range(5)]
    assert next(row for row in stats.together(just, "m", []) if row["kind"] == "tag")["similar"] is False  # 0.4 apart
    far = [page(d(n), values={"m": 6}, tags=("t",)) for n in range(5)] + [page(d(10 + n), values={"m": 5}) for n in range(5)]
    assert next(row for row in stats.together(far, "m", []) if row["kind"] == "tag")["similar"] is False
    assert stats.together(pages, None, []) == []


def test_best_and_worst_day_in_each_span_with_the_younger_day_on_a_tie() -> None:
    pages = [page(d(0), values={"m": 5}), page(d(5), values={"m": 9}), page(d(6), values={"m": 9}),
             page(d(29), values={"m": 1}), page(d(30), values={"m": 1}), page(d(100), values={"m": 10}),
             page(d(300), values={"m": 2}), page(d(364), values={"m": 10}), page(d(365), values={"m": 1}),
             page(d(10), values={"x": 1})]
    short = stats._extremes(pages, "m", TODAY, 30)
    # Thirty days end today: the 30th day back is out, the 29th is in. The tie of 9 goes to the younger day.
    assert short == {"count": 4, "best": d(5).isoformat(), "worst": d(29).isoformat()}
    year = stats._extremes(pages, "m", TODAY, 365)
    assert year["best"] == d(100).isoformat() and year["worst"] == d(29).isoformat() and year["count"] == 8
    every = stats._extremes(pages, "m", TODAY, None)
    assert every["count"] == 9 and every["best"] == d(100).isoformat() and every["worst"] == d(29).isoformat()
    assert stats._extremes(pages[:1], "m", TODAY, None) == {"count": 1, "best": None, "worst": None}
    assert stats._extremes(pages, None, TODAY, None) == {"count": 0, "best": None, "worst": None}


def test_the_calendar_runs_from_a_monday_26_weeks_ago_to_today() -> None:
    found = stats.calendar([page(d(0), values={"m": 7}, title="Heute"), page(d(1), written=False, title="Leer"),
                            page(d(500))], "m", TODAY)
    start = date.fromisoformat(found["start"])
    assert start.weekday() == 0 and (TODAY - start).days // 7 == stats.CALENDAR_WEEKS - 1
    assert found["start"] == "2026-04-13"
    assert sorted(found["days"], key=lambda item: item["date"]) == [
        {"date": "2026-10-05", "written": False, "value": None, "title": "Leer"},
        {"date": "2026-10-06", "written": True, "value": 7, "title": "Heute"}]


def test_the_writing_split_counts_written_days_and_the_tags_come_most_used_first() -> None:
    written = [page(d(0), ai=True), page(d(1)), page(d(2), ai=True), page(d(3))]
    split = stats.writing(written, {d(0).isoformat(), d(3).isoformat(), "1999-01-01"}, {d(1).isoformat()})
    assert split == {"total": 4, "ai": 2, "self": 2, "photos": 2, "shared": 1}
    assert stats.writing([], set(), set()) == {"total": 0, "ai": 0, "self": 0, "photos": 0, "shared": 0}
    tagged = [page(d(0), tags=("b", "a")), page(d(1), tags=("b",)), page(d(2), tags=("c", "a"))]
    assert stats.top_tags(tagged) == [{"tag": "a", "count": 2}, {"tag": "b", "count": 2}, {"tag": "c", "count": 1}]
    many = [page(d(n), tags=(f"t{n:02d}",)) for n in range(12)]
    assert len(stats.top_tags(many)) == stats.TOP_TAGS


# --- Over HTTP ------------------------------------------------------------------------------------------------------


def test_an_empty_diary_gives_zeros_and_nothing_divides_by_nothing(client: TestClient, account: Account) -> None:
    setup(client)
    found = get(client)
    assert found["pages"] == 0 and found["unreadable"] == 0
    assert found["tiles"] == {"unit": "days", "goal": 7, "current": 0, "longest": 0, "longest_end": None,
                              "today_done": False, "shields": 0, "week": {"count": 0, "goal": 7}, "rescues": [],
                              "year": 2026, "days_year": 0, "days_total": 0, "words": 0, "words_per_day": 0}
    assert found["value"] == {"id": value_ids(client)["Mood"], "name": "Mood", "low": "awful", "high": "great"}
    assert found["values"][0]["name"] == "Mood"
    assert found["writing"] == {"total": 0, "ai": 0, "self": 0, "photos": 0, "shared": 0}
    assert found["together"] == [] and found["tags"] == [] and found["year_ago"] is None
    assert found["weekdays"]["best"] is None
    assert all(item["best"] is None and item["worst"] is None for item in found["extremes"].values())
    mood = found["series"]["values"][found["value"]["id"]]
    assert set(mood["values"]) == {None} and mood["mean"] == {"30": None, "90": None, "180": None}


def test_the_figures_of_a_small_diary(client: TestClient, account: Account) -> None:
    setup(client)
    ids = value_ids(client)
    mood = ids["Mood"]
    seed(account, {
        "2026-10-06": {"title": "Heute", "text": "eins zwei drei", "tags": ["sport"], "values": {mood: 7},
                       "written_by": "ai"},
        "2026-10-05": {"title": "Gestern", "text": "vier fünf", "tags": ["sport", "arbeit"], "values": {mood: 9}},
        "2026-10-04": {"title": "Nur Wert", "text": "  ", "values": {mood: 2}},
        "2026-10-03": {"title": "Vor drei Tagen", "text": "sechs", "values": {mood: 9}, "written_by": "ai"},
        "2025-10-06": {"title": "Vor einem Jahr", "text": "alt", "values": {mood: 6}},
        "2025-02-01": {"title": "Früher", "text": "a b c d", "values": {mood: 1}},
        "2026-12-31": {"title": "Zukunft", "text": "darf nicht zählen", "values": {mood: 10}},
    })
    assert client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-05"},
                       content=_png()).status_code == 201
    with person("tom"):
        pass
    tom = _account_named("tom")
    assert client.put("/api/days/2026-10-05/shares", json={"to": [tom.id]}).status_code == 200
    found = get(client)
    tiles = found["tiles"]
    # Written: 6 Oct, 5 Oct, 3 Oct, 6 Oct 2025, 1 Feb 2025. (4 Oct has no text; 31 Dec is still to come.)
    assert tiles["current"] == 2 and tiles["longest"] == 2 and tiles["longest_end"] == "2026-10-06"
    assert tiles["today_done"] is True
    assert tiles["days_year"] == 3 and tiles["days_total"] == 5
    assert tiles["words"] == 3 + 2 + 1 + 1 + 4 and tiles["words_per_day"] == 2
    assert found["pages"] == 6
    assert found["writing"] == {"total": 5, "ai": 2, "self": 3, "photos": 1, "shared": 1}
    assert found["tags"] == [{"tag": "sport", "count": 2}, {"tag": "arbeit", "count": 1}]
    assert found["year_ago"]["date"] == "2025-10-06" and found["year_ago"]["title"] == "Vor einem Jahr"
    assert found["year_ago"]["excerpt"] == "alt" and found["year_ago"]["cover"]
    # Ratings count on every page that has them, written or not: 9, 9 (younger day wins), 2, 7, 6, 1. A year of days
    # ends today and starts 364 days back, so the page of 6 October 2025 is just out of it.
    year = found["extremes"]["365"]
    assert year["count"] == 4 and year["best"]["date"] == "2026-10-05" and year["best"]["value"] == 9
    assert year["worst"]["date"] == "2026-10-04" and year["worst"]["value"] == 2
    every = found["extremes"]["all"]
    assert every["count"] == 6 and every["worst"]["date"] == "2025-02-01" and every["worst"]["value"] == 1
    short = found["extremes"]["30"]
    assert short["count"] == 4 and short["best"]["title"] == "Gestern"
    week = found["calendar"]["days"]
    assert {item["date"] for item in week} >= {"2026-10-06", "2026-10-04"}
    assert next(item for item in week if item["date"] == "2026-10-04") == {"date": "2026-10-04", "written": False,
                                                                           "value": 2, "title": "Nur Wert"}
    assert all(item["date"] <= "2026-10-06" for item in week)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 122, 82)).save(out, "PNG")
    return out.getvalue()


def _account_named(name: str) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=name).one()
        db.expunge(row)
    return row


def test_the_streak_follows_the_persons_own_time_zone(client: TestClient, account: Account,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    # 22:00 UTC on 6 October is already 7 October in Auckland, where 7 October is still open.
    late = datetime(2026, 10, 6, 22, 0, tzinfo=UTC)
    client.put("/api/me/preferences", json={"timezone": "Pacific/Auckland"})
    seed(account, {"2026-10-06": {"text": "gestern dort"}, "2026-10-05": {"text": "davor"}})
    monkeypatch.setattr(clock, "now", lambda: late)
    found = get(client)
    assert found["today"] == "2026-10-07" and found["tiles"]["current"] == 2 and found["tiles"]["today_done"] is False
    client.put("/api/me/preferences", json={"timezone": "America/Los_Angeles"})
    far = get(client)
    # There it is still the 6th at 15:00, and the 6th is written.
    assert far["today"] == "2026-10-06" and far["tiles"]["today_done"] is True


def test_only_the_own_days_count(client: TestClient, account: Account) -> None:
    setup(client)
    mine = value_ids(client)["Mood"]
    seed(account, {"2026-10-06": {"text": "ich", "values": {mine: 5}, "tags": ["mein"]}})
    before = get(client)
    with person("tom") as tom:
        tom.put("/api/me/preferences", json={"timezone": "UTC"})
        theirs = {item["name"]: item["id"] for item in tom.get("/api/values").json()}["Mood"]
        seed(_account_named("tom"), {f"2026-10-{n:02d}": {"text": "viele Wörter von Tom", "values": {theirs: 10},
                                                           "tags": ["seins"]} for n in range(1, 7)})
        assert tom.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": "2026-10-06"},
                        content=_png()).status_code == 201
        theirs_found = get(tom)
        assert theirs_found["writing"]["photos"] == 1
        assert theirs_found["tiles"]["days_total"] == 6 and theirs_found["tags"][0]["tag"] in {"seins"}
    assert get(client) == before
    assert before["writing"]["photos"] == 0
    assert before["tiles"]["days_total"] == 1 and before["tags"] == [{"tag": "mein", "count": 1}]
    # The operator of a server is a person like the others here: the own days only.
    assert get(client)["pages"] == 1


def test_nobody_without_a_session_and_no_token_reads_the_statistics(client: TestClient, operator: Account) -> None:
    assert client.put("/api/settings", json={"api_tokens_allowed": True}).status_code == 200
    created = client.post("/api/api-tokens", json={"name": "card"})
    assert created.status_code == 201, created.text
    token = created.json()["secret"]
    with TestClient(client.app, base_url="http://testserver", headers={"X-Nexdiary-Client": "program"}) as bare:
        assert bare.get("/api/stats").status_code == 401
        # An API token opens /api/v1 and nothing else.
        assert bare.get("/api/stats", headers={"Authorization": f"Bearer {token}"}).status_code == 401
        assert bare.get("/api/stats", headers={"Authorization": "Bearer nonsense"}).status_code == 401
        assert bare.get("/api/v1/stats", headers={"Authorization": f"Bearer {token}"}).status_code == 404
    assert apitokens is not None


def test_a_page_that_does_not_open_is_passed_over_and_counted(client: TestClient, account: Account) -> None:
    setup(client)
    mood = value_ids(client)["Mood"]
    seed(account, {"2026-10-06": {"text": "gut", "values": {mood: 5}}, "2026-10-05": {"text": "kaputt", "values": {mood: 9}},
                   "2026-10-04": {"text": "auch gut", "values": {mood: 1}}})
    with SessionLocal() as db:
        db.execute(update(Day).where(Day.date == "2026-10-05").values(content_enc=b"\x01" + b"x" * 40))
        db.commit()
    found = get(client)
    assert found["unreadable"] == 1 and found["pages"] == 2
    assert found["tiles"]["days_total"] == 2 and found["tiles"]["current"] == 1
    assert found["extremes"]["all"]["best"]["date"] == "2026-10-06"


def test_the_main_value_is_the_first_active_one_and_the_names_are_free(client: TestClient, account: Account) -> None:
    setup(client)
    ids = value_ids(client)
    client.put(f"/api/values/{ids['Mood']}", json={"name": "Laune", "active": False})
    seed(account, {"2026-10-06": {"text": "x", "values": {ids["Mood"]: 3, ids["Health"]: 8}},
                   "2026-10-05": {"text": "y", "values": {ids["Health"]: 4}}})
    found = get(client)
    assert found["value"] == {"id": ids["Health"], "name": "Health", "low": "ill", "high": "in top form"}
    assert [item["name"] for item in found["values"]] == ["Health", "Sleep", "Work day"]
    assert ids["Mood"] not in found["series"]["values"]
    assert found["series"]["values"][ids["Health"]]["values"][-2:] == [4, 8]
    assert found["extremes"]["all"]["best"]["value"] == 8 and found["extremes"]["all"]["worst"]["value"] == 4
    # No value asked at all: the rest of the page still stands.
    for item in client.get("/api/values").json():
        client.put(f"/api/values/{item['id']}", json={"active": False})
    bare = get(client)
    assert bare["value"] is None and bare["values"] == [] and bare["series"]["values"] == {}
    assert bare["together"] == [] and bare["tiles"]["days_total"] == 2
    assert bare["extremes"]["all"] == {"count": 0, "best": None, "worst": None}


def test_the_statistics_are_braked_per_person(client: TestClient, account: Account,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(brakes.LIMITS, "stats", 3)
    monkeypatch.setattr(clock, "monotonic", lambda: 1000.0)  # the minute stands still, however slow the machine is
    for _ in range(3):
        assert client.get("/api/stats").status_code == 200
    slow = client.get("/api/stats")
    assert slow.status_code == 429 and slow.json()["detail"]["code"] == "stats_too_often"
    with person("tom") as tom:
        assert tom.get("/api/stats").status_code == 200


def test_3000_days_are_worked_out_in_good_time(client: TestClient, account: Account) -> None:
    setup(client)
    ids = value_ids(client)
    days: dict[str, dict[str, Any]] = {}
    for n in range(3000):
        day = (TODAY - timedelta(days=n)).isoformat()
        days[day] = {"title": f"Tag {n}", "text": "ein längerer Text " * 40, "tags": [f"t{n % 7}", "alle"],
                     "values": {ids["Mood"]: 1 + n % 10, ids["Sleep"]: 1 + (n * 3) % 10},
                     "written_by": "ai" if n % 3 else "self"}
    seed(account, days)
    # The time this process worked, not the time that passed: another job on the machine cannot make it longer.
    started = time.process_time()
    found = get(client)
    took = time.process_time() - started
    print(f"3000 days: {took:.3f} s of work")
    assert found["tiles"]["days_total"] == 3000 and found["tiles"]["current"] == 3000
    assert took < 3.0, took
