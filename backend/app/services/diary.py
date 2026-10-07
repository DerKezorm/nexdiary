"""Notes, days and values of one person, sealed with that person's data key (``services/vault.py``).

Every function here takes the account id from the session and nothing else: a person reaches only their own rows, and
a row of somebody else answers exactly like one that does not exist.

Writes that could meet another write are atomic in the database, not checked in Python first:

* a note carries an id made by the browser; the same note sent twice (a double click, a retry) inserts once;
* a day is changed only on the revision it was read from, and made with ``ON CONFLICT DO NOTHING``: two saves at the
  same moment make one day, and neither change is lost;
* the values a person starts with are laid out under a mark on the account that is set once.
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, tzinfo
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from sqlalchemy import bindparam, delete, select, text, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .. import clock
from ..errors import error
from ..models import Account, Day, Draft, Note, Photo, UtcDateTime, ValueDef
from . import covers, quota, vault

logger = logging.getLogger("nexdiary.diary")

# --- Limits ---------------------------------------------------------------------------------------------------------

NOTE_MAX = 5000
PROMPT_MAX = 300
NOTES_PER_DAY = 500
TITLE_MAX = 200
TEXT_MAX = 100_000
TAG_MAX = 40
TAGS_MAX = 30
VALUE_DEFS_MAX = 30
VALUE_NAME_MAX = 40
VALUE_END_MAX = 30
VALUE_HINT_MAX = 80
SEARCH_MAX = 100
SEARCH_RESULTS = 50
#: Searches per person and minute; a search opens every sealed text of the person, so it is not free.
SEARCHES_PER_MINUTE = 30
SNIPPET_AROUND = 40
DAYS_LIST_MAX = 1000
#: How often a change of a day is tried again when another change came in between.
CHANGE_TRIES = 8
WRITTEN_BY = ("ai", "self")
COVER_MAX = 80
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOTE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VALUE_ID = re.compile(r"^[0-9a-f]{16,32}$")
EARLIEST = date(1900, 1, 1)
#: Characters a line of text may not carry: control characters, apart from line breaks and tabs in longer texts.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_LINE_BREAKS = re.compile(r"[\r\n\t]+")
_WORD = re.compile(r"\w+", re.UNICODE)

# --- Time -----------------------------------------------------------------------------------------------------------


@lru_cache(maxsize=1)
def time_zones() -> frozenset[str]:
    return frozenset(available_timezones())


def valid_time_zone(name: Any) -> bool:
    return isinstance(name, str) and 0 < len(name) <= 64 and name in time_zones()


def zone_of(account: Account) -> tzinfo:
    """The person's time zone as the browser reported it; the server's own until then."""
    profile = account.profile if isinstance(account.profile, dict) else {}
    name = profile.get("timezone")
    if valid_time_zone(name):
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    zone = datetime.now().astimezone().tzinfo
    assert zone is not None
    return zone


def now() -> datetime:
    """The moment for a row, to the second: nothing finer stays in the clear."""
    return clock.now().replace(microsecond=0)


def unreadable(table: str) -> None:
    """A sealed value that did not open: damaged, or moved in the database. Said in the log without content; the
    rest of the person's diary stays usable."""
    logger.warning("A sealed value did not open table=%s", table)


def today_of(account: Account) -> date:
    """"Today" for this person: the date on the clock of their own time zone."""
    return clock.now().astimezone(zone_of(account)).date()


def check_date(account: Account, value: str) -> str:
    """A date a diary may hold: a real one, not before 1900, and not later than tomorrow in the person's zone
    (tomorrow, because a person travelling or writing just after midnight may be a day ahead of the server)."""
    if not isinstance(value, str) or not DATE_PATTERN.match(value):
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422)
    try:
        day = date.fromisoformat(value)
    except ValueError as exc:
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422) from exc
    if day < EARLIEST:
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422)
    if day > today_of(account) + timedelta(days=1):
        raise error("date_in_future", "This date is still to come.", 422)
    return value


# --- Text -----------------------------------------------------------------------------------------------------------


def clean_text(value: str, limit: int, code: str) -> str:
    """A longer text: control characters out, line breaks kept, ends trimmed."""
    value = _CONTROL.sub("", value.replace("\r\n", "\n")).strip()
    if len(value) > limit:
        raise error(code, "The text is too long.", 422, max=limit)
    return value


def clean_line(value: str, limit: int, code: str) -> str:
    """One line: line breaks become spaces, control characters go, ends trimmed."""
    value = _CONTROL.sub("", _LINE_BREAKS.sub(" ", value)).strip()
    if len(value) > limit:
        raise error(code, "The text is too long.", 422, max=limit)
    return value


def clean_tags(tags: list[str]) -> list[str]:
    """Tags in lower case without a leading #, each once, in the order given."""
    out: list[str] = []
    for raw in tags:
        tag = " ".join(clean_line(raw, TAG_MAX * 4, "tag_too_long").lstrip("#").split()).lower()
        if not tag:
            continue
        if len(tag) > TAG_MAX:
            raise error("tag_too_long", "A tag is too long.", 422, max=TAG_MAX)
        if tag not in out:
            out.append(tag)
    if len(out) > TAGS_MAX:
        raise error("too_many_tags", "Too many tags for one day.", 422, max=TAGS_MAX)
    return out


def words_in(value: str) -> int:
    return len(_WORD.findall(value))


