"""The statistics of one person, worked out from their own opened days and nothing else.

Every figure here comes from the pages of the signed-in person (``Day`` rows opened with their own data key); no other
person's page, no note and no photo is read, and the operator has no way to ask for somebody else's. Nothing is kept
between two requests: a page of statistics opens every sealed day once, adds it up and forgets it.

The clock is a parameter (``today``), the arithmetic is plain and takes no database, so that the rules can be tested
with fixed days.

Words used here:

* a *page* is a day that opens and exists; a *written* day is a page with text (that is what the streak counts);
* the *main value* is the first value the person asks for (the first active one in their order: mood, ab werk);
* a *group* of days is only compared with another when each holds at least ``MIN_GROUP`` days.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Day, Photo, Share
from . import diary, journal

#: The calendar of the year shows this many weeks, Monday to Sunday, the last one the week of today.
CALENDAR_WEEKS = 26
#: Days the line of one value can show (the interface offers 30, 90 and 180 of them).
SERIES_DAYS = 180
SERIES_RANGES = (30, 90, 180)
#: Days in the span of the best and worst day; ``None`` stands for all days there are.
SPANS: dict[str, int | None] = {"30": 30, "365": 365, "all": None}
#: A claim about what goes together needs at least this many days in each of the two groups.
MIN_GROUP = 5
#: A weekday counts for "the best one" with at least this many rated days, and only when two weekdays do.
MIN_WEEKDAY = 3
#: Mood this high, or higher, is a "good" day of another value.
HIGH = 7
#: Two averages closer than this are said to differ hardly.
SIMILAR = 0.3
#: How many comparisons of each kind are shown.
TOGETHER_VALUES = 3
TOGETHER_TAGS = 2
TOP_TAGS = 8
#: Tags looked at for a comparison before giving up on finding enough that have days in both groups.
TAGS_LOOKED_AT = 12


def year_before(day: date) -> date:
    """The same calendar day one year earlier; 29 February has no such day then and is met by 28 February."""
    try:
        return day.replace(year=day.year - 1)
    except ValueError:
        return day.replace(year=day.year - 1, day=28)


def mean(numbers: list[int] | list[float]) -> float | None:
    return sum(numbers) / len(numbers) if numbers else None


def _rounded(number: float | None, places: int = 2) -> float | None:
    return None if number is None else round(number, places)


@dataclass(frozen=True)
class Page:
    """What the statistics keep of one opened day: no text, only what is counted."""

    day: date
    written: bool
    words: int
    tags: tuple[str, ...]
    values: dict[str, int]
    by_ai: bool
    title: str


def _rating(raw: Any) -> int | None:
    return raw if type(raw) is int and 1 <= raw <= 10 else None


def _page(day: date, content: dict[str, Any]) -> Page:
    text = content["text"] if isinstance(content["text"], str) else ""
    written = bool(text.strip())
    ratings = content["values"] if isinstance(content["values"], dict) else {}
    tags = content["tags"] if isinstance(content["tags"], list) else []
    return Page(
        day=day,
        written=written,
        words=diary.words_in(text) if written else 0,
        tags=tuple(tag for tag in tags if isinstance(tag, str)),
        values={uid: rating for uid, raw in ratings.items() if (rating := _rating(raw)) is not None},
        by_ai=content["written_by"] == "ai",
        title=content["title"] if isinstance(content["title"], str) else "",
    )


def load_pages(db: Session, account_id: int, dek: bytes, today: date) -> tuple[list[Page], int]:
    """The pages of the person up to today, oldest first, and how many did not open (they are left out)."""
    pages: list[Page] = []
    unreadable = 0
    limit = today.isoformat()
    for row in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id, Day.date <= limit)
                          .order_by(Day.date)):
        content = diary._readable_content(account_id, dek, row.date, row.content_enc)
        if content is None:
            unreadable += 1
            continue
        pages.append(_page(date.fromisoformat(row.date), content))
    return pages, unreadable


# --- The pieces -----------------------------------------------------------------------------------------------------


def streaks(written: set[date], today: date) -> dict[str, Any]:
    """The streak now (up to today, or up to yesterday while today is still open), the longest one ever and the day
    it ended. A longer or an equally long streak further back loses to the later one."""
    cursor = today if today in written else today - timedelta(days=1)
    current = 0
    while cursor in written:
        current += 1
        cursor -= timedelta(days=1)
    longest = 0
    longest_end: date | None = None
    run = 0
    previous: date | None = None
    for day in sorted(written):
        run = run + 1 if previous is not None and day - previous == timedelta(days=1) else 1
        if run >= longest:
            longest, longest_end = run, day
        previous = day
    return {"current": current, "longest": longest, "longest_end": longest_end.isoformat() if longest_end else None,
            "today_done": today in written}


def calendar(pages: list[Page], main: str | None, today: date) -> dict[str, Any]:
    """The last ``CALENDAR_WEEKS`` weeks: for every page in them whether it is written, the main value and the title."""
    monday = today - timedelta(days=today.weekday())
    start = monday - timedelta(weeks=CALENDAR_WEEKS - 1)
    days = [{"date": page.day.isoformat(), "written": page.written, "value": page.values.get(main) if main else None,
             "title": page.title} for page in pages if start <= page.day <= today]
    return {"start": start.isoformat(), "weeks": CALENDAR_WEEKS, "days": days}


def series(pages: list[Page], value: str, today: date) -> dict[str, Any]:
    """One value over the last ``SERIES_DAYS`` days: the rating of each day and the mean of the seven days ending on
    it. Days without a rating are left out of the mean, not counted as zero; a week without any has no mean. The mean
    looks at the days before the span too, so its first points are as good as the others."""
    ratings = {page.day: page.values[value] for page in pages if value in page.values}
    first = today - timedelta(days=SERIES_DAYS - 1)
    values: list[int | None] = []
    means: list[float | None] = []
    for offset in range(SERIES_DAYS):
        day = first + timedelta(days=offset)
        values.append(ratings.get(day))
        week = [ratings[d] for step in range(7) if (d := day - timedelta(days=step)) in ratings]
        means.append(_rounded(mean(week)))
    ranges = {str(span): _rounded(mean([v for v in values[-span:] if v is not None]), 1) for span in SERIES_RANGES}
    return {"values": values, "means": means, "mean": ranges}


def weekdays(pages: list[Page], main: str | None) -> dict[str, Any]:
    """The mean of the main value for each weekday, Monday first, and the weekday it is highest on (None while the
    days are too few to say)."""
    sums: list[list[int]] = [[] for _ in range(7)]
    if main:
        for page in pages:
            if main in page.values:
                sums[page.day.weekday()].append(page.values[main])
    per = [{"n": len(found), "mean": _rounded(mean(found))} for found in sums]
    enough = [index for index, found in enumerate(sums) if len(found) >= MIN_WEEKDAY]
    best = None
    if len(enough) >= 2:
        top = max(sum(sums[index]) / len(sums[index]) for index in enough)
        best = next(index for index in enough if sum(sums[index]) / len(sums[index]) == top)
    return {"days": per, "best": best}


def _compare(a: list[int], b: list[int]) -> dict[str, Any] | None:
    """Two groups of the main value, said only when both are big enough."""
    if len(a) < MIN_GROUP or len(b) < MIN_GROUP:
        return None
    mean_a, mean_b = sum(a) / len(a), sum(b) / len(b)
    diff = mean_a - mean_b
    return {"a_n": len(a), "b_n": len(b), "a_mean": round(mean_a, 2), "b_mean": round(mean_b, 2),
            "diff": round(diff, 2), "similar": abs(diff) < SIMILAR}


def together(pages: list[Page], main: str | None, others: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """What goes together with the main value: other values high or low, weekend or not, days with a tag or without.
    Only what has enough days on both sides; never a cause, only two averages side by side."""
    if not main:
        return []
    rated = [page for page in pages if main in page.values]
    rows: list[dict[str, Any]] = []
    for uid, name in others:
        if uid == main:
            continue
        both = [page for page in rated if uid in page.values]
        found = _compare([p.values[main] for p in both if p.values[uid] >= HIGH],
                         [p.values[main] for p in both if p.values[uid] < HIGH])
        if found:
            rows.append({"kind": "value", "name": name, **found})
        if sum(1 for row in rows if row["kind"] == "value") == TOGETHER_VALUES:
            break
    found = _compare([p.values[main] for p in rated if p.day.weekday() >= 5],
                     [p.values[main] for p in rated if p.day.weekday() < 5])
    if found:
        rows.append({"kind": "weekend", **found})
    counted = Counter(tag for page in pages for tag in set(page.tags))
    ranked = sorted(counted.items(), key=lambda pair: (-pair[1], pair[0]))[:TAGS_LOOKED_AT]
    tagged = 0
    for tag, _count in ranked:
        found = _compare([p.values[main] for p in rated if tag in p.tags],
                         [p.values[main] for p in rated if tag not in p.tags])
        if found:
            rows.append({"kind": "tag", "tag": tag, **found})
            tagged += 1
        if tagged == TOGETHER_TAGS:
            break
    return rows


def top_tags(pages: list[Page]) -> list[dict[str, Any]]:
    counted = Counter(tag for page in pages for tag in set(page.tags))
    ranked = sorted(counted.items(), key=lambda pair: (-pair[1], pair[0]))[:TOP_TAGS]
    return [{"tag": tag, "count": count} for tag, count in ranked]


def _extremes(pages: list[Page], main: str | None, today: date, span: int | None) -> dict[str, Any]:
    """The best and the worst day by the main value in the last ``span`` days (all when None). With equal ratings the
    younger day counts."""
    if not main:
        return {"count": 0, "best": None, "worst": None}
    start = today - timedelta(days=span - 1) if span else None
    rated = sorted((page for page in pages if main in page.values and (start is None or page.day >= start)),
                   key=lambda page: page.day)
    if len(rated) < 2:
        return {"count": len(rated), "best": None, "worst": None}
    # Oldest first: a later page of the same rating wins every comparison below.
    best = worst = rated[0]
    for page in rated[1:]:
        if page.values[main] >= best.values[main]:
            best = page
        if page.values[main] <= worst.values[main]:
            worst = page
    return {"count": len(rated), "best": best.day.isoformat(), "worst": worst.day.isoformat()}


def writing(written: list[Page], photo_days: set[str], shared_days: set[str]) -> dict[str, int]:
    """How the written pages came about, and which of them carry photos or are shared. All of them out of ``total``."""
    ai = sum(1 for page in written if page.by_ai)
    return {
        "total": len(written),
        "ai": ai,
        "self": len(written) - ai,
        "photos": sum(1 for page in written if page.day.isoformat() in photo_days),
        "shared": sum(1 for page in written if page.day.isoformat() in shared_days),
    }


# --- Everything -----------------------------------------------------------------------------------------------------


def _value_view(value: dict[str, Any]) -> dict[str, str]:
    """A value as the statistics name it: its id, its name and the words at its two ends."""
    return {"id": value["id"], "name": value["name"], "low": value["low"], "high": value["high"]}


def _day_card(item: dict[str, Any] | None, rating: int | None = None) -> dict[str, Any] | None:
    if item is None:
        return None
    card = {"date": item["date"], "title": item["title"], "excerpt": item["excerpt"], "cover": item["cover"]}
    if rating is not None:
        card["value"] = rating
    return card


def compute(db: Session, account_id: int, dek: bytes, today: date) -> dict[str, Any]:
    """All the statistics of the person, as of ``today`` in their time zone."""
    defs = [value for value in diary.list_values(db, account_id, dek) if value["active"] and not value["unreadable"]]
    main = defs[0]["id"] if defs else None
    pages, unreadable = load_pages(db, account_id, dek, today)
    written = [page for page in pages if page.written]
    written_days = {page.day for page in written}

    this_year = sum(1 for page in written if page.day.year == today.year)
    words = sum(page.words for page in written)
    tiles = {
        **streaks(written_days, today),
        "year": today.year,
        "days_year": this_year,
        "days_total": len(written),
        "words": words,
        "words_per_day": round(words / len(written)) if written else 0,
    }

    spans = {name: _extremes(pages, main, today, span) for name, span in SPANS.items()}
    ratings = {page.day.isoformat(): page.values[main] for page in pages if main and main in page.values}
    year_ago = year_before(today).isoformat()
    wanted = sorted({day for found in spans.values() for day in (found["best"], found["worst"]) if day} | {year_ago})
    cards = journal.items_for_dates(db, account_id, dek, wanted)
    for found in spans.values():
        for side in ("best", "worst"):
            day = found[side]
            found[side] = _day_card(cards.get(day), ratings.get(day)) if day else None

    photo_days = set(db.scalars(select(Photo.date).where(Photo.user_id == account_id).distinct()))
    shared_days = set(db.scalars(select(Share.day_date).where(Share.owner_id == account_id).distinct()))

    return {
        "today": today.isoformat(),
        "pages": len(pages),
        "unreadable": unreadable,
        "value": _value_view(defs[0]) if defs else None,
        "values": [_value_view(value) for value in defs],
        "tiles": tiles,
        "calendar": calendar(pages, main, today),
        "series": {"days": SERIES_DAYS, "end": today.isoformat(),
                   "values": {value["id"]: series(pages, value["id"], today) for value in defs}},
        "weekdays": weekdays(pages, main),
        "together": together(pages, main, [(value["id"], value["name"]) for value in defs]),
        "tags": top_tags(pages),
        "extremes": spans,
        "writing": writing(written, photo_days, shared_days),
        "year_ago": _day_card(cards.get(year_ago)),
    }
