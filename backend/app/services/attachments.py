"""Attachments of a day: videos, sounds, PDFs and links, beside the photos and never inside the text.

* **What comes in is decided by the server**, from the first bytes and ffprobe, never from the name or the type the
  browser claims (``prepare``): a PDF begins with ``%PDF-``, a video or a sound is one of the containers and codecs of
  ``media_tools``. What the person meant (``kind``) must be what it is.
* **A video or sound is packed anew** without anything but its first picture and sound stream: no place, no device, no
  date, no chapter, no subtitle (``media_tools.remux``). Nothing is encoded again; only a video in HEVC may be turned
  into H.264 later, on request (``services/conversions.py``). A video gets a still, drawn like a photo.
* **A PDF is kept as it came**, a link only as its address and title: the server never fetches the page.
* **Everything is sealed**: the file in pieces (``services/sealed_file.py``), the still the same way, the name, the
  address, the length and the codec in ``meta_enc``. The media folder holds random names only.
* **An upload never lies whole in memory**: the body goes to a work folder of its own in the media folder while it
  comes, given up past the limit (``receive``), and at most ``UPLOAD_SLOTS`` uploads run at once on the whole server.
* **The limits are decided where the row is written**: at most ``PER_DAY`` attachments a day, the person's storage
  together with the photos (``quota``), a locked day takes none (and a trigger holds a locked day's attachments, see
  ``models.Attachment``), the same upload id twice keeps one.
* **Only the owner** gets an attachment, and whoever the day is shared with (``services/sharing.py``); any other
  answers like one that does not exist.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import secrets
import shutil
import threading
import unicodedata
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from sqlalchemy import and_, bindparam, func, or_, select, text
from sqlalchemy.orm import Session

from .. import private
from ..errors import error
from ..models import Attachment, UtcDateTime
from . import media_tools, photos, quota, sealed_file, settings_service, vault

logger = logging.getLogger("nexdiary.attachments")

FILE_KINDS = ("video", "audio", "pdf")
KINDS = (*FILE_KINDS, "link")
STATUSES = ("ready", "queued", "converting", "failed")
#: Attachments a day may hold (photos do not count).
PER_DAY = 50
NAME_MAX = 120
TITLE_MAX = 200
URL_MAX = 2048
PREVIEW_SUFFIX = photos.PREVIEW_SUFFIX
#: Uploads of attachments the whole server takes at the same moment (receiving, checking, packing).
UPLOAD_SLOTS = 3
#: The work folders of uploads and conversions in the media folder: never a media file, never in a backup.
WORK_PREFIX = ".work-"
WORK_NAME = re.compile(r"^\.work-[0-9a-f]{32}$")
#: What a body is written to disk in.
WRITE_BYTES = 1024 * 1024
MB = 1024 * 1024
#: The largest values the operator may set (``PUT /api/admin/attachments``).
VIDEO_MAX_MB = 4000
OTHER_MAX_MB = 1000
LIBRARY_MAX = 100
LIBRARY_DEFAULT = 60
_CURSOR = re.compile(r"^([ns])\.(\d{1,20})\.([0-9a-f]{32})$")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

#: The type a file is given out with, fixed by its kind and container.
CONTENT_TYPES = {
    ("video", "mp4"): "video/mp4",
    ("video", "webm"): "video/webm",
    ("audio", "mp4"): "audio/mp4",
    ("audio", "mp3"): "audio/mpeg",
    ("audio", "ogg"): "audio/ogg",
    ("audio", "webm"): "audio/webm",
    ("audio", "wav"): "audio/wav",
    ("pdf", "pdf"): "application/pdf",
}
EXTENSIONS = {
    ("video", "mp4"): "mp4",
    ("video", "webm"): "webm",
    ("audio", "mp4"): "m4a",
    ("audio", "mp3"): "mp3",
    ("audio", "ogg"): "ogg",
    ("audio", "webm"): "webm",
    ("audio", "wav"): "wav",
    ("pdf", "pdf"): "pdf",
}
#: Endings a name may bring that the download replaces by its own.
_KNOWN_ENDINGS = re.compile(r"\.(mp4|m4v|mov|qt|webm|mkv|m4a|mp3|ogg|oga|opus|wav|wave|pdf|aac|3gp)$", re.IGNORECASE)
#: A name when the person gave none.
DEFAULT_NAMES = {"video": "Video", "audio": "Audio", "pdf": "PDF"}


class TooLarge(Exception):
    """The body is larger than the operator allows for its kind."""


class Busy(Exception):
    """Every place for an upload of an attachment is taken."""


# --- What the operator decides --------------------------------------------------------------------------------------


def operator_settings(db: Session) -> dict[str, Any]:
    def number(key: str, top: int) -> int:
        try:
            value = int(settings_service.get(db, key))
        except (TypeError, ValueError):
            value = int(settings_service.DEFAULTS[key])
        return min(max(value, 1), top)

    return {"video_max_mb": number("attachment_video_max_mb", VIDEO_MAX_MB),
            "other_max_mb": number("attachment_other_max_mb", OTHER_MAX_MB),
            "convert": bool(settings_service.get(db, "attachment_convert"))}


def max_mb(db: Session, kind: str) -> int:
    chosen = operator_settings(db)
    return chosen["video_max_mb"] if kind == "video" else chosen["other_max_mb"]


# --- Files and work folders -----------------------------------------------------------------------------------------


def _file_path(file_id: str) -> Path:
    return photos.media_root() / file_id


def _preview_path(uid: str) -> Path:
    return photos.media_root() / (uid + PREVIEW_SUFFIX)


def _file_label(account_id: int, uid: str, file_id: str) -> bytes:
    return sealed_file.label(account_id, uid, "file", file_id)


def _preview_label(account_id: int, uid: str) -> bytes:
    return sealed_file.label(account_id, uid, "preview", uid + PREVIEW_SUFFIX)


def _meta_aad(account_id: int, uid: str) -> bytes:
    return vault.aad(account_id, "attachments", "meta", uid)


@contextlib.contextmanager
def work_folder() -> Iterator[Path]:
    """A folder of its own in the media folder for one upload or conversion, only the owner's; gone afterwards,
    whatever happened. Its name says nothing (``WORK_NAME``); the sweep takes one a crash left behind."""
    root = photos.media_root()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / f"{WORK_PREFIX}{secrets.token_hex(16)}"
    folder.mkdir(mode=private.FOLDER_MODE)
    private.tighten(folder)
    try:
        yield folder
    finally:
        _remove_folder(folder)


def _remove_folder(folder: Path) -> None:
    """The work folder, gone. Under Windows a program that was just stopped (ffprobe, ffmpeg) can hold a file a moment
    longer: a few more tries before it is left to the sweep."""
    import time

    for _ in range(50):
        shutil.rmtree(folder, ignore_errors=True)
        if not folder.exists():
            return
        time.sleep(0.1)
    logger.warning("A work folder could not be removed now; the sweep takes it")


def remove_disk_files(names: list[str]) -> None:
    """These files of the media folder, gone (a file that is not there is fine; one that cannot be deleted now, say an
    open one under Windows, is left for the sweep)."""
    root = photos.media_root()
    for name in names:
        photos.discard(root / name)


def _disk_names(file_id: str | None, uid: str, preview_size: int) -> list[str]:
    names = [file_id] if file_id else []
    return [*names, uid + PREVIEW_SUFFIX] if preview_size or file_id else names


def files_of(db: Session, account_id: int) -> list[str]:
    """The names of every file of the person's attachments, for deleting the account."""
    return [name for row in db.execute(select(Attachment.uid, Attachment.file_id, Attachment.preview_size)
                                       .where(Attachment.user_id == account_id))
            for name in _disk_names(row.file_id, row.uid, row.preview_size)]


