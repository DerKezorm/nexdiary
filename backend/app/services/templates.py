"""Templates for the pages: fixed headings a person writes under, each with an optional question as a hint.

A template has a name and one to twelve sections, each a heading (one line) and a question (what the section is
about, may be empty). One of them can be the default. All of a person's templates, and the choice of the default, are
one sealed value in one row (``WritingTemplates``): names and headings say something about the person, like the own
questions of the writing prompts. A save sends the whole list together with the revision it was read at and lands only
on exactly that revision, so two tabs never overwrite each other unseen: the later one is refused and has to reload.

A template reaches the AI only by its id, read here from the database (nothing the browser sends goes to the model),
and only as material in the JSON beside the notes. ``shape`` makes what the model wrote follow the template: every
heading once, in the template's order, an empty one where the model wrote nothing under it.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..errors import error
from ..models import WritingTemplates
from . import diary, quota, vault

#: What a person may keep. The question is as long as the question of a note.
MAX_TEMPLATES = 20
MIN_SECTIONS = 1
MAX_SECTIONS = 12
NAME_MAX = 60
HEADING_MAX = 120
QUESTION_MAX = diary.PROMPT_MAX
#: What stands for "no template" in a request, as against leaving the choice out (then the default counts).
NONE = "none"
#: The revision a person has before the first save: no row yet.
NO_ROW = -1

_ID = re.compile(r"^[0-9a-f]{12}$")
_LEADING_HASHES = re.compile(r"^[#\s]+")
_TRAILING_HASHES = re.compile(r"(?:^|\s)#+\s*$")


def new_id() -> str:
    return secrets.token_hex(6)


def _aad(account_id: int) -> bytes:
    return vault.aad(account_id, "writing_templates", "content", str(account_id))


def empty() -> dict[str, Any]:
    return {"templates": [], "default": None}


# --- What is stored --------------------------------------------------------------------------------------------------


def _clean_stored(stored: Any) -> dict[str, Any]:
    """What was stored, with anything that is not as it should be left out: a damaged value never breaks the page."""
    out = empty()
    if not isinstance(stored, dict) or not isinstance(stored.get("templates"), list):
        return out
    seen: set[str] = set()
    for entry in stored["templates"][:MAX_TEMPLATES]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not _ID.match(entry["id"]):
            continue
        if entry["id"] in seen or not isinstance(entry.get("name"), str) or not isinstance(entry.get("sections"), list):
            continue
        sections = []
        for part in entry["sections"][:MAX_SECTIONS]:
            if not isinstance(part, dict):
                continue
            if isinstance(part.get("heading"), str) and isinstance(part.get("question"), str):
                sections.append({"heading": part["heading"], "question": part["question"]})
        if not sections:
            continue
        seen.add(entry["id"])
        out["templates"].append({"id": entry["id"], "name": entry["name"], "sections": sections})
    if isinstance(stored.get("default"), str) and stored["default"] in seen:
        out["default"] = stored["default"]
    return out


def _row(db: Session, account_id: int) -> Any:
    return db.execute(select(WritingTemplates.content_enc, WritingTemplates.revision)
                      .where(WritingTemplates.user_id == account_id)).first()


def _open(account_id: int, dek: bytes, sealed: bytes) -> dict[str, Any]:
    try:
        return _clean_stored(vault.open_json(dek, sealed, _aad(account_id)))
    except vault.SealError:
        diary.unreadable("writing_templates")
        return empty()


def read(db: Session, account_id: int, dek: bytes) -> dict[str, Any]:
    """The templates, the default and the revision they stand at (``NO_ROW`` before the first save). A value that does
    not open reads as no templates."""
    row = _row(db, account_id)
    if row is None:
        return {**empty(), "revision": NO_ROW}
    return {**_open(account_id, dek, row.content_enc), "revision": row.revision}


# --- What comes in ---------------------------------------------------------------------------------------------------


_ESCAPED = re.compile(r"\\([!-/:-@\[-`{-~])")
_MARKS = re.compile(r"[\\*_\[\]<>`#~&]")


def _norm_markdown(markdown: str) -> str:
    """The one normal form, of Markdown text (the words of a heading line, as the editor or the model wrote them):
    escapes resolved, the marks of bold, italic and code gone, white space collapsed, case out of the way."""
    plain = re.sub(r"[*_`]", "", _ESCAPED.sub(r"\1", markdown))
    return " ".join(plain.split()).casefold()


def _norm(heading: str) -> str:
    """The normal form of a heading as the person typed it. It goes through the escaping first, as it does when it is
    written into the text, so that a backslash of the person's own (``C:\\Users``) is a backslash on both ways."""
    return _norm_markdown(_escape(heading))


