"""A year as a book: a PDF of the own pages of one year, set on the server, to print or to keep.

What it holds: a title page (six covers of the year, the year, whose diary it is), the contents (every month with the
page its chapter begins on), a chapter page for every month, and for every day its page: the cover, the date, the
title and the text with its photos, flowing on over as many pages as it needs; optionally the values under each day
and the raw notes gathered in an appendix. Only the signed-in person's own pages, the locked ones among them.

**Load and safety.** A book is set in a thread of its own, one at a time on the whole server (another person hears
"busy" and tries again later), one per person, a few per hour, and stopped when it takes longer than ``JOB_SECONDS``.
Photos are opened one at a time, made smaller and let go before the next. The finished PDF is never written to the disk
in the clear: it is sealed while it is written, piece by piece (AES-GCM), with a key that lives only in this process
(``books/`` in the data folder holds nothing a restart could open; the start clears it). Only the person who asked for
it can fetch it, once: it is gone after the download, and after ``KEEP_SECONDS`` when nobody fetched it.
"""

from __future__ import annotations

import hashlib
import io
import logging
import secrets
import shutil
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, A5
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, NextPageTemplate, PageBreak, PageTemplate, Paragraph
from reportlab.platypus import Spacer as PlatypusSpacer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import private
from ..config import get_settings
from ..errors import error
from ..models import Account, Day, Note, Photo
from . import book_art, book_text, covers, diary, photos, pictures

logger = logging.getLogger("nexdiary.book")

FORMATS = {"a5": A5, "a4": A4}
#: The whole of one book, from the first page opened to the last byte sealed.
JOB_SECONDS = 600.0
#: How long a finished book waits to be fetched.
KEEP_SECONDS = 30 * 60
#: Books a person may ask for in an hour.
PER_HOUR = 6
#: The long side of a photo in the book, in pixels: sharp in print on A4, and a year of photos stays a file one can
#: send to a print shop.
PHOTO_EDGE = 1600
JPEG_QUALITY = 82
#: The sealed file is written in pieces of this size.
CHUNK = 1024 * 1024
FONTS = Path(__file__).resolve().parent.parent / "assets" / "fonts"
JOB_ID_LENGTH = 32

INK = colors.HexColor("#3b2f27")
INK_2 = colors.HexColor("#6b5a4c")
MUTED = colors.HexColor("#8a7867")

#: The words of the book, in the person's language; English for any other.
TEXTS: dict[str, dict[str, Any]] = {
    "de": {
        "months": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
                   "November", "Dezember"],
        "weekdays": ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"],
        "date": "{weekday}, {day}. {month} {year}",
        "of": "Das Tagebuch von {name}",
        "contents": "Inhalt",
        "chapter": "Kapitel",
        "days": {1: "1 Tag", 0: "{n} Tage"},
        "appendix": "Anhang",
        "notes": "Rohnotizen",
    },
    "en": {
        "months": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
                   "November", "December"],
        "weekdays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        "date": "{weekday}, {day} {month} {year}",
        "of": "The diary of {name}",
        "contents": "Contents",
        "chapter": "Chapter",
        "days": {1: "1 day", 0: "{n} days"},
        "appendix": "Appendix",
        "notes": "Raw notes",
    },
}

#: The clock for the deadline; the tests put their own in.
ticks: Callable[[], float] = time.monotonic
#: Called at every step of setting a book (``"day"``, ``"sealed"``); the tests look into the data folder there.
checkpoint: Callable[[str], None] | None = None


def fail(code: str, text: str, status: int) -> Exception:
    return error(code, text, status)


# --- Options --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Options:
    year: int
    format: str = "a5"
    photos: bool = True
    values: bool = False
    notes: bool = False
    language: str = "de"


# --- Sealing --------------------------------------------------------------------------------------------------------


class SealedWriter(io.RawIOBase):
    """A file that is written sealed: every ``CHUNK`` bytes become one AES-GCM piece (its length, then the sealed
    bytes), numbered so that none can be left out, moved or added; the last one is marked as the last."""

    def __init__(self, path: Path, key: bytes, label: bytes) -> None:
        super().__init__()
        self._aead = AESGCM(key)
        self._label = label
        self._buffer = bytearray()
        self._index = 0
        private.new_file(path)
        self._file = path.open("wb")
        self.size = 0

    def writable(self) -> bool:
        return True

    def _nonce(self, last: bool) -> bytes:
        return self._index.to_bytes(11, "big") + (b"\x01" if last else b"\x00")

    def _seal(self, piece: bytes, last: bool) -> None:
        sealed = self._aead.encrypt(self._nonce(last), piece, self._label)
        self._file.write(len(sealed).to_bytes(4, "big") + sealed)
        self._index += 1

    def write(self, data: Any) -> int:
        view = memoryview(data).cast("B")
        self._buffer.extend(view)
        self.size += len(view)
        while len(self._buffer) > CHUNK:
            self._seal(bytes(self._buffer[:CHUNK]), last=False)
            del self._buffer[:CHUNK]
        return len(view)

    def close(self) -> None:
        if not self.closed:
            self._seal(bytes(self._buffer), last=True)
            self._buffer.clear()
            self._file.flush()
            self._file.close()
        super().close()

    def abandon(self) -> None:
        self._buffer.clear()
        self._file.close()
        super().close()


