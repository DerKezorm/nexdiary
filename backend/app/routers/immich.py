"""Immich over HTTP (``services/immich.py``): the person's own link, the photos of a day, their small pictures, taking
one, and the operator's bolt.

Every route of a person uses only that person's own link, read here from the database: nothing the browser sends
names an Immich or a key, so nobody reaches the Immich of somebody else. The small pictures go out with a fixed type,
``nosniff`` (``middleware``) and kept by the browser alone for a little while, never by a proxy in between.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from ..deps import Account, DbSession, OperatorAccount
from ..services import diary, immich, vault

router = APIRouter(prefix="/api", tags=["immich"])

#: A small picture changes seldom; the browser keeps it a few minutes, for itself only.
THUMB_CACHE = "private, max-age=600"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LinkIn(Strict):
    url: str | None = Field(default=None, max_length=immich.URL_MAX)
    #: Empty or left out keeps the stored key, unless the address changes.
    key: str | None = Field(default=None, max_length=immich.KEY_MAX)
    suggest: bool | None = None


class TakeIn(Strict):
    date: str = Field(default="", max_length=10)
    #: For a note: the photo goes with the notes of the day, never with its photos.
    note: bool = False


class OperatorIn(Strict):
    allowed: bool | None = None
    hosts: list[Annotated[str, Field(max_length=immich.ENTRY_MAX)]] | None = Field(default=None,
                                                                                    max_length=immich.HOSTS_MAX * 2)


@router.get("/immich", summary="The own Immich: whether it may be used, connected, and what the card shows")
def state(account: Account, db: DbSession) -> dict[str, Any]:
    return immich.state(db, account.id, lambda: vault.dek_for(account.id))


@router.put("/immich", summary="Connect the own Immich, or change the link; only the fields sent change")
def save(payload: LinkIn, account: Account, db: DbSession) -> dict[str, Any]:
    return immich.save(db, account.id, vault.dek_for(account.id), url=payload.url, key=payload.key,
                       suggest=payload.suggest)


@router.delete("/immich", status_code=204, summary="Disconnect the own Immich; photos taken from it stay")
def disconnect(account: Account, db: DbSession) -> None:
    immich.disconnect(db, account.id)


@router.post("/immich/probe", summary="Whether the own Immich answers: its version and the photos of today")
def probe(account: Account, db: DbSession) -> dict[str, Any]:
    return immich.probe(db, account.id, vault.dek_for(account.id), diary.today_of(account).isoformat(),
                        diary.zone_of(account))


@router.get("/immich/photos", summary="The photos of one day in the own Immich, oldest first")
def photos_of_day(account: Account, db: DbSession,
                  date: Annotated[str, Query(max_length=10)] = "") -> dict[str, Any]:
    day = diary.check_date(account, date) if date else diary.today_of(account).isoformat()
    return immich.photos_of_day(db, account.id, vault.dek_for(account.id), day, diary.zone_of(account))


def _thumbnail(db: Any, account_id: int, asset: str) -> tuple[bytes, str]:
    return immich.thumbnail(db, account_id, vault.dek_for(account_id), asset)


@router.get("/immich/photos/{asset}/thumbnail", summary="The small picture of a photo in the own Immich")
async def thumbnail(asset: str, account: Account, db: DbSession) -> Response:
    """A page asks for a day's small pictures at once: they wait in line here, a few at a time per person, without
    holding a thread while they wait."""
    asset = immich.check_asset(asset)
    async with immich.waiting(account.id):
        data, media_type = await run_in_threadpool(_thumbnail, db, account.id, asset)
    return Response(data, media_type=media_type, headers={"Cache-Control": THUMB_CACHE,
                                                          "Content-Disposition": "inline"})


@router.post("/immich/photos/{asset}", summary="Take a photo of the own Immich for a day: it is copied now")
def take(asset: str, payload: TakeIn, response: Response, account: Account, db: DbSession) -> dict[str, Any]:
    day = diary.check_date(account, payload.date) if payload.date else diary.today_of(account).isoformat()
    photo, new = immich.take(db, account.id, vault.dek_for(account.id), immich.check_asset(asset), day,
                             diary.zone_of(account), diary.now(), payload.note)
    response.status_code = 201 if new else 200
    return photo


# --- The operator ---------------------------------------------------------------------------------------------------


@router.get("/settings/immich", summary="Whether Immich may be used here, on which hosts, and how many connected")
def operator_view(_operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return immich.operator_view(db)


@router.put("/settings/immich", summary="Open or close Immich, and the hosts it may be reached on")
def operator_save(payload: OperatorIn, _operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return immich.operator_save(db, allowed=payload.allowed, hosts=payload.hosts)