#: How much of a page a list shows as its start.
EXCERPT_MAX = 320
_BLOCK_MARKS = re.compile(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)+")
_STARS = re.compile(r"(?<!\\)\*+")
#: Underscores that mark emphasis: not those inside a word (``snake_case`` is written as it is).
_UNDERSCORES = re.compile(r"(?<!\\)(?:(?<!\w)_+|_+(?!\w))")
_ESCAPED = re.compile(r"\\([!-/:-@\[-`{-~])")


def plain_text(markdown: str) -> str:
    """A page as plain words in one line: the marks of headings, quotes, lists, bold and italic gone, escaped
    characters as themselves. For lists and the start of a page, never for showing the page itself."""
    lines = []
    for line in markdown.split("\n"):
        line = _BLOCK_MARKS.sub("", line)
        line = _UNDERSCORES.sub("", _STARS.sub("", line))
        line = _ESCAPED.sub(r"\1", line.rstrip()).rstrip("\\")
        lines.append(line)
    return " ".join(" ".join(lines).split())


#: How much of a page the start is made from: enough for ``EXCERPT_MAX`` words even among many marks, and a list of
#: long pages stays as quick as one of short ones.
EXCERPT_SOURCE = EXCERPT_MAX * 8


def excerpt(markdown: str, limit: int = EXCERPT_MAX) -> str:
    """The start of a page in plain words, cut at a word."""
    cut_source = len(markdown) > EXCERPT_SOURCE
    words = plain_text(markdown[:EXCERPT_SOURCE])
    if cut_source and words and len(words) <= limit:
        return words.rstrip(" ,;:") + " …"
    if len(words) <= limit:
        return words
    cut = words[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:") + " …"


# --- Values ---------------------------------------------------------------------------------------------------------

#: The values every person starts with, as in the mock: four asked, one off. The language is the account's.
STARTING_VALUES: dict[str, list[dict[str, Any]]] = {
    "de": [
        {"name": "Stimmung", "hint": "Wie ging es dir heute?", "low": "mies", "high": "super", "active": True},
        {"name": "Gesundheit", "hint": "Körperlich", "low": "krank", "high": "topfit", "active": True},
        {"name": "Schlaf", "hint": "Letzte Nacht", "low": "kaum", "high": "erholt", "active": True},
        {"name": "Arbeitstag", "hint": "Nur an Arbeitstagen", "low": "zäh", "high": "richtig gut", "active": True},
        {"name": "Beziehung", "hint": "Wie war es miteinander?", "low": "schwierig", "high": "innig", "active": False},
    ],
    "en": [
        {"name": "Mood", "hint": "How were you today?", "low": "awful", "high": "great", "active": True},
        {"name": "Health", "hint": "Physically", "low": "ill", "high": "in top form", "active": True},
        {"name": "Sleep", "hint": "Last night", "low": "barely", "high": "rested", "active": True},
        {"name": "Work day", "hint": "Only on work days", "low": "a slog", "high": "really good", "active": True},
        {"name": "Relationship", "hint": "How were you together?", "low": "difficult", "high": "close",
         "active": False},
    ],
}


def _value_aad(account_id: int, uid: str) -> bytes:
    return vault.aad(account_id, "value_defs", "data", uid)


def _new_value_id() -> str:
    return secrets.token_hex(12)


def ensure_values(db: Session, account: Account, dek: bytes, language: str) -> None:
    """The starting values, once per account: the mark is set in the same transaction as the values are written, and
    only by the one request that finds it unset."""
    if account.values_seeded:
        return
    taken = db.execute(
        update(Account).where(Account.id == account.id, Account.values_seeded.is_(False)).values(values_seeded=True)
    )
    if taken.rowcount != 1:
        db.rollback()
        return
    moment = now()
    for position, entry in enumerate(STARTING_VALUES["de" if language == "de" else "en"]):
        uid = _new_value_id()
        db.add(ValueDef(uid=uid, user_id=account.id, position=position, created_at=moment,
                        data_enc=vault.seal_json(dek, entry, _value_aad(account.id, uid))))
    db.commit()


def _value_data(account_id: int, dek: bytes, row: Any) -> dict[str, Any] | None:
    try:
        return vault.open_json(dek, row.data_enc, _value_aad(account_id, row.uid))
    except vault.SealError:
        unreadable("value_defs")
        return None


def _value_view(account_id: int, dek: bytes, row: ValueDef | Any) -> dict[str, Any]:
    data = _value_data(account_id, dek, row)
    if data is None:
        return {"id": row.uid, "name": "", "low": "", "high": "", "hint": "", "active": False, "position": row.position,
                "unreadable": True}
    return {
        "id": row.uid,
        "name": data.get("name", ""),
        "low": data.get("low", ""),
        "high": data.get("high", ""),
        "hint": data.get("hint", ""),
        "active": bool(data.get("active", True)),
        "position": row.position,
        "unreadable": False,
    }


def list_values(db: Session, account_id: int, dek: bytes) -> list[dict[str, Any]]:
    rows = db.execute(
        select(ValueDef.uid, ValueDef.position, ValueDef.data_enc)
        .where(ValueDef.user_id == account_id)
        .order_by(ValueDef.position, ValueDef.id)
    ).all()
    return [_value_view(account_id, dek, row) for row in rows]


def _value_ids(db: Session, account_id: int) -> set[str]:
    return set(db.scalars(select(ValueDef.uid).where(ValueDef.user_id == account_id)))


def clean_value_fields(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "name" in fields:
        out["name"] = clean_line(fields["name"], VALUE_NAME_MAX, "value_name_too_long")
        if not out["name"]:
            raise error("value_name_missing", "A value needs a name.", 422)
    for key in ("low", "high"):
        if key in fields:
            out[key] = clean_line(fields[key], VALUE_END_MAX, "value_end_too_long")
    if "hint" in fields:
        out["hint"] = clean_line(fields["hint"], VALUE_HINT_MAX, "value_hint_too_long")
    if "active" in fields:
        out["active"] = bool(fields["active"])
    return out


def create_value(db: Session, account_id: int, dek: bytes, fields: dict[str, Any]) -> dict[str, Any]:
    data = {"name": "", "low": "", "high": "", "hint": "", "active": True, **clean_value_fields(fields)}
    if not data["name"]:
        raise error("value_name_missing", "A value needs a name.", 422)
    uid = _new_value_id()
    sealed = vault.seal_json(dek, data, _value_aad(account_id, uid))
    # Counting and adding in one statement: two adds at the same moment cannot pass the limit together.
    inserted = db.execute(
        text(
            "INSERT INTO value_defs (uid, user_id, position, data_enc, created_at) "
            "SELECT :uid, :user, (SELECT coalesce(max(position), -1) + 1 FROM value_defs WHERE user_id = :user), "
            ":data, :now WHERE (SELECT count(*) FROM value_defs WHERE user_id = :user) < :limit"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"uid": uid, "user": account_id, "data": sealed, "now": now(), "limit": VALUE_DEFS_MAX},
    )
    if inserted.rowcount == 1:
        quota.check_after_write(db, account_id, len(sealed))
    db.commit()
    if inserted.rowcount != 1:
        raise error("too_many_values", "There are as many values as there may be.", 409, max=VALUE_DEFS_MAX)
    row = db.execute(select(ValueDef.uid, ValueDef.position, ValueDef.data_enc)
                     .where(ValueDef.user_id == account_id, ValueDef.uid == uid)).one()
    return _value_view(account_id, dek, row)


def change_value(db: Session, account_id: int, dek: bytes, uid: str, fields: dict[str, Any]) -> dict[str, Any]:
    changes = clean_value_fields(fields)
    for _ in range(CHANGE_TRIES):
        row = db.execute(select(ValueDef.uid, ValueDef.position, ValueDef.data_enc)
                         .where(ValueDef.user_id == account_id, ValueDef.uid == uid)).first()
        if row is None:
            raise error("not_found", "Not found.", 404)
        # An unreadable value can still be given a new name and ends: what is sent replaces it.
        data = {"name": "", "low": "", "high": "", "hint": "", "active": True,
                **(_value_data(account_id, dek, row) or {}), **changes}
        # Written only onto what was read: a change in between makes this one read again.
        sealed = vault.seal_json(dek, data, _value_aad(account_id, uid))
        written = db.execute(
            update(ValueDef)
            .where(ValueDef.user_id == account_id, ValueDef.uid == uid, ValueDef.data_enc == row.data_enc)
            .values(data_enc=sealed)
        )
        if written.rowcount == 1:
            quota.check_after_write(db, account_id, len(sealed) - len(row.data_enc))
        db.commit()
        if written.rowcount == 1:
            return _value_view(account_id, dek, db.execute(
                select(ValueDef.uid, ValueDef.position, ValueDef.data_enc)
                .where(ValueDef.user_id == account_id, ValueDef.uid == uid)).one())
    raise error("busy", "nexdiary is busy. Try again in a moment.", 503)


def order_values(db: Session, account_id: int, dek: bytes, ids: list[str]) -> list[dict[str, Any]]:
    if len(ids) != len(set(ids)) or set(ids) != _value_ids(db, account_id):
        raise error("order_mismatch", "The order must name every value once.", 409)
    for position, uid in enumerate(ids):
        db.execute(update(ValueDef).where(ValueDef.user_id == account_id, ValueDef.uid == uid)
                   .values(position=position))
    db.commit()
    return list_values(db, account_id, dek)


def delete_value(db: Session, account_id: int, uid: str) -> None:
    gone = db.execute(delete(ValueDef).where(ValueDef.user_id == account_id, ValueDef.uid == uid))
    db.commit()
    if gone.rowcount != 1:
        raise error("not_found", "Not found.", 404)


# --- Notes ----------------------------------------------------------------------------------------------------------


def _note_aad(account_id: int, uid: str, day: str, column: str) -> bytes:
    return vault.aad(account_id, "notes", column, f"{uid}|{day}")


def _note_view(account_id: int, dek: bytes, row: Any) -> dict[str, Any]:
    try:
        text_ = vault.open_text(dek, row.text_enc, _note_aad(account_id, row.uid, row.date, "text"))
        prompt = vault.open_text(dek, row.prompt_enc, _note_aad(account_id, row.uid, row.date, "prompt")) \
            if row.prompt_enc is not None else None
        prompt_id = vault.open_text(dek, row.prompt_ref_enc, _note_aad(account_id, row.uid, row.date, "prompt_ref")) \
            if row.prompt_ref_enc is not None else None
        broken = False
    except vault.SealError:
        unreadable("notes")
        text_, prompt, prompt_id, broken = "", None, None, True
    return {
        "id": row.uid,
        "date": row.date,
        "text": text_,
        "unreadable": broken,
        "prompt": prompt,
        "prompt_id": prompt_id,
        "photo_id": row.photo_id,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


_NOTE_COLUMNS = (Note.uid, Note.date, Note.text_enc, Note.prompt_enc, Note.prompt_ref_enc, Note.photo_id,
                 Note.created_at, Note.updated_at)
#: The id of a question a note answers: a shipped one (``group.index``) or an own one (``own.<hex>``).
PROMPT_ID = re.compile(r"^(?:[a-z]{2,16}\.\d{1,3}|own\.[0-9a-f]{12})$")


def list_notes(db: Session, account_id: int, dek: bytes, day: str) -> list[dict[str, Any]]:
    rows = db.execute(select(*_NOTE_COLUMNS).where(Note.user_id == account_id, Note.date == day)
                      .order_by(Note.created_at, Note.id)).all()
    return [_note_view(account_id, dek, row) for row in rows]


def _note_row(db: Session, account_id: int, uid: str) -> Any:
    return db.execute(select(*_NOTE_COLUMNS).where(Note.user_id == account_id, Note.uid == uid)).first()


def check_note_id(uid: str) -> str:
    """A note id in an address: one that cannot exist is not found."""
    uid = uid.lower() if isinstance(uid, str) else ""
    if not NOTE_ID.match(uid):
        raise error("not_found", "Not found.", 404)
    return uid


def check_new_note_id(uid: str) -> str:
    """The id a browser made for a new note: a UUID, or the input is refused."""
    uid = uid.lower() if isinstance(uid, str) else ""
    if not NOTE_ID.match(uid):
        raise error("note_id_invalid", "A note id is a UUID.", 422)
    return uid


def check_own_photo(db: Session, account_id: int, uid: str | None) -> str | None:
    """A photo the person may put on a note or a day: one of their own. Any other answers like one that is not
    there."""
    if uid is None:
        return None
    uid = uid.lower() if isinstance(uid, str) else ""
    if not covers.PHOTO_ID.match(uid) or db.scalar(
            select(Photo.id).where(Photo.user_id == account_id, Photo.uid == uid)) is None:
        raise error("not_found", "Not found.", 404)
    return uid


def add_note(db: Session, account_id: int, dek: bytes, uid: str, day: str, note_text: str,
             prompt: str | None, photo_id: str | None = None,
             prompt_id: str | None = None) -> tuple[dict[str, Any], bool]:
    """The note, and whether it is new. The same id with the same text again returns the note that stands (a double
    click, a retry after a lost answer); the same id with another text is refused (``note_id_taken``): returning the
    old note would let the browser think the new text was kept. A note with a photo may be without words."""
    note_text = clean_text(note_text, NOTE_MAX, "note_too_long")
    photo_id = check_own_photo(db, account_id, photo_id)
    if not note_text and photo_id is None:
        raise error("note_empty", "A note needs a text.", 422)
    prompt = clean_line(prompt, PROMPT_MAX, "prompt_too_long") if prompt else None
    if prompt_id is not None and (prompt is None or not PROMPT_ID.match(prompt_id)):
        raise error("invalid_input", "The input is not valid.", 422, fields=["prompt_id"])
    existing = _note_row(db, account_id, uid)
    if existing is not None:
        return _same_note(account_id, dek, existing, note_text, photo_id), False
    sealed = {
        "text": vault.seal_text(dek, note_text, _note_aad(account_id, uid, day, "text")),
        "prompt": vault.seal_text(dek, prompt, _note_aad(account_id, uid, day, "prompt")) if prompt else None,
        "prompt_ref": vault.seal_text(dek, prompt_id, _note_aad(account_id, uid, day, "prompt_ref"))
        if prompt_id else None,
    }
    inserted = db.execute(
        text(
            "INSERT INTO notes (uid, user_id, date, created_at, text_enc, prompt_enc, prompt_ref_enc, photo_id) "
            "SELECT :uid, :user, :date, :now, :text, :prompt, :prompt_ref, :photo "
            "WHERE (SELECT count(*) FROM notes WHERE user_id = :user AND date = :date) < :limit "
            "ON CONFLICT (user_id, uid) DO NOTHING"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"uid": uid, "user": account_id, "date": day, "now": now(), "limit": NOTES_PER_DAY, "photo": photo_id,
         **sealed},
    )
    if inserted.rowcount == 1:
        quota.check_after_write(db, account_id, sum(len(value) for value in sealed.values() if value))
        # In the same transaction: a photo on a note is a note's for good, never a photo of the day.
        _mark_on_note(db, account_id, photo_id)
    db.commit()
    row = _note_row(db, account_id, uid)
    if row is None:
        raise error("too_many_notes", "There are as many notes on this day as there may be.", 409,
                    max=NOTES_PER_DAY)
    if inserted.rowcount != 1:
        return _same_note(account_id, dek, row, note_text, photo_id), False
    return _note_view(account_id, dek, row), True


def _same_note(account_id: int, dek: bytes, row: Any, note_text: str, photo_id: str | None) -> dict[str, Any]:
    view = _note_view(account_id, dek, row)
    if view["unreadable"] or view["text"] != note_text or view["photo_id"] != photo_id:
        raise error("note_id_taken", "A note with this id holds another text.", 409)
    return view


_KEEP: Any = object()


def change_note(db: Session, account_id: int, dek: bytes, uid: str, note_text: str,
                photo_id: Any = _KEEP) -> dict[str, Any]:
    """A new text for a note, and with ``photo_id`` another photo (or None: none). A note keeps words or a photo."""
    note_text = clean_text(note_text, NOTE_MAX, "note_too_long")
    row = _note_row(db, account_id, uid)
    if row is None:
        raise error("not_found", "Not found.", 404)
    photo = row.photo_id if photo_id is _KEEP else check_own_photo(db, account_id, photo_id)
    if not note_text and photo is None:
        raise error("note_empty", "A note needs a text.", 422)
    sealed = vault.seal_text(dek, note_text, _note_aad(account_id, uid, row.date, "text"))
    changed = db.execute(update(Note).where(Note.user_id == account_id, Note.uid == uid, Note.date == row.date).values(
        text_enc=sealed, photo_id=photo, updated_at=now()))
    if changed.rowcount == 1:
        quota.check_after_write(db, account_id, len(sealed) - len(row.text_enc))
        _mark_on_note(db, account_id, photo)
    db.commit()
    # Deleted in between (another tab): gone, like any note that is not there.
    found = _note_row(db, account_id, uid) if changed.rowcount == 1 else None
    if found is None:
        raise error("not_found", "Not found.", 404)
    return _note_view(account_id, dek, found)


def _mark_on_note(db: Session, account_id: int, uid: str | None) -> None:
    if uid is not None:
        db.execute(update(Photo).where(Photo.user_id == account_id, Photo.uid == uid).values(on_note=True))


def _is_cover(account_id: int, dek: bytes, sealed: bytes | None, day: str, uid: str) -> bool:
    if sealed is None:
        return False
    content = _readable_content(account_id, dek, day, sealed)
    # A page that does not open keeps the photo: it may be its cover.
    return content is None or content.get("cover") == covers.PHOTO_PREFIX + uid


def delete_note(db: Session, account_id: int, dek: bytes, uid: str) -> list[str]:
    """Deletes a note, and the photo that came with it, unless that photo is the cover of its day or another note
    holds it too. One transaction; the files of a deleted photo are the caller's to remove (the ids returned)."""
    row = db.execute(select(Note.photo_id).where(Note.user_id == account_id, Note.uid == uid)).first()
    gone = db.execute(delete(Note).where(Note.user_id == account_id, Note.uid == uid))
    if gone.rowcount != 1:
        db.rollback()
        raise error("not_found", "Not found.", 404)
    removed: list[str] = []
    photo = row.photo_id if row is not None else None
    if photo is not None:
        found = db.execute(select(Photo.date, Photo.on_note).where(Photo.user_id == account_id, Photo.uid == photo)
                           ).first()
        others = db.scalar(select(Note.id).where(Note.user_id == account_id, Note.photo_id == photo).limit(1))
        if found is not None and found.on_note and others is None:
            sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account_id, Day.date == found.date))
            if not _is_cover(account_id, dek, sealed, found.date, photo):
                db.execute(delete(Photo).where(Photo.user_id == account_id, Photo.uid == photo))
                removed.append(photo)
    db.commit()
    return removed


# --- Days -----------------------------------------------------------------------------------------------------------


def _day_aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "days", "content", day)


