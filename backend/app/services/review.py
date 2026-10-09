"""Looking back: a week or a month of the own pages, worked out on the server like the statistics.

A *period* is a week (Monday to Sunday, as ISO counts it) or a calendar month, named by its first day, in the time
zone of the person. Only periods that are over can be looked at: the latest is last week or last month, the earliest
the one that holds the first page the person ever wrote. Everything comes from the signed-in person's own days,
opened with their own data key; nothing is kept between two requests.

The strip on "Today" points at the period just over: from Monday to Wednesday at last week, from the 1st to the 3rd of
a month at last month (the month wins when both hold), and only when that period has a page.

The summary of a period (``ai.summarize``) gets the plain words of its pages, each cut to a fair share of a fixed
budget, so that a full month never makes the request too large.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Day, Photo
from . import diary, journal

KINDS = ("week", "month")
#: The tags a look back names, the most used first.
TOP_TAGS = 5
#: The days a strip on "Today" shows at most.
STRIP = 7
#: What the words of all pages of a period may weigh when they go to the AI, in characters. A month of long pages is
#: cut down to this, each page to its fair share, never refused.
SUMMARY_CHARS = 40_000
#: No page is cut below this, so that a page keeps a sentence or two whatever else the period holds.
SUMMARY_PAGE_MIN = 200
#: The pages as JSON stay below this, well under what one request to the AI may carry (``ai.MAX_CHARS``).
SUMMARY_JSON_MAX = 50_000
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def not_found() -> Exception:
    return error("not_found", "Not found.", 404)


# --- Periods --------------------------------------------------------------------------------------------------------


def align(kind: str, day: date) -> date:
    """The first day of the period that holds ``day``."""
    if kind == "week":
        return day - timedelta(days=day.weekday())
    return day.replace(day=1)


def end_of(kind: str, start: date) -> date:
    if kind == "week":
        return start + timedelta(days=6)
    following = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return following - timedelta(days=1)


def shift(kind: str, start: date, steps: int) -> date:
    """The period ``steps`` periods away (negative: before)."""
    if kind == "week":
        return start + timedelta(weeks=steps)
    months = start.year * 12 + start.month - 1 + steps
    return date(months // 12, months % 12 + 1, 1)


def latest(kind: str, today: date) -> date:
    """The last period that is over: last week, last month."""
    return shift(kind, align(kind, today), -1)


def days_of(kind: str, start: date) -> list[date]:
    last = end_of(kind, start)
    return [start + timedelta(days=offset) for offset in range((last - start).days + 1)]


def check_start(kind: str, value: str | None, today: date) -> date:
    """The period asked for: its first day, a Monday or the 1st, not before 1900 and not later than the latest one
    that is over. Empty: the latest."""
    if kind not in KINDS:
        raise not_found()
    if not value:
        return latest(kind, today)
    if not diary.DATE_PATTERN.match(value):
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422)
    try:
        start = date.fromisoformat(value)
    except ValueError as exc:
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422) from exc
    if start < diary.EARLIEST or align(kind, start) != start or start > latest(kind, today):
        raise not_found()
    return start


# --- What the days hold ---------------------------------------------------------------------------------------------


def _rating(raw: Any) -> int | None:
    return raw if type(raw) is int and 1 <= raw <= 10 else None


def _main_value(db: Session, account_id: int, dek: bytes) -> dict[str, Any] | None:
    """The value a look back is about: the first one asked, in the person's own order (as in the statistics)."""
    for value in diary.list_values(db, account_id, dek):
        if value["active"] and not value["unreadable"]:
            return value
    return None


def _opened(db: Session, account_id: int, dek: bytes, first: date, last: date) -> dict[str, dict[str, Any] | None]:
    """The days between ``first`` and ``last`` that have a row, opened (None: did not open)."""
    rows = db.execute(select(Day.date, Day.content_enc).where(
        Day.user_id == account_id, Day.date >= first.isoformat(), Day.date <= last.isoformat()))
    return {row.date: diary._readable_content(account_id, dek, row.date, row.content_enc) for row in rows}


