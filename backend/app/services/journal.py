"""The journal: the own days to page back through, as a blog or a timeline, newest first.

A page of the list opens only the days it shows (with a tag to filter by, as many as it takes to fill the page). Each
day comes with what the list draws: the cover, the title, the start of the text, the tags, the first value and who it
is shared with. Everything here is the signed-in person's own; nothing of anybody else.
"""

from __future__ import annotations

from collections import Counter
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
         tag: str | None) -> dict[str, Any]:
    """One page of the own days before ``before`` (all when None), with ``tag`` only those that carry it, and whether
    there are more. Only days with a page: one that holds just values or tags is not listed."""
    limit = min(max(limit, 1), PAGE_MAX)
    found: list[tuple[str, dict[str, Any] | None]] = []
    more = False
    cursor = before
    size = limit + 1 if tag is None else BATCH
    while True:
        query = select(Day.date, Day.content_enc).where(Day.user_id == account_id)
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


def overview(db: Session, account_id: int, dek: bytes) -> dict[str, Any]:
    """How many days there are, since when, and every tag with the number of days that carry it, most used first."""
    count, since = 0, None
    tags: Counter[str] = Counter()
    for row in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id).order_by(Day.date)):
        content = diary._readable_content(account_id, dek, row.date, row.content_enc)
        if not has_page(content):
            continue
        count += 1
        since = since or row.date
        if content is not None:
            tags.update(set(content["tags"]))
    ordered = sorted(tags.items(), key=lambda pair: (-pair[1], pair[0]))
    return {"count": int(count or 0), "since": since, "tags": [{"tag": tag, "count": n} for tag, n in ordered]}
