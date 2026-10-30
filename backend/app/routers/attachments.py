"""Attachments over HTTP, each only for the person whose day it belongs to (``services/attachments.py``), and the
operator's settings for them.

An attachment of somebody else answers 404, exactly like one that does not exist. Files go out through these routes
only, never as static files: in pieces as the browser asks for them (``Range``), with a fixed type, ``nosniff``
(``middleware``), ``Content-Security-Policy: sandbox`` (a file opened on its own can run nothing), a PDF always as a
download (the browser never shows one itself; the interface reads it with pdf.js).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..services import (
    attachments,
    brakes,
    conversions,
    diary,
    media_tools,
    photos,
    quota,
    sealed_file,
    settings_service,
    vault,
)

router = APIRouter(prefix="/api", tags=["attachments"])

#: An attachment's file can change under its id (a conversion): the browser keeps it, but asks again each time.
CACHE = "private, no-cache"
#: A still never changes under its id.
PREVIEW_CACHE = "private, max-age=31536000, immutable"


class LinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str | None = Field(default=None, max_length=10)
    url: str = Field(max_length=attachments.URL_MAX * 4)
    title: str | None = Field(default=None, max_length=attachments.TITLE_MAX * 4)
    upload_id: str = Field(max_length=photos.UPLOAD_ID_LENGTH)


class AdminIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_max_mb: int | None = Field(default=None, ge=1, le=attachments.VIDEO_MAX_MB)
    other_max_mb: int | None = Field(default=None, ge=1, le=attachments.OTHER_MAX_MB)
    convert: bool | None = None


def _day_of(account: Any, date: str | None) -> str:
    return diary.check_date(account, date) if date else diary.note_day(account).isoformat()


def _busy() -> Exception:
    exc = error("busy", "The server is busy. Try again in a moment.", 503)
    exc.headers = {"Retry-After": "5"}
    return exc


@router.post("/attachments", summary="Attach a video, a sound or a PDF to a day (the file itself as the body)")
async def upload(
    request: Request,
    response: Response,
    account: Account,
    db: DbSession,
    upload_id: Annotated[str, Query(max_length=photos.UPLOAD_ID_LENGTH)],
    kind: Annotated[str, Query(max_length=8)],
    date: Annotated[str, Query(max_length=10)] = "",
    name: Annotated[str, Query(max_length=1000)] = "",
) -> dict[str, Any]:
    """What the file is, the server decides from its contents; it must be the ``kind`` the person meant. The same
    ``upload_id`` again answers with the attachment that stands (200)."""
    if kind not in attachments.FILE_KINDS:
        raise error("invalid_input", "The input is not valid.", 422, fields=["kind"])
    key = _day_of(account, date)
    upload = photos.check_upload_id(upload_id)
    dek = vault.dek_for(account.id)
    found = attachments.by_upload(db, account.id, dek, upload)
    if found is not None:
        response.status_code = 200
        return found
    # A locked day takes nothing, said before a byte of the body is read.
    diary.ensure_open(db, account.id, key)
    brakes.take("attachment", account.id)
    if kind in ("video", "audio") and not media_tools.available():
        raise attachments.not_supported()
    limit_mb = attachments.max_mb(db, kind)
    limit = limit_mb * attachments.MB
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit():
        if int(declared) > limit:
            raise error("attachment_too_large", "The file is too large.", 413, max_mb=limit_mb)
        allowed = quota.limit_bytes(db)
        if allowed is not None and quota.used(db, account.id) + int(declared) > allowed:
            raise quota.full(db)
    try:
        with attachments.admitted(account.id), photos.writing(), attachments.work_folder() as work:
            body = work / "in"
            await attachments.receive(request.stream(), body, limit)
            prepared = await run_in_threadpool(attachments.prepare, work, body, kind)
            item, new = await run_in_threadpool(
                lambda: attachments.add(db, account.id, dek, key, upload, name, prepared, diary.now()))
    except attachments.TooLarge as exc:
        raise error("attachment_too_large", "The file is too large.", 413, max_mb=limit_mb) from exc
    except attachments.Busy as exc:
        raise _busy() from exc
    except attachments.Stalled as exc:
        raise error("upload_stalled", "The upload stopped coming. Try again.", 408) from exc
    response.status_code = 201 if new else 200
    return item


@router.post("/attachments/link", summary="Attach a link to a day: its address and a title, nothing fetched")
def add_link(payload: LinkIn, response: Response, account: Account, db: DbSession) -> dict[str, Any]:
    key = _day_of(account, payload.date)
    upload = photos.check_upload_id(payload.upload_id)
    url, title = attachments.check_link(payload.url, payload.title)
    dek = vault.dek_for(account.id)
    found = attachments.by_upload(db, account.id, dek, upload)
    if found is not None:
        response.status_code = 200
        return found
    diary.ensure_open(db, account.id, key)
    brakes.take("attachment", account.id)
    item, new = attachments.add_link(db, account.id, dek, key, upload, url, title, diary.now())
    response.status_code = 201 if new else 200
    return item


@router.get("/attachments", summary="The attachments of one day, oldest first")
def of_day(account: Account, db: DbSession, date: Annotated[str, Query(max_length=10)]) -> dict[str, Any]:
    key = diary.check_date(account, date)
    return {"attachments": attachments.list_of_day(db, account.id, vault.dek_for(account.id), key)}


# The routes with a fixed name come before the one with an id, which would take the name for an id.


@router.get("/attachments/library", summary="All own attachments, newest or largest first; a page at a time")
def library(
    account: Account,
    db: DbSession,
    kind: Literal["video", "audio", "pdf", "link"] | None = None,
    order: Literal["new", "size"] = "new",
    before: Annotated[str, Query(max_length=80)] = "",
    limit: Annotated[int, Query(ge=1, le=attachments.LIBRARY_MAX)] = attachments.LIBRARY_DEFAULT,
) -> dict[str, Any]:
    return attachments.library(db, account.id, vault.dek_for(account.id), kind=kind, order=order,
                               before=before or None, limit=limit)


@router.get("/attachments/limits", summary="How large a file may be, and whether videos and sounds are taken at all")
def limits(_account: Account, db: DbSession) -> dict[str, Any]:
    """For every signed-in person, so that the interface can say it before an upload and hide video and recording
    where the server has no ffmpeg."""
    chosen = attachments.operator_settings(db)
    return {"video_max_mb": chosen["video_max_mb"], "other_max_mb": chosen["other_max_mb"],
            "ffmpeg": media_tools.available()}


def stream(request: Request, opened: attachments.Opened, *, download: bool, cache: str) -> Response:
    """The file as the browser asks for it: whole (200) or the one range of ``Range`` (206), piece by piece; a range
    that cannot be served answers 416. Nothing is held whole in memory."""
    reader = opened.reader
    size = reader.size
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": cache,
        "Content-Disposition": attachments.content_disposition(opened.filename,
                                                               download or opened.kind == "pdf"),
        "Content-Security-Policy": "sandbox",
        "ETag": opened.etag,
    }
    if request.headers.get("if-none-match") == opened.etag:
        reader.close()
        return Response(status_code=304, headers=headers)
    asked = request.headers.get("range")
    condition = request.headers.get("if-range")
    if condition is not None and condition != opened.etag:
        # The file changed since the browser had its first part: the whole of the new one.
        asked = None
    try:
        span = attachments.parse_range(asked, size)
    except attachments.RangeInvalid:
        reader.close()
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    if span is None:
        first, last, status = 0, size - 1, 200
    else:
        (first, last), status = span, 206
        headers["Content-Range"] = f"bytes {first}-{last}/{size}"
    headers["Content-Length"] = str(last - first + 1 if size else 0)

    def pieces() -> Iterator[bytes]:
        try:
            yield from reader.iter_range(first, last)
        finally:
            reader.close()

    return StreamingResponse(pieces(), status_code=status, media_type=opened.content_type, headers=headers)


def still(opened: attachments.Opened, cache: str) -> Response:
    try:
        data = opened.reader.read_all()
    except sealed_file.SealedFileError as exc:
        raise error("not_found", "Not found.", 404) from exc
    finally:
        opened.reader.close()
    return Response(data, media_type="image/webp", headers={"Cache-Control": cache, "Content-Disposition": "inline",
                                                            "Content-Security-Policy": "sandbox"})


@router.get("/attachments/{attachment_id}", summary="The file of an own attachment (ranges as the browser asks)")
def attachment_file(attachment_id: str, request: Request, account: Account, db: DbSession,
                    download: bool = False) -> Response:
    opened = attachments.open_file(db, account.id, vault.dek_for(account.id), attachments.check_id(attachment_id),
                                   preview=False)
    return stream(request, opened, download=download, cache=CACHE)


@router.get("/attachments/{attachment_id}/preview", summary="The still of an own video")
def attachment_preview(attachment_id: str, account: Account, db: DbSession) -> Response:
    opened = attachments.open_file(db, account.id, vault.dek_for(account.id), attachments.check_id(attachment_id),
                                   preview=True)
    return still(opened, PREVIEW_CACHE)


@router.delete("/attachments/{attachment_id}", status_code=204, summary="Delete an own attachment and its files")
def delete_attachment(attachment_id: str, account: Account, db: DbSession) -> None:
    attachments.remove(db, account.id, attachments.check_id(attachment_id))


@router.post("/attachments/{attachment_id}/convert", status_code=202,
             summary="Have an own video in HEVC turned into H.264, so that it plays everywhere")
def convert(attachment_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    return conversions.request(db, account.id, vault.dek_for(account.id), attachments.check_id(attachment_id))


# --- The operator ---------------------------------------------------------------------------------------------------


def _admin_view(db: Any) -> dict[str, Any]:
    chosen = attachments.operator_settings(db)
    last = settings_service.get(db, "attachment_convert_last")
    return {**chosen, "ffmpeg": media_tools.available(),
            "queue": {"waiting": conversions.waiting(), "running": conversions.running(),
                      "last": last if isinstance(last, dict) else None}}


@router.get("/admin/attachments", summary="The operator's settings for attachments, and the queue of conversions")
def admin_read(_operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return _admin_view(db)


@router.put("/admin/attachments", summary="Change the operator's settings for attachments; only the fields sent")
def admin_save(payload: AdminIn, _operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    if payload.video_max_mb is not None:
        changes["attachment_video_max_mb"] = payload.video_max_mb
    if payload.other_max_mb is not None:
        changes["attachment_other_max_mb"] = payload.other_max_mb
    if payload.convert is not None:
        changes["attachment_convert"] = payload.convert
    if changes:
        settings_service.save(db, changes)
    if payload.convert:
        # What waited while the switch was off begins now.
        conversions.wake()
    return _admin_view(db)