def empty_day() -> dict[str, Any]:
    return {"title": "", "text": "", "tags": [], "values": {}, "cover": None, "written_by": None}


def effective_cover(day: str, content: dict[str, Any], photo_ids: set[str] | None) -> tuple[str, bool]:
    """The cover a day shows, and whether it is the one chosen: the chosen illustration, the chosen photo while it
    exists, else the suggestion. Never empty."""
    chosen = content.get("cover")
    if covers.is_illustration(chosen):
        return chosen, True
    photo = covers.photo_of(chosen)
    if photo is not None and photo_ids is not None and photo in photo_ids:
        return chosen, True
    return covers.suggested_cover(day, content.get("tags") or []), False


def photo_ids_of(db: Session, account_id: int) -> set[str]:
    return set(db.scalars(select(Photo.uid).where(Photo.user_id == account_id)))


def _content(account_id: int, dek: bytes, day: str, sealed: bytes) -> dict[str, Any]:
    return {**empty_day(), **vault.open_json(dek, sealed, _day_aad(account_id, day))}


def _readable_content(account_id: int, dek: bytes, day: str, sealed: bytes) -> dict[str, Any] | None:
    try:
        return _content(account_id, dek, day, sealed)
    except vault.SealError:
        unreadable("days")
        return None


def _day_view(day: str, content: dict[str, Any] | None, created: datetime, updated: datetime, revision: int,
              photo_ids: set[str]) -> dict[str, Any]:
    broken = content is None
    content = content or empty_day()
    cover, chosen = effective_cover(day, content, photo_ids)
    return {
        "date": day,
        "title": content["title"],
        "text": content["text"],
        "tags": content["tags"],
        "values": content["values"],
        "cover": cover,
        "cover_chosen": chosen,
        "written_by": content["written_by"],
        "words": words_in(content["text"]),
        "unreadable": broken,
        "revision": revision,
        "created_at": created.isoformat(),
        "updated_at": updated.isoformat(),
    }


