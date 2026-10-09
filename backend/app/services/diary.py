"""Notes, days and values of one person, sealed with that person's data key (``services/vault.py``).

Every function here takes the account id from the session and nothing else: a person reaches only their own rows, and
a row of somebody else answers exactly like one that does not exist.

Writes that could meet another write are atomic in the database, not checked in Python first:

* a note carries an id made by the browser; the same note sent twice (a double click, a retry) inserts once;
* a day is changed only on the revision it was read from, and made with ``ON CONFLICT DO NOTHING``: two saves at the
  same moment make one day, and neither change is lost;
* the values a person starts with are laid out under a mark on the account that is set once;
* a day locked for good (``locked_at``) is changed by nothing: every statement that writes to the day, its notes, its
  photos or its draft carries the lock in its own condition, so a lock that lands between a check and the write still
  stops the write, and a trigger holds the locked row still whatever code asks.
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

from sqlalchemy import bindparam, delete, exists, func, select, text, update
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


# --- The night -------------------------------------------------------------------------------------------------------

#: Notes written from midnight up to this hour (the person's time) may belong to the day before: the person says.
NIGHT_ENDS = 4


@dataclass(frozen=True)
class Night:
    """The hours after midnight, as they stand for one person at one moment."""

    #: The calendar day those hours fall on (the "today" of the clock), and the day before it.
    window: str
    yesterday: str
    #: What the person answered for this night: ``"yesterday"``, ``"today"`` or None while nobody was asked.
    choice: str | None

    def view(self) -> dict[str, Any]:
        return {"active": True, "today": self.window, "yesterday": self.yesterday, "choice": self.choice}


def night_of(account: Account) -> Night | None:
    """The night the person is in, or None from 4:00 on. Read from the clock of their time zone, so a night is the
    same night for every device they use, and the extra hour when the clocks go back changes nothing (the date stays,
    the answer stays)."""
    local = clock.now().astimezone(zone_of(account))
    if local.hour >= NIGHT_ENDS:
        return None
    window = local.date()
    yesterday = (window - timedelta(days=1)).isoformat()
    choice = None
    if account.night_for == window.isoformat():
        if account.night_day == yesterday:
            choice = "yesterday"
        elif account.night_day == window.isoformat():
            choice = "today"
    return Night(window.isoformat(), yesterday, choice)


def note_day(account: Account) -> date:
    """The day a note, a photo of a note or a question's answer goes to when the browser names no day: the person's
    today, or after midnight the day they said the night belongs to."""
    night = night_of(account)
    if night is not None and night.choice == "yesterday":
        return date.fromisoformat(night.yesterday)
    return today_of(account)


def choose_night(db: Session, account: Account, choice: str) -> Night:
    """The person's answer for the night they are in (and again, if they change their mind). ``not_night`` from 4:00 on:
    nothing is kept for a day that is not in doubt. One statement; the answer is never a date the browser names."""
    night = night_of(account)
    if choice not in ("yesterday", "today"):
        raise error("invalid_input", "The input is not valid.", 422, fields=["choice"])
    if night is None:
        raise error("not_night", "It is not night: notes belong to today.", 409)
    target = night.yesterday if choice == "yesterday" else night.window
    db.execute(update(Account).where(Account.id == account.id).values(night_for=night.window, night_day=target))
    db.commit()
    account.night_for, account.night_day = night.window, target
    found = night_of(account)
    assert found is not None
    return found


# --- Locked days -----------------------------------------------------------------------------------------------------


def locked_error() -> Exception:
    return error("day_locked", "This day is locked for good.", 409)


def _locked_day(user_id: Any, day: Any) -> Any:
    """The condition "the day of this user is locked", for a statement that decides in the database itself."""
    return exists().where(Day.user_id == user_id, Day.date == day, Day.locked_at.is_not(None))


def is_locked(db: Session, account_id: int, day: str) -> bool:
    return db.scalar(select(Day.id).where(Day.user_id == account_id, Day.date == day,
                                          Day.locked_at.is_not(None))) is not None


def ensure_open(db: Session, account_id: int, day: str) -> None:
    """Refuses a change to a locked day early (before a photo is read or drawn); the statement that writes checks
    again in the database, so this is courtesy, not the lock."""
    if is_locked(db, account_id, day):
        raise locked_error()


def locked_dates(db: Session, account_id: int, dates: list[str]) -> set[str]:
    if not dates:
        return set()
    return set(db.scalars(select(Day.date).where(Day.user_id == account_id, Day.date.in_(dates),
                                                 Day.locked_at.is_not(None))))


def lock_day(db: Session, account_id: int, dek: bytes, day: str) -> dict[str, Any]:
    """Locks a written day for good. Only a day with a page: a day that holds only values, tags or notes is not
    written yet (``not_written``), one that cannot be read is not locked blind. Locking twice is no error. The mark is
    set onto the revision that was read, so a save that came in between is either in the page that is locked or comes
    after the lock and is refused; the day's draft ends with it (it can never be saved)."""
    for _ in range(CHANGE_TRIES):
        row = db.execute(select(*_DAY_COLUMNS).where(Day.user_id == account_id, Day.date == day)).first()
        if row is None:
            raise error("not_found", "Not found.", 404)
        if row.locked_at is not None:
            found = get_day(db, account_id, dek, day)
            assert found is not None
            return found
        content = _readable_content(account_id, dek, day, row.content_enc)
        if content is None:
            raise error("day_unreadable", "This day cannot be read; it can only be deleted.", 409)
        if not has_page(content):
            raise error("not_written", "Only a day with a page can be locked.", 409)
        locked = db.execute(update(Day).where(Day.id == row.id, Day.revision == row.revision,
                                              Day.locked_at.is_(None)).values(locked_at=now()))
        if locked.rowcount == 1:
            db.execute(delete(Draft).where(Draft.user_id == account_id, Draft.date == day))
        db.commit()
        if locked.rowcount == 1:
            found = get_day(db, account_id, dek, day)
            assert found is not None
            return found
    raise error("busy", "nexdiary is busy. Try again in a moment.", 503)


