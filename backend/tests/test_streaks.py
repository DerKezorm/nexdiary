"""The weekly goal, the streak and its shields: every rule with fixed days at goal 7, 3 and 1, the goal kept with the
account, only the own pages counting, an automatic draft counting for nothing and 3,000 days in good time. The clock is
set by the test, never read from the wall."""

from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.models import Account, Day
from app.services import diary, streaks, vault

from .conftest import person

WEDNESDAY = date(2026, 10, 7)
NOON = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
#: The words of a long page, as the interface tells (not read from the code under test).
LONG = 300
#: A picture whose caption has 60 words (the text of a picture does not count as the person's words).
PICTURE = "![" + "wort " * 60 + "](photo:" + "b" * 32 + ") "


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    yield


def before(n: int, today: date = WEDNESDAY) -> date:
    """The day ``n`` days before ``today``."""
    return today - timedelta(days=n)


def pages(*days: date, words: int = 5) -> dict[date, int]:
    return {day: words for day in days}


def run(first: int, last: int, today: date = WEDNESDAY, words: int = 5) -> dict[date, int]:
    """Every day from ``first`` to ``last`` days before ``today``, both included."""
    return {before(n, today): words for n in range(first, last + 1)}


def at(written: dict[date, int], goal: int, today: date = WEDNESDAY) -> dict[str, Any]:
    return streaks.compute(written, today, goal)


def week(n: int, count: int, today: date = WEDNESDAY, words: int = 5) -> dict[date, int]:
    """``count`` pages in the week ``n`` weeks before the week of ``today``: the first days of it, Monday on."""
    monday = streaks.monday_of(today) - timedelta(weeks=n)
    return {monday + timedelta(days=index): words for index in range(count)}


def weeks(*counts: int, ending: int = 1, today: date = WEDNESDAY) -> dict[date, int]:
    """Weeks in a row, the last of them ``ending`` weeks before this one; ``counts`` oldest first."""
    out: dict[date, int] = {}
    for index, count in enumerate(counts):
        out |= week(ending + len(counts) - 1 - index, count, today)
    return out


# --- The goal ---------------------------------------------------------------------------------------------------------


def test_the_goal_is_one_to_seven_and_seven_where_nothing_valid_is_kept() -> None:
    assert streaks.goal_of({}) == 7 and streaks.goal_of(None) == 7 and streaks.goal_of({"goal": 3}) == 3
    for wrong in (0, 8, -1, True, 3.0, "3", None):
        assert streaks.goal_of({"goal": wrong}) == 7, wrong


def test_the_numbers_are_those_the_interface_tells() -> None:
    assert (streaks.LONG_WORDS, streaks.DAYS_PER_SHIELD, streaks.WEEKS_PER_SHIELD) == (300, 10, 4)


def test_the_unit_follows_the_goal() -> None:
    assert at({}, 7)["unit"] == "days"
    assert [at({}, goal)["unit"] for goal in range(1, 7)] == ["weeks"] * 6


# --- Goal 7: days in a row ----------------------------------------------------------------------------------------------


def test_at_goal_7_days_in_a_row_count_and_the_open_day_waits() -> None:
    found = at(run(0, 4), 7)
    assert (found["current"], found["longest"], found["today_done"], found["shields"]) == (5, 5, True, 0)
    found = at(run(1, 4), 7)
    assert (found["current"], found["today_done"]) == (4, False)
    # Yesterday missing as well: over.
    assert at(run(2, 4), 7)["current"] == 0 and at(run(2, 4), 7)["longest"] == 3


def test_ten_days_in_a_row_give_a_shield_and_twenty_two() -> None:
    assert at(run(0, 8), 7)["shields"] == 0
    assert at(run(0, 9), 7)["shields"] == 1
    found = at(run(0, 19), 7)
    assert (found["current"], found["shields"]) == (20, 2)


