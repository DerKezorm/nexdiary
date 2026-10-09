"""Photos of a day: what comes in is a picture a phone or camera makes; what is kept is drawn anew from its pixels and
sealed with the person's data key.

* **Nothing but pixels survives**: the picture is turned upright by its EXIF orientation, then drawn into a new WebP
  without EXIF, XMP or colour profile (colours are converted to sRGB first). No place, no device, no time of day, no
  second picture hidden behind the first, no script in a polyglot.
* **Two files per photo** in the media folder: the original (at most ``EDGE`` pixels on its longer side) and a smaller
  copy for lists (``PREVIEW_EDGE``), both sealed (AES-256-GCM, the person's data key, bound to the photo's id and the
  part). Their names are the photo's random id and ``<id>.p``: nothing that tells whose they are or what they show.
* **Only the owner** gets a photo back, through ``routers/photos.py``; a photo of somebody else answers like one that
  does not exist. The media folder is never served as static files.
* **Deleting** a photo deletes its files and takes it out of every place it shows (``remove``); deleting an account
  deletes all its files (``remove_files``). A photo taken for the text of a page goes by itself once nothing holds
  it (``diary.tidy_text_photos``).

The database keeps in the clear what sorting and laying out need: the date, the size in pixels and bytes, the time it
came. A backup carries the sealed files and the database, never the master key.
"""

from __future__ import annotations

import functools
import io
import itertools
import logging
import os
import re
import secrets
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, bindparam, func, or_, select, text, update
from sqlalchemy.orm import Session

from .. import private
from ..config import get_settings
from ..errors import error
from ..models import Day, Draft, Note, Photo, UtcDateTime
from . import covers, pictures, quota, vault

logger = logging.getLogger("nexdiary.photos")

#: The longer side of a kept photo: sharp on any screen, a fraction of what a phone makes.
EDGE = 2560
#: The longer side of the copy for lists and covers in a list.
PREVIEW_EDGE = 720
QUALITY = 84
PREVIEW_QUALITY = 78
#: What phones and cameras make for photos (GIF and BMP are not photos).
KINDS = {"jpeg", "png", "webp", "heic", "avif"}
PHOTOS_PER_DAY = 100
PREVIEW_SUFFIX = ".p"
UPLOAD_ID_LENGTH = 36
SOURCES = ("upload", "immich")


@dataclass
class Drawn:
    original: bytes
    preview: bytes
    width: int
    height: int


def _srgb(image: Any) -> Any:
    """The picture in sRGB, when it came with a colour profile of its own (the profile itself is not kept: it can
    name the device). Unchanged when the profile cannot be read."""
    profile = image.info.get("icc_profile")
    if not profile:
        return image
    try:
        from PIL import ImageCms

        source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        target = ImageCms.createProfile("sRGB")
        mode = "RGBA" if image.mode == "RGBA" else "RGB"
        return ImageCms.profileToProfile(image, source, target, outputMode=mode)
    except Exception:  # noqa: BLE001 - a broken profile only costs colour accuracy
        return image


def _webp(image: Any, quality: int) -> bytes:
    out = io.BytesIO()
    # Nothing from the source rides along: ``save`` would otherwise copy EXIF, XMP and the profile from ``info``.
    image.info = {}
    image.save(out, "WEBP", quality=quality, method=4, exif=b"", xmp=b"", icc_profile=b"")
    return out.getvalue()


def draw(data: bytes) -> Drawn:
    """The photo drawn anew: upright, sRGB, at most ``EDGE`` pixels, and its smaller copy. ``pictures.PictureError``
    for anything that is not a photo of an accepted kind or is too large.

    Memory first: the picture is turned and made small in place, and its mode changed only once it is small, so that
    a large photo is held in full only once."""
    from PIL import Image, ImageOps

    with pictures.opened(data, KINDS) as image:
        if image.format == "JPEG":
            # A JPEG is decoded at a fraction of its size when that still covers ``EDGE``: far less memory.
            image.draft("RGB", (EDGE, EDGE))
        image.load()
        alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
        if image.mode not in ("RGB", "RGBA", "L"):
            # Palettes and 16-bit pictures cannot be made smaller smoothly; wide modes only shrink after this.
            image = image.convert("RGBA" if alpha else "RGB")
        ImageOps.exif_transpose(image, in_place=True)
        image.thumbnail((EDGE, EDGE), Image.Resampling.LANCZOS)
        picture = _srgb(image.convert("RGBA" if alpha else "RGB"))
        if picture.mode not in ("RGB", "RGBA"):
            picture = picture.convert("RGBA" if alpha else "RGB")
        small = picture.copy()
        small.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE), Image.Resampling.LANCZOS)
        return Drawn(_webp(picture, QUALITY), _webp(small, PREVIEW_QUALITY), picture.width, picture.height)