def first_page(db: Session, account_id: int, dek: bytes) -> date | None:
    """The day of the first page the person ever wrote (a day of values alone is no page)."""
    for row in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id).order_by(Day.date)):
        if diary.has_page(diary._readable_content(account_id, dek, row.date, row.content_enc)):
            return date.fromisoformat(row.date)
    return None


def mean(numbers: list[int]) -> float | None:
    return round(sum(numbers) / len(numbers), 2) if numbers else None


def best_of(rated: list[tuple[date, int]]) -> date | None:
    """The day with the highest rating; with equal ratings the younger day, as in the statistics."""
    best: tuple[date, int] | None = None
    for day, rating in sorted(rated):
        if best is None or rating >= best[1]:
            best = (day, rating)
    return best[0] if best else None


def _value_view(value: dict[str, Any] | None) -> dict[str, str] | None:
    if value is None:
        return None
    return {"id": value["id"], "name": value["name"], "low": value["low"], "high": value["high"]}


def compute(db: Session, account_id: int, dek: bytes, kind: str, start: date, today: date) -> dict[str, Any]:
    """Everything a look back at one period shows: the days with their covers, how many are written, the main value
    on average and the period before, words, photos, the best day, the tags, and where the arrows lead."""
    days = days_of(kind, start)
    last = days[-1]
    before = shift(kind, start, -1)
    opened = _opened(db, account_id, dek, before, last)
    value = _main_value(db, account_id, dek)
    main = value["id"] if value else None

    def rating(content: dict[str, Any] | None) -> int | None:
        if not main or content is None or not isinstance(content.get("values"), dict):
            return None
        return _rating(content["values"].get(main))

    pages = [(day.isoformat(), opened[day.isoformat()]) for day in days
             if day.isoformat() in opened and diary.has_page(opened[day.isoformat()])]
    cards = {item["date"]: item for item in journal.items(db, account_id, dek, pages)}
    shown = []
    for day in days:
        key = day.isoformat()
        card = cards.get(key)
        shown.append({
            "date": key,
            "value": rating(opened.get(key)),
            "page": None if card is None else {"title": card["title"], "cover": card["cover"],
                                               "cover_crop": card["cover_crop"], "unreadable": card["unreadable"]},
        })
    ratings = [item["value"] for item in shown if item["value"] is not None]
    earlier = [r for day in days_of(kind, before) if (r := rating(opened.get(day.isoformat()))) is not None]
    rated_pages = [(date.fromisoformat(item["date"]), item["value"]) for item in shown
                   if item["page"] is not None and item["value"] is not None]
    best_day = best_of(rated_pages)
    best = None
    if best_day is not None:
        card = cards[best_day.isoformat()]
        best = {"date": card["date"], "title": card["title"], "cover": card["cover"],
                "cover_crop": card["cover_crop"], "value": dict(rated_pages)[best_day]}
    readable = [content for _key, content in pages if content is not None]
    tags = Counter(tag for content in readable for tag in set(content["tags"]) if isinstance(tag, str))
    photos = db.scalar(select(func.count(Photo.id)).where(
        Photo.user_id == account_id, Photo.date >= start.isoformat(), Photo.date <= last.isoformat())) or 0
    first = first_page(db, account_id, dek)
    earliest = align(kind, first) if first else start
    newest = latest(kind, today)
    return {
        "kind": kind,
        "start": start.isoformat(),
        "end": last.isoformat(),
        "prev": shift(kind, start, -1).isoformat() if start > earliest else None,
        "next": shift(kind, start, 1).isoformat() if start < newest else None,
        "days": shown,
        "written": len(pages),
        "total": len(days),
        "unreadable": sum(1 for _key, content in pages if content is None),
        "value": _value_view(value),
        "mean": mean(ratings),
        "mean_before": mean(earlier),
        "words": sum(diary.words_in(content["text"]) for content in readable if isinstance(content["text"], str)),
        "photos": int(photos),
        "best": best,
        "tags": [{"tag": tag, "count": count}
                 for tag, count in sorted(tags.items(), key=lambda pair: (-pair[1], pair[0]))[:TOP_TAGS]],
    }