def test_a_missed_day_is_saved_by_a_shield_and_does_not_count() -> None:
    # Ten days earn the shield, one day is missed, then two more pages.
    written = run(3, 12) | pages(before(1), before(0))
    found = at(written, 7)
    assert (found["current"], found["longest"], found["shields"]) == (12, 12, 0)
    assert found["rescues"] == [before(2).isoformat()]


def test_two_missed_days_with_one_shield_break_the_streak() -> None:
    written = run(4, 13) | pages(before(1), before(0))
    found = at(written, 7)
    assert (found["current"], found["longest"], found["shields"], found["rescues"]) == (2, 10, 0, [])


def test_an_open_day_uses_nothing_and_a_missed_yesterday_is_saved_at_once() -> None:
    open_today = at(run(1, 10), 7)
    assert (open_today["current"], open_today["shields"], open_today["rescues"]) == (10, 1, [])
    yesterday_missed = at(run(2, 11), 7)
    assert (yesterday_missed["current"], yesterday_missed["shields"]) == (10, 0)
    assert yesterday_missed["rescues"] == [before(1).isoformat()]
    # Today comes and is written: the streak goes on from the saved day.
    assert at(run(2, 11) | pages(before(0)), 7)["current"] == 11


def test_a_page_written_afterwards_changes_the_result_with_it() -> None:
    written = run(3, 12) | pages(before(1), before(0))
    saved = at(written, 7)
    assert saved["rescues"] == [before(2).isoformat()] and saved["current"] == 12 and saved["shields"] == 0
    # The missed day is written later: nothing needs saving, the streak is a day longer and the shield is still there.
    mended = at(written | pages(before(2)), 7)
    assert (mended["current"], mended["shields"], mended["rescues"]) == (13, 1, [])


def test_a_saved_day_is_no_written_day() -> None:
    saved = at(run(3, 12) | pages(before(1), before(0)), 7)
    assert saved["today_done"] is True and saved["week"]["count"] == 2
    # The ten days that made the shield count; the saved one does not make an eleventh towards the next.
    assert saved["current"] == 12


def test_a_long_page_gives_a_shield_but_one_in_a_week() -> None:
    assert at(pages(before(0)), 7)["shields"] == 0
    assert at(pages(before(0), words=LONG), 7)["shields"] == 1
    assert at(pages(before(0), words=LONG - 1), 7)["shields"] == 0
    # Wednesday and Tuesday of the same week: one shield. Tuesday of the week before: a second.
    assert at({before(0): LONG, before(1): LONG + 50}, 7)["shields"] == 1
    assert at({before(3): LONG, before(2): 5, before(1): 5, before(0): LONG}, 7)["shields"] == 2


def test_a_long_page_week_turns_on_monday_not_on_the_streak() -> None:
    today = date(2026, 10, 12)  # a Monday
    sunday, monday = date(2026, 10, 11), today
    assert streaks.compute({sunday: LONG, monday: LONG}, today, 7)["shields"] == 2
    assert streaks.compute({date(2026, 10, 10): LONG, sunday: LONG}, today, 7)["shields"] == 1


def test_a_week_across_new_year_is_one_week_for_the_shield() -> None:
    # ISO week 53 of 2026 runs from Monday 28 December to Sunday 3 January.
    today = date(2027, 1, 4)
    same = {date(2026, 12, 29): LONG, date(2026, 12, 30): 5, date(2026, 12, 31): 5, date(2027, 1, 1): LONG}
    assert streaks.compute(same, date(2027, 1, 2), 7)["shields"] == 1
    across = {date(2026, 12, 29) + timedelta(days=n): 5 for n in range(7)}
    across |= {date(2026, 12, 29): LONG, date(2027, 1, 4): LONG}
    assert streaks.compute(across, today, 7)["shields"] == 2


