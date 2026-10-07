"""The journal: the own days page by page, with a tag or without, the tags over all days, the start of each text,
and the search with the days it found. Only ever the own; the clock stands still."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.models import Account
from app.services import diary, journal

from .conftest import person

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    yield


def days(client: TestClient, count: int, *, tag_every: int = 0) -> list[str]:
    """``count`` days back from 6 October, the newest first; every ``tag_every``-th carries the tag ``see``."""
    made = []
    for index in range(count):
        date = f"2026-{9 - index // 28:02d}-{28 - index % 28:02d}" if index >= 6 else f"2026-10-{6 - index:02d}"
        tags = ["see"] if tag_every and index % tag_every == 0 else ["arbeit"]
        assert client.put(f"/api/days/{date}", json={"title": f"Tag {index}", "text": f"Text {index}",
                                                     "tags": tags}).status_code == 200
        made.append(date)
    return sorted(made, reverse=True)


def test_the_journal_goes_back_page_by_page_and_says_when_there_is_more(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    made = days(client, 7)
    first = client.post("/api/journal", json={"limit": 3}).json()
    assert [item["date"] for item in first["days"]] == made[:3] and first["more"] is True
    second = client.post("/api/journal", json={"limit": 3, "before": first["days"][-1]["date"]}).json()
    assert [item["date"] for item in second["days"]] == made[3:6] and second["more"] is True
    last = client.post("/api/journal", json={"limit": 3, "before": second["days"][-1]["date"]}).json()
    assert [item["date"] for item in last["days"]] == made[6:] and last["more"] is False
    exact = client.post("/api/journal", json={"limit": 7}).json()
    assert len(exact["days"]) == 7 and exact["more"] is False
    for wrong in ({"limit": 0}, {"limit": journal.PAGE_MAX + 1}, {"before": "gestern"}, {"before": "2027-01-01"},
                  {"unknown": 1}):
        assert client.post("/api/journal", json=wrong).status_code == 422, wrong


def test_a_journal_page_opens_only_the_days_it_shows(client: TestClient, account: Account,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    days(client, 7)
    opened: list[str] = []
    original = diary._readable_content

    def counting(account_id: int, dek: bytes, day: str, sealed: bytes) -> object:
        opened.append(day)
        return original(account_id, dek, day, sealed)

    monkeypatch.setattr(diary, "_readable_content", counting)
    client.post("/api/journal", json={"limit": 2})
    # The two shown, and the one after them: that is how the page knows there is more.
    assert len(opened) == 3


def test_a_tag_filters_across_as_many_days_as_it_takes(client: TestClient, account: Account,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    made = days(client, 9, tag_every=3)
    tagged = [made[index] for index in (0, 3, 6)]
    # Small batches: the filter has to go on past the first one.
    monkeypatch.setattr(journal, "BATCH", 2)
    first = client.post("/api/journal", json={"limit": 2, "tag": "#See"}).json()
    assert [item["date"] for item in first["days"]] == tagged[:2] and first["more"] is True
    rest = client.post("/api/journal", json={"limit": 2, "tag": "see", "before": tagged[1]}).json()
    assert [item["date"] for item in rest["days"]] == tagged[2:] and rest["more"] is False
    assert client.post("/api/journal", json={"tag": "nirgends"}).json() == {"days": [], "more": False}
    assert client.post("/api/journal", json={"tag": "x" * 200}).status_code == 422
    # Nothing left once cleaned: no filter, never a fault of the server.
    everything = client.post("/api/journal", json={"limit": 60}).json()
    for empty in ("\t", "\n", "\x00", " # ", "\x7f\r"):
        answer = client.post("/api/journal", json={"limit": 60, "tag": empty})
        assert answer.status_code == 200 and answer.json() == everything, repr(empty)


def test_an_entry_carries_what_the_list_draws(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    mood = client.get("/api/values").json()[0]
    client.put("/api/days/2026-10-05", json={
        "title": "Am See", "text": "## Morgens\n\n> Ein **langer** *Tag*, mit \\*Sternen\\* und snake_case.\n\n- eins\n- zwei",
        "tags": ["urlaub"], "values": {mood["id"]: 9}, "written_by": "ai"})
    item = client.post("/api/journal", json={}).json()["days"][0]
    assert item == {"date": "2026-10-05", "title": "Am See",
                    "excerpt": "Morgens Ein langer Tag, mit *Sternen* und snake_case. eins zwei",
                    "tags": ["urlaub"], "cover": "illu:strand.abend.herbst", "written_by": "ai",
                    "first_value": {"name": mood["name"], "value": 9}, "shared_with": [], "unreadable": False}
    # The first value asked counts: switched off, the next one.
    client.put(f"/api/values/{mood['id']}", json={"active": False})
    assert client.post("/api/journal", json={}).json()["days"][0]["first_value"] is None


def test_the_start_of_a_long_text_is_cut_at_a_word() -> None:
    text = "Wort " * 200
    cut = diary.excerpt(text)
    assert cut.endswith(" …") and len(cut) <= diary.EXCERPT_MAX + 2 and "Wor …" not in cut
    assert diary.plain_text("Zeile eins\\\nZeile zwei") == "Zeile eins Zeile zwei"
    assert diary.plain_text("1. erst\n2. dann\n\n### tief") == "erst dann tief"


def test_the_overview_counts_days_and_tags(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    assert client.get("/api/journal/overview").json() == {"count": 0, "since": None, "tags": []}
    client.put("/api/days/2026-10-05", json={"title": "Am See", "tags": ["familie", "see"]})
    client.put("/api/days/2026-10-01", json={"text": "Ein Tag.", "tags": ["familie"]})
    client.put("/api/days/2026-09-20", json={"title": "Arbeit", "tags": ["arbeit"]})
    assert client.get("/api/journal/overview").json() == {
        "count": 3, "since": "2026-09-20",
        "tags": [{"tag": "familie", "count": 2}, {"tag": "arbeit", "count": 1}, {"tag": "see", "count": 1}]}


def test_a_day_with_only_values_tags_or_notes_is_no_page_and_stays_out_of_the_journal(
        client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    value = client.get("/api/values").json()[0]["id"]
    client.put("/api/days/2026-10-06/values", json={"values": {value: 6}})
    client.put("/api/days/2026-10-05", json={"tags": ["herbst"]})
    client.put("/api/days/2026-10-04", json={"title": "  ", "text": " \n "})
    client.put("/api/days/2026-10-03", json={"title": "Ein Titel"})
    client.put("/api/days/2026-10-02", json={"text": "Nur Text."})
    assert [item["date"] for item in client.post("/api/journal", json={}).json()["days"]] == ["2026-10-03", "2026-10-02"]
    assert client.post("/api/journal", json={"tag": "herbst"}).json()["days"] == []
    assert client.get("/api/journal/overview").json() == {"count": 2, "since": "2026-10-02", "tags": []}
    # The page of such a day still opens (the statistics and the quick note work with it); it is only not listed.
    assert client.get("/api/days/2026-10-06").status_code == 200


def test_the_journal_goes_on_past_days_without_a_page(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    for day in range(10, 20):
        client.put(f"/api/days/2026-09-{day}", json={"tags": ["leer"]})
    client.put("/api/days/2026-09-01", json={"title": "Der erste"})
    answer = client.post("/api/journal", json={"limit": 1}).json()
    assert [item["date"] for item in answer["days"]] == ["2026-09-01"] and answer["more"] is False


def test_the_search_brings_the_days_it_found(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    client.put("/api/days/2026-10-04", json={"title": "Kastanien am See", "tags": ["herbst"]})
    client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "noch mehr kastanien", "date": "2026-10-06"})
    found = client.post("/api/search", json={"q": "kastanien"}).json()
    assert [(hit["date"], hit["kind"]) for hit in found["results"]] == [("2026-10-06", "note"),
                                                                        ("2026-10-04", "title")]
    assert list(found["days"]) == ["2026-10-04"], "a date with notes only has no page to list"
    assert found["days"]["2026-10-04"]["title"] == "Kastanien am See"


def test_the_journal_is_the_own_only(client: TestClient, account: Account) -> None:
    client.put("/api/me/preferences", json={"timezone": "UTC"})
    client.put("/api/days/2026-10-05", json={"title": "Geheim", "tags": ["privat"]})
    with person("tom") as tom:
        assert tom.post("/api/journal", json={}).json() == {"days": [], "more": False}
        assert tom.get("/api/journal/overview").json() == {"count": 0, "since": None, "tags": []}
        assert tom.post("/api/journal", json={"tag": "privat"}).json()["days"] == []


PATHOLOGIES = {
    "*a ": "*a " * 33_333, "_a ": "_a " * 33_333, "**a ": "**a " * 25_000, "***a ": "***a " * 20_000,
    "> deep": ">" * 100_000, "> spaced": "> " * 50_000, "> a": "> a" * 33_333, "lines": "a\n" * 50_000,
    "quote lines": "> a\n" * 25_000, "*_": "*_" * 50_000,
}


@pytest.mark.parametrize("name", list(PATHOLOGIES))
def test_the_start_of_a_hostile_page_is_made_quickly(name: str) -> None:
    """The largest page there may be, written to be slow: a list of 24 of them must still come at once."""
    import time

    text = PATHOLOGIES[name]
    started = time.perf_counter()
    for _ in range(5):
        cut = diary.excerpt(text)
    assert (time.perf_counter() - started) / 5 < 0.04, name
    assert len(cut) <= diary.EXCERPT_MAX + 2
