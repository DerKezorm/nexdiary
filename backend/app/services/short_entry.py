"""The short entry for tired days ("Heute nur kurz"): one sentence, and the first value the person asks about rated,
make the page of today. It counts as a written day like any other page (streak, weekly goal, statistics); with at most
``TEXT_MAX`` characters it is never a long page, so it earns no shield.

Only today, only while the day has no page: a page that stands is never written over. The notes stay as they are, the
page can grow later like any other (writing it up with the AI, or by hand). Pressing "Speichern" twice keeps one page.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from ..errors import error
from . import covers, diary

#: The longest sentence, and the longest that stands as the title as well (a longer one leaves the title to the date).
TEXT_MAX = 280
TITLE_FROM_TEXT = 48

_MARKS = re.compile(r"([\\`*_\[\]<>#~|!&])")
_BLOCK_START = re.compile(r"^(\s*)([-+>]|\d{1,9}[.)])")


def as_paragraph(sentence: str) -> str:
    """The sentence as one paragraph of Markdown, read as written: nothing in it becomes a heading, a list, a link,
    emphasis or a character reference (``&amp;`` stays those five letters, in the reader and in the editor alike)."""
    escaped = _MARKS.sub(r"\\\1", sentence)
    return _BLOCK_START.sub(lambda found: found.group(1) + "\\" + found.group(2), escaped)


def first_value(db: Session, account_id: int, dek: bytes) -> dict[str, Any] | None:
    """The first value the person rates each day (in their order), or None when they rate none."""
    return next((value for value in diary.list_values(db, account_id, dek)
                 if value["active"] and not value["unreadable"]), None)


def save(db: Session, account_id: int, dek: bytes, day: str, sentence: str, title: str, rating: Any,
         cover: Any) -> dict[str, Any]:
    """Makes the page of ``day`` out of the sentence (the caller checked that ``day`` is today). ``title`` is used
    only when the sentence is too long to be the title itself (the date, as the interface writes it)."""
    sentence = diary.clean_line(sentence, TEXT_MAX, "short_too_long")
    if not sentence:
        raise error("short_empty", "A short entry needs a sentence.", 422)
    value = first_value(db, account_id, dek)
    patch: dict[str, Any] = {
        "title": sentence if len(sentence) <= TITLE_FROM_TEXT else diary.clean_line(title, diary.TITLE_MAX,
                                                                                    "title_too_long"),
        "text": as_paragraph(sentence),
        "written_by": "self",
    }
    if value is not None:
        if type(rating) is not int or not 1 <= rating <= 10:
            raise error("value_out_of_range", "A value is a whole number from 1 to 10.", 422)
        patch["values"] = {value["id"]: rating}
    chosen = diary.check_cover(db, account_id, day, cover)

    def apply(content: dict[str, Any]) -> dict[str, Any]:
        if content["text"].strip():
            # The same entry once more (a double press) is the page that stands; any other page is never written over.
            if content["text"] == patch["text"]:
                return content
            raise error("day_written", "This day has a page already.", 409)
        out = diary.merge(content, patch)
        # The cover chosen in the dialog, else one chosen before, else the suggestion of today: never left empty.
        out["cover"] = chosen or content.get("cover") or covers.suggested_cover(day, out.get("tags") or [])
        return out

    return diary.change_day(db, account_id, dek, day, apply)


__all__ = ["TEXT_MAX", "TITLE_FROM_TEXT", "as_paragraph", "first_value", "save"]
