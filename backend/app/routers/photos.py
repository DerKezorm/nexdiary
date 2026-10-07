"""Photos over HTTP, each only for the person who took them (``services/photos.py``).

A photo of somebody else answers 404, exactly like one that does not exist. The pictures go out through these routes
only, never as static files: with a fixed type, ``nosniff`` (``middleware``), kept by the browser alone
(``private``), never by a proxy in between.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from ..deps import Account, DbSession
from ..errors import error
from ..services import brakes, diary, photos, pictures, vault

router = APIRouter(prefix="/api", tags=["photos"])

#: A photo never changes under its id: a browser keeps it as long as it likes, but only for itself.
CACHE = "private, max-age=31536000, immutable"
MAX_MB = pictures.MAX_BYTES // (1024 * 1024)


@router.post("/photos", summary="Keep a photo of a day (the picture itself as the body)")
async def upload(
    request: Request,
    response: Response,
    account: Account,
    db: DbSession,
    upload_id: Annotated[str, Query(max_length=photos.UPLOAD_ID_LENGTH)],
    date: Annotated[str, Query(max_length=10)] = "",
    note: bool = False,
) -> dict[str, Any]:
    """With ``note`` the photo is for a note: it goes with the notes of the day, never with its photos."""
    key = diary.check_date(account, date) if date else diary.today_of(account).isoformat()
    upload = photos.check_upload_id(upload_id)
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
    photo, new = await run_in_threadpool(photos.add, db, account.id, dek, key, upload, drawn, diary.now(), note)
    response.status_code = 201 if new else 200
    return photo


@router.get("/photos", summary="The own photos of one day, oldest first")
def photos_of_day(account: Account, db: DbSession, date: Annotated[str, Query(max_length=10)]) -> list[dict[str, Any]]:
    return photos.list_of_day(db, account.id, diary.check_date(account, date))


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


@router.delete("/photos/{photo_id}", status_code=204, summary="Delete a photo and its files")
def delete_photo(photo_id: str, account: Account, db: DbSession) -> None:
    photos.remove(db, account.id, photos.check_id(photo_id))
