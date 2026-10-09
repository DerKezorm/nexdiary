"""Files in the media folder that no row names any more: the remains of a crash between writing a file and its row, of
a deletion whose files could not be removed at that moment, or of a restore that brought back an older database. At the
start and once a day they go, when they are older than an hour.

What names a file: a photo of a day (``photos``), a photo of a time capsule (``capsule_photos``) and a photo chosen for
a capsule not closed yet (``capsule_uploads``), each as ``uid`` and its smaller copy ``uid.p``. Nothing else lies in
the media folder; a temporary file of a write (``.<name>.<pid>-<ns>.part``) that is that old was left by a process that
died while writing.

Never a file that may still be waiting for its row: a file is only taken when it is older than an hour *and* older
than the start of every operation of this process that is writing media files right now (``photos.writes``), and its
row is looked for once more right before it goes. Only names of the media folder's own form are touched, links never,
the master key never (it cannot lie there; checked anyway).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Iterable
from pathlib import Path

from sqlalchemy import select, union_all
from sqlalchemy.orm import Session

from ..models import CapsulePhoto, CapsuleUpload, Photo
from . import photos, vault

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
        )))
    return found


def _master_key() -> Path | None:
    try:
        return vault.master_key_path().resolve()
    except OSError:
        return None


def sweep(now: float | None = None) -> int:
    """One round: deletes the old files no row names. Gives how many went."""
    from ..db import SessionLocal

    root = photos.media_root()
    if not root.is_dir():
        return 0
    moment = time.time() if now is None else now
    cutoff = moment - KEEP_SECONDS
    busy = photos.oldest_writing()
    if busy is not None:
        cutoff = min(cutoff, busy - 1)
    master = _master_key()
    candidates: list[tuple[Path, str | None]] = []
    for entry in root.iterdir():
        name = entry.name
        found = MEDIA_NAME.match(name)
        if not found and not PART_NAME.match(name):
            continue
        try:
            if entry.is_symlink() or not entry.is_file() or entry.resolve() == master:
                continue
            if entry.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        candidates.append((entry, found.group(1) if found else None))
    if not candidates:
        return 0
    removed = 0
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


async def run_forever(stop: asyncio.Event) -> None:
    """At the start, then once a day."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(sweep)
        except Exception:
            logger.exception("The sweep of the media folder failed")
        try:
            await asyncio.wait_for(stop.wait(), EVERY_SECONDS)
        except TimeoutError:
            continue
