"""Turning a video in HEVC into H.264, so that it plays in every browser, on request of the person it belongs to.

* **A queue in the database**: an attachment waits as ``queued`` (``queued_at`` keeps the order), one runs as
  ``converting``. **One at a time on the whole server**: encoding takes the CPU of a small server for minutes. The
  worker is a thread of this process, started with it; a start puts what was ``converting`` back to ``queued``
  (``recover``), so nothing waits for a run that died with the last process.
* **The original stays until the new file is there**: the new one is sealed under a new name, then one statement puts
  it in the row, only while the attachment is still converting, still has the file it began from, and the person's
  storage holds the difference (else ``failed``, original kept). The old file goes after; a browser still streaming it
  keeps its open file.
* **Failing keeps the original**: an error, the time limit (ten times the length of the video, at least
  ``MIN_SECONDS``, at most ``MAX_SECONDS``) or a result that is not H.264 make it ``failed``, as it was before.
* **HDR** (HLG from an iPhone, PQ) is tone mapped to BT.709 in 8 bit and said to be that; an ffmpeg without the
  filters for it (``media_tools.can_tonemap``) fails such a video honestly instead of marking it wrongly.
* **At most ``PER_PERSON`` requests of one person** wait or run at once: one family member cannot fill the queue.
* **Deleting the attachment stops its conversion** (``cancel``) and its work folder goes.
* **A locked day** takes no new request (``attachments.convertible``); one that runs when the day is locked runs to its
  end: the person asked for it while the day was open, and it changes how the video is packed, not what it shows.
* **The operator's switch** (``attachment_convert``) off: nothing new starts, and what waits keeps waiting until it is
  on again. Throwing the requests away would make people ask again for something they asked for.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from typing import Any

from sqlalchemy import bindparam, func, select, text

from ..models import Attachment, UtcDateTime
from . import attachments, media_tools, photos, quota, sealed_file, settings_service, vault

logger = logging.getLogger("nexdiary.conversions")

MIN_SECONDS = 600
PER_SECOND_OF_VIDEO = 10
#: The longest any conversion may take, however long the video: the one place must not be held for days.
MAX_SECONDS = 6 * 3600
#: Conversions one person may have waiting or running at once: the queue is everybody's.
PER_PERSON = 3
#: How often an idle worker looks again on its own (a request wakes it at once).
POLL_SECONDS = 30
#: The largest file a conversion may write, beside four times the source.
OUTPUT_FLOOR = 256 * 1024 * 1024

_lock = threading.Lock()
_wake = threading.Event()
_stop = threading.Event()
_thread: threading.Thread | None = None
#: The conversion running now: the attachment, its person, how far (0 to 100), and the event that stops it.
_current: dict[str, Any] | None = None


def progress_of(uid: str) -> int | None:
    with _lock:
        if _current is not None and _current["uid"] == uid:
            return int(_current["progress"])
    return 0


def running() -> dict[str, Any] | None:
    with _lock:
        if _current is None:
            return None
        return {"id": _current["uid"], "progress": int(_current["progress"])}


def cancel(uid: str) -> None:
    """Stops the conversion of this attachment, if it runs (it was deleted)."""
    with _lock:
        if _current is not None and _current["uid"] == uid:
            _current["cancel"].set()


def cancel_account(account_id: int) -> None:
    """Stops a conversion of an attachment of this person (the account goes)."""
    with _lock:
        if _current is not None and _current["user"] == account_id:
            _current["cancel"].set()


def waiting() -> int:
    from ..db import SessionLocal

    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(Attachment).where(Attachment.status == "queued")) or 0)


def request(db: Any, account_id: int, dek: bytes, uid: str) -> dict[str, Any]:
    """Puts an own attachment in the queue; ``attachment_cannot_convert`` when it may not be converted now (not a video
    in HEVC, already waiting or running, the day locked, the switch off, no ffmpeg)."""
    from ..errors import error

    found = attachments.one(db, account_id, dek, uid)
    if not found["can_convert"]:
        raise error("attachment_cannot_convert", "This attachment cannot be converted now.", 409)
    queued = db.execute(
        text("UPDATE attachments SET status = 'queued', queued_at = :now WHERE user_id = :user AND uid = :uid "
             "AND kind = 'video' AND status IN ('ready', 'failed') AND NOT EXISTS (SELECT 1 FROM days "
             "WHERE days.user_id = :user AND days.date = attachments.date AND days.locked_at IS NOT NULL) "
             "AND (SELECT count(*) FROM attachments AS mine WHERE mine.user_id = :user "
             "AND mine.status IN ('queued', 'converting')) < :most"
             ).bindparams(bindparam("now", type_=UtcDateTime())),
        {"user": account_id, "uid": uid, "now": _now(), "most": PER_PERSON},
    )
    db.commit()
    if queued.rowcount != 1:
        raise error("attachment_cannot_convert", "This attachment cannot be converted now.", 409)
    _wake.set()
    return attachments.one(db, account_id, dek, uid)


def _now() -> Any:
    from .diary import now

    return now()


def recover() -> int:
    """At the start: what was converting when the last process ended waits again. How many."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        back = db.execute(text("UPDATE attachments SET status = 'queued' WHERE status = 'converting'"))
        db.commit()
    if back.rowcount:
        logger.info("Conversions taken up again count=%s", back.rowcount)
    return int(back.rowcount)