def has_page(content: dict[str, Any] | None) -> bool:
    """Whether a day is a page: it has a title or a text. A day that holds only values, tags or notes is not (an
    unreadable one counts, so that it can be seen and dealt with)."""
    return content is None or bool(content["title"].strip() or content["text"].strip())


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


# --- Photos in the text ----------------------------------------------------------------------------------------------

#: A picture inside a page: ``![caption](photo:<id>#crop=x,y,w,h&rot=90)``, the id of one of the person's own photos
#: and, after ``#``, how the text shows it (``canonical_fragment``). The only picture syntax a page keeps; any other
#: picture (an address, ``data:``) is turned into its words when the page is read. The fragment may hold anything but
#: brackets, parentheses and line breaks: what is not the canonical form is dropped when the page is saved, the picture
#: stays. It never reaches past the next ``[``, so a page full of half pictures is still read in one pass.
PHOTO_IMAGE = re.compile(r"!\[((?:\\.|[^\]\\\n]){0,300})\]\(photo:([0-9a-f]{32})(?:#([^()\[\]\n]*))?\)")
_PARTIAL_IMAGE = re.compile(r"!\[[^\]\n]*(?:\]\(?(?:photo:?[0-9a-f]*(?:#[^()\[\]\n]*)?)?)?$")
_BLANKS = re.compile(r"\n{3,}")
#: The longest fragment that is read at all; the canonical form is at most 33 characters.
FRAGMENT_MAX = 64
#: A crop and its parts are in per mille of the photo as turned (``rot``); the smallest side of a crop.
PERMILLE = 1000
CROP_MIN = 10
ROTATIONS = (0, 90, 180, 270)
_FRAGMENT_NUMBER = re.compile(r"[0-9]{1,4}")


def canonical_fragment(raw: str | None) -> str:
    """How a picture in the text is shown, in the one form the server keeps: ``#crop=x,y,w,h&rot=r`` (either part
    optional, the crop first), or nothing. Turned first, then cut: the crop is in per mille of the turned picture, whole
    numbers without a sign, at least ``CROP_MIN`` wide and high and inside the picture; a crop of all of it and a turn
    of 0 are left out. A fragment with anything else (another key, a key twice, spaces, decimals, a sign, too long) is
    dropped whole: the picture stays and is shown as it is. The photo itself is never changed by it."""
    if not raw or len(raw) > FRAGMENT_MAX:
        return ""
    parts: dict[str, str] = {}
    for part in raw.split("&"):
        key, equals, value = part.partition("=")
        if not equals or key not in ("crop", "rot") or key in parts:
            return ""
        parts[key] = value
    out: list[str] = []
    if "crop" in parts:
        numbers = parts["crop"].split(",")
        if len(numbers) != 4 or not all(_FRAGMENT_NUMBER.fullmatch(number) for number in numbers):
            return ""
        x, y, w, h = (int(number) for number in numbers)
        if w < CROP_MIN or h < CROP_MIN or x + w > PERMILLE or y + h > PERMILLE:
            return ""
        if (x, y, w, h) != (0, 0, PERMILLE, PERMILLE):
            out.append(f"crop={x},{y},{w},{h}")
    if "rot" in parts:
        if not _FRAGMENT_NUMBER.fullmatch(parts["rot"]) or int(parts["rot"]) not in ROTATIONS:
            return ""
        if int(parts["rot"]):
            out.append(f"rot={int(parts['rot'])}")
    return "#" + "&".join(out) if out else ""


def canonical_photos(markdown: str) -> str:
    """The text with every picture of a photo in its canonical form (``canonical_fragment``); nothing else changes."""
    return PHOTO_IMAGE.sub(
        lambda match: f"![{match.group(1)}](photo:{match.group(2)}{canonical_fragment(match.group(3))})", markdown)


def text_photo_ids(markdown: str) -> list[str]:
    """The photos a page shows in its text, each once, in the order they stand."""
    return list(dict.fromkeys(match.group(2) for match in PHOTO_IMAGE.finditer(markdown)))


def strip_images(markdown: str, *, keep_caption: bool = False) -> str:
    """The text without its pictures: for counting words, for the start of a page in a list, for the search (which
    finds a caption, but not the id behind it)."""
    return PHOTO_IMAGE.sub(lambda match: match.group(1) if keep_caption else "", markdown)