def unsealed(path: Path, key: bytes, label: bytes) -> Iterator[bytes]:
    """The pieces of a sealed file, opened in their order; stops with an error when one is missing or changed."""
    aead = AESGCM(key)
    index = 0
    with path.open("rb") as handle:
        while True:
            head = handle.read(4)
            if len(head) < 4:
                raise ValueError("cut off")
            sealed = handle.read(int.from_bytes(head, "big"))
            try:
                piece = aead.decrypt(index.to_bytes(11, "big") + b"\x00", sealed, label)
                last = False
            except InvalidTag:
                piece = aead.decrypt(index.to_bytes(11, "big") + b"\x01", sealed, label)
                last = True
            index += 1
            if piece:
                yield piece
            if last:
                return


# --- Jobs -----------------------------------------------------------------------------------------------------------


@dataclass
class Job:
    id: str
    account_id: int
    year: int
    started: float
    state: str = "working"
    code: str | None = None
    pages: int = 0
    finished: float | None = None
    #: The thread is still at work. Only it clears this, as its very last step: until then the job holds the server's
    #: one place for a book, also when it was given up.
    running: bool = True
    key: bytes = field(default_factory=lambda: AESGCM.generate_key(bit_length=256), repr=False)

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "year": self.year, "state": self.state, "pages": self.pages, "error": self.code}


_lock = threading.Lock()
_jobs: dict[str, Job] = {}
_starts: dict[int, deque[float]] = {}
#: People whose last book ran past ``JOB_SECONDS``: when they may start the next one.
_paused: dict[int, float] = {}
#: How long a person waits after a book that took too long; it held the server's one place for that long.
PAUSE_SECONDS = 15 * 60


def folder() -> Path:
    return get_settings().data_dir / "books"


def _path(job: Job) -> Path:
    return folder() / f"{job.id}.sealed"


def _drop(job: Job) -> None:
    """The job and its file, gone (under ``_lock``)."""
    _jobs.pop(job.id, None)
    try:
        _path(job).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("A book file could not be deleted: %s", exc.strerror)


def startup() -> None:
    """At start: whatever lies in ``books/`` was sealed with a key that died with the last process. Away with it."""
    shutil.rmtree(folder(), ignore_errors=True)


def sweep() -> None:
    """Books nobody fetched within ``KEEP_SECONDS``, and failed ones, go; so do files in ``books/`` that no job knows
    (a download that never finished, say) once they are that old."""
    moment = ticks()
    with _lock:
        for job in list(_jobs.values()):
            if job.finished is not None and moment - job.finished > KEEP_SECONDS and not job.running:
                _drop(job)
        known = {_path(job).name for job in _jobs.values()}
        try:
            files = list(folder().iterdir())
        except OSError:
            files = []
        now = time.time()
        for path in files:
            try:
                if path.name not in known and now - path.stat().st_mtime > KEEP_SECONDS:
                    path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("A book file could not be deleted: %s", exc.strerror)


def forget_account(account_id: int) -> None:
    """An account is deleted: its books go at once, one being set stops at its next step."""
    with _lock:
        for job in [job for job in _jobs.values() if job.account_id == account_id]:
            if job.running:
                job.state = "cancelled"
            else:
                _drop(job)
        _starts.pop(account_id, None)
        _paused.pop(account_id, None)


def forget() -> None:
    """For the tests."""
    with _lock:
        for job in list(_jobs.values()):
            _drop(job)
        _starts.clear()
        _paused.clear()


def _check_id(job_id: str) -> None:
    if len(job_id) != JOB_ID_LENGTH or any(char not in "0123456789abcdef" for char in job_id):
        raise fail("not_found", "Not found.", 404)


def status(job_id: str, account_id: int) -> dict[str, Any]:
    """The state of an own job; another person's is not found, like one that never was."""
    _check_id(job_id)
    sweep()
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.account_id != account_id:
            raise fail("not_found", "Not found.", 404)
        return job.view()


def discard(job_id: str, account_id: int) -> None:
    _check_id(job_id)
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.account_id != account_id:
            raise fail("not_found", "Not found.", 404)
        if job.state == "working":
            job.state = "cancelled"
            return
        # A book on its way to the browser goes when the download ends.
        if job.state != "taken":
            _drop(job)