# --- Files ----------------------------------------------------------------------------------------------------------


def media_root() -> Path:
    root = get_settings().media_dir
    assert root is not None
    return root


def _path(uid: str, preview: bool) -> Path:
    return media_root() / (uid + (PREVIEW_SUFFIX if preview else ""))


def _aad(account_id: int, uid: str, preview: bool) -> bytes:
    return vault.aad(account_id, "photos", "preview" if preview else "original", uid)


def _write(path: Path, data: bytes) -> None:
    """Written whole under a name of its own, then moved to its place: a reader never sees half a file, and a backup
    never takes the temporary one (its name does not look like a media file)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}-{time.time_ns()}.part")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


#: The wall-clock start of every operation of this process that writes media files before the row that names them
#: (``writes``): a file younger than the oldest of them may still be waiting for its row, and the sweep of the media
#: folder (``services/media_sweep.py``) leaves it alone.
_writing: dict[int, float] = {}
_writing_lock = threading.Lock()
_writing_count = itertools.count()


def writes[F: Callable[..., Any]](function: F) -> F:
    """Marks an operation that writes media files and then the rows that name them, for as long as it runs."""

    @functools.wraps(function)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        token = next(_writing_count)
        with _writing_lock:
            _writing[token] = time.time()
        try:
            return function(*args, **kwargs)
        finally:
            with _writing_lock:
                _writing.pop(token, None)

    return wrapped  # type: ignore[return-value]


def oldest_writing() -> float | None:
    """When the oldest operation that is writing media files right now began (wall clock); None when none is."""
    with _writing_lock:
        return min(_writing.values(), default=None)


def remove_files(uids: Iterable[str]) -> None:
    """The files of these photos, gone. A file that is not there is fine; one that cannot be deleted is said in the
    log (without anything that tells whose it was) and left for the operator."""
    for uid in uids:
        for preview in (False, True):
            try:
                _path(uid, preview).unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("A photo file could not be deleted: %s", exc.strerror)


def uids_of(db: Session, account_id: int) -> list[str]:
    return list(db.scalars(select(Photo.uid).where(Photo.user_id == account_id)))


# --- Rows -----------------------------------------------------------------------------------------------------------


def view(row: Any) -> dict[str, Any]:
    return {
        "id": row.uid,
        "date": row.date,
        "source": row.source,
        "width": row.width,
        "height": row.height,
        "created_at": row.created_at.isoformat(),
        "on_note": bool(row.on_note),
        "for_text": bool(row.for_text),
    }


_COLUMNS = (Photo.uid, Photo.date, Photo.source, Photo.width, Photo.height, Photo.created_at, Photo.on_note,
            Photo.for_text)


def check_id(uid: str) -> str:
    """A photo id in an address: one that cannot exist is not found."""
    uid = uid.lower() if isinstance(uid, str) else ""
    if len(uid) != 32 or any(char not in "0123456789abcdef" for char in uid):
        raise error("not_found", "Not found.", 404)
    return uid


def check_upload_id(value: str) -> str:
    from .diary import NOTE_ID

    value = value.lower() if isinstance(value, str) else ""
    if not NOTE_ID.match(value):
        raise error("upload_id_invalid", "An upload id is a UUID.", 422)
    return value


def owned(db: Session, account_id: int, uid: str) -> bool:
    return db.scalar(select(Photo.id).where(Photo.user_id == account_id, Photo.uid == uid)) is not None


def list_of_day(db: Session, account_id: int, day: str) -> list[dict[str, Any]]:
    rows = db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.date == day)
                      .order_by(Photo.created_at, Photo.id)).all()
    return [view(row) for row in rows]


def _by_upload(db: Session, account_id: int, upload_id: str | None, asset_key: str | None = None) -> Any:
    """The photo that came with this upload id, or from this photo of Immich (``asset_key``)."""
    if asset_key is not None:
        found = Photo.asset_id == asset_key
    elif upload_id is not None:
        found = Photo.upload_id == upload_id
    else:
        return None
    return db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, found)).first()


def by_asset(db: Session, account_id: int, asset_key: str) -> dict[str, Any] | None:
    row = _by_upload(db, account_id, None, asset_key)
    return view(row) if row is not None else None


def taken_from_immich(db: Session, account_id: int, keys: Iterable[str]) -> dict[str, str]:
    """For the keys of photos of Immich, the ids of the photos taken over from them."""
    wanted = list(keys)
    if not wanted:
        return {}
    rows = db.execute(select(Photo.asset_id, Photo.uid).where(Photo.user_id == account_id,
                                                              Photo.asset_id.in_(wanted))).all()
    return {str(row.asset_id): row.uid for row in rows}


def chosen(db: Session, account_id: int, photo: dict[str, Any]) -> dict[str, Any]:
    """A photo taken for the text that is now chosen on purpose (a photo of the day, a cover): it is no longer one to
    tidy away. One statement; the photo as it stands then."""
    if not photo["for_text"]:
        return photo
    db.execute(update(Photo).where(Photo.user_id == account_id, Photo.uid == photo["id"]).values(for_text=False))
    db.commit()
    row = db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.uid == photo["id"])).first()
    return view(row) if row is not None else {**photo, "for_text": False}


@writes
def add(db: Session, account_id: int, dek: bytes, day: str, upload_id: str | None, drawn: Drawn,
        moment: Any, on_note: bool = False, *, source: str = "upload",
        asset_key: str | None = None, for_text: bool = False) -> tuple[dict[str, Any], bool]:
    """Keeps a drawn photo: files first, then the row; the photo and whether it is new. The same upload id again, or
    the same photo of Immich taken over again (``asset_key``), returns the photo that stands (a double tap, a retry
    after a lost answer, two tabs) and leaves no files behind; a photo of Immich taken for the text before and now
    chosen without ``for_text`` stays for good (``chosen``). The row is written only while the day has room and the
    person's storage too (``quota``), checked in the same statement."""
    assert source in SOURCES and (upload_id is not None) != (asset_key is not None)
    assert not (on_note and for_text)
    existing = _by_upload(db, account_id, upload_id, asset_key)
    if existing is not None:
        return _again(db, account_id, existing, asset_key, for_text), False
    from .diary import ensure_open

    ensure_open(db, account_id, day)
    uid = secrets.token_hex(16)
    original = vault.seal(dek, drawn.original, _aad(account_id, uid, False))
    preview = vault.seal(dek, drawn.preview, _aad(account_id, uid, True))
    _write(_path(uid, False), original)
    _write(_path(uid, True), preview)
    limit = quota.limit_bytes(db)
    try:
        inserted = db.execute(
            text(
                "INSERT INTO photos (uid, user_id, date, source, upload_id, asset_id, width, height, size, "  # noqa: S608 - constants
                "preview_size, created_at, on_note, for_text) SELECT :uid, :user, :date, :source, :upload, :asset, "
                ":width, :height, :size, :preview, :now, :on_note, :for_text "
                "WHERE (SELECT count(*) FROM photos WHERE user_id = :user AND date = :date) < :limit "
                # A day locked in between (a second device): decided in this statement.
                "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :date "
                "AND locked_at IS NOT NULL) "
                f"AND (:quota IS NULL OR {quota.USED} + :size + :preview <= :quota) "
                # The upload id, or the photo of Immich: whichever was there first stays.
                "ON CONFLICT DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"uid": uid, "user": account_id, "date": day, "upload": upload_id, "asset": asset_key, "source": source,
             "width": drawn.width,
             "height": drawn.height, "size": len(original), "preview": len(preview), "now": moment,
             "limit": PHOTOS_PER_DAY, "quota": limit, "on_note": bool(on_note), "for_text": bool(for_text)},
        )
        db.commit()
    except Exception:
        db.rollback()
        remove_files([uid])
        raise
    if inserted.rowcount != 1:
        remove_files([uid])
        found = _by_upload(db, account_id, upload_id, asset_key)
        if found is not None:
            return _again(db, account_id, found, asset_key, for_text), False
        ensure_open(db, account_id, day)
        if limit is not None and quota.used(db, account_id) + len(original) + len(preview) > limit:
            raise quota.full(db)
        raise error("too_many_photos", "There are as many photos on this day as there may be.", 409,
                    max=PHOTOS_PER_DAY)
    row = db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.uid == uid)).one()
    return view(row), True