def scrub_text_photos(db: Session, account_id: int, day: str, markdown: str) -> str:
    """The text as it may be kept: every picture in its canonical form (``canonical_photos``), and a picture of a photo
    that is not the person's own, or not of this day, removed (a deleted photo cannot be told from a stranger's, and
    both must answer alike). The rest of the text is untouched."""
    markdown = canonical_photos(markdown)
    wanted = text_photo_ids(markdown)
    if not wanted:
        return markdown
    known = set(db.scalars(select(Photo.uid).where(Photo.user_id == account_id, Photo.date == day,
                                                   Photo.uid.in_(wanted))))
    if known == set(wanted):
        return markdown
    kept = PHOTO_IMAGE.sub(lambda match: match.group(0) if match.group(2) in known else "", markdown)
    return _BLANKS.sub("\n\n", kept).strip()


def photos_held(content: dict[str, Any] | None) -> set[str]:
    """The photos a page or a draft holds: the pictures of its text and its cover."""
    if not content:
        return set()
    held = set(text_photo_ids(content.get("text") or ""))
    photo = covers.photo_of(content.get("cover"))
    if photo is not None:
        held.add(photo)
    return held


def without_photo(content: dict[str, Any], uid: str) -> dict[str, Any] | None:
    """A page or a draft without this photo: its pictures in the text gone, the cover back to the suggestion (and its
    crop with it). None when it did not hold the photo."""
    out = {**content}
    text_ = content.get("text") or ""
    if uid in text_photo_ids(text_):
        kept = PHOTO_IMAGE.sub(lambda match: "" if match.group(2) == uid else match.group(0), text_)
        out["text"] = _BLANKS.sub("\n\n", kept).strip()
    if covers.photo_of(content.get("cover")) == uid:
        out["cover"] = None
        out["cover_crop"] = None
    return out if out != content else None


def settle_photos(db: Session, account_id: int, dek: bytes, day: str, saved: dict[str, Any]) -> dict[str, Any]:
    """After a save: a photo the saved page names that was deleted while the save was under way (checked before, gone
    before the write) is taken out of it again, so that no page keeps a picture or a cover of a photo that is gone. The
    page as it stands then."""
    named = set(text_photo_ids(saved["text"]))
    sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account_id, Day.date == day))
    content = _readable_content(account_id, dek, day, sealed) if sealed is not None else None
    if content is not None:
        named |= photos_held(content)
    if not named:
        return saved
    missing = named - set(db.scalars(select(Photo.uid).where(Photo.user_id == account_id, Photo.uid.in_(named))))
    if not missing:
        return saved

    def without(standing: dict[str, Any]) -> dict[str, Any]:
        for uid in missing:
            standing = without_photo(standing, uid) or standing
        return standing

    try:
        return change_day(db, account_id, dek, day, without)
    except Exception:  # noqa: BLE001 - a lock or a busy moment in between: the page reads as it is, the next save cleans
        db.rollback()
        return get_day(db, account_id, dek, day) or saved


def adopt_text_photos(db: Session, account_id: int, day: str, markdown: str) -> None:
    """A photo that stands in the text is a photo of the day, whether it came with a note or not: it no longer goes
    with its note (deleting the note leaves it). Not on a locked day."""
    wanted = text_photo_ids(markdown)
    if not wanted:
        return
    db.execute(update(Photo).where(Photo.user_id == account_id, Photo.date == day, Photo.uid.in_(wanted),
                                   Photo.on_note.is_(True), ~_locked_day(Photo.user_id, Photo.date))
               .values(on_note=False))
    db.commit()


def words_in(value: str) -> int:
    return len(_WORD.findall(strip_images(value)))


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
    head = strip_images(markdown[:EXCERPT_SOURCE])
    if cut_source:
        head = _PARTIAL_IMAGE.sub("", head)
    words = plain_text(head)
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
    ensure_open(db, account_id, day)
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
            # A day locked in between (a second device): decided in this statement, not in the check before it.
            "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :date AND locked_at IS NOT NULL) "
            "ON CONFLICT (user_id, uid) DO NOTHING"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"uid": uid, "user": account_id, "date": day, "now": now(), "limit": NOTES_PER_DAY, "photo": photo_id,
         **sealed},
    )
    if inserted.rowcount == 1:
        quota.check_after_write(db, account_id, sum(len(value) for value in sealed.values() if value))
        # In the same transaction: a photo on a note is a note's for good, never a photo of the day, and it is of the
        # note's day.
        _follow_note(db, account_id, dek, photo_id, day, uid)
        _mark_on_note(db, account_id, photo_id)
    db.commit()
    row = _note_row(db, account_id, uid)
    if row is None:
        ensure_open(db, account_id, day)
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
    ensure_open(db, account_id, row.date)
    changed = db.execute(update(Note).where(Note.user_id == account_id, Note.uid == uid, Note.date == row.date,
                                            ~_locked_day(Note.user_id, Note.date)).values(
        text_enc=sealed, photo_id=photo, updated_at=now()))
    if changed.rowcount == 1:
        quota.check_after_write(db, account_id, len(sealed) - len(row.text_enc))
        _follow_note(db, account_id, dek, photo, row.date, uid)
        _mark_on_note(db, account_id, photo)
    db.commit()
    # Deleted in between (another tab): gone, like any note that is not there.
    found = _note_row(db, account_id, uid) if changed.rowcount == 1 else None
    if found is None:
        ensure_open(db, account_id, row.date)
        raise error("not_found", "Not found.", 404)
    return _note_view(account_id, dek, found)


