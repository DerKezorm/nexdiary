"""Files in the media folder that no row names any more: the remains of a crash between writing a file and its row, of
a deletion whose files could not be removed at that moment, or of a restore that brought back an older database. At the
start and once a day they go, when they are older than an hour.

What names a file: a photo of a day (``photos``), a photo of a time capsule (``capsule_photos``) and a photo chosen for
a capsule not closed yet (``capsule_uploads``), each as ``uid`` and its smaller copy ``uid.p``; an attachment of a day
(``attachments``) as ``file_id`` and the still of a video as ``uid.p``. A temporary file of a write
(``.<name>.<pid>-<ns>.part``) and a work folder of an upload or a conversion (``.work-<hex>``, the plain file being
checked or converted) that are that old were left by a process that died while writing; a work folder goes whole.

Never a file that may still be waiting for its row: a file is only taken when it is older than an hour *and* older
than the start of every operation of this process that is writing media files right now (``photos.writes``), and its
row is looked for once more right before it goes. Only names of the media folder's own form are touched, links never,
the master key never (it cannot lie there; checked anyway).
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from collections.abc import Iterable
from pathlib import Path

from sqlalchemy import select, union_all
from sqlalchemy.orm import Session

from ..models import Attachment, CapsulePhoto, CapsuleUpload, Photo
from . import attachments, photos, vault

logger = logging.getLogger("nexdiary.media")

#: How old a file without a row must be before it goes.
KEEP_SECONDS = 3600
#: How often the sweep runs after the one at the start.
EVERY_SECONDS = 24 * 3600
#: A media file: an id, and ``.p`` for the smaller copy (as ``backups.MEDIA_NAME``).
MEDIA_NAME = re.compile(r"^([A-Za-z0-9_-]{8,40})(\.p)?$")
#: A temporary file of ``photos._write``.
PART_NAME = re.compile(r"^\.[A-Za-z0-9_.-]{1,80}\.part$")
CHUNK = 500


def _named(db: Session, uids: Iterable[str]) -> set[str]:
    """Which of these ids a row of the database names."""
    wanted = list(set(uids))
    found: set[str] = set()
    for start in range(0, len(wanted), CHUNK):
        part = wanted[start:start + CHUNK]
        found.update(db.scalars(union_all(
            select(Photo.uid).where(Photo.uid.in_(part)),
            select(CapsulePhoto.uid).where(CapsulePhoto.uid.in_(part)),
            select(CapsuleUpload.uid).where(CapsuleUpload.uid.in_(part)),
            select(Attachment.uid).where(Attachment.uid.in_(part)),
            select(Attachment.file_id).where(Attachment.file_id.in_(part)),
        )))
    return found


def _master_key() -> Path | None:
    try:
        return vault.master_key_path().resolve()
    except OSError:
        return None


def sweep(now: float | None = None, *, at_start: bool = False) -> int:
    """One round: deletes the old files no row names. Gives how many went. ``at_start``: nothing of this process
    writes yet, so every work folder and temporary file goes at once, whatever its age (a crash or a killed process
    left them, and a work folder holds a video in the clear); files of the media folder still wait their hour."""
    from ..db import SessionLocal

    root = photos.media_root()
    if not root.is_dir():
        return 0
    moment = time.time() if now is None else now
    cutoff = moment - KEEP_SECONDS
    leftovers = moment + 1 if at_start else cutoff
    busy = photos.oldest_writing()
    if busy is not None:
        cutoff = min(cutoff, busy - 1)
        leftovers = min(leftovers, busy - 1)
    master = _master_key()
    candidates: list[tuple[Path, str | None]] = []
    removed = 0
    for entry in root.iterdir():
        name = entry.name
        if attachments.WORK_NAME.match(name):
            removed += _work_folder(entry, leftovers)
            continue
        found = MEDIA_NAME.match(name)
        if not found and not PART_NAME.match(name):
            continue
        try:
            if entry.is_symlink() or not entry.is_file() or entry.resolve() == master:
                continue
            if entry.stat().st_mtime >= (cutoff if found else leftovers):
                continue
        except OSError:
            continue
        candidates.append((entry, found.group(1) if found else None))
    if not candidates:
        if removed:
            logger.info("Media files without a row removed count=%s", removed)
        return removed
    with SessionLocal() as db:
        named = _named(db, [uid for _entry, uid in candidates if uid])
        for entry, uid in candidates:
            if uid is not None and (uid in named or _named(db, [uid])):
                continue
            try:
                entry.unlink()
                removed += 1
            except FileNotFoundError:
                continue
            except OSError as exc:
                logger.warning("A media file without a row could not be deleted: %s", exc.strerror)
    if removed:
        logger.info("Media files without a row removed count=%s", removed)
    return removed


def _work_folder(entry: Path, cutoff: float) -> int:
    """A work folder older than ``cutoff`` (by itself and everything in it), never a link: gone with what it holds.
    1 when it went."""
    try:
        if entry.is_symlink() or not entry.is_dir():
            return 0
        newest = entry.stat().st_mtime
        for inner in entry.iterdir():
            if inner.is_symlink() or not inner.is_file():
                return 0
            newest = max(newest, inner.stat().st_mtime)
        if newest >= cutoff:
            return 0
    except OSError:
        return 0
    shutil.rmtree(entry, ignore_errors=True)
    return 0 if entry.exists() else 1


async def run_forever(stop: asyncio.Event) -> None:
    """At the start, then once a day."""
    first = True
    while not stop.is_set():
        at_start, first = first, False
        try:
            await asyncio.to_thread(sweep, at_start=at_start)
        except Exception:
            logger.exception("The sweep of the media folder failed")
        try:
            await asyncio.wait_for(stop.wait(), EVERY_SECONDS)
        except TimeoutError:
            continue