# --- Admission ------------------------------------------------------------------------------------------------------

_admission_lock = threading.Lock()
_admitted = 0
#: The people with an upload of an attachment under way: one each at a time.
_uploading: set[int] = set()


@contextlib.contextmanager
def admitted(account_id: int) -> Iterator[None]:
    """A place for one upload, taken before its body is read; ``Busy`` at once when every place is taken, or when the
    person has an upload under way already: one person's stalled uploads must not keep everybody else out."""
    global _admitted
    with _admission_lock:
        if _admitted >= UPLOAD_SLOTS or account_id in _uploading:
            raise Busy
        _admitted += 1
        _uploading.add(account_id)
    try:
        yield
    finally:
        with _admission_lock:
            _admitted -= 1
            _uploading.discard(account_id)


class Stalled(Exception):
    """No piece of the body came for ``BODY_GAP_SECONDS``."""


#: How long an upload may go without sending a byte before it is given up and its place is free again.
BODY_GAP_SECONDS = 30.0


async def next_piece(pieces: AsyncIterator[bytes], seconds: float) -> bytes | None:
    """The next piece of a body, None at its end; ``Stalled`` when none comes within ``seconds``. The tests put their
    own in (no wall clock in a test)."""
    import asyncio

    try:
        return await asyncio.wait_for(anext(pieces), seconds)
    except StopAsyncIteration:
        return None
    except TimeoutError as exc:
        raise Stalled from exc