# --- The strip on "Today" -------------------------------------------------------------------------------------------


def teaser_period(today: date) -> list[tuple[str, date]]:
    """Which periods the strip may point at today, the first that has a page wins: last month from the 1st to the
    3rd, last week from Monday to Wednesday."""
    found: list[tuple[str, date]] = []
    if today.day <= 3:
        found.append(("month", latest("month", today)))
    if today.weekday() <= 2:
        found.append(("week", latest("week", today)))
    return found


def teaser(db: Session, account_id: int, dek: bytes, today: date) -> dict[str, Any] | None:
    """The strip: the period, how many of its days have a page, and up to seven small covers (a week: one per day,
    None for a day left free; a month: its newest pages). None when there is nothing to look back at today."""
    for kind, start in teaser_period(today):
        days = days_of(kind, start)
        opened = _opened(db, account_id, dek, start, days[-1])
        pages = [(day.isoformat(), opened[day.isoformat()]) for day in days
                 if day.isoformat() in opened and diary.has_page(opened[day.isoformat()])]
        if not pages:
            continue
        cards = {item["date"]: item for item in journal.items(db, account_id, dek, pages)}

        def small(key: str, cards: dict[str, dict[str, Any]] = cards) -> dict[str, Any] | None:
            card = cards.get(key)
            return None if card is None else {"date": key, "cover": card["cover"], "cover_crop": card["cover_crop"]}

        keys = [day.isoformat() for day in days] if kind == "week" else [key for key, _content in pages][-STRIP:]
        return {"kind": kind, "start": start.isoformat(), "end": days[-1].isoformat(), "written": len(pages),
                "total": len(days), "covers": [small(key) for key in keys]}
    return None


# --- What the summary is made from ----------------------------------------------------------------------------------


def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:") + " …"


def shares(lengths: list[int], budget: int, floor: int = SUMMARY_PAGE_MIN) -> list[int]:
    """How many characters each page may keep: all of it while everything fits, else an equal share for each, the
    room a short page leaves over going to the longer ones. No share below ``floor``, so the total may pass the
    budget by that much per page at worst (a month holds 31 pages)."""
    allowed = list(lengths)
    if sum(lengths) <= budget:
        return allowed
    left = budget
    waiting = sorted(range(len(lengths)), key=lambda index: lengths[index])
    while waiting:
        share = max(floor, left // len(waiting))
        index = waiting[0]
        if lengths[index] <= share:
            allowed[index] = lengths[index]
            left -= lengths[index]
            waiting.pop(0)
            continue
        for rest in waiting:
            allowed[rest] = min(lengths[rest], share)
        break
    return allowed


def summary_pages(db: Session, account_id: int, dek: bytes, kind: str, start: date) -> list[dict[str, Any]]:
    """The pages of a period as the AI gets them: weekday, day of the month, title and the plain words of the text,
    oldest first, cut to fit ``SUMMARY_CHARS`` together. No photo, no rating, no tag, no note."""
    days = days_of(kind, start)
    opened = _opened(db, account_id, dek, start, days[-1])
    found = []
    for day in days:
        content = opened.get(day.isoformat())
        if content is None or not diary.has_page(content):
            continue
        text = content["text"] if isinstance(content["text"], str) else ""
        found.append({"weekday": WEEKDAYS[day.weekday()], "day": day.day,
                      "title": content["title"] if isinstance(content["title"], str) else "",
                      "text": diary.plain_text(diary.strip_images(text))})
    budget = SUMMARY_CHARS
    while True:
        allowed = shares([len(page["text"]) for page in found], budget)
        cut = [{**page, "text": _cut(page["text"], limit)} for page, limit in zip(found, allowed, strict=True)]
        # Quotes and backslashes weigh double once written as JSON: then each page gets less, until it fits.
        if len(json.dumps(cut, ensure_ascii=False)) <= SUMMARY_JSON_MAX or budget <= SUMMARY_PAGE_MIN:
            return cut
        budget //= 2