def _again(db: Session, account_id: int, row: Any, asset_key: str | None, for_text: bool) -> dict[str, Any]:
    photo = view(row)
    return chosen(db, account_id, photo) if asset_key is not None and not for_text else photo


def read(db: Session, account_id: int, dek: bytes, uid: str, preview: bool) -> bytes:
    """The picture, opened; ``not_found`` for a photo that is not the person's, or whose file is gone or damaged."""
    if not owned(db, account_id, uid):
        raise error("not_found", "Not found.", 404)
    try:
        sealed = _path(uid, preview).read_bytes()
    except OSError as exc:
        logger.warning("A photo file is missing: %s", exc.strerror)
        raise error("not_found", "Not found.", 404) from exc
    try:
        return vault.open_sealed(dek, sealed, _aad(account_id, uid, preview))
    except vault.SealError as exc:
        logger.warning("A photo file did not open")
        raise error("not_found", "Not found.", 404) from exc


# --- Deleting, and what a photo is used for --------------------------------------------------------------------------

#: The most photos one request deletes; the most a page of the library lists, and how many it looks at to find unused
#: ones before it hands back a cursor.
DELETE_MAX = 100
LIBRARY_MAX = 100
LIBRARY_DEFAULT = 60
LIBRARY_SCAN = 400
_CURSOR = re.compile(r"^(\d{4}-\d{2}-\d{2})\.(\d{1,16})\.([0-9a-f]{32})$")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

