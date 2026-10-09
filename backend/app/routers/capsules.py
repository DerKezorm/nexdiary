"""Time capsules over HTTP.

* ``/api/capsules``: the capsules for the signed-in person and the ones they sent; close a new one.
* ``/api/capsules/count``: how many opened for them and are not read yet.
* ``/api/capsules/photos``: a photo chosen for a capsule before it is closed (as many as the storage holds).
* ``/api/capsules/{id}``: one capsule, change it, take it back; mark it read; its photos.

Every rule of who sees what and when lives in ``services/capsules.py``. A capsule that is neither from nor for the
signed-in person answers 404, exactly like one that does not exist; the operator has no way in.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from starlette.concurrency import run_in_threadpool

from ..deps import Account, DbSession
from ..errors import error
from ..services import brakes, capsules, photos, pictures

router = APIRouter(prefix="/api", tags=["time capsules"])

MAX_MB = pictures.MAX_BYTES // (1024 * 1024)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CapsuleIn(Strict):
    #: Made by the browser (a UUID): "Verschließen" sent twice keeps one capsule.
    id: str = Field(max_length=36)
    #: The accounts it is for, the sender too when it is for them; account ids as whole numbers.
    to: list[StrictInt] = Field(max_length=capsules.RECIPIENTS_MAX)
    opens_on: str = Field(max_length=10)
    title: str = Field(max_length=capsules.TITLE_MAX * 4)
    text: str = Field(max_length=capsules.TEXT_MAX * 4)
    #: The photos chosen for it (``POST /api/capsules/photos``), in their order.
    photos: list[Annotated[str, Field(max_length=32)]] = Field(default_factory=list,
                                                                max_length=capsules.PHOTOS_PER_REQUEST)


class CapsuleChangeIn(Strict):
    #: The revision the change was made on: a capsule changed meanwhile is not overwritten.
    revision: StrictInt = Field(ge=0)
    to: list[StrictInt] = Field(max_length=capsules.RECIPIENTS_MAX)
    opens_on: str = Field(max_length=10)
    title: str = Field(max_length=capsules.TITLE_MAX * 4)
    text: str = Field(max_length=capsules.TEXT_MAX * 4)
    #: Sent: the photos it holds from now on, in their order, each one of its own or one chosen for it (``POST
    #: /api/capsules/photos``); an empty list: none. Not sent: they stay as they are.
    photos: list[Annotated[str, Field(max_length=32)]] | None = Field(default=None,
                                                                       max_length=capsules.PHOTOS_PER_REQUEST)


@router.get("/capsules", summary="The time capsules for me and the ones I sent")
def lists(account: Account, db: DbSession) -> dict[str, Any]:
    return capsules.lists(db, account)


@router.get("/capsules/count", summary="How many time capsules for me opened and are not read yet")
def count(account: Account, db: DbSession) -> dict[str, int]:
    return {"new": capsules.unread_count(db, account)}


@router.post("/capsules", summary="Close a new time capsule")
def create(payload: CapsuleIn, response: Response, account: Account, db: DbSession) -> dict[str, Any]:
    brakes.take("capsule", account.id)
    capsule, new = capsules.create(db, account, payload.id.lower(), payload.to, payload.opens_on, payload.title,
                                   payload.text, payload.photos)
    response.status_code = 201 if new else 200
    return capsule


@router.post("/capsules/photos", summary="A photo for a time capsule not closed yet (the picture itself as the body)")
async def upload(
    request: Request,
    response: Response,
    account: Account,
    db: DbSession,
    upload_id: Annotated[str, Query(max_length=photos.UPLOAD_ID_LENGTH)],
) -> dict[str, Any]:
    upload = photos.check_upload_id(upload_id)
    brakes.take("upload", account.id)
    try:
        with pictures.admitted():
            data = await pictures.read_body(request)
            drawn = await run_in_threadpool(photos.draw, data)
    except pictures.PictureError as exc:
        if exc.reason == "size":
            raise error("photo_too_large", "The photo is too large.", 422, max_mb=MAX_MB) from exc
        raise error("photo_not_a_picture", "This is not a photo nexdiary takes.", 422) from exc
    kept, new = await run_in_threadpool(lambda: capsules.add_upload(db, account, upload, drawn))
    response.status_code = 201 if new else 200
    return kept


@router.delete("/capsules/photos/{photo_id}", status_code=204,
               summary="A photo chosen for a time capsule that is not going to be closed with it")
def drop_upload(photo_id: str, account: Account, db: DbSession) -> None:
    capsules.drop_upload(db, account, capsules.check_uid(photo_id))


@router.get("/capsules/{capsule_id}", summary="One time capsule, as far as I may see it now")
def one(capsule_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    return capsules.one(db, account, capsules.check_uid(capsule_id))


@router.put("/capsules/{capsule_id}", summary="Change a time capsule I sent to others, before it opened")
def change(capsule_id: str, payload: CapsuleChangeIn, account: Account, db: DbSession) -> dict[str, Any]:
    brakes.take("capsule", account.id)
    chosen: Any = capsules.KEEP
    if "photos" in payload.model_fields_set:
        chosen = payload.photos or []
    return capsules.change(db, account, capsules.check_uid(capsule_id), payload.revision, payload.to,
                           payload.opens_on, payload.title, payload.text, chosen)


@router.delete("/capsules/{capsule_id}", status_code=204, summary="Take a time capsule back, before it opened")
def withdraw(capsule_id: str, account: Account, db: DbSession) -> None:
    brakes.take("capsule", account.id)
    capsules.withdraw(db, account, capsules.check_uid(capsule_id))


@router.post("/capsules/{capsule_id}/read", status_code=204, summary="Mark a time capsule for me as read")
def read(capsule_id: str, account: Account, db: DbSession) -> None:
    capsules.mark_read(db, account, capsules.check_uid(capsule_id))


def _picture(account: Any, db: Any, capsule_id: str, photo_id: str, preview: bool) -> Response:
    data = capsules.read_photo(db, account, capsules.check_uid(capsule_id), capsules.check_uid(photo_id), preview)
    # Not kept by the browser: a capsule taken back must leave nothing in the cache of the one it was for.
    return Response(data, media_type="image/webp", headers={"Cache-Control": "private, no-store",
                                                            "Content-Disposition": "inline"})


@router.get("/capsules/{capsule_id}/photos/{photo_id}", summary="A photo of a time capsule")
def photo(capsule_id: str, photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, capsule_id, photo_id, preview=False)


@router.get("/capsules/{capsule_id}/photos/{photo_id}/preview", summary="The smaller copy of that photo")
def preview(capsule_id: str, photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, capsule_id, photo_id, preview=True)