def test_the_shield_of_a_long_page_saves_a_day_too() -> None:
    written = pages(before(3), before(2), before(0), words=5) | {before(3): LONG}
    found = at(written, 7)
    assert (found["current"], found["shields"], found["rescues"]) == (3, 0, [before(1).isoformat()])


def test_the_saved_days_are_told_newest_first_and_only_the_last_five() -> None:
    # Seven weeks that each begin with a long page, miss the Tuesday and go on from Wednesday: seven saved Tuesdays.
    sunday = date(2026, 10, 11)
    written: dict[date, int] = {}
    for weeks_ago in range(7):
        monday = streaks.monday_of(sunday) - timedelta(weeks=weeks_ago)
        written[monday] = LONG
        for offset in range(2, 7):
            written[monday + timedelta(days=offset)] = 5
    found = streaks.compute(written, sunday, 7)
    tuesdays = [streaks.monday_of(sunday) - timedelta(weeks=weeks_ago) + timedelta(days=1) for weeks_ago in range(7)]
    assert found["rescues"] == [day.isoformat() for day in tuesdays[:5]]
    assert found["current"] == 42


def test_the_longest_streak_takes_the_later_of_equal_runs_and_counts_over_saved_days() -> None:
    days = pages(before(40), before(39), before(38), before(20), before(19), before(18), before(10))
    found = at(days, 7)
    assert (found["longest"], found["longest_end"]) == (3, before(18).isoformat())
    # A saved day keeps one run together: 10 days, a saved one, 3 more.
    held = at(run(20, 29) | run(16, 18), 7)
    assert held["longest"] == 13 and held["longest_end"] == before(16).isoformat()


# --- Goal 3: weeks in a row ---------------------------------------------------------------------------------------------


def test_at_goal_3_weeks_in_a_row_count_whatever_the_days() -> None:
    # Wednesday, Thursday, Saturday in a week count the same as Monday, Tuesday, Wednesday.
    monday = streaks.monday_of(WEDNESDAY) - timedelta(weeks=1)
    scattered = pages(monday + timedelta(days=2), monday + timedelta(days=3), monday + timedelta(days=5))
    found = at(scattered | week(2, 3), 3)
    assert (found["unit"], found["current"], found["longest"]) == ("weeks", 2, 2)
    assert at(scattered | week(2, 3), 3)["longest_end"] == monday.isoformat()


def test_the_running_week_breaks_nothing_while_the_goal_is_in_reach() -> None:
    # Wednesday, nothing written yet this week: Wednesday to Sunday are five days for three pages.
    found = at(weeks(3, 3), 3)
    assert (found["current"], found["week"]) == (2, {"count": 0, "goal": 3})


def test_the_running_week_counts_as_soon_as_the_goal_is_reached() -> None:
    found = at(weeks(3, 3) | week(0, 3), 3)
    assert (found["current"], found["week"]["count"], found["today_done"]) == (3, 3, True)


def test_the_running_week_is_lost_when_the_days_left_are_too_few() -> None:
    # Saturday: Saturday and Sunday are two days for three pages.
    saturday = date(2026, 10, 10)
    lost = streaks.compute(weeks(3, 3, today=saturday), saturday, 3)
    assert lost["current"] == 0 and lost["longest"] == 2
    # With two pages in the week (Monday, Tuesday) one more on the two days left is still in reach.
    reach = streaks.compute(weeks(3, 3, today=saturday) | week(0, 2, saturday), saturday, 3)
    assert reach["current"] == 2
    # Sunday, today open, one page missing: today is the last day and still counts; written it would be reached.
    sunday = date(2026, 10, 11)
    last_day = streaks.compute(weeks(3, 3, today=sunday) | week(0, 2, sunday), sunday, 3)
    assert last_day["current"] == 2
    assert streaks.compute(weeks(3, 3, today=sunday) | week(0, 2, sunday) | pages(sunday), sunday, 3)["current"] == 3
    # Sunday, today written, two pages in the week: nothing left to write.
    done = streaks.compute(weeks(3, 3, today=sunday) | week(0, 1, sunday) | pages(sunday), sunday, 3)
    assert done["current"] == 0