#: The photo is held by a note on a locked day: that note may not lose it.
_ON_A_LOCKED_NOTE = (
    "EXISTS (SELECT 1 FROM notes JOIN days ON days.user_id = notes.user_id AND days.date = notes.date "
    "WHERE notes.user_id = :user AND notes.photo_id = :uid AND days.locked_at IS NOT NULL)"
)


def _locked_for(db: Session, account_id: int, uid: str, day: str) -> bool:
    """Whether deleting the photo would change a locked day: its own, or the day of a note that holds it."""
    from .diary import is_locked

    return is_locked(db, account_id, day) or bool(
        db.execute(text(f"SELECT {_ON_A_LOCKED_NOTE}"), {"user": account_id, "uid": uid}).scalar())


def remove(db: Session, account_id: int, dek: bytes, uid: str) -> None:
    """Deletes a photo of the person and everything that shows it, in one transaction: its pictures leave the text of
    the page (whose revision goes up) and of the draft of its day, a cover it was goes back to the suggestion (with its
    crop), the notes that held it lose it. Files only after the commit. ``day_locked`` when that would change a locked
    day (its own, or that of a note holding it), and nothing changes; ``not_found`` for a photo that is not the
    person's. Every write is made onto exactly what was read (the revision of the page, the draft as it was), so a save
    from another device in between makes it read again, never lose that save or leave a picture of a photo that is
    gone."""
    from . import diary

    for _ in range(diary.CHANGE_TRIES):
        day = db.scalar(select(Photo.date).where(Photo.user_id == account_id, Photo.uid == uid))
        if day is None:
            raise error("not_found", "Not found.", 404)
        # Courtesy, early: the statement that deletes checks both again.
        diary.ensure_open(db, account_id, day)
        if _locked_for(db, account_id, uid, day):
            raise diary.locked_error()
        page = db.execute(select(Day.id, Day.revision, Day.content_enc)
                          .where(Day.user_id == account_id, Day.date == day)).first()
        draft = db.execute(select(Draft.content_enc, Draft.base_revision)
                           .where(Draft.user_id == account_id, Draft.date == day)).first()
        page_sealed = page.content_enc if page is not None else None
        draft_sealed = draft.content_enc if draft is not None else None
        new_page = new_draft = None
        if page is not None:
            content = diary._readable_content(account_id, dek, day, page.content_enc)
            changed = diary.without_photo(content, uid) if content is not None else None
            if changed is not None:
                new_page = vault.seal_json(dek, changed, diary._day_aad(account_id, day))
        if draft is not None:
            try:
                opened = vault.open_json(dek, draft.content_enc, diary._draft_aad(account_id, day))
            except vault.SealError:
                opened = None
            changed = diary.without_photo(opened, uid) if opened is not None else None
            if changed is not None:
                new_draft = vault.seal_json(dek, changed, diary._draft_aad(account_id, day))
        try:
            if new_page is not None:
                assert page is not None
                written = db.execute(update(Day).where(Day.id == page.id, Day.revision == page.revision,
                                                       Day.locked_at.is_(None))
                                     .values(content_enc=new_page, revision=page.revision + 1, updated_at=diary.now()))
                if written.rowcount != 1:
                    db.rollback()
                    continue
                page_sealed = new_page
            if new_draft is not None:
                assert draft is not None
                # A draft that began from the page as it stood takes the page as it stands now: it holds the same
                # change, and saving it must not meet a page "changed meanwhile" by this.
                base = draft.base_revision
                if new_page is not None and page is not None and draft.base_revision == page.revision:
                    base = page.revision + 1
                written = db.execute(update(Draft).where(Draft.user_id == account_id, Draft.date == day,
                                                         Draft.content_enc == draft.content_enc)
                                     .values(content_enc=new_draft, base_revision=base))
                if written.rowcount != 1:
                    db.rollback()
                    continue
                draft_sealed = new_draft
            gone = db.execute(
                text(
                    "DELETE FROM photos WHERE user_id = :user AND uid = :uid AND date = :day "  # noqa: S608 - constants
                    "AND NOT EXISTS (SELECT 1 FROM days WHERE user_id = :user AND date = :day "
                    "AND locked_at IS NOT NULL) "
                    f"AND NOT {_ON_A_LOCKED_NOTE} "
                    # The page and the draft are still what this request made of them: nothing came in between.
                    "AND (SELECT content_enc FROM days WHERE user_id = :user AND date = :day) IS :page "
                    "AND (SELECT content_enc FROM drafts WHERE user_id = :user AND date = :day) IS :draft"
                ),
                {"user": account_id, "uid": uid, "day": day, "page": page_sealed, "draft": draft_sealed},
            )
            if gone.rowcount != 1:
                db.rollback()
                continue
            db.execute(update(Note).where(Note.user_id == account_id, Note.photo_id == uid).values(photo_id=None))
            db.commit()
        except Exception:
            db.rollback()
            raise
        remove_files([uid])
        return
    raise error("busy", "nexdiary is busy. Try again in a moment.", 503)