def _mark_on_note(db: Session, account_id: int, uid: str | None) -> None:
    if uid is not None:
        db.execute(update(Photo).where(Photo.user_id == account_id, Photo.uid == uid).values(on_note=True))


def _follow_note(db: Session, account_id: int, dek: bytes, uid: str | None, day: str, note_uid: str) -> None:
    """A photo taken for a note belongs to the day of the note: one picked before the person said which day a note of
    the night belongs to has the other day, and follows the note here. Only a photo that was a note's already, that no
    other note holds, that is not the cover of its day and whose day is not locked; and while the new day has room.
    Call before ``_mark_on_note``."""
    if uid is None:
        return
    row = db.execute(select(Photo.date, Photo.on_note).where(Photo.user_id == account_id, Photo.uid == uid)).first()
    if row is None or row.date == day or not row.on_note:
        return
    if db.scalar(select(Note.id).where(Note.user_id == account_id, Note.photo_id == uid, Note.uid != note_uid)
                 .limit(1)) is not None:
        return
    sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account_id, Day.date == row.date))
    if sealed is not None and _is_cover(account_id, dek, sealed, row.date, uid):
        return
    from .photos import PHOTOS_PER_DAY

    db.execute(
        text(
            "UPDATE photos SET date = :day WHERE user_id = :user AND uid = :uid AND date = :old AND on_note = 1 "
            "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :old AND locked_at IS NOT NULL) "
            "AND (SELECT count(*) FROM photos WHERE user_id = :user AND date = :day) < :limit"
        ),
        {"day": day, "old": row.date, "user": account_id, "uid": uid, "limit": PHOTOS_PER_DAY},
    )


def _is_cover(account_id: int, dek: bytes, sealed: bytes | None, day: str, uid: str) -> bool:
    """Whether the page of the day holds this photo: as its cover, or as a picture in its text. Such a photo goes with
    neither the note it came with nor the move of that note."""
    if sealed is None:
        return False
    content = _readable_content(account_id, dek, day, sealed)
    # A page that does not open keeps the photo: it may be its cover.
    return (content is None or content.get("cover") == covers.PHOTO_PREFIX + uid
            or uid in text_photo_ids(content["text"]))


def delete_note(db: Session, account_id: int, dek: bytes, uid: str) -> list[str]:
    """Deletes a note, and the photo that came with it, unless that photo is the cover of its day or another note
    holds it too. One transaction; the files of a deleted photo are the caller's to remove (the ids returned)."""
    row = db.execute(select(Note.photo_id, Note.date).where(Note.user_id == account_id, Note.uid == uid)).first()
    if row is not None:
        ensure_open(db, account_id, row.date)
    gone = db.execute(delete(Note).where(Note.user_id == account_id, Note.uid == uid,
                                         ~_locked_day(Note.user_id, Note.date)))
    if gone.rowcount != 1:
        db.rollback()
        if row is not None:
            ensure_open(db, account_id, row.date)
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


def move_note(db: Session, account_id: int, dek: bytes, uid: str, direction: str, today: date) -> dict[str, Any]:
    """A note to the day before or the day after its own (``previous`` / ``next``), sealed anew: the date is part of
    what binds a sealed value, so a note cannot simply be pointed at another day. Refused (``day_locked``) when either
    day is locked, and when the target lies after ``today`` (``date_in_future``) or before 1900. The photo that came
    with the note goes along, unless another note or the cover of the old day still holds it. One statement for the
    note: it moves onto exactly the sealed values that were read, while neither day is locked and the target has
    room."""
    if direction not in ("previous", "next"):
        raise error("invalid_input", "The input is not valid.", 422, fields=["direction"])
    row = _note_row(db, account_id, uid)
    if row is None:
        raise error("not_found", "Not found.", 404)
    source = date.fromisoformat(row.date)
    target = source + timedelta(days=-1 if direction == "previous" else 1)
    if target > today:
        raise error("date_in_future", "This date is still to come.", 422)
    if target < EARLIEST:
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422)
    to = target.isoformat()
    ensure_open(db, account_id, row.date)
    ensure_open(db, account_id, to)
    view = _note_view(account_id, dek, row)
    if view["unreadable"]:
        raise error("note_unreadable", "This note cannot be read.", 409)

    def sealed(column: str, value: str | None) -> bytes | None:
        return vault.seal_text(dek, value, _note_aad(account_id, uid, to, column)) if value is not None else None

    moved = db.execute(
        text(
            "UPDATE notes SET date = :to, text_enc = :text, prompt_enc = :prompt, prompt_ref_enc = :prompt_ref, "
            "updated_at = :now WHERE user_id = :user AND uid = :uid AND date = :from AND text_enc = :old_text "
            "AND (prompt_enc IS :old_prompt) AND (prompt_ref_enc IS :old_prompt_ref) "
            "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date IN (:from, :to) "
            "AND locked_at IS NOT NULL) "
            "AND (SELECT count(*) FROM notes WHERE user_id = :user AND date = :to) < :limit"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"to": to, "from": row.date, "user": account_id, "uid": uid, "now": now(), "limit": NOTES_PER_DAY,
         "text": sealed("text", view["text"]), "prompt": sealed("prompt", view["prompt"]),
         "prompt_ref": sealed("prompt_ref", view["prompt_id"]), "old_text": row.text_enc,
         "old_prompt": row.prompt_enc, "old_prompt_ref": row.prompt_ref_enc},
    )
    if moved.rowcount == 1 and row.photo_id is not None:
        _move_photo_along(db, account_id, dek, row.photo_id, row.date, to)
    db.commit()
    if moved.rowcount != 1:
        again = _note_row(db, account_id, uid)
        if again is None:
            raise error("not_found", "Not found.", 404)
        ensure_open(db, account_id, row.date)
        ensure_open(db, account_id, to)
        if again.date == row.date and db.scalar(
                select(func.count()).select_from(Note).where(Note.user_id == account_id, Note.date == to)
        ) >= NOTES_PER_DAY:
            raise error("too_many_notes", "There are as many notes on this day as there may be.", 409,
                        max=NOTES_PER_DAY)
        raise error("busy", "nexdiary is busy. Try again in a moment.", 503)
    found = _note_row(db, account_id, uid)
    assert found is not None
    return _note_view(account_id, dek, found)