_DAY_COLUMNS = (Day.id, Day.date, Day.content_enc, Day.revision, Day.created_at, Day.updated_at)


def day_exists(db: Session, account_id: int, day: str) -> bool:
    return db.scalar(select(Day.id).where(Day.user_id == account_id, Day.date == day)) is not None


def get_day(db: Session, account_id: int, dek: bytes, day: str) -> dict[str, Any] | None:
    row = db.execute(select(*_DAY_COLUMNS).where(Day.user_id == account_id, Day.date == day)).first()
    if row is None:
        return None
    return _day_view(day, _readable_content(account_id, dek, day, row.content_enc), row.created_at, row.updated_at,
                     row.revision, photo_ids_of(db, account_id))


def change_day(db: Session, account_id: int, dek: bytes, day: str,
               apply: Callable[[dict[str, Any]], dict[str, Any]], *, base_revision: int | None = None,
               discard_draft: bool = False) -> dict[str, Any]:
    """Reads the day (or an empty one), lets ``apply`` change it and writes it back, atomically: a day that does not
    exist yet is inserted only if no other save inserted it first, one that exists is written only onto the revision
    it was read from. Otherwise it is read again and ``apply`` runs on what stands now.

    With ``base_revision`` (the revision the writer started from, -1 for "there was no page") the change is made only
    onto exactly that: a page saved meanwhile on another device is not overwritten unseen (``day_changed``, with the
    revision that stands). ``discard_draft`` deletes the day's draft in the same transaction."""
    for _ in range(CHANGE_TRIES):
        row = db.execute(select(*_DAY_COLUMNS).where(Day.user_id == account_id, Day.date == day)).first()
        if base_revision is not None:
            standing_revision = row.revision if row is not None else -1
            if standing_revision != base_revision:
                raise error("day_changed", "This day was changed meanwhile.", 409, revision=standing_revision)
        moment = now()
        if row is None:
            content = apply(empty_day())
            sealed = vault.seal_json(dek, content, _day_aad(account_id, day))
            written = db.execute(
                sqlite_insert(Day)
                .values(user_id=account_id, date=day, revision=0, created_at=moment, updated_at=moment,
                        content_enc=sealed)
                .on_conflict_do_nothing(index_elements=[Day.user_id, Day.date])
            )
            growth = len(sealed)
        else:
            standing = _readable_content(account_id, dek, day, row.content_enc)
            if standing is None:
                # Merging into what cannot be read would throw it away unseen; deleting the day stays possible.
                raise error("day_unreadable", "This day cannot be read; it can only be deleted.", 409)
            content = apply(standing)
            sealed = vault.seal_json(dek, content, _day_aad(account_id, day))
            written = db.execute(
                update(Day)
                .where(Day.id == row.id, Day.revision == row.revision)
                .values(content_enc=sealed, revision=row.revision + 1, updated_at=moment)
            )
            growth = len(sealed) - len(row.content_enc)
        if written.rowcount == 1:
            quota.check_after_write(db, account_id, growth)
        if written.rowcount == 1 and discard_draft:
            db.execute(delete(Draft).where(Draft.user_id == account_id, Draft.date == day))
        db.commit()
        if written.rowcount == 1:
            found = get_day(db, account_id, dek, day)
            assert found is not None
            return found
    raise error("busy", "nexdiary is busy. Try again in a moment.", 503)