def test_a_running_week_with_enough_days_left_after_a_written_today() -> None:
    # Thursday, today written, one page earlier: Friday to Sunday are three days for the one missing.
    thursday = date(2026, 10, 8)
    found = streaks.compute(weeks(3, 3, today=thursday) | week(0, 1, thursday) | pages(thursday), thursday, 3)
    assert found["current"] == 2 and found["week"]["count"] == 2


def test_four_weeks_in_a_row_give_a_shield_at_goal_3() -> None:
    assert at(weeks(3, 3, 3), 3)["shields"] == 0
    assert at(weeks(3, 3, 3, 3), 3)["shields"] == 1
    assert at(weeks(*[3] * 8), 3)["shields"] == 2


def test_a_missed_week_is_saved_by_a_shield_at_goal_3() -> None:
    # Four weeks earn the shield, one week fails (2 pages), then a good one.
    written = weeks(3, 3, 3, 3, 2, 3, ending=1)
    found = at(written, 3)
    assert (found["current"], found["longest"], found["shields"]) == (5, 5, 0)
    assert found["rescues"] == [(streaks.monday_of(WEDNESDAY) - timedelta(weeks=2)).isoformat()]


def test_two_missed_weeks_with_one_shield_break_the_streak_at_goal_3() -> None:
    written = weeks(3, 3, 3, 3, 2, 0, 3, ending=1)
    found = at(written, 3)
    assert (found["current"], found["longest"], found["shields"], found["rescues"]) == (1, 4, 0, [])


def test_a_week_with_no_page_at_all_counts_as_missed() -> None:
    saved = at(weeks(3, 3, 3, 3, 0, 3, ending=1), 3)
    assert saved["current"] == 5 and saved["shields"] == 0
    assert len(saved["rescues"]) == 1


def test_a_long_page_in_a_failed_week_saves_that_week_at_goal_3() -> None:
    written = weeks(3, 3, ending=2) | week(1, 1, words=LONG)
    found = at(written, 3)
    assert (found["current"], found["shields"]) == (2, 0)
    assert found["rescues"] == [(streaks.monday_of(WEDNESDAY) - timedelta(weeks=1)).isoformat()]


def test_after_the_week_has_ended_a_week_is_judged_by_its_whole() -> None:
    # Two pages: one short of three. The week is over, there is nothing to wait for.
    assert at(weeks(3, 3, 2, ending=1), 3)["current"] == 0


def test_the_old_history_is_a_streak_of_its_own() -> None:
    old = weeks(3, 3, 3, 3, ending=40)
    found = at(old | weeks(3, 3, ending=1), 3)
    assert found["current"] == 2 and found["longest"] == 4


# --- Goal 1 ---------------------------------------------------------------------------------------------------------------


def test_at_goal_1_one_page_in_a_week_is_enough() -> None:
    found = at(weeks(1, 1, 1, 1), 1)
    assert (found["current"], found["shields"], found["week"]) == (4, 1, {"count": 0, "goal": 1})
    # The running week with a page counts; without one it waits for as long as a day is left.
    assert at(weeks(1, 1) | pages(WEDNESDAY), 1)["current"] == 3
    sunday = date(2026, 10, 11)
    assert streaks.compute(weeks(1, 1, today=sunday), sunday, 1)["current"] == 2


def test_at_goal_1_a_week_without_a_page_is_lost_when_it_is_over() -> None:
    old = week(2, 1)
    # Two weeks ago a page, last week nothing, this week open: no shield, so it broke.
    assert at(old, 1)["current"] == 0
    assert at(old | week(2, 1) | weeks(1, ending=3), 1)["current"] == 0


def test_the_same_pages_are_judged_by_the_goal_of_today() -> None:
    written = weeks(2, 2, 2, 2, 7)
    assert [at(written, goal)["current"] for goal in (1, 2, 3, 7)] == [5, 5, 1, 0]