def _move_photo_along(db: Session, account_id: int, dek: bytes, photo: str, old: str, new: str) -> None:
    """The photo of a moved note takes the new day, unless it would leave something behind: another note on the old
    day that holds it, or the cover of the old day. Then it stays where it is (the note still shows it)."""
    from .photos import PHOTOS_PER_DAY

    # The moved note itself is on the new day already: what is found on the old day is another note.
    if db.scalar(select(Note.id).where(Note.user_id == account_id, Note.photo_id == photo, Note.date == old)
                 .limit(1)) is not None:
        return
    sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account_id, Day.date == old))
    if sealed is not None and _is_cover(account_id, dek, sealed, old, photo):
        return
    db.execute(
        text(
            "UPDATE photos SET date = :new WHERE user_id = :user AND uid = :uid AND date = :old "
            "AND (SELECT count(*) FROM photos WHERE user_id = :user AND date = :new) < :limit"
        ),
        {"new": new, "old": old, "user": account_id, "uid": photo, "limit": PHOTOS_PER_DAY},
    )


# --- Days -----------------------------------------------------------------------------------------------------------


def _day_aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "days", "content", day)


def empty_day() -> dict[str, Any]:
    return {"title": "", "text": "", "tags": [], "values": {}, "cover": None, "cover_crop": None, "written_by": None}


#: The part of a photo a cover shows: its middle in per mille of the photo, and how far it is zoomed in (100: the photo
#: fills the cover).
COVER_CROP_KEYS = frozenset({"x", "y", "zoom"})
ZOOM_MIN = 100
ZOOM_MAX = 400