async def receive(chunks: AsyncIterator[bytes], target: Path, limit: int) -> int:
    """The body, written to ``target`` while it comes and given up past ``limit`` bytes (``TooLarge``) or after
    ``BODY_GAP_SECONDS`` without a byte (``Stalled``): never held whole in memory. The bytes received."""
    from starlette.concurrency import run_in_threadpool

    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
    total = 0
    pieces = aiter(chunks)
    with os.fdopen(descriptor, "wb") as out:
        buffer = bytearray()
        while (chunk := await next_piece(pieces, BODY_GAP_SECONDS)) is not None:
            total += len(chunk)
            if total > limit:
                raise TooLarge
            buffer.extend(chunk)
            if len(buffer) >= WRITE_BYTES:
                data = bytes(buffer)
                buffer.clear()
                await run_in_threadpool(out.write, data)
        if buffer:
            await run_in_threadpool(out.write, bytes(buffer))
    return total


# --- Names and links ------------------------------------------------------------------------------------------------


def clean_name(raw: Any, kind: str) -> str:
    """A name to show: the last part of a path, without control characters and line breaks, at most ``NAME_MAX``
    characters; the kind's own word when nothing is left."""
    value = raw if isinstance(raw, str) else ""
    value = re.split(r"[\\/]", unicodedata.normalize("NFC", value))[-1]
    value = "".join(" " if char in "\r\n\t" else char for char in value
                    if not unicodedata.category(char).startswith("C") or char in "\r\n\t")
    value = " ".join(value.split())[:NAME_MAX].strip()
    return value or DEFAULT_NAMES.get(kind, kind)


def check_link(url: Any, title: Any) -> tuple[str, str]:
    """The address of a link as it may be kept (``http`` or ``https``, no spaces, no user in it, at most ``URL_MAX``
    characters) and its title (the host when none). ``invalid_input`` naming the field else."""
    if not isinstance(url, str) or not url or len(url) > URL_MAX or any(
            char.isspace() or unicodedata.category(char).startswith("C") for char in url):
        raise error("invalid_input", "The input is not valid.", 422, fields=["url"])
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for a port that is not a number
    except ValueError as exc:
        raise error("invalid_input", "The input is not valid.", 422, fields=["url"]) from exc
    if parts.scheme.lower() not in ("http", "https") or not host or "@" in parts.netloc:
        raise error("invalid_input", "The input is not valid.", 422, fields=["url"])
    shown = title if isinstance(title, str) else ""
    shown = unicodedata.normalize("NFC", shown)
    shown = " ".join("".join(char for char in shown if not unicodedata.category(char).startswith("C")
                             or char in "\r\n\t").split())
    if len(shown) > TITLE_MAX:
        raise error("invalid_input", "The input is not valid.", 422, fields=["title"])
    return url, shown or host


# --- Checking what came ---------------------------------------------------------------------------------------------


@dataclass
class Prepared:
    """A file checked and packed, ready to be sealed: where it lies, its container, what it says about itself, and the
    still of a video (WebP) when there is one."""

    path: Path
    kind: str
    container: str
    seconds: float | None = None
    width: int | None = None
    height: int | None = None
    codec: str | None = None
    audio_codec: str | None = None
    preview: bytes | None = None


def not_supported() -> Exception:
    return error("attachment_not_supported", "nexdiary does not take this file.", 422)


def wrong_kind() -> Exception:
    return error("attachment_wrong_kind", "This file is of another kind.", 422)


def _codec_shown(codec: str | None) -> str | None:
    if codec is None:
        return None
    return "pcm" if codec.startswith("pcm_") else codec


