"""Photos over HTTP, each only for the person who took them (``services/photos.py``).

A photo of somebody else answers 404, exactly like one that does not exist. The pictures go out through these routes
only, never as static files: with a fixed type, ``nosniff`` (``middleware``), kept by the browser alone
(``private``), never by a proxy in between.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from ..deps import Account, DbSession
from ..errors import error
from ..services import brakes, diary, photos, pictures, vault

router = APIRouter(prefix="/api", tags=["photos"])

#: A photo never changes under its id: a browser keeps it as long as it likes, but only for itself.
CACHE = "private, max-age=31536000, immutable"
MAX_MB = pictures.MAX_BYTES // (1024 * 1024)


class DeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The photos to delete, each an id of an own photo; at most ``photos.DELETE_MAX``.
    ids: list[Annotated[str, Field(max_length=32)]] = Field(max_length=photos.DELETE_MAX)


@router.post("/photos", summary="Keep a photo of a day (the picture itself as the body)")
async def upload(
    request: Request,
    response: Response,
    account: Account,
    db: DbSession,
    upload_id: Annotated[str, Query(max_length=photos.UPLOAD_ID_LENGTH)],
    date: Annotated[str, Query(max_length=10)] = "",
    note: bool = False,
    text: bool = False,
) -> dict[str, Any]:
    """With ``note`` the photo is for a note: it goes with the notes of the day, never with its photos. With ``text``
    it is for a picture in the text of the page: it goes again when the page is saved and nothing holds it."""
    if note and text:
        raise error("invalid_input", "The input is not valid.", 422, fields=["text"])
    key = diary.check_date(account, date) if date else diary.note_day(account).isoformat()
    upload = photos.check_upload_id(upload_id)
    # A locked day takes no photo: said before a body is read or drawn.
    diary.ensure_open(db, account.id, key)
    brakes.take("upload", account.id)
    # A place first, then the body: no more bodies wait in memory than there are places.
    try:
        with pictures.admitted():
            data = await pictures.read_body(request)
            drawn = await run_in_threadpool(photos.draw, data)
    except pictures.PictureError as exc:
        if exc.reason == "size":
            raise error("photo_too_large", "The photo is too large.", 422, max_mb=MAX_MB) from exc
        raise error("photo_not_a_picture", "This is not a photo nexdiary takes.", 422) from exc
    dek = vault.dek_for(account.id)
    photo, new = await run_in_threadpool(lambda: photos.add(db, account.id, dek, key, upload, drawn, diary.now(), note,
                                                            for_text=text))
    response.status_code = 201 if new else 200
    return photo


@router.get("/photos", summary="The own photos of one day, oldest first")
def photos_of_day(account: Account, db: DbSession, date: Annotated[str, Query(max_length=10)]) -> list[dict[str, Any]]:
    return photos.list_of_day(db, account.id, diary.check_date(account, date))


# The routes with a fixed name come before the one with an id, which would take the name for an id.


@router.get("/photos/library", summary="All own photos, newest day first, each with what uses it; a page at a time")
def library(
    account: Account,
    db: DbSession,
    before: Annotated[str, Query(max_length=80)] = "",
    limit: Annotated[int, Query(ge=1, le=photos.LIBRARY_MAX)] = photos.LIBRARY_DEFAULT,
    unused: bool = False,
) -> dict[str, Any]:
    """``before`` is the ``next`` of the page before. ``unused``: only photos that are no cover, in no text and on no
    note; a page may then come back shorter than ``limit``, with ``next`` to go on."""
    return photos.library(db, account.id, vault.dek_for(account.id), before=before or None, limit=limit,
                          unused=unused)


@router.get("/photos/storage", summary="How much the own storage holds, the limit, and how many photos")
def storage(account: Account, db: DbSession) -> dict[str, Any]:
    return photos.storage(db, account.id)


@router.post("/photos/delete", summary="Delete several own photos; a locked day keeps its own")
def delete_many(payload: DeleteIn, account: Account, db: DbSession) -> dict[str, list[str]]:
    return photos.remove_many(db, account.id, vault.dek_for(account.id), payload.ids)


def _picture(account: Any, db: Any, photo_id: str, preview: bool) -> Response:
    uid = photos.check_id(photo_id)
    data = photos.read(db, account.id, vault.dek_for(account.id), uid, preview)
    return Response(data, media_type="image/webp", headers={"Cache-Control": CACHE,
                                                            "Content-Disposition": "inline"})


@router.get("/photos/{photo_id}", summary="A photo, for the person who took it")
def photo(photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, photo_id, preview=False)


@router.get("/photos/{photo_id}/preview", summary="The smaller copy of a photo, for lists")
def preview(photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, photo_id, preview=True)


@router.get("/photos/{photo_id}/uses", summary="What an own photo is used for: cover, text, notes; its day")
def uses(photo_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    return photos.uses(db, account.id, vault.dek_for(account.id), photos.check_id(photo_id))


@router.delete("/photos/{photo_id}", status_code=204, summary="Delete a photo, its files, and every place it shows")
def delete_photo(photo_id: str, account: Account, db: DbSession) -> None:
    """Its pictures leave the text of the page and of the draft, a cover it was goes back to the suggestion, notes
    lose it. ``day_locked`` when that would change a locked day."""
    photos.remove(db, account.id, vault.dek_for(account.id), photos.check_id(photo_id))