def check_values(db: Session, account_id: int, values: dict[str, Any]) -> dict[str, int | None]:
    """Ratings for this person's own values only, each a whole number from 1 to 10, or null to take it back."""
    if len(values) > VALUE_DEFS_MAX:
        raise error("too_many_values", "There are as many values as there may be.", 409, max=VALUE_DEFS_MAX)
    known = _value_ids(db, account_id)
    out: dict[str, int | None] = {}
    for uid, rating in values.items():
        if uid not in known:
            raise error("value_unknown", "There is no such value.", 422)
        if rating is not None and (type(rating) is not int or not 1 <= rating <= 10):
            raise error("value_out_of_range", "A value is a whole number from 1 to 10.", 422)
        out[uid] = rating
    return out


def merge(content: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """The day with the fields of ``patch`` changed; ``values`` is merged one by one, null takes a value back."""
    out = {**content}
    for key in ("title", "text", "tags", "written_by", "cover"):
        if key in patch:
            out[key] = patch[key]
    if "values" in patch:
        values = {**content.get("values", {})}
        for uid, rating in patch["values"].items():
            if rating is None:
                values.pop(uid, None)
            else:
                values[uid] = rating
        out["values"] = values
    return out


def clean_day_patch(db: Session, account_id: int, day: str, fields: dict[str, Any]) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if fields.get("title") is not None:
        patch["title"] = clean_line(fields["title"], TITLE_MAX, "title_too_long")
    if fields.get("text") is not None:
        patch["text"] = clean_text(fields["text"], TEXT_MAX, "text_too_long")
    if fields.get("tags") is not None:
        patch["tags"] = clean_tags(fields["tags"])
    if "written_by" in fields:
        if fields["written_by"] not in (*WRITTEN_BY, None):
            raise error("invalid_input", "The input is not valid.", 422, fields=["written_by"])
        patch["written_by"] = fields["written_by"]
    if fields.get("values") is not None:
        patch["values"] = check_values(db, account_id, fields["values"])
    if "cover" in fields:
        patch["cover"] = check_cover(db, account_id, day, fields["cover"])
    return patch


def check_cover(db: Session, account_id: int, day: str, cover: Any) -> str | None:
    """A cover a day may store: a known illustration, or one of the person's own photos of that very day, whether it
    came with a note or not (any other photo answers like one that is not there). None: the suggestion again."""
    if cover is None:
        return None
    if not isinstance(cover, str) or len(cover) > COVER_MAX:
        raise error("cover_unknown", "There is no such cover.", 422)
    if covers.is_illustration(cover):
        return cover
    if cover.startswith(covers.PHOTO_PREFIX):
        uid = check_own_photo(db, account_id, cover[len(covers.PHOTO_PREFIX):])
        if db.scalar(select(Photo.date).where(Photo.user_id == account_id, Photo.uid == uid)) != day:
            raise error("cover_other_day", "The cover is a photo of this day.", 422)
        return covers.PHOTO_PREFIX + str(uid)
    raise error("cover_unknown", "There is no such cover.", 422)


def delete_day(db: Session, account_id: int, day: str) -> None:
    """The page of the day; its notes stay (the raw notes are always kept)."""
    gone = db.execute(delete(Day).where(Day.user_id == account_id, Day.date == day))
    db.commit()
    if gone.rowcount != 1:
        raise error("not_found", "Not found.", 404)


def list_days(db: Session, account_id: int, dek: bytes, *, before: str | None, limit: int) -> list[dict[str, Any]]:
    query = select(*_DAY_COLUMNS).where(Day.user_id == account_id)
    if before:
        query = query.where(Day.date < before)
    rows = db.execute(query.order_by(Day.date.desc()).limit(min(max(limit, 1), DAYS_LIST_MAX))).all()
    photo_ids = photo_ids_of(db, account_id)
    out = []
    for row in rows:
        content = _readable_content(account_id, dek, row.date, row.content_enc)
        shown = content or empty_day()
        out.append({"date": row.date, "title": shown["title"], "tags": shown["tags"],
                    "words": words_in(shown["text"]), "values": shown["values"],
                    "cover": effective_cover(row.date, shown, photo_ids)[0],
                    "written_by": shown["written_by"], "unreadable": content is None})
    return out


def streak(db: Session, account_id: int, dek: bytes, today: date) -> int:
    """Days in a row with a written page, up to today, or up to yesterday while today is still open."""
    dates = set(db.scalars(select(Day.date).where(Day.user_id == account_id, Day.date <= today.isoformat())))

    def written(day: date) -> bool:
        key = day.isoformat()
        if key not in dates:
            return False
        sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account_id, Day.date == key))
        content = _readable_content(account_id, dek, key, sealed) if sealed is not None else None
        return content is not None and bool(content["text"].strip())

    cursor = today if written(today) else today - timedelta(days=1)
    count = 0
    while written(cursor):
        count += 1
        cursor -= timedelta(days=1)
    return count