def prepare(work: Path, body: Path, kind: str) -> Prepared:
    """The body checked for what it is and, for a video or sound, packed anew in ``work``. ``attachment_wrong_kind``
    for a file of another kind, ``attachment_not_supported`` for one nexdiary does not take."""
    with body.open("rb") as handle:
        head = handle.read(64)
    if kind == "pdf":
        if head.startswith(b"%PDF-"):
            return Prepared(body, "pdf", "pdf")
        raise wrong_kind() if media_tools.looks_like_media(head) else not_supported()
    if head.startswith(b"%PDF-"):
        raise wrong_kind()
    if not media_tools.available():
        raise not_supported()
    try:
        checked = media_tools.check(body, head, kind)
    except media_tools.MediaError as exc:
        logger.info("An attachment was not taken: %s", exc)
        raise wrong_kind() if exc.reason == "kind" else not_supported() from exc
    packed = work / "packed"
    try:
        media_tools.remux(checked, body, packed)
        after = media_tools.probe(packed, media_tools.demuxer_of_container(checked.container))
    except (media_tools.ToolFailed, media_tools.MediaError) as exc:
        logger.info("An attachment could not be packed: %s", exc)
        raise not_supported() from exc
    if after.places:
        # Never kept with a place in it, whatever the source did to hide it.
        logger.warning("A packed attachment still named a place; not taken")
        raise not_supported()
    seconds = after.duration if after.duration is not None else checked.seconds
    limit = media_tools.VIDEO_MAX_SECONDS if kind == "video" else media_tools.AUDIO_MAX_SECONDS
    if seconds is not None and seconds > limit:
        raise not_supported()
    body.unlink(missing_ok=True)
    out = Prepared(packed, kind, checked.container, seconds=round(seconds, 2) if seconds is not None else None,
                   audio_codec=checked.audio.codec if checked.audio else None)
    if kind == "video":
        assert checked.video is not None
        out.width, out.height, out.codec = checked.video.width, checked.video.height, checked.video.codec
        out.preview = _still(work, packed, checked.container, seconds)
    else:
        out.codec = _codec_shown(out.audio_codec)
    return out


def _still(work: Path, video: Path, container: str, seconds: float | None) -> bytes | None:
    """The still of a video, drawn like a photo (WebP, the size of a photo's smaller copy); None when there is none."""
    from . import pictures

    picture = work / "still.png"
    if not media_tools.still(video, container, seconds, picture):
        return None
    try:
        return photos.draw(picture.read_bytes()).preview
    except (pictures.PictureError, pictures.DecodersBusy, OSError) as exc:
        logger.info("The still of a video could not be drawn: %s", type(exc).__name__)
        return None
    finally:
        picture.unlink(missing_ok=True)


# --- Rows -----------------------------------------------------------------------------------------------------------

_COLUMNS = (Attachment.id, Attachment.uid, Attachment.user_id, Attachment.date, Attachment.kind, Attachment.status,
            Attachment.file_id, Attachment.size, Attachment.preview_size, Attachment.meta_enc, Attachment.created_at)


def check_id(uid: str) -> str:
    """An attachment id in an address: one that cannot exist is not found."""
    uid = uid.lower() if isinstance(uid, str) else ""
    if len(uid) != 32 or any(char not in "0123456789abcdef" for char in uid):
        raise error("not_found", "Not found.", 404)
    return uid


def _meta(account_id: int, dek: bytes, row: Any) -> dict[str, Any] | None:
    try:
        opened = vault.open_json(dek, row.meta_enc, _meta_aad(account_id, row.uid))
    except (vault.SealError, ValueError):
        logger.warning("A sealed value did not open table=attachments")
        return None
    return opened if isinstance(opened, dict) else None


def convertible(row: Any, meta: dict[str, Any], locked: bool, switch: bool | None = None,
                tools: bool | None = None) -> bool:
    """Whether the person may have this attachment turned into H.264 now."""
    if row.kind != "video" or meta.get("codec") != "hevc" or row.status not in ("ready", "failed") or locked:
        return False
    return bool(switch) and bool(tools)


