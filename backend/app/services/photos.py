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
* **Deleting** a photo deletes its files; deleting an account deletes all its files (``remove_files``).

The database keeps in the clear what sorting and laying out need: the date, the size in pixels and bytes, the time it
came. A backup carries the sealed files and the database, never the master key.
"""

from __future__ import annotations

import io
import logging
import os
import secrets
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import bindparam, delete, select, text, update
from sqlalchemy.orm import Session

from .. import private
from ..config import get_settings
from ..errors import error
from ..models import Note, Photo, UtcDateTime
from . import pictures, quota, vault

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
    }


_COLUMNS = (Photo.uid, Photo.date, Photo.source, Photo.width, Photo.height, Photo.created_at, Photo.on_note)


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


def _by_upload(db: Session, account_id: int, upload_id: str) -> Any:
    return db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.upload_id == upload_id)).first()


def add(db: Session, account_id: int, dek: bytes, day: str, upload_id: str, drawn: Drawn,
        moment: Any, on_note: bool = False) -> tuple[dict[str, Any], bool]:
    """Keeps a drawn photo: files first, then the row; the photo and whether it is new. The same upload id again
    returns the photo that stands (a double tap, a retry after a lost answer) and leaves no files behind. The row is
    written only while the day has room and the person's storage too (``quota``), checked in the same statement."""
    existing = _by_upload(db, account_id, upload_id)
    if existing is not None:
        return view(existing), False
    uid = secrets.token_hex(16)
    original = vault.seal(dek, drawn.original, _aad(account_id, uid, False))
    preview = vault.seal(dek, drawn.preview, _aad(account_id, uid, True))
    _write(_path(uid, False), original)
    _write(_path(uid, True), preview)
    limit = quota.limit_bytes(db)
    try:
        inserted = db.execute(
            text(
                "INSERT INTO photos (uid, user_id, date, source, upload_id, width, height, size, preview_size, "  # noqa: S608 - constants
                "created_at, on_note) SELECT :uid, :user, :date, 'upload', :upload, :width, :height, :size, :preview, "
                ":now, :on_note "
                "WHERE (SELECT count(*) FROM photos WHERE user_id = :user AND date = :date) < :limit "
                f"AND (:quota IS NULL OR {quota.USED} + :size + :preview <= :quota) "
                "ON CONFLICT (user_id, upload_id) DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"uid": uid, "user": account_id, "date": day, "upload": upload_id, "width": drawn.width,
             "height": drawn.height, "size": len(original), "preview": len(preview), "now": moment,
             "limit": PHOTOS_PER_DAY, "quota": limit, "on_note": bool(on_note)},
        )
        db.commit()
    except Exception:
        db.rollback()
        remove_files([uid])
        raise
    if inserted.rowcount != 1:
        remove_files([uid])
        found = _by_upload(db, account_id, upload_id)
        if found is not None:
            return view(found), False
        if limit is not None and quota.used(db, account_id) + len(original) + len(preview) > limit:
            raise quota.full(db)
        raise error("too_many_photos", "There are as many photos on this day as there may be.", 409,
                    max=PHOTOS_PER_DAY)
    row = db.execute(select(*_COLUMNS).where(Photo.user_id == account_id, Photo.uid == uid)).one()
    return view(row), True


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


def remove(db: Session, account_id: int, uid: str) -> None:
    """The photo, its files, and its place on notes. A day whose cover it was falls back to its suggestion when it
    is shown (``diary.effective_cover``)."""
    gone = db.execute(delete(Photo).where(Photo.user_id == account_id, Photo.uid == uid))
    if gone.rowcount != 1:
        db.rollback()
        raise error("not_found", "Not found.", 404)
    db.execute(update(Note).where(Note.user_id == account_id, Note.photo_id == uid).values(photo_id=None))
    db.commit()
    remove_files([uid])