# --- Drafts ---------------------------------------------------------------------------------------------------------


def _draft_aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "drafts", "content", day)


def clean_draft(db: Session, account_id: int, day: str, fields: dict[str, Any]) -> dict[str, Any]:
    """What a draft holds: title, text, tags and cover, cleaned and limited like the page itself."""
    draft: dict[str, Any] = {"title": "", "text": "", "tags": [], "cover": None, "written_by": None, "ai_length": None}
    if fields.get("title") is not None:
        draft["title"] = clean_line(fields["title"], TITLE_MAX, "title_too_long")
    if fields.get("text") is not None:
        draft["text"] = clean_text(fields["text"], TEXT_MAX, "text_too_long")
    if fields.get("tags") is not None:
        draft["tags"] = clean_tags(fields["tags"])
    if fields.get("cover") is not None:
        draft["cover"] = check_cover(db, account_id, day, fields["cover"])
    # Whether the writing began as a suggestion of the AI, and how long it was asked for: kept with the draft, so a
    # page closed and opened again still counts as written with the AI.
    if fields.get("written_by") is not None:
        if fields["written_by"] not in WRITTEN_BY:
            raise error("invalid_input", "The input is not valid.", 422, fields=["written_by"])
        draft["written_by"] = fields["written_by"]
    if fields.get("ai_length") is not None:
        if fields["ai_length"] not in ("short", "long"):
            raise error("invalid_input", "The input is not valid.", 422, fields=["ai_length"])
        draft["ai_length"] = fields["ai_length"]
    return draft