def test_a_goal_of_7_over_scattered_weeks_is_days_not_weeks() -> None:
    assert at(weeks(3, 3, 3), 7)["current"] == 0


# --- Words ------------------------------------------------------------------------------------------------------------------


def test_words_leave_out_the_pictures_and_short_texts_are_not_counted_word_by_word() -> None:
    picture = PICTURE * 5
    assert diary.words_in("Heute war ein guter Tag. " + picture) == 5
    assert streaks.words_of("Heute war ein guter Tag. ") == 1  # short enough not to count words at all
    # Long on paper: the pictures alone are more than 300 words, the text 299.
    assert streaks.words_of(("wort " * (LONG - 1)) + picture) == LONG - 1
    assert streaks.words_of(("wort " * LONG) + picture) == LONG
    assert streaks.words_of("   ") is None and streaks.words_of(None) is None


# --- With the diary ---------------------------------------------------------------------------------------------------------


def seed(who: Account, days: dict[str, dict[str, Any]]) -> None:
    dek = vault.dek_for(who.id)
    now = clock.now()
    with SessionLocal() as db:
        for day, content in days.items():
            full = {**diary.empty_day(), **content}
            db.add(Day(user_id=who.id, date=day, revision=0, created_at=now, updated_at=now,
                       content_enc=vault.seal_json(dek, full, diary._day_aad(who.id, day))))
        db.commit()


def zone(client: TestClient, name: str = "UTC") -> None:
    assert client.put("/api/me/preferences", json={"timezone": name}).status_code == 200


def goal(client: TestClient, value: int) -> None:
    assert client.put("/api/me/preferences", json={"goal": value}).status_code == 200


def iso(day: date) -> str:
    return day.isoformat()


def test_the_goal_is_kept_with_the_account_and_checked(client: TestClient, account: Account) -> None:
    assert client.get("/api/auth/me").json()["profile"]["goal"] == 7
    for wrong in (0, 8, True, "3", 2.5, None, [3]):
        answer = client.put("/api/me/preferences", json={"goal": wrong})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "bad_preference", wrong
    assert client.put("/api/me/preferences", json={"goal": 3}).json()["goal"] == 3
    assert client.get("/api/auth/me").json()["profile"]["goal"] == 3
    client.put("/api/me/preferences", json={"mode": "dark"})
    assert client.get("/api/auth/me").json()["profile"]["goal"] == 3


def test_today_and_the_statistics_say_the_same_in_the_unit_of_the_goal(client: TestClient, account: Account) -> None:
    zone(client)
    seed(account, {iso(day): {"text": "ein Tag"} for day in
                   [*week(1, 3), *week(2, 3), *week(3, 3)]})
    days_view = client.get("/api/today").json()
    assert days_view["streak"] == 0 and days_view["series"]["unit"] == "days"
    goal(client, 3)
    today = client.get("/api/today").json()
    assert today["streak"] == 3 == today["series"]["current"]
    assert (today["series"]["unit"], today["series"]["goal"], today["series"]["week"]) == ("weeks", 3, {"count": 0, "goal": 3})
    tiles = client.get("/api/stats").json()["tiles"]
    assert (tiles["unit"], tiles["goal"], tiles["current"], tiles["longest"], tiles["shields"]) == ("weeks", 3, 3, 3, 0)
    assert tiles["rescues"] == [] and tiles["week"] == {"count": 0, "goal": 3}
    goal(client, 7)
    assert client.get("/api/stats").json()["tiles"]["unit"] == "days"
    assert client.get("/api/stats").json()["tiles"]["current"] == 0