def remove_many(db: Session, account_id: int, dek: bytes, ids: list[str]) -> dict[str, list[str]]:
    """Deletes these photos one by one, each as ``remove`` does: a locked day keeps only its own photos. What was
    deleted, what a locked day kept, and what is not there (or not the person's: the same answer)."""
    if len(ids) > DELETE_MAX:
        raise error("too_many_photos", "Too many photos at once.", 422, max=DELETE_MAX)
    out: dict[str, list[str]] = {"deleted": [], "locked": [], "missing": []}
    for raw in dict.fromkeys(value.lower() if isinstance(value, str) else "" for value in ids):
        try:
            remove(db, account_id, dek, check_id(raw))
        except HTTPException as exc:
            code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
            if code == "not_found":
                out["missing"].append(raw)
            elif code == "day_locked":
                out["locked"].append(raw)
            else:
                raise
        else:
            out["deleted"].append(raw)
    return out


def _uses_of(db: Session, account_id: int, dek: bytes, rows: list[Any]) -> dict[str, dict[str, Any]]:
    """For these own photos: whether each is the cover of its page, a picture in its text, and the notes that hold
    it; and ``unknown`` when its page cannot be read (what it holds is not known then)."""
    from . import diary

    if not rows:
        return {}
    dates = sorted({row.date for row in rows})
    pages: dict[str, dict[str, Any] | None] = {}
    for page in db.execute(select(Day.date, Day.content_enc).where(Day.user_id == account_id, Day.date.in_(dates))):
        pages[page.date] = diary._readable_content(account_id, dek, page.date, page.content_enc)
    holders: dict[str, list[dict[str, str]]] = {}
    uids = [row.uid for row in rows]
    for note in db.execute(select(Note.uid, Note.date, Note.photo_id)
                           .where(Note.user_id == account_id, Note.photo_id.in_(uids))
                           .order_by(Note.date, Note.created_at, Note.id)):
        holders.setdefault(note.photo_id, []).append({"id": note.uid, "date": note.date})
    out = {}
    for row in rows:
        content = pages.get(row.date)
        out[row.uid] = {
            "cover": content is not None and covers.photo_of(content.get("cover")) == row.uid,
            "text": content is not None and row.uid in diary.text_photo_ids(content["text"]),
            "notes": holders.get(row.uid, []),
            "unknown": row.date in pages and content is None,
        }
    return out