def save_draft(db: Session, account_id: int, dek: bytes, day: str, draft: dict[str, Any],
               base_revision: int) -> dict[str, Any]:
    """Keeps the draft of a day, replacing the one before (one statement: two tabs typing at once leave one), while
    the person's storage has room for it (``quota``; the draft it replaces does not count)."""
    moment = now()
    sealed = vault.seal_json(dek, draft, _draft_aad(account_id, day))
    limit = quota.limit_bytes(db)
    written = db.execute(
        text(
            "INSERT INTO drafts (user_id, date, content_enc, base_revision, updated_at) "  # noqa: S608 - constants
            "SELECT :user, :date, :content, :base, :now "
            f"WHERE (:quota IS NULL OR {quota.USED} - coalesce((SELECT length(content_enc) FROM drafts "
            "WHERE user_id = :user AND date = :date), 0) + length(:content) <= :quota) "
            "ON CONFLICT (user_id, date) DO UPDATE SET content_enc = excluded.content_enc, "
            "base_revision = excluded.base_revision, updated_at = excluded.updated_at"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"user": account_id, "date": day, "content": sealed, "base": base_revision, "now": moment, "quota": limit},
    )
    db.commit()
    if written.rowcount != 1:
        raise quota.full(db)
    return {**draft, "base_revision": base_revision, "updated_at": moment.isoformat()}


