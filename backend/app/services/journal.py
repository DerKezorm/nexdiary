"""The journal: the own days to page back through, as a blog or a timeline, newest first.

A page of the list opens only the days it shows (with a tag to filter by, as many as it takes to fill the page). Each
day comes with what the list draws: the cover, the title, the start of the text, the tags, the first value and who it
is shared with. Everything here is the signed-in person's own; nothing of anybody else.
"""

from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Day
from . import diary, sharing

#: Days on one page of the list.
PAGE_MAX = 60
#: Days opened at a time while a tag filter looks for enough of them.
BATCH = 200


def _first_value(values: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The value a list shows next to each day: the first one asked, in the person's own order (mood, at the start)."""
    for value in values:
        if value["active"] and not value["unreadable"]:
            return value
    return None


def _item(day: str, content: dict[str, Any] | None, photo_ids: set[str], first: dict[str, Any] | None,
          shared_with: list[dict[str, Any]], locked: bool) -> dict[str, Any]:
    shown = content or diary.empty_day()
    rating = shown["values"].get(first["id"]) if first else None
    cover, chosen = diary.effective_cover(day, shown, photo_ids)
    return {
        "date": day,
        "title": shown["title"],
        "excerpt": diary.excerpt(shown["text"]),
        "tags": shown["tags"],
        "cover": cover,
        "cover_crop": diary.shown_crop(shown, chosen),
        "written_by": shown["written_by"],
        "first_value": {"name": first["name"], "value": rating} if first and isinstance(rating, int) else None,
        "shared_with": shared_with,
        "locked": locked,
        "unreadable": content is None,
    }


def has_page(content: dict[str, Any] | None) -> bool:
    """Whether a day belongs in the journal: it has a title or a text (``diary.has_page``)."""
    return diary.has_page(content)


def page(db: Session, account_id: int, dek: bytes, *, before: str | None, limit: int,
         tag: str | None, year: int | None = None) -> dict[str, Any]:
    """One page of the own days before ``before`` (all when None), with ``tag`` only those that carry it, with
    ``year`` only those of that year (the volume opened on the shelf), and whether there are more. Only days with a
    page: one that holds just values or tags is not listed."""
    limit = min(max(limit, 1), PAGE_MAX)
    found: list[tuple[str, dict[str, Any] | None]] = []
    more = False
    cursor = before
    size = limit + 1 if tag is None else BATCH
    while True:
        query = select(Day.date, Day.content_enc).where(Day.user_id == account_id)
        if year is not None:
            query = query.where(Day.date >= f"{year:04d}-01-01", Day.date <= f"{year:04d}-12-31")
        if cursor:
            query = query.where(Day.date < cursor)
        rows = db.execute(query.order_by(Day.date.desc()).limit(size)).all()
        for row in rows:
            content = diary._readable_content(account_id, dek, row.date, row.content_enc)
            if not has_page(content) or (tag is not None and (content is None or tag not in content["tags"])):
                continue
            if len(found) == limit:
                # One more day stands: that is all there is to know of it.
                more = True
                break
            found.append((row.date, content))
        if more or len(rows) < size:
            break
        cursor = rows[-1].date
    return {"days": items(db, account_id, dek, found), "more": more}


def items(db: Session, account_id: int, dek: bytes,
          found: list[tuple[str, dict[str, Any] | None]]) -> list[dict[str, Any]]:
    if not found:
        return []
    photo_ids = diary.photo_ids_of(db, account_id)
    first = _first_value(diary.list_values(db, account_id, dek))
    shared = sharing.recipients_by_day(db, account_id, [day for day, _content in found])
    locked = diary.locked_dates(db, account_id, [day for day, _content in found])
    return [_item(day, content, photo_ids, first, shared.get(day, []), day in locked) for day, content in found]


def items_for_dates(db: Session, account_id: int, dek: bytes, dates: list[str]) -> dict[str, dict[str, Any]]:
    """The list entries of these own days (those that have a page), for the results of a search."""
    if not dates:
        return {}
    rows = db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id, Day.date.in_(dates))).all()
    found = [(row.date, diary._readable_content(account_id, dek, row.date, row.content_enc)) for row in rows]
    return {item["date"]: item for item in items(db, account_id, dek, found)}


def days_in_year(year: int) -> int:
    return 366 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 365


def days_left(today: date) -> int:
    """The days after ``today`` up to and with the 31 December of its year (0 on New Year's Eve)."""
    return (date(today.year, 12, 31) - today).days


def volume_days(year: int, first: date | None) -> int:
    """How many pages a volume has room for: a whole year, but the first volume only from the day of the first page
    on (that day and the 31 December included)."""
    if first is not None and first.year == year:
        return (date(year, 12, 31) - first).days + 1
    return days_in_year(year)


def overview(db: Session, account_id: int, dek: bytes, today: date) -> dict[str, Any]:
    """How many days there are, since when, every tag with the number of days that carry it, most used first, and the
    volumes of the shelf: for every year with a page how many pages it holds, out of how many days (the first volume
    from its first page on), and how many in each month; and how many days are left in the year of ``today`` (the
    person's), the days after today up to and with the 31 December."""
    count, since = 0, None
    tags: Counter[str] = Counter()
    years: Counter[int] = Counter()
    months: dict[int, list[int]] = {}
    for row in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id).order_by(Day.date)):
        content = diary._readable_content(account_id, dek, row.date, row.content_enc)
        if not has_page(content):
            continue
        count += 1
        since = since or row.date
        years[int(row.date[:4])] += 1
        months.setdefault(int(row.date[:4]), [0] * 12)[int(row.date[5:7]) - 1] += 1
        if content is not None:
            tags.update(set(content["tags"]))
    ordered = sorted(tags.items(), key=lambda pair: (-pair[1], pair[0]))
    first = date.fromisoformat(since) if since else None
    return {"count": int(count or 0), "since": since, "tags": [{"tag": tag, "count": n} for tag, n in ordered],
            "volumes": [{"year": year, "pages": n, "days": volume_days(year, first), "months": months[year]}
                        for year, n in sorted(years.items())],
            "days_left": days_left(today)}