def _keys(heading: str) -> set[str]:
    """What a line of the model's answer may say to be this heading: its normal form, and the heading taken as
    Markdown as it stands (a model that copies the words, backslashes and all, without escaping them again)."""
    return {_norm(heading), _norm_markdown(heading)}


def _escape(heading: str) -> str:
    """A heading as the text of a Markdown heading line: every mark that Markdown would read is escaped, so that the
    editor shows the words as the person typed them."""
    return _MARKS.sub(lambda found: "\\" + found.group(0), heading)


#: Characters that print as nothing without being white space or a character of format: the fillers of Hangul, the
#: empty Braille cell and the joiner of combining marks. The selectors of a variant are taken out by their ranges.
_BLANKS = frozenset(chr(code) for code in (0x3164, 0x115F, 0x1160, 0xFFA0, 0x2800, 0x034F))
#: The same, for whoever else cleans a line of text.
INVISIBLE = _BLANKS


def _blank(char: str) -> bool:
    code = ord(char)
    return (char.isspace() or unicodedata.category(char) == "Cf" or char in _BLANKS or 0xFE00 <= code <= 0xFE0F
            or 0xE0100 <= code <= 0xE01EF)


def _seen(value: str) -> bool:
    """Whether there is anything to see in a text: not only white space and characters that print as nothing (those
    that reverse the direction of the writing, joiners, fillers, selectors of a variant). An emoji with its selector
    is seen: the emoji is."""
    return not all(_blank(char) for char in value)


def _heading(value: Any) -> str:
    if not isinstance(value, str):
        raise error("invalid_input", "The input is not valid.", 422, fields=["heading"])
    line = diary.clean_line(value, HEADING_MAX * 4, "template_heading_too_long")
    line = _TRAILING_HASHES.sub("", _LEADING_HASHES.sub("", line)).strip()
    if not line or not _seen(line) or not _norm(line):
        raise error("template_heading_empty", "A heading needs words.", 422)
    if len(line) > HEADING_MAX:
        raise error("template_heading_too_long", "A heading is too long.", 422, max=HEADING_MAX)
    return line