def get_draft(db: Session, account_id: int, dek: bytes, day: str) -> dict[str, Any] | None:
    row = db.execute(select(Draft.content_enc, Draft.base_revision, Draft.updated_at)
                     .where(Draft.user_id == account_id, Draft.date == day)).first()
    if row is None:
        return None
    try:
        content = vault.open_json(dek, row.content_enc, _draft_aad(account_id, day))
    except vault.SealError:
        unreadable("drafts")
        return None
    cover = content.get("cover")
    photo = covers.photo_of(cover)
    if photo is not None and photo not in photo_ids_of(db, account_id):
        # The photo was deleted since: the draft falls back to the suggestion, it never names a photo that is gone.
        cover = None
    written_by = content.get("written_by") if content.get("written_by") in WRITTEN_BY else None
    ai_length = content.get("ai_length") if content.get("ai_length") in ("short", "long") else None
    return {"title": content.get("title", ""), "text": content.get("text", ""), "tags": content.get("tags", []),
            "cover": cover, "written_by": written_by, "ai_length": ai_length, "base_revision": row.base_revision,
            "updated_at": row.updated_at.isoformat()}


def delete_draft(db: Session, account_id: int, day: str) -> None:
    db.execute(delete(Draft).where(Draft.user_id == account_id, Draft.date == day))
    db.commit()


# --- Search ---------------------------------------------------------------------------------------------------------


def _fold(value: str) -> tuple[str, list[int]]:
    """The text in a form that ignores case and the ways of writing an umlaut (NFC, casefold: ß finds ss), and for
    every character of it the place in the original."""
    folded: list[str] = []
    places: list[int] = []
    for index, char in enumerate(unicodedata.normalize("NFC", value)):
        for part in char.casefold():
            folded.append(part)
            places.append(index)
    return "".join(folded), places


def fold(value: str) -> str:
    return _fold(value)[0]


def _snippet(original: str, places: list[int], start: int, length: int) -> str:
    normal = unicodedata.normalize("NFC", original)
    begin = places[start]
    end = places[min(start + length, len(places)) - 1] + 1
    left = max(0, begin - SNIPPET_AROUND)
    right = min(len(normal), end + SNIPPET_AROUND)
    piece = " ".join(normal[left:right].split())
    return ("… " if left > 0 else "") + piece + (" …" if right < len(normal) else "")


KIND_ORDER = ("title", "text", "tag", "note")


@dataclass
class Hit:
    date: str
    kind: str
    snippet: str
    note_id: str | None = None

    def view(self) -> dict[str, Any]:
        out: dict[str, Any] = {"date": self.date, "kind": self.kind, "snippet": self.snippet}
        if self.note_id:
            out["note_id"] = self.note_id
        return out


def _find(value: str, needle: str) -> tuple[int, str, list[int]] | None:
    folded, places = _fold(value)
    found = folded.find(needle)
    return (found, folded, places) if found >= 0 else None


def search(db: Session, account_id: int, dek: bytes, query: str) -> dict[str, Any]:
    """In memory, over this person's own titles, texts, tags and notes: everything is sealed on disk, so the database
    cannot search. Newest first, at most ``SEARCH_RESULTS``."""
    needle = fold(" ".join(clean_line(query, SEARCH_MAX, "search_too_long").split()))
    if not needle:
        raise error("search_empty", "There is nothing to look for.", 422)
    hits: list[Hit] = []
    for row in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id)):
        content = _readable_content(account_id, dek, row.date, row.content_enc)
        if content is None:
            continue
        for kind, value in (("title", content["title"]), ("text", content["text"])):
            found = _find(value, needle)
            if found:
                hits.append(Hit(row.date, kind, _snippet(value, found[2], found[0], len(needle))))
                break
        else:
            tags = [tag for tag in content["tags"] if needle in fold(tag)]
            if tags:
                hits.append(Hit(row.date, "tag", ", ".join(tags)))
    for row in db.execute(select(*_NOTE_COLUMNS).where(Note.user_id == account_id)):
        try:
            note = vault.open_text(dek, row.text_enc, _note_aad(account_id, row.uid, row.date, "text"))
        except vault.SealError:
            unreadable("notes")
            continue
        found = _find(note, needle)
        if found:
            hits.append(Hit(row.date, "note", _snippet(note, found[2], found[0], len(needle)), row.uid))
    # Newest day first; within a day the page before its notes (the sort is stable).
    hits.sort(key=lambda hit: KIND_ORDER.index(hit.kind))
    hits.sort(key=lambda hit: hit.date, reverse=True)
    return {"results": [hit.view() for hit in hits[:SEARCH_RESULTS]], "more": len(hits) > SEARCH_RESULTS}


# --- The brake on searching -----------------------------------------------------------------------------------------

_search_lock = threading.Lock()
_searching: set[int] = set()
_searches: dict[int, deque[float]] = {}


class SearchBrake:
    """One search at a time per person, and at most ``SEARCHES_PER_MINUTE`` a minute: a search opens every sealed
    text of the person, and a stolen session or a stuck script must not keep the server doing that."""

    def __init__(self, account_id: int) -> None:
        self.account_id = account_id

    def __enter__(self) -> None:
        moment = time.monotonic()
        with _search_lock:
            if self.account_id in _searching:
                raise error("search_busy", "A search is still running. Try again in a moment.", 429)
            seen = _searches.setdefault(self.account_id, deque())
            while seen and moment - seen[0] > 60:
                seen.popleft()
            if len(seen) >= SEARCHES_PER_MINUTE:
                exc = error("search_slow_down", "Too many searches. Wait a minute.", 429)
                exc.headers = {"Retry-After": "60"}
                raise exc
            seen.append(moment)
            _searching.add(self.account_id)

    def __exit__(self, *_exc: object) -> None:
        with _search_lock:
            _searching.discard(self.account_id)


def forget_searches() -> None:
    """For the tests."""
    with _search_lock:
        _searching.clear()
        _searches.clear()