def check_cover_crop(value: Any) -> dict[str, int] | None:
    """A crop of a cover as it may be kept: exactly ``x``, ``y`` (0 to 1000) and ``zoom`` (100 to 400), whole numbers;
    None takes it back. ``cover_crop_invalid`` for anything else."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != COVER_CROP_KEYS or any(
            type(value[key]) is not int for key in COVER_CROP_KEYS):
        raise error("cover_crop_invalid", "The crop of the cover is not valid.", 422)
    if not (0 <= value["x"] <= PERMILLE and 0 <= value["y"] <= PERMILLE and ZOOM_MIN <= value["zoom"] <= ZOOM_MAX):
        raise error("cover_crop_invalid", "The crop of the cover is not valid.", 422)
    return {"x": value["x"], "y": value["y"], "zoom": value["zoom"]}


def kept_crop(content: dict[str, Any]) -> dict[str, int] | None:
    """The crop a page or a draft keeps: only with a photo for its cover, and only one of the right form (what an older
    nexdiary or a damaged value left is no crop)."""
    if covers.photo_of(content.get("cover")) is None:
        return None
    try:
        return check_cover_crop(content.get("cover_crop"))
    except Exception:  # noqa: BLE001 - a crop that is not one is simply none
        return None


def shown_crop(content: dict[str, Any], chosen: bool) -> dict[str, int] | None:
    """The crop of the cover a day shows: the kept one while the chosen photo is shown, else none."""
    return kept_crop(content) if chosen else None


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
              photo_ids: set[str], locked_at: datetime | None = None) -> dict[str, Any]:
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
        "cover_crop": shown_crop(content, chosen),
        "written_by": content["written_by"],
        "words": words_in(content["text"]),
        "unreadable": broken,
        "revision": revision,
        "locked": locked_at is not None,
        "locked_at": locked_at.isoformat() if locked_at else None,
        "created_at": created.isoformat(),
        "updated_at": updated.isoformat(),
    }


_DAY_COLUMNS = (Day.id, Day.date, Day.content_enc, Day.revision, Day.created_at, Day.updated_at, Day.locked_at)


def has_draft(db: Session, account_id: int, day: str) -> bool:
    """Whether a draft of the day stands (the person's own or one the morning writing made)."""
    return db.scalar(select(Draft.date).where(Draft.user_id == account_id, Draft.date == day)) is not None


def has_notes(db: Session, account_id: int, day: str) -> bool:
    return db.scalar(select(Note.uid).where(Note.user_id == account_id, Note.date == day).limit(1)) is not None


def day_exists(db: Session, account_id: int, day: str) -> bool:
    return db.scalar(select(Day.id).where(Day.user_id == account_id, Day.date == day)) is not None


def get_day(db: Session, account_id: int, dek: bytes, day: str) -> dict[str, Any] | None:
    row = db.execute(select(*_DAY_COLUMNS).where(Day.user_id == account_id, Day.date == day)).first()
    if row is None:
        return None
    return _day_view(day, _readable_content(account_id, dek, day, row.content_enc), row.created_at, row.updated_at,
                     row.revision, photo_ids_of(db, account_id), row.locked_at)


def change_day(db: Session, account_id: int, dek: bytes, day: str,
               apply: Callable[[dict[str, Any]], dict[str, Any]], *, base_revision: int | None = None,
               discard_draft: bool = False, guard: Callable[[], None] | None = None) -> dict[str, Any]:
    """Reads the day (or an empty one), lets ``apply`` change it and writes it back, atomically: a day that does not
    exist yet is inserted only if no other save inserted it first, one that exists is written only onto the revision
    it was read from. Otherwise it is read again and ``apply`` runs on what stands now.

    With ``base_revision`` (the revision the writer started from, -1 for "there was no page") the change is made only
    onto exactly that: a page saved meanwhile on another device is not overwritten unseen (``day_changed``, with the
    revision that stands). ``discard_draft`` deletes the day's draft in the same transaction. ``guard`` runs after the
    write, inside its transaction (which holds the database's write lock from the write on): what it reads cannot change
    before the commit, and when it raises, nothing of the change stays."""
    for _ in range(CHANGE_TRIES):
        row = db.execute(select(*_DAY_COLUMNS).where(Day.user_id == account_id, Day.date == day)).first()
        if base_revision is not None:
            standing_revision = row.revision if row is not None else -1
            if standing_revision != base_revision:
                raise error("day_changed", "This day was changed meanwhile.", 409, revision=standing_revision)
        if row is not None and row.locked_at is not None:
            raise locked_error()
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
                # Not onto a day locked since it was read: that one is read again, and refused.
                .where(Day.id == row.id, Day.revision == row.revision, Day.locked_at.is_(None))
                .values(content_enc=sealed, revision=row.revision + 1, updated_at=moment)
            )
            growth = len(sealed) - len(row.content_enc)
        if written.rowcount == 1:
            quota.check_after_write(db, account_id, growth)
        if written.rowcount == 1 and guard is not None:
            try:
                guard()
            except Exception:
                db.rollback()
                raise
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
    """The day with the fields of ``patch`` changed; ``values`` is merged one by one, null takes a value back. A cover
    that changes without a crop of its own loses the crop of the one before, and only a photo keeps a crop."""
    out = {**content}
    for key in ("title", "text", "tags", "written_by", "cover", "cover_crop"):
        if key in patch:
            out[key] = patch[key]
    if "cover" in patch and "cover_crop" not in patch and patch["cover"] != content.get("cover"):
        out["cover_crop"] = None
    out["cover_crop"] = kept_crop(out)
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
        patch["text"] = scrub_text_photos(db, account_id, day, clean_text(fields["text"], TEXT_MAX, "text_too_long"))
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
    if "cover_crop" in fields:
        patch["cover_crop"] = check_cover_crop(fields["cover_crop"])
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
    """The page of the day: its title, text, tags, ratings and the choice of its cover, and with it every share of the
    day (the foreign key cascades) and the draft of the day, in the same transaction, so that no old draft comes back
    over the empty day. The notes stay (the raw notes are always kept), and the photos of the day; the photos taken for
    the text alone are the caller's to tidy (``tidy_text_photos``)."""
    gone = db.execute(delete(Day).where(Day.user_id == account_id, Day.date == day, Day.locked_at.is_(None)))
    if gone.rowcount == 1:
        db.execute(delete(Draft).where(Draft.user_id == account_id, Draft.date == day))
    db.commit()
    if gone.rowcount != 1:
        ensure_open(db, account_id, day)
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
        cover, chosen = effective_cover(row.date, shown, photo_ids)
        out.append({"date": row.date, "title": shown["title"], "tags": shown["tags"],
                    "words": words_in(shown["text"]), "values": shown["values"],
                    "cover": cover, "cover_crop": shown_crop(shown, chosen),
                    "written_by": shown["written_by"], "unreadable": content is None,
                    "locked": row.locked_at is not None})
    return out


# --- Catching up -----------------------------------------------------------------------------------------------------

#: How far back "days with notes and without a page" look, and how much of the first note is shown of each.
CATCH_UP_DAYS = 60
START_MAX = 140