def _template(raw: Any, known: set[str], taken: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise error("invalid_input", "The input is not valid.", 422)
    name = raw.get("name")
    if not isinstance(name, str):
        raise error("invalid_input", "The input is not valid.", 422, fields=["name"])
    name = diary.clean_line(name, NAME_MAX * 4, "template_name_too_long")
    if not name or not _seen(name):
        raise error("template_name_empty", "A template needs a name.", 422)
    if len(name) > NAME_MAX:
        raise error("template_name_too_long", "The name is too long.", 422, max=NAME_MAX)
    sections_in = raw.get("sections")
    if not isinstance(sections_in, list):
        raise error("invalid_input", "The input is not valid.", 422, fields=["sections"])
    if not MIN_SECTIONS <= len(sections_in) <= MAX_SECTIONS:
        raise error("template_sections", "A template has between one and twelve sections.", 422,
                    min=MIN_SECTIONS, max=MAX_SECTIONS)
    sections: list[dict[str, str]] = []
    headings: set[str] = set()
    for part in sections_in:
        if not isinstance(part, dict):
            raise error("invalid_input", "The input is not valid.", 422)
        heading = _heading(part.get("heading"))
        question = part.get("question", "")
        if not isinstance(question, str):
            raise error("invalid_input", "The input is not valid.", 422, fields=["question"])
        question = diary.clean_line(question, QUESTION_MAX, "question_too_long")
        if _norm(heading) in headings:
            raise error("template_heading_twice", "A template cannot have the same heading twice.", 422)
        headings.add(_norm(heading))
        sections.append({"heading": heading, "question": question})
    chosen = raw.get("id")
    if chosen is None:
        chosen = new_id()
        while chosen in taken:
            chosen = new_id()
    elif not isinstance(chosen, str) or chosen not in known:
        # Ids are made here; a template the person never had under that id is not one to take.
        raise error("template_unknown", "There is no such template.", 422)
    if chosen in taken:
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    taken.add(chosen)
    return {"id": chosen, "name": name, "sections": sections}


def save(db: Session, account_id: int, dek: bytes, raw: list[Any], default: str | None,
         revision: int) -> dict[str, Any]:
    """Replaces the templates and the default, onto exactly the revision they were read at: ``409 templates_changed``
    when another save came in between (nothing is written then)."""
    if len(raw) > MAX_TEMPLATES:
        raise error("too_many_templates", "There are as many templates as there may be.", 422, max=MAX_TEMPLATES)
    row = _row(db, account_id)
    known = {entry["id"] for entry in _open(account_id, dek, row.content_enc)["templates"]} if row else set()
    taken: set[str] = set()
    templates = [_template(entry, known, taken) for entry in raw]
    if default is not None and default not in taken:
        raise error("template_unknown", "There is no such template.", 422)
    content = {"templates": templates, "default": default}
    sealed = vault.seal_json(dek, content, _aad(account_id))
    if revision == NO_ROW:
        written = db.execute(
            sqlite_insert(WritingTemplates)
            .values(user_id=account_id, revision=0, updated_at=diary.now(), content_enc=sealed)
            .on_conflict_do_nothing(index_elements=[WritingTemplates.user_id])
        )
        growth, now_at = len(sealed), 0
    else:
        written = db.execute(
            update(WritingTemplates)
            .where(WritingTemplates.user_id == account_id, WritingTemplates.revision == revision)
            .values(content_enc=sealed, revision=revision + 1, updated_at=diary.now())
        )
        growth, now_at = len(sealed) - (len(row.content_enc) if row else 0), revision + 1
    if written.rowcount != 1:
        db.rollback()
        raise error("templates_changed", "Your templates were changed elsewhere. Load them again.", 409)
    quota.check_after_write(db, account_id, growth)
    db.commit()
    return {**content, "revision": now_at}


# --- Using one -------------------------------------------------------------------------------------------------------


def resolve(db: Session, account_id: int, dek: bytes, asked: str | None) -> dict[str, Any] | None:
    """The template a request means: ``None`` (left out) is the person's default if there is one, ``"none"`` is no
    template, an id is that template of this person (``422 template_unknown`` for any other, a stranger's too)."""
    stored = read(db, account_id, dek)
    if asked == NONE:
        return None
    wanted = stored["default"] if asked is None else asked
    if wanted is None:
        return None
    for entry in stored["templates"]:
        if entry["id"] == wanted:
            return entry
    if asked is None:
        return None
    raise error("template_unknown", "There is no such template.", 422)


def default_of(db: Session, account_id: int, dek: bytes) -> dict[str, Any] | None:
    """The person's default template, or None (none chosen, or it does not open)."""
    return resolve(db, account_id, dek, None)


# --- Making an answer follow the template ----------------------------------------------------------------------------

_HEADING_LINE = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$")


def heading_of(line: str) -> str | None:
    """The words of a Markdown heading line, or None for any other line."""
    found = _HEADING_LINE.match(line)
    return found.group(1).strip() if found and found.group(1).strip() else None


def is_heading_of(line: str, headings: list[str]) -> bool:
    """Whether the line is a heading with the words of one of ``headings``."""
    words = heading_of(line)
    return words is not None and _norm_markdown(words) in {key for item in headings for key in _keys(item)}


def _tidy(block: str) -> str:
    """A block of lines with its ends trimmed and no more than one empty line in a row."""
    return re.sub(r"\n[ \t]*(?:\n[ \t]*)+\n", "\n\n", block.strip())


def shape(text: str, headings: list[str]) -> str:
    """The text, made to follow ``headings``: each of them once as ``## heading`` in the order given, with the text the
    model wrote under it, and nothing under it where the model wrote nothing. Text before the first heading stays in
    front. A heading twice is one: what stood under both stands under the one, in the order written. A heading of
    another wording stays as a line of bold text with what stood under it, so nothing the model wrote is lost. The
    same text shaped again comes out as it is."""
    index: dict[str, int] = {}
    for position, item in enumerate(headings):
        for key in _keys(item):
            index.setdefault(key, position)
    front: list[str] = []
    bodies: list[list[str]] = [[] for _ in headings]
    current: list[str] = front
    for line in text.replace("\r\n", "\n").split("\n"):
        words = heading_of(line)
        if words is None:
            current.append(line)
        elif _norm_markdown(words) in index:
            current = bodies[index[_norm_markdown(words)]]
        else:
            # Not one of the template's: kept as text, where it stood.
            current.extend(["", f"**{words.strip('*_ ')}**", ""])
    parts: list[str] = []
    before = _tidy("\n".join(front))
    if before:
        parts.append(before)
    for heading, body in zip(headings, bodies, strict=True):
        parts.append(f"## {_escape(heading)}")
        written = _tidy("\n".join(body))
        if written:
            parts.append(written)
    return "\n\n".join(parts)


def has_words(shaped: str, headings: list[str]) -> bool:
    """Whether anything but the template's own headings stands in a shaped text."""
    return any(line.strip() and not is_heading_of(line, headings) for line in shaped.split("\n"))


__all__ = ["MAX_SECTIONS", "MAX_TEMPLATES", "NONE", "default_of", "has_words", "heading_of", "is_heading_of", "read",
           "resolve", "save", "shape"]