def view(row: Any, meta: dict[str, Any], *, can_convert: bool = False) -> dict[str, Any]:
    from . import conversions

    out: dict[str, Any] = {
        "id": row.uid,
        "date": row.date,
        "kind": row.kind,
        "name": meta.get("name") or DEFAULT_NAMES.get(row.kind, row.kind),
        "size": int(meta.get("plain_size") or 0),
        "seconds": meta.get("seconds") if row.kind in ("video", "audio") else None,
        "width": meta.get("width") if row.kind == "video" else None,
        "height": meta.get("height") if row.kind == "video" else None,
        "codec": meta.get("codec") if row.kind in ("video", "audio") else None,
        "status": row.status,
        "progress": conversions.progress_of(row.uid) if row.status == "converting" else None,
        "playable": not (row.kind == "video" and meta.get("codec") == "hevc"),
        "can_convert": can_convert,
        "has_preview": row.kind == "video" and bool(row.preview_size),
        "created_at": row.created_at.isoformat(),
    }
    if row.kind == "link":
        out["url"] = meta.get("url") or ""
    return out


def _views(db: Session, account_id: int, dek: bytes, rows: list[Any], *, shared: bool) -> list[dict[str, Any]]:
    from .diary import locked_dates

    if not rows:
        return []
    switch = tools = False
    locked: set[str] = set()
    if not shared:
        switch = operator_settings(db)["convert"]
        tools = media_tools.available() if any(row.kind == "video" for row in rows) else False
        locked = locked_dates(db, account_id, sorted({row.date for row in rows}))
    out = []
    for row in rows:
        meta = _meta(account_id, dek, row)
        if meta is None:
            continue
        can = not shared and convertible(row, meta, row.date in locked, switch, tools)
        out.append(view(row, meta, can_convert=can))
    return out


def list_of_day(db: Session, account_id: int, dek: bytes, day: str, *, shared: bool = False) -> list[dict[str, Any]]:
    """The attachments of a day, oldest first; ``shared`` for the person the day is shared with (never convertible
    there)."""
    rows = db.execute(select(*_COLUMNS).where(Attachment.user_id == account_id, Attachment.date == day)
                      .order_by(Attachment.created_at, Attachment.id)).all()
    return _views(db, account_id, dek, list(rows), shared=shared)


def _row(db: Session, account_id: int, uid: str) -> Any:
    return db.execute(select(*_COLUMNS).where(Attachment.user_id == account_id, Attachment.uid == uid)).first()


def one(db: Session, account_id: int, dek: bytes, uid: str) -> dict[str, Any]:
    row = _row(db, account_id, uid)
    found = _views(db, account_id, dek, [row], shared=False) if row is not None else []
    if not found:
        raise error("not_found", "Not found.", 404)
    return found[0]


def by_upload(db: Session, account_id: int, dek: bytes, upload_id: str) -> dict[str, Any] | None:
    row = db.execute(select(*_COLUMNS).where(Attachment.user_id == account_id,
                                             Attachment.upload_id == upload_id)).first()
    if row is None:
        return None
    found = _views(db, account_id, dek, [row], shared=False)
    return found[0] if found else None