def uses(db: Session, account_id: int, dek: bytes, uid: str) -> dict[str, Any]:
    """What an own photo is used for, before it is deleted: the cover, the text, the notes holding it, its day and
    whether deleting it would change a locked day. ``not_found`` for any other photo."""
    row = db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.uid == uid)).first()
    if row is None:
        raise error("not_found", "Not found.", 404)
    found = _uses_of(db, account_id, dek, [row])[uid]
    return {"cover": found["cover"], "text": found["text"], "notes": found["notes"], "date": row.date,
            "locked": _locked_for(db, account_id, uid, row.date)}


def _cursor(row: Any) -> str:
    moment = row.created_at - _EPOCH
    micro = (moment.days * 86_400 + moment.seconds) * 1_000_000 + moment.microseconds
    return f"{row.date}.{micro}.{row.uid}"


def _after(cursor: str) -> Any:
    """The condition "after this place in the library" (newest day first, then the newest photo), for a cursor as
    ``_cursor`` makes it. ``invalid_input`` for anything else."""
    match = _CURSOR.match(cursor) if isinstance(cursor, str) else None
    if match is None:
        raise error("invalid_input", "The input is not valid.", 422, fields=["before"])
    day, micro, uid = match.group(1), int(match.group(2)), match.group(3)
    moment = _EPOCH + timedelta(microseconds=micro)
    return or_(Photo.date < day,
               and_(Photo.date == day, Photo.created_at < moment),
               and_(Photo.date == day, Photo.created_at == moment, Photo.uid < uid))


def library(db: Session, account_id: int, dek: bytes, *, before: str | None, limit: int,
            unused: bool) -> dict[str, Any]:
    """The person's own photos, newest day first and the newest photo of a day first, each with what uses it, a page
    at a time (``next``: the cursor for the page after, or None at the end). With ``unused`` only the photos that are
    no cover, no picture in a text and on no note (a photo of the day that is only that counts as unused; one whose
    page cannot be read does not); then at most ``LIBRARY_SCAN`` photos are looked at, and a page may come back
    shorter, with a cursor to go on."""
    limit = min(max(limit, 1), LIBRARY_MAX)
    query = select(*_COLUMNS).where(Photo.user_id == account_id)
    if before:
        query = query.where(_after(before))
    take = LIBRARY_SCAN + 1 if unused else limit + 1
    rows = db.execute(query.order_by(Photo.date.desc(), Photo.created_at.desc(), Photo.uid.desc()).limit(take)).all()
    looked = rows[:LIBRARY_SCAN] if unused else rows[:limit]
    found = _uses_of(db, account_id, dek, looked)
    out: list[dict[str, Any]] = []
    following: str | None = None
    for index, row in enumerate(looked):
        use = found[row.uid]
        if unused and (use["cover"] or use["text"] or use["notes"] or use["unknown"]):
            continue
        out.append({**view(row), "uses": {"cover": use["cover"], "text": use["text"], "notes": use["notes"]}})
        if len(out) == limit:
            following = _cursor(row) if index + 1 < len(rows) else None
            break
    else:
        following = _cursor(looked[-1]) if looked and len(rows) > len(looked) else None
    return {"photos": out, "next": following}


def storage(db: Session, account_id: int) -> dict[str, Any]:
    """What the person holds (photos and sealed texts, as the limit counts it), the limit, and how many photos."""
    count = db.scalar(select(func.count()).select_from(Photo).where(Photo.user_id == account_id))
    return {"used": quota.used(db, account_id), "limit": quota.limit_bytes(db), "count": int(count or 0)}