def test_a_page_written_now_moves_the_week(client: TestClient, account: Account) -> None:
    zone(client)
    goal(client, 3)
    assert client.get("/api/today").json()["series"]["week"]["count"] == 0
    assert client.put(f"/api/days/{iso(WEDNESDAY)}", json={"text": "heute"}).status_code == 200
    assert client.get("/api/today").json()["series"]["week"]["count"] == 1
    assert client.delete(f"/api/days/{iso(WEDNESDAY)}").status_code == 204
    assert client.get("/api/today").json()["series"]["week"]["count"] == 0


def test_an_automatic_draft_and_a_page_without_text_count_for_nothing(client: TestClient, account: Account) -> None:
    zone(client)
    goal(client, 1)
    assert client.put(f"/api/days/{iso(before(1))}/draft", json={"text": "Entwurf", "base_revision": -1}).status_code == 200
    mood = client.get("/api/values").json()[0]["id"]
    client.put(f"/api/days/{iso(before(0))}/values", json={"values": {mood: 5}})
    series = client.get("/api/today").json()["series"]
    assert (series["current"], series["week"]["count"], series["today_done"]) == (0, 0, False)


def test_a_long_page_with_pictures_does_not_count_its_pictures(client: TestClient, account: Account) -> None:
    zone(client)
    picture = PICTURE * 5
    seed(account, {iso(before(0)): {"text": ("wort " * 100) + picture}})
    assert client.get("/api/today").json()["series"]["shields"] == 0
    seed(account, {iso(before(1)): {"text": ("wort " * LONG) + picture}})
    assert client.get("/api/today").json()["series"]["shields"] == 1


def test_the_week_follows_the_persons_time_zone(client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    # Sunday 11 October 22:00 UTC is already Monday 12 October in Auckland: a new week, a new count.
    late = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    monkeypatch.setattr(clock, "now", lambda: late)
    seed(account, {"2026-10-11": {"text": "sonntag"}, "2026-10-10": {"text": "samstag"}})
    goal(client, 3)
    zone(client, "Pacific/Auckland")
    auckland = client.get("/api/today").json()
    assert auckland["date"] == "2026-10-12" and auckland["series"]["week"]["count"] == 0
    zone(client, "UTC")
    utc = client.get("/api/today").json()
    assert utc["date"] == "2026-10-11" and utc["series"]["week"]["count"] == 2


def test_only_the_own_pages_count(client: TestClient, account: Account) -> None:
    zone(client)
    seed(account, {iso(before(0)): {"text": "ich"}})
    with person("tom") as tom:
        tom.put("/api/me/preferences", json={"timezone": "UTC", "goal": 1})
        seed(_named("tom"), {iso(before(n)): {"text": "tom schreibt"} for n in range(9)})
        theirs = tom.get("/api/today").json()["series"]
        assert (theirs["current"], theirs["unit"]) == (2, "weeks")
    mine = client.get("/api/today").json()["series"]
    assert (mine["current"], mine["unit"], mine["goal"]) == (1, "days", 7)
    assert client.get("/api/stats").json()["tiles"]["days_total"] == 1


def _named(name: str) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=name).one()
        db.expunge(row)
    return row


def test_a_statistic_without_login_is_refused(client: TestClient) -> None:
    with TestClient(client.app) as stranger:
        assert stranger.get("/api/today").status_code == 401
        assert stranger.get("/api/stats").status_code == 401


def test_3000_days_stay_in_good_time_with_shields_and_a_goal(client: TestClient, account: Account) -> None:
    zone(client)
    goal(client, 3)
    days = {}
    for n in range(3000):
        day = before(n)
        if day.weekday() < 3 or n % 11 == 0:
            days[iso(day)] = {"text": ("ein längerer Text " * 120) if n % 5 == 0 else "kurz"}
    seed(account, days)
    started = time.process_time()
    found = client.get("/api/today").json()
    took = time.process_time() - started
    print(f"3000 days of streak: {took:.3f} s of work")
    assert found["series"]["unit"] == "weeks" and found["series"]["current"] > 0
    assert took < 3.0, took