def _insert(db: Session, account_id: int, dek: bytes, *, uid: str, day: str, kind: str, upload_id: str,
            file_id: str | None, size: int, preview_size: int, meta: dict[str, Any], moment: datetime) -> int:
    """The row, written only while the day is open, has room and the person's storage too, in one statement; how
    many rows were written (0 or 1)."""
    sealed = vault.seal_json(dek, meta, _meta_aad(account_id, uid))
    limit = quota.limit_bytes(db)
    try:
        inserted = db.execute(
            text(
                "INSERT INTO attachments (uid, user_id, date, kind, status, file_id, size, preview_size, upload_id, "  # noqa: S608 - constants
                "meta_enc, created_at) SELECT :uid, :user, :date, :kind, 'ready', :file, :size, :preview, :upload, "
                ":meta, :now "
                "WHERE (SELECT count(*) FROM attachments WHERE user_id = :user AND date = :date) < :per_day "
                "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :date "
                "AND locked_at IS NOT NULL) "
                f"AND (:quota IS NULL OR {quota.USED} + :size + :preview + :meta_size <= :quota) "
                "ON CONFLICT DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"uid": uid, "user": account_id, "date": day, "kind": kind, "file": file_id, "size": size,
             "preview": preview_size, "upload": upload_id, "meta": sealed, "meta_size": len(sealed), "now": moment,
             "per_day": PER_DAY, "quota": limit},
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return int(inserted.rowcount)


def _refused(db: Session, account_id: int, dek: bytes, day: str, upload_id: str,
             growth: int) -> tuple[dict[str, Any], bool]:
    """Why a row was not written: the same upload id came first (that one is the answer), the day was locked, the
    storage is full or the day has as many attachments as it may."""
    from .diary import ensure_open

    found = by_upload(db, account_id, dek, upload_id)
    if found is not None:
        return found, False
    ensure_open(db, account_id, day)
    limit = quota.limit_bytes(db)
    if limit is not None and quota.used(db, account_id) + growth > limit:
        raise quota.full(db)
    raise error("attachments_per_day", "There are as many attachments on this day as there may be.", 422,
                max=PER_DAY)


def add(db: Session, account_id: int, dek: bytes, day: str, upload_id: str, name: str,
        prepared: Prepared, moment: datetime) -> tuple[dict[str, Any], bool]:
    """Keeps a checked file: the sealed file and its still first, then the row; the attachment and whether it is new.
    The same upload id again returns the one that stands and leaves no file behind."""
    uid, file_id = secrets.token_hex(16), secrets.token_hex(16)
    plain = prepared.path.stat().st_size
    meta = {"name": clean_name(name, prepared.kind), "container": prepared.container, "plain_size": plain,
            "seconds": prepared.seconds, "width": prepared.width, "height": prepared.height, "codec": prepared.codec,
            "audio_codec": prepared.audio_codec}
    names = [file_id]
    try:
        size = sealed_file.write(prepared.path, _file_path(file_id), dek, _file_label(account_id, uid, file_id))
        preview = 0
        if prepared.preview:
            names.append(uid + PREVIEW_SUFFIX)
            preview = sealed_file.write_bytes(prepared.preview, _preview_path(uid), dek,
                                              _preview_label(account_id, uid))
        written = _insert(db, account_id, dek, uid=uid, day=day, kind=prepared.kind, upload_id=upload_id,
                          file_id=file_id, size=size, preview_size=preview, meta=meta, moment=moment)
    except Exception:
        remove_disk_files(names)
        raise
    if written != 1:
        remove_disk_files(names)
        return _refused(db, account_id, dek, day, upload_id, size + preview)
    return one(db, account_id, dek, uid), True


def add_link(db: Session, account_id: int, dek: bytes, day: str, upload_id: str, url: str, title: str,
             moment: datetime) -> tuple[dict[str, Any], bool]:
    """Keeps a link: its address and title, sealed; no file, and the server never asks the address for anything."""
    found = by_upload(db, account_id, dek, upload_id)
    if found is not None:
        return found, False
    uid = secrets.token_hex(16)
    meta = {"name": title, "url": url, "plain_size": 0}
    written = _insert(db, account_id, dek, uid=uid, day=day, kind="link", upload_id=upload_id, file_id=None, size=0,
                      preview_size=0, meta=meta, moment=moment)
    if written != 1:
        return _refused(db, account_id, dek, day, upload_id, 0)
    return one(db, account_id, dek, uid), True


def remove(db: Session, account_id: int, uid: str) -> None:
    """Deletes an attachment of the person, its files after the commit; a conversion of it stops. ``day_locked`` at a
    locked day, ``not_found`` for one that is not the person's."""
    from . import conversions
    from .diary import ensure_open, locked_error

    day = db.scalar(select(Attachment.date).where(Attachment.user_id == account_id, Attachment.uid == uid))
    if day is None:
        raise error("not_found", "Not found.", 404)
    ensure_open(db, account_id, day)
    try:
        gone = db.execute(
            text("DELETE FROM attachments WHERE user_id = :user AND uid = :uid AND NOT EXISTS (SELECT 1 FROM days "
                 "WHERE days.user_id = :user AND days.date = attachments.date AND days.locked_at IS NOT NULL) "
                 "RETURNING file_id, preview_size"),
            {"user": account_id, "uid": uid},
        ).all()
        db.commit()
    except Exception:
        db.rollback()
        raise
    if not gone:
        if db.scalar(select(Attachment.id).where(Attachment.user_id == account_id, Attachment.uid == uid)):
            raise locked_error()
        raise error("not_found", "Not found.", 404)
    conversions.cancel(uid)
    remove_disk_files(_disk_names(gone[0].file_id, uid, gone[0].preview_size))


# --- Giving a file out ----------------------------------------------------------------------------------------------


@dataclass
class Opened:
    """An attachment's file, open for reading: what to give it out as."""

    reader: sealed_file.Reader
    content_type: str
    filename: str
    kind: str
    etag: str


def _download_name(name: str, kind: str, container: str) -> str:
    base = _KNOWN_ENDINGS.sub("", name).strip(" .") or DEFAULT_NAMES.get(kind, kind)
    base = "".join(char for char in base if char not in '"\\/;' and not unicodedata.category(char).startswith("C"))
    return f"{base or DEFAULT_NAMES.get(kind, kind)}.{EXTENSIONS.get((kind, container), 'bin')}"


def content_disposition(filename: str, download: bool) -> str:
    return f"{'attachment' if download else 'inline'}; filename*=UTF-8''{quote(filename, safe='')}"


def open_row(account_id: int, dek: bytes, row: Any, preview: bool) -> Opened:
    """The file (or still) of a row of ``account_id``; ``not_found`` for a link, a video without still, a file that is
    gone or does not open here."""
    meta = _meta(account_id, dek, row)
    if meta is None or row.kind == "link" or not row.file_id:
        raise error("not_found", "Not found.", 404)
    try:
        if preview:
            if row.kind != "video" or not row.preview_size:
                raise error("not_found", "Not found.", 404)
            reader = sealed_file.Reader(_preview_path(row.uid), dek, _preview_label(account_id, row.uid))
            return Opened(reader, "image/webp", "", row.kind, f'"{row.uid}p"')
        reader = sealed_file.Reader(_file_path(row.file_id), dek, _file_label(account_id, row.uid, row.file_id))
        if reader.size:
            try:
                # The first piece opens, or nothing is given out at all.
                reader.piece(0)
            except sealed_file.SealedFileError:
                reader.close()
                raise
    except (OSError, sealed_file.SealedFileError) as exc:
        logger.warning("An attachment file did not open: %s", type(exc).__name__)
        raise error("not_found", "Not found.", 404) from exc
    container = str(meta.get("container") or "")
    content_type = CONTENT_TYPES.get((row.kind, container), "application/octet-stream")
    return Opened(reader, content_type, _download_name(str(meta.get("name") or ""), row.kind, container), row.kind,
                  f'"{row.file_id}"')


def open_file(db: Session, account_id: int, dek: bytes, uid: str, preview: bool) -> Opened:
    row = _row(db, account_id, uid)
    if row is None:
        raise error("not_found", "Not found.", 404)
    return open_row(account_id, dek, row, preview)


def open_shared(db: Session, owner_id: int, dek: bytes, day: str, uid: str, preview: bool) -> Opened:
    """An attachment of a day the caller already checked is shared: only one of exactly that day."""
    row = _row(db, owner_id, uid)
    if row is None or row.date != day:
        raise error("not_found", "Not found.", 404)
    return open_row(owner_id, dek, row, preview)


class RangeInvalid(Exception):
    """A range that cannot be served (``416``)."""


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """The one range a ``Range`` header asks for, as first and last byte; None for the whole file (no header, an
    empty one, or another unit than bytes: RFC 9110 says to ignore those). ``bytes=a-b``, ``bytes=a-`` and
    ``bytes=-n``, the unit in any case; several ranges, a start past the end or nonsense: ``RangeInvalid``."""
    value = (header or "").strip()
    unit, equals, _spec = value.partition("=")
    if not value or not equals or unit.strip().lower() != "bytes":
        return None
    match = re.fullmatch(r"bytes=(\d{0,19})-(\d{0,19})", value, re.IGNORECASE)
    if match is None or (not match.group(1) and not match.group(2)) or size <= 0:
        raise RangeInvalid
    first, last = match.group(1), match.group(2)
    if not first:
        suffix = int(last)
        if suffix == 0:
            raise RangeInvalid
        return max(size - suffix, 0), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or end < start:
        raise RangeInvalid
    return start, min(end, size - 1)


# --- Lists ----------------------------------------------------------------------------------------------------------


def _cursor(order: str, row: Any) -> str:
    if order == "size":
        return f"s.{int(row.size)}.{row.uid}"
    moment = row.created_at - _EPOCH
    micro = (moment.days * 86_400 + moment.seconds) * 1_000_000 + moment.microseconds
    return f"n.{micro}.{row.uid}"


def _after(order: str, cursor: str) -> Any:
    match = _CURSOR.match(cursor) if isinstance(cursor, str) else None
    if match is None or (match.group(1) == "s") != (order == "size"):
        raise error("invalid_input", "The input is not valid.", 422, fields=["before"])
    number, uid = int(match.group(2)), match.group(3)
    if order == "size":
        return or_(Attachment.size < number, and_(Attachment.size == number, Attachment.uid < uid))
    try:
        moment = _EPOCH + timedelta(microseconds=number)
    except OverflowError as exc:
        raise error("invalid_input", "The input is not valid.", 422, fields=["before"]) from exc
    return or_(Attachment.created_at < moment, and_(Attachment.created_at == moment, Attachment.uid < uid))


def library(db: Session, account_id: int, dek: bytes, *, kind: str | None, order: str, before: str | None,
            limit: int) -> dict[str, Any]:
    """The person's attachments, newest first (``new``) or largest first (``size``), a page at a time."""
    limit = min(max(limit, 1), LIBRARY_MAX)
    query = select(*_COLUMNS).where(Attachment.user_id == account_id)
    if kind:
        query = query.where(Attachment.kind == kind)
    if before:
        query = query.where(_after(order, before))
    if order == "size":
        query = query.order_by(Attachment.size.desc(), Attachment.uid.desc())
    else:
        query = query.order_by(Attachment.created_at.desc(), Attachment.uid.desc())
    rows = list(db.execute(query.limit(limit + 1)).all())
    page = rows[:limit]
    following = _cursor(order, page[-1]) if len(rows) > limit and page else None
    return {"attachments": _views(db, account_id, dek, page, shared=False), "next": following}


def bytes_by_kind(db: Session, account_id: int) -> tuple[dict[str, int], int]:
    """The bytes the person's attachments take, per kind of file, and how many attachments there are."""
    out = dict.fromkeys(FILE_KINDS, 0)
    count = 0
    for row in db.execute(select(Attachment.kind, func.count(), func.coalesce(func.sum(
            Attachment.size + Attachment.preview_size), 0)).where(Attachment.user_id == account_id)
            .group_by(Attachment.kind)):
        count += int(row[1])
        if row[0] in out:
            out[row[0]] = int(row[2])
    return out, count


def search(db: Session, account_id: int, dek: bytes, needle: str) -> list[tuple[str, str]]:
    """The days whose attachments carry ``needle`` (already folded) in their name, with the name: (day, name)."""
    from .diary import fold

    out = []
    for row in db.execute(select(Attachment.uid, Attachment.date, Attachment.meta_enc)
                          .where(Attachment.user_id == account_id).order_by(Attachment.created_at)):
        meta = _meta(account_id, dek, row)
        name = str(meta.get("name") or "") if meta else ""
        if name and needle in fold(name):
            out.append((row.date, name))
    return out


def for_book(db: Session, account_id: int, dek: bytes, first: str, last: str) -> dict[str, list[dict[str, str]]]:
    """For the book of a year: per day its attachments as a line each (the kind, the name, a link's address); nothing
    of their contents."""
    out: dict[str, list[dict[str, str]]] = {}
    for row in db.execute(select(Attachment.uid, Attachment.date, Attachment.kind, Attachment.meta_enc)
                          .where(Attachment.user_id == account_id, Attachment.date >= first, Attachment.date <= last)
                          .order_by(Attachment.date, Attachment.created_at, Attachment.id)):
        meta = _meta(account_id, dek, row)
        if meta is None:
            continue
        out.setdefault(row.date, []).append({"kind": row.kind, "name": str(meta.get("name") or ""),
                                             "url": str(meta.get("url") or "") if row.kind == "link" else ""})
    return out


def meta_of(account_id: int, dek: bytes, row: Any) -> dict[str, Any] | None:
    return _meta(account_id, dek, row)


def seal_meta(account_id: int, dek: bytes, uid: str, meta: dict[str, Any]) -> bytes:
    return vault.seal_json(dek, meta, _meta_aad(account_id, uid))


def file_path(file_id: str) -> Path:
    return _file_path(file_id)


def file_label(account_id: int, uid: str, file_id: str) -> bytes:
    return _file_label(account_id, uid, file_id)
