"""The text of a page, for the book: its Markdown as paragraphs, headings, quotes, lists, bold and italic, and the
photos in it at their place.

Read in one pass over the lines and one over the characters of each, with no pattern that could take long on a strange
text: a page may hold 100,000 characters of anything. What comes out is the markup ReportLab's paragraphs understand
(``<b>``, ``<i>``, entities), always well formed, whatever the marks in the text: bold and italic are switched on and
off as they come and every run of text is wrapped on its own.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from . import diary

Kind = Literal["paragraph", "heading", "quote", "bullet", "number", "photo"]


@dataclass(frozen=True)
class Block:
    kind: Kind
    #: The markup for ReportLab (a photo: its id).
    text: str
    #: The heading's level, the number of a numbered item; for a photo its cut (the fragment after ``#``).
    extra: str = ""


_ESCAPABLE = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
#: The longest run of text one paragraph of the book gets: a longer one is set as several, one after the other.
#: ReportLab takes far longer than linear on one huge paragraph full of marks; in pieces it stays quick.
PIECE = 2_000
#: More bold or italic marks than this in one piece and it is set as plain text, marks and all.
MARKS_MAX = 64


def runs(text: str, size: int = PIECE) -> list[str]:
    """The text cut into runs of at most ``size`` characters, at a space where there is one in the second half."""
    out: list[str] = []
    while len(text) > size:
        cut = text.rfind(" ", size // 2, size)
        cut = cut if cut > 0 else size
        out.append(text[:cut])
        text = text[cut:].lstrip(" ")
    if text:
        out.append(text)
    return out


def _plain(text: str) -> str:
    """The text as it stands, escapes as their character: for a piece with too many marks to be worth setting."""
    out: list[str] = []
    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text) and text[index + 1] in _ESCAPABLE:
            out.append(text[index + 1])
            index += 2
            continue
        out.append(text[index])
        index += 1
    return "".join(out).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(text: str) -> str:
    """One line or paragraph of Markdown as markup: ``**bold**``, ``*italic*`` and ``_italic_`` (not inside a word),
    escapes as the character itself, everything else as text. More than ``MARKS_MAX`` marks: all of it as text."""
    if text.count("*") + text.count("_") > MARKS_MAX:
        return _plain(text)
    out: list[str] = []
    run: list[str] = []
    bold = italic = False

    def flush() -> None:
        if not run:
            return
        piece = "".join(run).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if italic:
            piece = f"<i>{piece}</i>"
        if bold:
            piece = f"<b>{piece}</b>"
        out.append(piece)
        run.clear()

    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\" and index + 1 < length and text[index + 1] in _ESCAPABLE:
            run.append(text[index + 1])
            index += 2
            continue
        if char == "*":
            stars = 1
            while index + stars < length and text[index + stars] == "*":
                stars += 1
            flush()
            if stars >= 2:
                bold = not bold
            if stars % 2 == 1:
                italic = not italic
            index += stars
            continue
        if char == "_":
            before = text[index - 1] if index else " "
            after = text[index + 1] if index + 1 < length else " "
            if not (before.isalnum() and after.isalnum()):
                flush()
                italic = not italic
                index += 1
                continue
        run.append(char)
        index += 1
    flush()
    return "".join(out)


def _heading(line: str) -> tuple[int, str] | None:
    stripped = line.lstrip(" ")
    if len(line) - len(stripped) > 3:
        return None
    level = 0
    while level < len(stripped) and stripped[level] == "#":
        level += 1
    if 1 <= level <= 6 and (len(stripped) == level or stripped[level] == " "):
        return level, stripped[level:].strip().rstrip("#").strip()
    return None


def _item(line: str) -> tuple[str, str] | None:
    stripped = line.lstrip(" ")
    if len(line) - len(stripped) > 3:
        return None
    if stripped[:1] in "-*+" and stripped[1:2] == " ":
        return "", stripped[2:].strip()
    digits = 0
    while digits < len(stripped) and digits < 9 and stripped[digits].isdigit():
        digits += 1
    if digits and stripped[digits : digits + 1] in (".", ")") and stripped[digits + 1 : digits + 2] == " ":
        return stripped[:digits], stripped[digits + 2 :].strip()
    return None


def _photos(line: str) -> Iterator[tuple[str, str, str]]:
    """The line in pieces: ("text", words, "") and ("photo", id, cut)."""
    at = 0
    for match in diary.PHOTO_IMAGE.finditer(line):
        if match.start() > at:
            yield "text", line[at : match.start()], ""
        yield "photo", match.group(2), match.group(3) or ""
        at = match.end()
    if at < len(line):
        yield "text", line[at:], ""


def blocks(markdown: str) -> list[Block]:
    """The page as blocks, in their order. Lines of one paragraph (or one quote) are joined; a photo stands alone."""
    found: list[Block] = []
    paragraph: list[str] = []
    quote: list[str] = []

    def end_paragraph() -> None:
        if paragraph:
            text = " ".join(part.strip() for part in paragraph).strip()
            found.extend(Block("paragraph", inline(piece)) for piece in runs(text))
            paragraph.clear()

    def end_quote() -> None:
        if quote:
            text = " ".join(part.strip() for part in quote).strip()
            found.extend(Block("quote", inline(piece)) for piece in runs(text))
            quote.clear()

    for raw in markdown.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            end_paragraph()
            end_quote()
            continue
        stripped = line.lstrip(" ")
        if stripped.startswith(">"):
            end_paragraph()
            quote.append(stripped[1:].lstrip(" ").lstrip(">").lstrip(" "))
            continue
        end_quote()
        heading = _heading(line)
        if heading is not None:
            end_paragraph()
            if heading[1]:
                first, *rest = runs(heading[1])
                found.append(Block("heading", inline(first), str(min(heading[0], 3))))
                found.extend(Block("paragraph", inline(piece)) for piece in rest)
            continue
        item = _item(line)
        pieces = list(_photos(line if item is None else item[1]))
        if item is not None:
            end_paragraph()
            words = "".join(text for kind, text, _cut in pieces if kind == "text").strip()
            if words:
                first, *rest = runs(words)
                found.append(Block("number" if item[0] else "bullet", inline(first), item[0]))
                found.extend(Block("paragraph", inline(piece)) for piece in rest)
            found.extend(Block("photo", uid, cut) for kind, uid, cut in pieces if kind == "photo")
            continue
        for kind, value, cut in pieces:
            if kind == "photo":
                end_paragraph()
                found.append(Block("photo", value, cut))
            else:
                paragraph.append(value)
    end_paragraph()
    end_quote()
    return found


def cut_of(fragment: str) -> tuple[tuple[int, int, int, int] | None, int]:
    """The cut of a photo in the text (``crop=x,y,w,h&rot=90``, thousandths of the turned photo), as the server keeps
    it (``diary.canonical_fragment``); anything else shows the photo whole."""
    canonical = diary.canonical_fragment(fragment).removeprefix("#")
    crop: tuple[int, int, int, int] | None = None
    rotation = 0
    for part in canonical.split("&") if canonical else []:
        if part.startswith("crop="):
            values = [int(value) for value in part[5:].split(",")]
            crop = (values[0], values[1], values[2], values[3])
        elif part.startswith("rot="):
            rotation = int(part[4:])
    return crop, rotation