def fetch(job_id: str, account_id: int) -> tuple[int, Iterator[bytes]]:
    """The finished PDF of an own job, opened piece by piece as it is sent. Taken once: a second request finds
    nothing, and the file is gone when the last piece went out (or the download broke off)."""
    _check_id(job_id)
    sweep()
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.account_id != account_id or job.state != "done":
            raise fail("not_found", "Not found.", 404)
        job.state = "taken"
        path = _path(job)

    def pieces() -> Iterator[bytes]:
        try:
            yield from unsealed(path, job.key, job.id.encode())
        finally:
            with _lock:
                _drop(job)

    return job.year, pieces()


def start(db: Session, account: Account, options: Options) -> dict[str, Any]:
    """A new book for the person, set in the background. Refused while another is being set (on the whole server),
    after ``PER_HOUR`` in the last hour, and for a year without a page."""
    if options.format not in FORMATS:
        raise fail("invalid_input", "The input is not valid.", 422)
    first, last = f"{options.year:04d}-01-01", f"{options.year:04d}-12-31"
    rows = db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account.id, Day.date >= first,
                                                             Day.date <= last).limit(400)).all()
    from . import vault

    dek = vault.dek_for(account.id)
    if not any(diary.has_page(diary._readable_content(account.id, dek, row.date, row.content_enc)) for row in rows):
        raise fail("book_empty", "There is no page in this year.", 409)
    sweep()
    moment = ticks()
    with _lock:
        # A job counts until its thread has ended, given up or not.
        working = [job for job in _jobs.values() if job.running]
        if any(job.account_id == account.id for job in working):
            raise fail("book_running", "Your book is being set already.", 409)
        if working:
            exc = fail("book_busy", "A book is being set right now. Try again in a moment.", 503)
            exc.headers = {"Retry-After": "30"}  # type: ignore[attr-defined]
            raise exc
        paused = _paused.get(account.id)
        if paused is not None and moment < paused:
            exc = fail("book_paused", "Your last book took too long. Try again later.", 429)
            exc.headers = {"Retry-After": str(int(paused - moment) + 1)}  # type: ignore[attr-defined]
            raise exc
        seen = _starts.setdefault(account.id, deque())
        while seen and moment - seen[0] > 3600:
            seen.popleft()
        if len(seen) >= PER_HOUR:
            exc = fail("book_too_often", "That was enough books for an hour. Try again later.", 429)
            exc.headers = {"Retry-After": str(int(3600 - (moment - seen[0])) + 1)}  # type: ignore[attr-defined]
            raise exc
        seen.append(moment)
        # A book of the person that was never fetched gives way to the new one; one on its way to the browser stays.
        for job in [job for job in _jobs.values() if job.account_id == account.id and job.state != "taken"]:
            _drop(job)
        job = Job(id=secrets.token_hex(JOB_ID_LENGTH // 2), account_id=account.id, year=options.year, started=moment)
        _jobs[job.id] = job
    name = account.display_name or account.name
    worker = threading.Thread(target=_run, args=(job, options, name), name="nexdiary-book", daemon=True)
    worker.start()
    return job.view()


class Stopped(Exception):
    """The job ran past its deadline or was given up."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _step(job: Job, what: str) -> None:
    if checkpoint is not None:
        checkpoint(what)
    if job.state == "cancelled":
        raise Stopped("book_cancelled")
    if ticks() - job.started > JOB_SECONDS:
        raise Stopped("book_too_long")


def _run(job: Job, options: Options, name: str) -> None:
    from ..db import SessionLocal

    folder().mkdir(parents=True, exist_ok=True)
    private.tighten(folder())
    writer: SealedWriter | None = None
    started = time.monotonic()
    try:
        writer = SealedWriter(_path(job), job.key, job.id.encode())
        with SessionLocal() as db:
            pages = make(db, job, options, name, writer)
        writer.close()
        _step(job, "sealed")
        with _lock:
            if job.state == "cancelled":
                raise Stopped("book_cancelled")
            job.pages = pages
            job.state = "done"
            job.finished = ticks()
        logger.info("A book was set pages=%d seconds=%.1f", pages, time.monotonic() - started)
    except Exception as exc:
        code = exc.code if isinstance(exc, Stopped) else "book_failed"
        if not isinstance(exc, Stopped):
            logger.exception("A book could not be set")
        else:
            logger.info("A book was stopped reason=%s", code)
        if writer is not None and not writer.closed:
            writer.abandon()
        with _lock:
            try:
                _path(job).unlink(missing_ok=True)
            except OSError:
                pass
            job.state = "failed"
            job.code = code
            job.finished = ticks()
            if code == "book_too_long":
                _paused[job.account_id] = ticks() + PAUSE_SECONDS
    finally:
        with _lock:
            job.running = False
            if job.state in ("cancelled", "failed") and job.code in (None, "book_cancelled"):
                _drop(job)


# --- Setting the book -----------------------------------------------------------------------------------------------

_fonts_lock = threading.Lock()
_fonts_ready = False


def _harden() -> None:
    """ReportLab opens whatever a picture or a font names: a path, ``file:``, ``http:`` (an ``<img src>`` in a paragraph
    would do it). nexdiary hands it every picture in memory and only its own fonts by path, so nothing else is ever
    opened: not the disk, not the network, even if text ever slipped through unescaped."""
    from reportlab import rl_config
    from reportlab.lib import utils
    from reportlab.pdfbase import pdfdoc, pdfutils
    from reportlab.platypus import flowables

    rl_config.trustedSchemes = []
    rl_config.trustedHosts = []
    original = utils.open_for_read
    if getattr(original, "nexdiary_guard", False):
        return
    fonts = FONTS.resolve()

    def guarded(name: Any, mode: str = "b") -> Any:
        if hasattr(name, "read"):
            return name
        if isinstance(name, str):
            try:
                path = Path(name).resolve()
            except (OSError, ValueError):
                path = None
            if path is not None and path.parent == fonts and path.suffix == ".ttf" and path.is_file():
                return original(name, mode)
        raise OSError("nexdiary opens no file and no address for a book")

    def refused(url: Any, headers: Any = None) -> Any:
        raise OSError("nexdiary opens no address for a book")

    guarded.nexdiary_guard = True  # type: ignore[attr-defined]
    for module in (utils, pdfdoc, pdfutils, flowables):
        if hasattr(module, "open_for_read"):
            module.open_for_read = guarded  # type: ignore[attr-defined]
    utils.rlUrlRead = refused  # type: ignore[attr-defined]


def _fonts() -> None:
    global _fonts_ready
    with _fonts_lock:
        _harden()
        if _fonts_ready:
            return
        for name in ("Fraunces-SemiBold", "DiarySerif-Regular", "DiarySerif-Bold", "DiarySerif-Italic",
                     "DiarySerif-BoldItalic"):
            pdfmetrics.registerFont(TTFont(name, str(FONTS / f"{name}.ttf")))
        pdfmetrics.registerFontFamily("DiarySerif", normal="DiarySerif-Regular", bold="DiarySerif-Bold",
                                      italic="DiarySerif-Italic", boldItalic="DiarySerif-BoldItalic")
        _fonts_ready = True


@dataclass
class Layout:
    width: float
    height: float
    margin: float
    top: float
    bottom: float
    scale: float

    @property
    def frame_width(self) -> float:
        return self.width - 2 * self.margin

    @property
    def frame_height(self) -> float:
        return self.height - self.top - self.bottom


def layout_of(name: str) -> Layout:
    width, height = FORMATS[name]
    if name == "a4":
        return Layout(width, height, 66, 64, 70, 1.15)
    return Layout(width, height, 46, 48, 56, 1.0)


class Styles:
    def __init__(self, scale: float) -> None:
        def style(name: str, **values: Any) -> ParagraphStyle:
            return ParagraphStyle(name, **values)

        size = 10.5 * scale
        self.body = style("body", fontName="DiarySerif-Regular", fontSize=size, leading=size * 1.5, textColor=INK,
                          spaceAfter=size * 0.6)
        self.quote = style("quote", parent=self.body, fontName="DiarySerif-Italic", textColor=INK_2,
                           leftIndent=14 * scale, borderPadding=0)
        self.bullet = style("bullet", parent=self.body, leftIndent=14 * scale, bulletIndent=2 * scale,
                            spaceAfter=size * 0.25)
        self.heading = {
            level: style(f"h{level}", fontName="Fraunces-SemiBold", fontSize=(15 - 1.5 * level) * scale,
                         leading=(15 - 1.5 * level) * scale * 1.3, textColor=INK, spaceBefore=size * 0.6,
                         spaceAfter=size * 0.35)
            for level in (1, 2, 3)
        }
        self.date = style("date", fontName="DiarySerif-Bold", fontSize=7.5 * scale, leading=10 * scale,
                          textColor=MUTED, spaceAfter=3 * scale)
        self.title = style("title", fontName="Fraunces-SemiBold", fontSize=20 * scale, leading=24 * scale,
                           textColor=INK, spaceAfter=10 * scale)
        self.values = style("values", fontName="DiarySerif-Regular", fontSize=8 * scale, leading=11 * scale,
                            textColor=MUTED, spaceBefore=6 * scale)
        self.note = style("note", parent=self.body, fontSize=9.5 * scale, leading=9.5 * scale * 1.45,
                          leftIndent=34 * scale, firstLineIndent=-34 * scale, spaceAfter=3 * scale)
        self.center = style("center", parent=self.body, alignment=TA_CENTER)


def _upper(text: str) -> str:
    return text.upper().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def long_date(day: date, words: dict[str, Any]) -> str:
    return words["date"].format(weekday=words["weekdays"][day.weekday()], day=day.day,
                                month=words["months"][day.month - 1], year=day.year)


def count_days(count: int, words: dict[str, Any]) -> str:
    return words["days"][1] if count == 1 else words["days"][0].format(n=count)


class Jpeg(ImageReader):
    """A JPEG made in memory, handed to ReportLab as it is: its bytes go into the PDF unchanged. ReportLab's own reader
    would decode every photo to raw pixels only to name it, and keep it; this one names it by a hash of its bytes."""

    def __init__(self, data: bytes, width: int, height: int) -> None:
        self._jpeg = data
        self._width, self._height = width, height
        self._dataA = None
        self._image = None
        self._ident = None
        self.fileName = f"jpeg-{hashlib.sha256(data).hexdigest()}"

    def getSize(self) -> tuple[int, int]:
        return self._width, self._height

    def getRGBData(self) -> bytes:
        return self.fileName.encode()

    def jpeg_fh(self) -> io.BytesIO:
        return io.BytesIO(self._jpeg)


@dataclass
class Picture:
    """A picture to draw: an illustration by its name, or an own photo by its id with how it is cut."""

    illustration: str | None = None
    photo: str | None = None
    crop: dict[str, int] | None = None
    cut: tuple[tuple[int, int, int, int] | None, int] = (None, 0)


class Book:
    """What the pages being drawn need: the person's photos, a session, the deadline."""

    def __init__(self, db: Session, job: Job, account_id: int, dek: bytes) -> None:
        self.db = db
        self.job = job
        self.account_id = account_id
        self.dek = dek
        self.chapters: list[tuple[str, int]] = []
        self.appendix_page: int | None = None
        self.quiet_pages: set[int] = set()

    def jpeg(self, uid: str, cut: tuple[tuple[int, int, int, int] | None, int] = (None, 0)) -> Jpeg | None:
        """One own photo, opened, turned and cut as the text says, made smaller and sealed again as JPEG in memory;
        let go as soon as it is drawn. None when it is gone."""
        try:
            data = photos.read(self.db, self.account_id, self.dek, uid, False)
        except HTTPException:
            return None
        crop, rotation = cut
        try:
            with pictures.opened(data, {"webp", "jpeg", "png"}) as image:
                picture = image.convert("RGB")
            del data
            if rotation:
                picture = picture.rotate(-rotation, expand=True)
            if crop is not None:
                x, y, w, h = crop
                picture = picture.crop((picture.width * x // 1000, picture.height * y // 1000,
                                        picture.width * (x + w) // 1000, picture.height * (y + h) // 1000))
            picture.thumbnail((PHOTO_EDGE, PHOTO_EDGE))
            out = io.BytesIO()
            picture.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
            size = picture.size
            picture.close()
        except (pictures.PictureError, pictures.DecodersBusy, OSError):
            return None
        return Jpeg(out.getvalue(), *size)

    def draw(self, canvas: Canvas, picture: Picture, x: float, y: float, width: float, height: float) -> None:
        if picture.illustration is not None:
            book_art.place(canvas, picture.illustration, x, y, width, height)
            return
        if picture.photo is None:
            return
        reader = self.jpeg(picture.photo)
        if reader is None:
            return
        photo_width, photo_height = reader.getSize()
        crop = picture.crop or {"x": 500, "y": 500, "zoom": 100}
        # As the interface shows a cover (``lib/textPhoto.ts``): the photo just fills the frame, the point x, y stands
        # where it stands in the frame, and the zoom grows around it.
        fill = max(width / photo_width, height / photo_height)
        zoom = crop["zoom"] / 100
        px, py = crop["x"] / 1000, crop["y"] / 1000
        drawn_w, drawn_h = photo_width * fill * zoom, photo_height * fill * zoom
        left = width * px + ((width - photo_width * fill) * px - width * px) * zoom
        top = height * py + ((height - photo_height * fill) * py - height * py) * zoom
        canvas.saveState()
        clip = canvas.beginPath()
        clip.rect(x, y, width, height)
        canvas.clipPath(clip, stroke=0, fill=0)
        canvas.drawImage(reader, x + left, y + height - top - drawn_h, drawn_w, drawn_h)
        canvas.restoreState()


class CoverBand(Flowable):
    """The cover of a day across the whole width of the page, at its top."""

    def __init__(self, book: Book, picture: Picture, layout: Layout) -> None:
        super().__init__()
        self.book = book
        self.picture = picture
        self.layout = layout
        self.band = layout.width * 9 / 16

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.height = max(0.0, self.band - self.layout.top) + 14 * self.layout.scale
        return available_width, self.height

    def draw(self) -> None:
        # The first thing on a page: its top is the top of the frame, so the band reaches up and out to the edges.
        top = self.height + self.layout.top
        self.book.draw(self.canv, self.picture, -self.layout.margin, top - self.band, self.layout.width, self.band)


class TextPhoto(Flowable):
    """A photo inside the text, as wide as the text, never higher than half the page."""

    def __init__(self, book: Book, uid: str, cut: tuple[tuple[int, int, int, int] | None, int], ratio: float,
                 layout: Layout) -> None:
        super().__init__()
        self.book = book
        self.uid = uid
        self.cut = cut
        self.ratio = ratio
        self.layout = layout

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        width = available_width
        height = width / self.ratio
        limit = self.layout.frame_height * 0.5
        if height > limit:
            height = limit
            width = height * self.ratio
        self.width, self.height = width, height + 8 * self.layout.scale
        return available_width, self.height

    def draw(self) -> None:
        reader = self.book.jpeg(self.uid, self.cut)
        if reader is not None:
            self.canv.drawImage(reader, 0, 8 * self.layout.scale, self.width, self.height - 8 * self.layout.scale)


class Whole(Flowable):
    """A page drawn by hand: the title page, the contents, a chapter. Takes the whole frame."""

    def __init__(self, paint: Callable[[Canvas, float, float], None]) -> None:
        super().__init__()
        self.paint = paint

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.width, self.height = available_width, available_height - 1
        return self.width, self.height

    def draw(self) -> None:
        self.paint(self.canv, self.width, self.height)


class Marker(Flowable):
    """Nothing to see: tells the book which page a chapter (or the appendix) begins on, and that it is quiet."""

    def __init__(self, book: Book, chapter: str | None = None, appendix: bool = False) -> None:
        super().__init__()
        self.book = book
        self.chapter = chapter
        self.appendix = appendix

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        return 0, 0

    def draw(self) -> None:
        page = self.canv.getPageNumber()
        self.book.quiet_pages.add(page)
        if self.chapter is not None:
            self.book.chapters.append((self.chapter, page))
        if self.appendix:
            self.book.appendix_page = page


class BookCanvas(Canvas):
    """Draws, as the document is saved, what is only known at the end: the contents with their page numbers."""

    book: Book
    words: dict[str, Any]
    layout: Layout

    def save(self) -> None:
        self._contents()
        super().save()

    def _contents(self) -> None:
        layout, scale = self.layout, self.layout.scale
        self.beginForm("contents", 0, 0, layout.width, layout.height)
        y = layout.height - layout.top - 70 * scale
        lines = list(self.book.chapters)
        if self.book.appendix_page is not None:
            lines.append((f"{self.words['appendix']}: {self.words['notes']}", self.book.appendix_page))
        size = 11 * scale
        for name, page in lines:
            self.setFont("DiarySerif-Regular", size)
            self.setFillColor(INK)
            self.drawString(layout.margin, y, name)
            number = str(page)
            self.drawRightString(layout.width - layout.margin, y, number)
            start = layout.margin + pdfmetrics.stringWidth(name, "DiarySerif-Regular", size) + 6
            end = layout.width - layout.margin - pdfmetrics.stringWidth(number, "DiarySerif-Regular", size) - 6
            self.setFillColor(MUTED)
            dot = 4.0 * scale
            x = start
            while x < end:
                self.drawString(x, y, ".")
                x += dot
            y -= size * 2
        self.endForm()


def make(db: Session, job: Job, options: Options, name: str, out: Any) -> int:
    """Sets the book of ``options.year`` for the person of ``job`` and writes it to ``out``; the number of pages."""
    from . import vault

    _fonts()
    account_id = job.account_id
    dek = vault.dek_for(account_id)
    words = TEXTS.get(options.language, TEXTS["en"])
    layout = layout_of(options.format)
    styles = Styles(layout.scale)
    book = Book(db, job, account_id, dek)

    first, last = f"{options.year:04d}-01-01", f"{options.year:04d}-12-31"
    rows = db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id, Day.date >= first,
                                                             Day.date <= last).order_by(Day.date)).all()
    photo_rows = {row.uid: row for row in db.execute(select(Photo.uid, Photo.width, Photo.height).where(
        Photo.user_id == account_id))}
    values = [value for value in diary.list_values(db, account_id, dek) if not value["unreadable"]]
    days: list[tuple[date, dict[str, Any]]] = []
    for row in rows:
        content = diary._readable_content(account_id, dek, row.date, row.content_enc)
        if content is not None and diary.has_page(content):
            days.append((date.fromisoformat(row.date), content))
    del rows

    def cover_of(day: date, content: dict[str, Any]) -> Picture:
        cover, chosen = diary.effective_cover(day.isoformat(), content, set(photo_rows))
        photo = covers.photo_of(cover)
        if photo is not None:
            return Picture(photo=photo, crop=diary.shown_crop(content, chosen))
        illustration = cover.removeprefix(covers.ILLU_PREFIX)
        return Picture(illustration=illustration if book_art.known(illustration) else "baum.abend.herbst")

    story: list[Flowable] = []
    # The title page.
    six = [cover_of(day, content) for day, content in days[-6:]] if options.photos else []

    def title_page(canvas: Canvas, width: float, height: float) -> None:
        page_w, page_h = layout.width, layout.height
        band = page_h * 0.6 if six else 0.0
        if six:
            cell_w, cell_h, gap = (page_w - 2) / 3, (band - 1) / 2, 1.0
            for index, picture in enumerate(six):
                column, line = index % 3, index // 3
                book.draw(canvas, picture, column * (cell_w + gap), page_h - (line + 1) * cell_h - line * gap,
                          cell_w, cell_h)
        middle = (page_h - band) / 2 if six else page_h / 2
        canvas.setFillColor(INK)
        canvas.setFont("Fraunces-SemiBold", 40 * layout.scale)
        canvas.drawCentredString(page_w / 2, middle + 4 * layout.scale, str(options.year))
        canvas.setFillColor(INK_2)
        canvas.setFont("DiarySerif-Regular", 11 * layout.scale)
        canvas.drawCentredString(page_w / 2, middle - 22 * layout.scale, words["of"].format(name=name))

    story.append(Whole(title_page))
    story.append(NextPageTemplate("page"))
    story.append(PageBreak())

    def contents_page(canvas: Canvas, width: float, height: float) -> None:
        canvas.setFillColor(INK)
        canvas.setFont("Fraunces-SemiBold", 22 * layout.scale)
        canvas.drawString(0, height - 24 * layout.scale, words["contents"])
        # The lines with their page numbers are drawn when the book is saved (``BookCanvas``).
        canvas.saveState()
        x, y = canvas.absolutePosition(0, 0)
        canvas.translate(-x, -y)
        canvas.doForm("contents")
        canvas.restoreState()

    story.append(Marker(book))
    story.append(Whole(contents_page))
    story.append(PageBreak())

    month = 0
    for day, content in days:
        _step(job, "day")
        if day.month != month:
            month = day.month
            count = sum(1 for other, _content in days if other.month == month)
            title = words["months"][month - 1]

            def chapter_page(canvas: Canvas, width: float, height: float, title: str = title,
                             count: int = count) -> None:
                middle = height / 2 + 20 * layout.scale
                canvas.setFillColor(MUTED)
                canvas.setFont("DiarySerif-Regular", 8 * layout.scale)
                canvas.drawCentredString(width / 2, middle + 30 * layout.scale, _spaced(words["chapter"]))
                canvas.setFillColor(INK)
                canvas.setFont("Fraunces-SemiBold", 28 * layout.scale)
                canvas.drawCentredString(width / 2, middle, title)
                canvas.setFillColor(MUTED)
                canvas.setFont("DiarySerif-Regular", 9 * layout.scale)
                canvas.drawCentredString(width / 2, middle - 22 * layout.scale, count_days(count, words))

            story.append(Marker(book, chapter=title))
            story.append(Whole(chapter_page))
            story.append(PageBreak())
        story.extend(_day(book, day, content, options, words, styles, layout, photo_rows, values, cover_of))
        story.append(PageBreak())

    if options.notes:
        notes = _notes(db, account_id, dek, [day for day, _content in days], words, styles)
        if notes:
            def appendix_page(canvas: Canvas, width: float, height: float) -> None:
                middle = height / 2 + 20 * layout.scale
                canvas.setFillColor(MUTED)
                canvas.setFont("DiarySerif-Regular", 8 * layout.scale)
                canvas.drawCentredString(width / 2, middle + 30 * layout.scale, _spaced(words["appendix"]))
                canvas.setFillColor(INK)
                canvas.setFont("Fraunces-SemiBold", 28 * layout.scale)
                canvas.drawCentredString(width / 2, middle, words["notes"])

            story.append(Marker(book, appendix=True))
            story.append(Whole(appendix_page))
            story.append(PageBreak())
            story.extend(notes)
    while story and isinstance(story[-1], PageBreak):
        story.pop()

    class Document(BaseDocTemplate):
        def afterFlowable(self, flowable: Flowable) -> None:
            _step(job, "flowable")

    def number(canvas: Canvas, document: Any) -> None:
        page = canvas.getPageNumber()
        if page in book.quiet_pages:
            return
        canvas.saveState()
        canvas.setFont("DiarySerif-Regular", 8 * layout.scale)
        canvas.setFillColor(MUTED)
        canvas.drawCentredString(layout.width / 2, layout.bottom / 2, str(page))
        canvas.restoreState()

    document = Document(out, pagesize=(layout.width, layout.height), title=f"{options.year}", author=name,
                        creator="nexdiary", producer="nexdiary", subject="", invariant=1)
    whole = Frame(0, 0, layout.width, layout.height, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
                  id="whole")
    text = Frame(layout.margin, layout.bottom, layout.frame_width, layout.frame_height, leftPadding=0,
                 rightPadding=0, topPadding=0, bottomPadding=0, id="text")
    document.addPageTemplates([PageTemplate(id="title", frames=[whole]),
                               PageTemplate(id="page", frames=[text], onPageEnd=number)])

    def canvasmaker(*args: Any, **kwargs: Any) -> BookCanvas:
        canvas = BookCanvas(*args, **kwargs)
        canvas.book, canvas.words, canvas.layout = book, words, layout
        return canvas

    book.quiet_pages.add(1)
    document.build(story, canvasmaker=canvasmaker)
    return int(document.page)


def _spaced(word: str) -> str:
    return " ".join(word.upper())


def _day(book: Book, day: date, content: dict[str, Any], options: Options, words: dict[str, Any], styles: Styles,
         layout: Layout, photo_rows: dict[str, Any], values: list[dict[str, Any]],
         cover_of: Callable[[date, dict[str, Any]], Picture]) -> list[Flowable]:
    out: list[Flowable] = []
    if options.photos:
        out.append(CoverBand(book, cover_of(day, content), layout))
    out.append(Paragraph(_upper(long_date(day, words)), styles.date))
    title = content["title"].strip() if isinstance(content["title"], str) else ""
    if title:
        out.append(Paragraph(_escape(title), styles.title))
    else:
        out.append(PlatypusSpacer(1, 6 * layout.scale))
    text = content["text"] if isinstance(content["text"], str) else ""
    for block in book_text.blocks(text):
        if block.kind == "photo":
            row = photo_rows.get(block.text)
            if not options.photos or row is None or not row.width or not row.height:
                continue
            crop, rotation = book_text.cut_of(block.extra)
            width, height = (row.height, row.width) if rotation in (90, 270) else (row.width, row.height)
            if crop is not None:
                width, height = width * crop[2] / 1000, height * crop[3] / 1000
            out.append(TextPhoto(book, block.text, (crop, rotation), max(0.2, min(5.0, width / height)), layout))
        elif block.kind == "heading":
            out.append(Paragraph(block.text, styles.heading[int(block.extra)]))
        elif block.kind == "quote":
            out.append(Paragraph(block.text, styles.quote))
        elif block.kind == "bullet":
            out.append(Paragraph(block.text, styles.bullet, bulletText="•"))
        elif block.kind == "number":
            out.append(Paragraph(block.text, styles.bullet, bulletText=f"{block.extra}."))
        else:
            out.append(Paragraph(block.text, styles.body))
    if options.values and isinstance(content.get("values"), dict):
        rated = [f"{_escape(value['name'])} {rating}/10" for value in values
                 if type(rating := content["values"].get(value["id"])) is int and 1 <= rating <= 10]
        if rated:
            out.append(Paragraph(" · ".join(rated), styles.values))
    return out


def _notes(db: Session, account_id: int, dek: bytes, days: list[date], words: dict[str, Any],
           styles: Styles) -> list[Flowable]:
    """The raw notes of the book's days, day by day, each with its time and the question it answered."""
    from zoneinfo import ZoneInfo

    account = db.get(Account, account_id)
    zone = diary.zone_of(account) if account is not None else ZoneInfo("UTC")
    wanted = {day.isoformat() for day in days}
    found: dict[str, list[dict[str, Any]]] = {}
    for row in db.execute(select(Note.date).where(Note.user_id == account_id, Note.date.in_(wanted)).distinct()):
        found[row.date] = diary.list_notes(db, account_id, dek, row.date)
    out: list[Flowable] = []
    for key in sorted(found):
        notes = [note for note in found[key] if note["text"] and not note["unreadable"]]
        if not notes:
            continue
        out.append(Paragraph(_upper(long_date(date.fromisoformat(key), words)), styles.date))
        for note in notes:
            moment = datetime.fromisoformat(note["created_at"]).astimezone(zone).strftime("%H:%M")
            question = f"<i>{_escape(note['prompt'])}</i> " if note.get("prompt") else ""
            out.append(Paragraph(f"{moment}&nbsp;&nbsp;&nbsp;{question}{_escape(note['text'])}".replace("\n", "<br/>"),
                                 styles.note))
        out.append(PlatypusSpacer(1, 8))
    return out
