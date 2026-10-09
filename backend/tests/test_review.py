"""Looking back: weeks and months in the person's time zone, the period before, the best day (the younger one when two
are equal), without values and without pages, how far the arrows go, the strip on "Today" from Monday to Wednesday
and from the 1st to the 3rd, the summary with a stand-in for the model (a full month is cut, not refused), the shelf's
volumes and the journal by year; and only ever the own days."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.services import ai, journal, review, settings_service

from .conftest import new_client, person

#: Friday 9 October 2026, noon in UTC.
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fixed(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    moment = [NOW]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    yield moment


def write(client: TestClient, day: str, title: str = "Ein Tag", text: str = "Ein paar Worte.", **extra: Any) -> None:
    answer = client.put(f"/api/days/{day}", json={"title": title, "text": text, **extra})
    assert answer.status_code == 200, answer.text


def mood(client: TestClient) -> str:
    return client.get("/api/values").json()[0]["id"]


def get(client: TestClient, kind: str, start: str = "") -> dict[str, Any]:
    answer = client.get(f"/api/review/{kind}", params={"start": start} if start else {})
    assert answer.status_code == 200, answer.text
    return answer.json()


# --- Periods --------------------------------------------------------------------------------------------------------


def test_periods_are_weeks_from_monday_and_calendar_months() -> None:
    assert review.align("week", date(2026, 10, 4)) == date(2026, 9, 28)  # a Sunday
    assert review.align("week", date(2026, 10, 5)) == date(2026, 10, 5)  # a Monday
    assert review.end_of("month", date(2028, 2, 1)) == date(2028, 2, 29)
    assert review.end_of("month", date(2026, 12, 1)) == date(2026, 12, 31)
    assert review.shift("month", date(2026, 1, 1), -1) == date(2025, 12, 1)
    assert review.latest("week", date(2026, 10, 9)) == date(2026, 9, 28)
    assert review.latest("month", date(2026, 10, 1)) == date(2026, 9, 1)


def test_the_week_is_the_week_of_the_persons_time_zone(fixed: list[datetime]) -> None:
    # Monday 5 October, 23:30 in UTC: already Tuesday in Tokyo, still Monday in New York. Last week is the same, but
    # Sunday night's page counts as the week it was written in where the person lives.
    fixed[0] = datetime(2026, 10, 4, 23, 30, tzinfo=UTC)
    with person("jule") as jule:
        jule.put("/api/me/preferences", json={"timezone": "Asia/Tokyo"})
        # In Tokyo it is Monday 5 October: last week is 28 September to 4 October.
        assert get(jule, "week")["start"] == "2026-09-28"
        jule.put("/api/me/preferences", json={"timezone": "America/New_York"})
        # In New York it is still Sunday 4 October: last week is 21 to 27 September.
        assert get(jule, "week")["start"] == "2026-09-21"


def test_a_week_shows_seven_days_its_pages_and_the_days_left_free() -> None:
    with person("jule") as jule:
        write(jule, "2026-09-28", "Montag")
        write(jule, "2026-10-04", "Sonntag")
        write(jule, "2026-10-05", "Schon die neue Woche")
        week = get(jule, "week")
    assert [day["date"] for day in week["days"]] == [f"2026-{d}" for d in (
        "09-28", "09-29", "09-30", "10-01", "10-02", "10-03", "10-04")]
    assert week["written"] == 2 and week["total"] == 7
    assert week["days"][0]["page"]["title"] == "Montag" and week["days"][1]["page"] is None
    assert week["days"][6]["page"]["cover"].startswith("illu:")


def test_mean_and_the_period_before_and_the_best_day_younger_on_a_tie() -> None:
    with person("jule") as jule:
        value = mood(jule)
        write(jule, "2026-09-21", "Vorwoche", values={value: 4})
        write(jule, "2026-09-22", "Vorwoche 2", values={value: 6})
        write(jule, "2026-09-28", "Gut", values={value: 8})
        write(jule, "2026-09-30", "Auch gut", values={value: 8})
        write(jule, "2026-10-01", "Mittel", values={value: 5})
        # Rated, but no page: counts for the mean and the line, never as the best day.
        jule.put("/api/days/2026-10-02/values", json={"values": {value: 10}})
        week = get(jule, "week")
    assert week["value"]["name"] in ("Stimmung", "Mood")
    assert week["mean"] == round((8 + 8 + 5 + 10) / 4, 2)
    assert week["mean_before"] == 5.0
    assert week["best"]["date"] == "2026-09-30" and week["best"]["value"] == 8
    assert [day["value"] for day in week["days"]] == [8, None, 8, 5, 10, None, None]
    assert week["written"] == 3


def test_a_week_without_values_and_one_without_pages() -> None:
    with person("jule") as jule:
        for item in jule.get("/api/values").json():
            jule.put(f"/api/values/{item['id']}", json={"active": False})
        write(jule, "2026-09-29", "Ohne Wert", tags=["garten", "arbeit"])
        write(jule, "2026-09-30", "Noch einer", tags=["garten"])
        week = get(jule, "week")
        empty = get(jule, "week", "2026-09-21")
    assert week["value"] is None and week["mean"] is None and week["best"] is None
    assert week["tags"] == [{"tag": "garten", "count": 2}, {"tag": "arbeit", "count": 1}]
    assert week["words"] == 6
    assert empty["written"] == 0 and empty["best"] is None and empty["tags"] == [] and empty["words"] == 0


def test_a_month_counts_its_days_photos_and_compares_with_the_month_before() -> None:
    with person("jule") as jule:
        value = mood(jule)
        write(jule, "2026-08-31", "August", values={value: 3})
        write(jule, "2026-09-01", "Erster", values={value: 7})
        write(jule, "2026-09-30", "Letzter", values={value: 9})
        answer = jule.post("/api/photos", params={"upload_id": "0b3c1d7e-0000-4000-8000-000000000001",
                                                  "date": "2026-09-15"}, content=_jpeg())
        assert answer.status_code == 201
        month = get(jule, "month")
    assert month["start"] == "2026-09-01" and month["end"] == "2026-09-30" and month["total"] == 30
    assert month["written"] == 2 and month["photos"] == 1
    assert month["mean"] == 8.0 and month["mean_before"] == 3.0
    assert month["best"]["date"] == "2026-09-30"


def test_the_arrows_reach_back_to_the_first_page_and_forward_to_the_last_period_over() -> None:
    with person("jule") as jule:
        newest = get(jule, "week")
        assert newest["prev"] is None and newest["next"] is None
        write(jule, "2026-09-16", "Früher")
        newest = get(jule, "week")
        assert newest["prev"] == "2026-09-21" and newest["next"] is None
        first = get(jule, "week", "2026-09-14")
        assert first["prev"] is None and first["next"] == "2026-09-21"
        # This week is not over: it is not there yet, nor anything later, nor a day that is no Monday.
        for start in ("2026-10-05", "2026-10-12", "2026-09-29"):
            assert jule.get("/api/review/week", params={"start": start}).status_code == 404
        assert jule.get("/api/review/month", params={"start": "2026-10-01"}).status_code == 404
        assert jule.get("/api/review/month", params={"start": "2026-09-02"}).status_code == 404
        assert jule.get("/api/review/month", params={"start": "1899-12-01"}).status_code == 404
        assert jule.get("/api/review/month", params={"start": "2026-13-01"}).status_code == 422
        assert jule.get("/api/review/year").status_code == 422


def test_only_the_own_days_and_only_signed_in() -> None:
    with person("jule") as jule, person("ben") as ben:
        write(ben, "2026-09-29", "Bens Woche", tags=["geheim"])
        week = get(jule, "week")
        assert week["written"] == 0 and week["tags"] == []
        assert jule.get("/api/review/teaser").json()["teaser"] is None
    with new_client() as anonymous:
        assert anonymous.get("/api/review/week").status_code == 401
        assert anonymous.get("/api/review/teaser").status_code == 401
        assert anonymous.post("/api/review/week/summary", json={"start": "2026-09-28"}).status_code == 401


# --- The strip on "Today" -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("today", "kind"), [
    (datetime(2026, 10, 5, 9, 0, tzinfo=UTC), "week"),  # Monday
    (datetime(2026, 10, 7, 21, 0, tzinfo=UTC), "week"),  # Wednesday
    (datetime(2026, 10, 8, 9, 0, tzinfo=UTC), None),  # Thursday
    (datetime(2026, 10, 11, 9, 0, tzinfo=UTC), None),  # Sunday
    (datetime(2026, 10, 1, 9, 0, tzinfo=UTC), "month"),  # Thursday the 1st
    (datetime(2026, 10, 3, 9, 0, tzinfo=UTC), "month"),  # the 3rd
    (datetime(2026, 10, 4, 9, 0, tzinfo=UTC), None),  # the 4th, a Sunday
    (datetime(2026, 6, 1, 9, 0, tzinfo=UTC), "month"),  # Monday the 1st: the month wins
])
def test_the_strip_shows_early_in_the_week_and_early_in_the_month(fixed: list[datetime], today: datetime,
                                                                   kind: str | None) -> None:
    fixed[0] = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
    with person("jule") as jule:
        jule.put("/api/me/preferences", json={"timezone": "UTC"})
        for day in ("2026-05-20", "2026-05-26", "2026-05-29", "2026-09-10", "2026-09-30", "2026-10-02"):
            write(jule, day)
        fixed[0] = today
        teaser = jule.get("/api/review/teaser").json()["teaser"]
    if kind is None:
        assert teaser is None
        return
    assert teaser["kind"] == kind
    if kind == "week":
        assert teaser["start"] == "2026-09-28" and teaser["written"] == 2 and len(teaser["covers"]) == 7
        assert teaser["covers"][1] is None and teaser["covers"][2]["date"] == "2026-09-30"
    elif today.month == 10:
        assert teaser["start"] == "2026-09-01" and teaser["written"] == 2 and teaser["total"] == 30
    else:
        assert teaser["start"] == "2026-05-01" and teaser["written"] == 3


def test_the_strip_needs_a_page_and_falls_back_to_the_week(fixed: list[datetime]) -> None:
    with person("jule") as jule:
        jule.put("/api/me/preferences", json={"timezone": "UTC"})
        fixed[0] = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)  # Monday the 1st, nothing in May
        assert jule.get("/api/review/teaser").json()["teaser"] is None
        fixed[0] = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
        write(jule, "2026-05-31", "Sonntag")
        fixed[0] = datetime(2026, 6, 2, 9, 0, tzinfo=UTC)
        # The 2nd, a Tuesday: May has a page, so the month; with June 1st as a Monday, last week holds the 31st too.
        assert jule.get("/api/review/teaser").json()["teaser"]["kind"] == "month"


# --- The summary ----------------------------------------------------------------------------------------------------


class Model:
    """A stand-in for the AI service: answers with a fixed text and keeps what it was sent."""

    def __init__(self, answer: str = "Eine ruhige Woche. Ich war viel im Garten.") -> None:
        self.answer = answer
        self.sent: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": self.answer}}]})


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> Model:
    found = Model()
    monkeypatch.setattr(ai, "transport", httpx.MockTransport(found))
    monkeypatch.setattr(ai, "resolver", lambda host, port: ["127.0.0.1"])
    with SessionLocal() as db:
        settings_service.save(db, {"ai_provider": "local", "ai_url": "http://127.0.0.1:11434/v1/",
                                   "ai_model": "tiny"})
    return found


def test_the_summary_comes_from_the_pages_of_the_period_and_is_not_kept(model: Model) -> None:
    with person("jule") as jule:
        jule.put("/api/me/language", json={"language": "de"})
        write(jule, "2026-09-28", "Garten", "Im **Garten** gewesen. ![x](photo:" + "a" * 32 + ")")
        write(jule, "2026-10-05", "Neue Woche", "Gehört nicht dazu.")
        answer = jule.post("/api/review/week/summary", json={"start": "2026-09-28"})
        again = get(jule, "week")
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"text": "Eine ruhige Woche. Ich war viel im Garten."}
    system, user = model.sent[0]["messages"][0]["content"], model.sent[0]["messages"][1]["content"]
    assert "Never invent anything" in system and "first person" in system and "German" in system
    assert "two to four sentences" in system
    assert "Im Garten gewesen." in user and "Gehört nicht dazu" not in user and "photo:" not in user
    assert '"weekday": "Monday"' in user
    assert "summary" not in json.dumps(again)


def test_a_full_month_of_long_pages_is_cut_to_fit_and_never_refused(model: Model) -> None:
    long = " ".join(["Wort"] * 6_000)
    with person("jule") as jule:
        for day in range(1, 31):
            write(jule, f"2026-09-{day:02d}", f"Tag {day}", long + f" Ende{day}")
        answer = jule.post("/api/review/month/summary", json={"start": "2026-09-01"})
    assert answer.status_code == 200, answer.text
    user = model.sent[0]["messages"][1]["content"]
    assert len(user) <= ai.MAX_CHARS
    assert "three to six sentences" in model.sent[0]["messages"][0]["content"]
    # Every day is still there, each cut to its share.
    for day in range(1, 31):
        assert f"Tag {day}" in user
    assert "Ende30" not in user


def test_shares_give_short_pages_all_and_long_ones_the_rest() -> None:
    assert review.shares([10, 20], 100) == [10, 20]
    assert review.shares([10, 1000, 1000], 610, floor=0) == [10, 300, 300]
    assert review.shares([5000] * 4, 1000) == [250] * 4
    assert review.shares([5000] * 4, 100) == [200] * 4  # never below the floor


def test_the_summary_is_refused_like_writing_up_when_the_ai_is_off(model: Model) -> None:
    with person("jule") as jule:
        write(jule, "2026-09-28")
        jule.put("/api/me/preferences", json={"ai": False})
        answer = jule.post("/api/review/week/summary", json={"start": "2026-09-28"})
        assert answer.status_code == 403 and answer.json()["detail"]["code"] == "ai_switched_off"
        jule.put("/api/me/preferences", json={"ai": True})
        empty = jule.post("/api/review/week/summary", json={"start": "2026-09-21"})
        assert empty.status_code == 409 and empty.json()["detail"]["code"] == "ai_no_pages"
        future = jule.post("/api/review/week/summary", json={"start": "2026-10-05"})
        assert future.status_code == 404
    assert len(model.sent) == 0
    with SessionLocal() as db:
        settings_service.save(db, {"ai_provider": "none"})
    with person("ben") as ben:
        write(ben, "2026-09-28")
        off = ben.post("/api/review/week/summary", json={"start": "2026-09-28"})
    assert off.status_code == 403 and off.json()["detail"]["code"] == "ai_off"


def test_a_model_that_writes_a_title_and_marks_gives_plain_paragraphs() -> None:
    assert ai.clean_summary("Title: Woche\n\nEine **gute** Woche.\n\n\n\nMit *Regen*.") == (
        "Eine gute Woche.\n\nMit Regen.")
    assert len(ai.clean_summary("Wort " * 2_000)) <= ai.SUMMARY_KEPT + 2


# --- The shelf and the journal by year ------------------------------------------------------------------------------


def test_the_shelf_counts_pages_per_year_with_leap_years() -> None:
    with person("jule") as jule:
        for day in ("2024-02-29", "2024-03-01", "2025-07-07", "2026-01-01", "2026-10-08"):
            write(jule, day)
        jule.put("/api/days/2023-05-05/values", json={"values": {mood(jule): 5}})  # no page: no volume
        overview = jule.get("/api/journal/overview").json()
    assert overview["year"] == 2026
    assert overview["volumes"] == [
        {"year": 2024, "pages": 2, "days": 366, "months": [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]},
        {"year": 2025, "pages": 1, "days": 365, "months": [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]},
        {"year": 2026, "pages": 2, "days": 365, "months": [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]},
    ]
    assert journal.days_in_year(2100) == 365 and journal.days_in_year(2000) == 366


def test_the_journal_filters_by_year_on_the_server() -> None:
    with person("jule") as jule:
        for day in ("2024-12-31", "2025-01-01", "2025-06-06", "2026-01-01"):
            write(jule, day, f"Seite {day}")
        only = jule.post("/api/journal", json={"year": 2025, "limit": 1}).json()
        rest = jule.post("/api/journal", json={"year": 2025, "limit": 1, "before": only["days"][0]["date"]}).json()
        everything = jule.post("/api/journal", json={}).json()
        bad = jule.post("/api/journal", json={"year": 1800})
    assert [day["date"] for day in only["days"]] == ["2025-06-06"] and only["more"] is True
    assert [day["date"] for day in rest["days"]] == ["2025-01-01"] and rest["more"] is False
    assert len(everything["days"]) == 4
    assert bad.status_code == 422


def _jpeg() -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 122, 82)).save(out, "JPEG")
    return out.getvalue()


def test_the_strip_follows_the_persons_time_zone_at_the_edge_of_a_day(fixed: list[datetime]) -> None:
    with person("jule") as jule:
        write(jule, "2026-09-30", "Mittwoch")
        # Sunday 4 October, 23:30 in UTC: already Monday in Berlin, still Sunday in UTC.
        fixed[0] = datetime(2026, 10, 4, 23, 30, tzinfo=UTC)
        jule.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
        teaser = jule.get("/api/review/teaser").json()["teaser"]
        assert teaser is not None and teaser["kind"] == "week" and teaser["start"] == "2026-09-28"
        jule.put("/api/me/preferences", json={"timezone": "UTC"})
        assert jule.get("/api/review/teaser").json()["teaser"] is None