def catch_up(db: Session, account_id: int, dek: bytes, before: date) -> dict[str, Any]:
    """The own days in the ``CATCH_UP_DAYS`` before ``before`` that have notes and no page, newest first: the date, how
    many notes, and the start of the first one. ``before`` itself (the day being kept) is not among them: it is still
    open. A day that holds only values or tags is not a page."""
    since = (before - timedelta(days=CATCH_UP_DAYS)).isoformat()
    rows = db.execute(
        select(Note.date, func.count(Note.id).label("n")).where(Note.user_id == account_id, Note.date >= since,
                                                                  Note.date < before.isoformat())
        .group_by(Note.date).order_by(Note.date.desc())
    ).all()
    dates = [row.date for row in rows]
    written: set[str] = set()
    if dates:
        for day in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id,
                                                                      Day.date.in_(dates))):
            if has_page(_readable_content(account_id, dek, day.date, day.content_enc)):
                written.add(day.date)
    waiting = set(db.scalars(select(Draft.date).where(Draft.user_id == account_id, Draft.auto.is_(True),
                                                      Draft.date.in_(dates)))) if dates else set()
    days = []
    for row in rows:
        if row.date in written:
            continue
        start = ""
        for note in list_notes(db, account_id, dek, row.date)[:5]:
            if note["text"] and not note["unreadable"]:
                start = excerpt(note["text"], START_MAX)
                break
        days.append({"date": row.date, "notes": int(row.n), "start": start, "auto": row.date in waiting})
    return {"count": len(days), "days": days, "auto": sum(1 for entry in days if entry["auto"])}


# --- Drafts ---------------------------------------------------------------------------------------------------------


def _draft_aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "drafts", "content", day)


def clean_draft(db: Session, account_id: int, day: str, fields: dict[str, Any]) -> dict[str, Any]:
    """What a draft holds: title, text, tags and cover, cleaned and limited like the page itself."""
    draft: dict[str, Any] = {"title": "", "text": "", "tags": [], "cover": None, "cover_crop": None,
                             "written_by": None, "ai_length": None}
    if fields.get("title") is not None:
        draft["title"] = clean_line(fields["title"], TITLE_MAX, "title_too_long")
    if fields.get("text") is not None:
        # The pictures in their canonical form already here; which photos stay is decided when the page is saved.
        draft["text"] = canonical_photos(clean_text(fields["text"], TEXT_MAX, "text_too_long"))
    if fields.get("tags") is not None:
        draft["tags"] = clean_tags(fields["tags"])
    if fields.get("cover") is not None:
        draft["cover"] = check_cover(db, account_id, day, fields["cover"])
    draft["cover_crop"] = check_cover_crop(fields.get("cover_crop"))
    draft["cover_crop"] = kept_crop(draft)
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
    the person's storage has room for it (``quota``; the draft it replaces does not count). A draft begun on a page
    (``base_revision`` 0 or more) is kept only while a page stands: one that arrives after the page was deleted (sent
    before, on its way) is refused with ``draft_page_gone``, decided in the same statement."""
    ensure_open(db, account_id, day)
    moment = now()
    sealed = vault.seal_json(dek, draft, _draft_aad(account_id, day))
    limit = quota.limit_bytes(db)
    written = db.execute(
        text(
            "INSERT INTO drafts (user_id, date, content_enc, base_revision, updated_at, auto) "  # noqa: S608 - constants
            "SELECT :user, :date, :content, :base, :now, 0 "
            f"WHERE (:quota IS NULL OR {quota.USED} - coalesce((SELECT length(content_enc) FROM drafts "
            "WHERE user_id = :user AND date = :date), 0) + length(:content) <= :quota) "
            "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :date AND locked_at IS NOT NULL) "
            "AND (:base < 0 OR EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :date)) "
            "ON CONFLICT (user_id, date) DO UPDATE SET content_enc = excluded.content_enc, "
            # Saved from the writing view the draft is the person's own: it no longer waits as the morning's.
            "base_revision = excluded.base_revision, updated_at = excluded.updated_at, auto = 0"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"user": account_id, "date": day, "content": sealed, "base": base_revision, "now": moment, "quota": limit},
    )
    db.commit()
    if written.rowcount != 1:
        ensure_open(db, account_id, day)
        if base_revision >= 0 and not day_exists(db, account_id, day):
            raise error("draft_page_gone", "The page this draft was begun on is gone.", 409)
        raise quota.full(db)
    return {**draft, "base_revision": base_revision, "updated_at": moment.isoformat(), "auto": False}


def save_auto_draft(db: Session, account_id: int, dek: bytes, day: str, draft: dict[str, Any],
                    revision: int) -> bool:
    """The draft the morning writing made, kept for the person to take or throw away. One statement: only where the
    day has no draft yet, is not locked, and still stands on the revision that was read (-1: no page then), so a page
    the person saved meanwhile is never met by a draft. True when it was kept."""
    sealed = vault.seal_json(dek, draft, _draft_aad(account_id, day))
    limit = quota.limit_bytes(db)
    written = db.execute(
        text(
            "INSERT INTO drafts (user_id, date, content_enc, base_revision, updated_at, auto) "  # noqa: S608 - constants
            "SELECT :user, :date, :content, :base, :now, 1 "
            f"WHERE (:quota IS NULL OR {quota.USED} + length(:content) <= :quota) "
            "AND coalesce((SELECT CASE WHEN locked_at IS NOT NULL THEN -2 ELSE revision END FROM days "
            "WHERE user_id = :user AND date = :date), -1) = :base "
            "ON CONFLICT (user_id, date) DO NOTHING"
        ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"user": account_id, "date": day, "content": sealed, "base": revision, "now": now(), "quota": limit},
    )
    db.commit()
    return written.rowcount == 1


def get_draft(db: Session, account_id: int, dek: bytes, day: str) -> dict[str, Any] | None:
    row = db.execute(select(Draft.content_enc, Draft.base_revision, Draft.updated_at, Draft.auto)
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
    crop = kept_crop(content)
    if photo is not None and photo not in photo_ids_of(db, account_id):
        # The photo was deleted since: the draft falls back to the suggestion, it never names a photo that is gone.
        cover, crop = None, None
    written_by = content.get("written_by") if content.get("written_by") in WRITTEN_BY else None
    ai_length = content.get("ai_length") if content.get("ai_length") in ("short", "long") else None
    return {"title": content.get("title", ""), "text": content.get("text", ""), "tags": content.get("tags", []),
            "cover": cover, "cover_crop": crop, "written_by": written_by, "ai_length": ai_length,
            "base_revision": row.base_revision, "updated_at": row.updated_at.isoformat(), "auto": bool(row.auto)}


def delete_draft(db: Session, account_id: int, dek: bytes, day: str) -> list[str]:
    """Throws the draft of a day away, and with it the photos taken for its text that nothing else holds
    (``tidy_text_photos``); the ids of those photos, whose files are the caller's to remove."""
    ensure_open(db, account_id, day)
    return tidy_text_photos(db, account_id, dek, day, drop_draft=True)