def enabled() -> bool:
    from ..db import SessionLocal

    with SessionLocal() as db:
        switch = attachments.operator_settings(db)["convert"]
    return bool(switch) and media_tools.available()


def _claim() -> Any:
    """The oldest waiting attachment, marked as converting; None when none waits."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        for _ in range(5):
            row = db.execute(select(Attachment.id, Attachment.uid, Attachment.user_id, Attachment.file_id,
                                    Attachment.size, Attachment.meta_enc)
                             .where(Attachment.status == "queued")
                             .order_by(Attachment.queued_at, Attachment.id).limit(1)).first()
            if row is None:
                return None
            taken = db.execute(text("UPDATE attachments SET status = 'converting' WHERE id = :id "
                                    "AND status = 'queued'"), {"id": row.id})
            db.commit()
            if taken.rowcount == 1:
                return row
    return None


def run_next() -> bool:
    """One conversion, if one waits and the switch is on; whether there was one."""
    if not enabled():
        return False
    row = _claim()
    if row is None:
        return False
    try:
        _convert(row)
    except Exception:
        logger.exception("A conversion failed")
        _fail(row.id)
    return True


def run_pending() -> int:
    """Every waiting conversion, one after the other (the tests; the worker does the same in its thread)."""
    done = 0
    while run_next():
        done += 1
    return done


def _fail(row_id: int) -> None:
    from ..db import SessionLocal

    with SessionLocal() as db:
        db.execute(text("UPDATE attachments SET status = 'failed', queued_at = NULL WHERE id = :id "
                        "AND status = 'converting'"), {"id": row_id})
        db.commit()


def _set_progress(value: int) -> None:
    with _lock:
        if _current is not None:
            _current["progress"] = max(0, min(99, value))


def _encode(command: list[str], seconds: float, source_bytes: int, stop: threading.Event) -> bool:
    """ffmpeg until it ends; whether it went through. Stopped when ``stop`` is set or the time is up."""
    limit = min(MAX_SECONDS, max(MIN_SECONDS, PER_SECOND_OF_VIDEO * seconds))
    process = media_tools.start(command, limit, max(4 * source_bytes, OUTPUT_FLOOR))
    deadline = time.monotonic() + limit
    killed = threading.Event()

    def watch() -> None:
        while process.poll() is None:
            if stop.wait(0.2) or time.monotonic() > deadline:
                killed.set()
                process.kill()
                return

    watcher = threading.Thread(target=watch, name="nexdiary-conversion-watch", daemon=True)
    watcher.start()
    try:
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.decode("ascii", "replace").strip()
            if line.startswith(("out_time_us=", "out_time_ms=")) and seconds > 0:
                try:
                    # ffmpeg says microseconds under both names.
                    _set_progress(int(int(line.split("=", 1)[1]) / 1_000_000 / seconds * 100))
                except ValueError:
                    continue
        process.wait()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        watcher.join(timeout=5)
    return process.returncode == 0 and not killed.is_set()


def _convert(row: Any) -> None:
    global _current
    from ..db import SessionLocal

    stop = threading.Event()
    with _lock:
        _current = {"uid": row.uid, "user": row.user_id, "progress": 0, "cancel": stop}
    started = time.monotonic()
    try:
        try:
            dek = vault.dek_of(row.user_id)
        except vault.SealError:
            _fail(row.id)
            return
        meta = attachments.meta_of(row.user_id, dek, row)
        if meta is None or not row.file_id:
            _fail(row.id)
            return
        seconds = float(meta.get("seconds") or 0)
        with photos.writing(), attachments.work_folder() as work:
            source, target = work / "in", work / "out.mp4"
            try:
                sealed_file.open_to(attachments.file_path(row.file_id), source, dek,
                                    attachments.file_label(row.user_id, row.uid, row.file_id))
            except (OSError, sealed_file.SealedFileError) as exc:
                logger.warning("A video to convert did not open: %s", type(exc).__name__)
                _fail(row.id)
                return
            try:
                found = media_tools.probe(source, "mov")
                hdr = found.video is not None and found.video.hdr
                command = media_tools.convert_command(source, target, meta.get("audio_codec"), hdr=hdr)
            except (media_tools.MediaError, media_tools.ToolFailed) as exc:
                logger.warning("A conversion could not begin: %s", exc)
                _fail(row.id)
                return
            went = _encode(command, seconds, source.stat().st_size, stop)
            if stop.is_set():
                # Its attachment was deleted, or the server is stopping (then it waits again at the next start).
                logger.info("A conversion stopped")
                return
            if not went:
                logger.warning("A conversion did not go through")
                _fail(row.id)
                return
            try:
                after = media_tools.probe(target, "mov")
            except media_tools.MediaError:
                _fail(row.id)
                return
            if after.video is None or after.video.codec != "h264" or after.places or after.video.hdr:
                _fail(row.id)
                return
            new_meta = {**meta, "codec": "h264", "container": "mp4", "plain_size": target.stat().st_size,
                        "seconds": round(after.duration, 2) if after.duration is not None else meta.get("seconds"),
                        "audio_codec": after.audio.codec if after.audio is not None else None}
            if after.video.width and after.video.height:
                new_meta["width"], new_meta["height"] = after.video.width, after.video.height
            new_id = secrets.token_hex(16)
            size = sealed_file.write(target, attachments.file_path(new_id), dek,
                                     attachments.file_label(row.user_id, row.uid, new_id))
        sealed = attachments.seal_meta(row.user_id, dek, row.uid, new_meta)
        growth = size + len(sealed) - row.size - len(row.meta_enc)
        with SessionLocal() as db:
            limit = quota.limit_bytes(db)
            changed = db.execute(
                text("UPDATE attachments SET file_id = :new, size = :size, meta_enc = :meta, status = 'ready', "  # noqa: S608 - constants
                     "queued_at = NULL WHERE id = :id AND status = 'converting' AND file_id = :old "
                     f"AND (:quota IS NULL OR :growth <= 0 OR {quota.USED} + :growth <= :quota)"),
                {"new": new_id, "size": size, "meta": sealed, "id": row.id, "old": row.file_id, "user": row.user_id,
                 "quota": limit, "growth": growth},
            )
            db.commit()
        if changed.rowcount != 1:
            attachments.remove_disk_files([new_id])
            # Still there and converting: the storage did not hold it. Deleted meanwhile: nothing to say.
            _fail(row.id)
            return
        attachments.remove_disk_files([row.file_id])
        took = round(time.monotonic() - started)
        with SessionLocal() as db:
            settings_service.save(db, {"attachment_convert_last": {"seconds_video": round(seconds, 1),
                                                                   "seconds_took": took}})
        logger.info("A video was converted seconds=%s took=%s", round(seconds), took)
    finally:
        with _lock:
            _current = None


# --- The worker -----------------------------------------------------------------------------------------------------


def _loop() -> None:
    while not _stop.is_set():
        try:
            if run_next():
                continue
        except Exception:
            logger.exception("The conversion worker failed")
        _wake.wait(POLL_SECONDS)
        _wake.clear()


def start() -> None:
    """At the start of the server: what was converting waits again, and the worker begins."""
    global _thread
    recover()
    _stop.clear()
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, name="nexdiary-conversions", daemon=True)
    _thread.start()


def stop(seconds: float = 10) -> None:
    """At the end: a running conversion stops (it waits again at the next start)."""
    global _thread
    _stop.set()
    _wake.set()
    with _lock:
        if _current is not None:
            _current["cancel"].set()
    if _thread is not None:
        _thread.join(timeout=seconds)
        _thread = None


def wake() -> None:
    _wake.set()


def forget() -> None:
    """For the tests."""
    global _current
    with _lock:
        _current = None