# --- Photos taken for the text ----------------------------------------------------------------------------------------

#: A photo taken for the text this short a time ago is never tidied away: it may be on its way into the text on
#: another device (uploaded there, its draft not saved yet: the draft follows a moment after the typing), or still in
#: the request that keeps it. Short on purpose: whoever puts a picture in and takes it out again sees it gone at once.
TEXT_PHOTO_GRACE = timedelta(seconds=5)


def tidy_text_photos(db: Session, account_id: int, dek: bytes, day: str, *, drop_draft: bool = False,
                     grace: bool = True) -> list[str]:
    """Deletes the photos of a day that were taken for its text (``for_text``) and that nothing holds any more: not the
    text or the cover of the saved page, not a note, not the text or the cover of the draft (thrown away first with
    ``drop_draft``, in the same transaction). Never on a locked day, never a photo younger than ``TEXT_PHOTO_GRACE``,
    and never when the page or the draft cannot be read (what they hold is not known then).

    ``grace=False`` (the page was deleted): the photos just taken go too, nothing is on its way into a page any more.

    One statement decides: it deletes only while the page still stands on the revision that was read and the draft is
    still the one that was read, so a save or a draft from another device in between keeps every photo; then it is
    read again. The ids of the photos deleted; their files are the caller's to remove, after this has committed."""
    for _ in range(CHANGE_TRIES):
        page = db.execute(select(Day.revision, Day.content_enc, Day.locked_at)
                          .where(Day.user_id == account_id, Day.date == day)).first()
        if page is not None and page.locked_at is not None:
            if drop_draft:
                raise locked_error()
            return []
        readable = True
        held: set[str] = set()
        if page is not None:
            content = _readable_content(account_id, dek, day, page.content_enc)
            readable = content is not None
            held |= photos_held(content)
        draft_sealed = None
        if not drop_draft:
            draft_sealed = db.scalar(select(Draft.content_enc).where(Draft.user_id == account_id, Draft.date == day))
            if draft_sealed is not None:
                try:
                    held |= photos_held(vault.open_json(dek, draft_sealed, _draft_aad(account_id, day)))
                except vault.SealError:
                    unreadable("drafts")
                    readable = False
        revision = page.revision if page is not None else None
        if drop_draft:
            db.execute(delete(Draft).where(Draft.user_id == account_id, Draft.date == day,
                                           ~_locked_day(Draft.user_id, Draft.date)))
        removed: list[str] = []
        if readable:
            removed = list(db.scalars(
                delete(Photo).where(
                    Photo.user_id == account_id, Photo.date == day, Photo.for_text.is_(True),
                    Photo.created_at <= now() - (TEXT_PHOTO_GRACE if grace else timedelta(0)),
                    Photo.uid.not_in(sorted(held)),
                    ~exists().where(Note.user_id == account_id, Note.photo_id == Photo.uid),
                    ~_locked_day(account_id, day),
                    select(Day.revision).where(Day.user_id == account_id, Day.date == day)
                    .scalar_subquery().is_not_distinct_from(revision),
                    select(Draft.content_enc).where(Draft.user_id == account_id, Draft.date == day)
                    .scalar_subquery().is_not_distinct_from(draft_sealed),
                ).returning(Photo.uid)
            ))
        if not removed:
            # Nothing deleted: because nothing was to go, or because the page or the draft changed in between (then
            # read again). Asked inside the transaction, which writes and so holds the lock.
            standing = db.execute(select(Day.revision, Day.locked_at)
                                  .where(Day.user_id == account_id, Day.date == day)).first()
            standing_draft = db.scalar(select(Draft.content_enc)
                                       .where(Draft.user_id == account_id, Draft.date == day))
            if (standing.revision if standing else None) != revision or standing_draft != draft_sealed or (
                    standing is not None and standing.locked_at is not None):
                db.rollback()
                continue
        db.commit()
        return removed
    if drop_draft:
        raise error("busy", "nexdiary is busy. Try again in a moment.", 503)
    return []


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
        # The text is searched, and quoted, as the words a person reads: not the Markdown it is kept as, in which a
        # heading is "## C\#" and a star is "\*".
        text = plain_text(strip_images(content["text"], keep_caption=True))
        for kind, value in (("title", content["title"]), ("text", text)):
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
