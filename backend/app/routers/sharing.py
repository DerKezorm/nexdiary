"""The journal and sharing over HTTP.

* ``/api/journal``: the own days page by page, and the tags over all of them.
* ``/api/people``: whom a day can be shared with (name, shown name, picture; nothing else).
* ``/api/days/{date}/shares``: who an own day is shared with; share it, end sharing it.
* ``/api/shares``: the own days shared with somebody.
* ``/api/shared``: the days others shared with the signed-in person, each one read only, its photos through the share,
  the heart.

Every rule of who sees what lives in ``services/sharing.py``. A day of somebody else that is not shared with the
signed-in person answers 404, exactly like one that does not exist; the operator has no way in.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from ..deps import Account, DbSession
from ..errors import error
from ..services import diary, journal, photos, sharing, vault

router = APIRouter(prefix="/api", tags=["journal and sharing"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ShareIn(Strict):
    #: The accounts that see the day from now on; everybody else no longer does. Empty: shared with nobody.
    #: Account ids as whole numbers, nothing that only looks like one (``true``, ``"3"``, ``3.0``).
    to: list[StrictInt] = Field(max_length=sharing.RECIPIENTS_MAX)
    with_values: bool = False
    with_notes: bool = False


def _owner_id(value: str) -> int:
    """The id of the person a shared day comes from, in an address: one that cannot exist is not found."""
    if not value.isascii() or not value.isdigit() or len(value) > 12 or value != str(int(value)):
        raise error("not_found", "Not found.", 404)
    return int(value)


def _shared_date(value: str) -> str:
    """A date in the address of a shared day. Not held to the viewer's own calendar (the owner may live a day
    ahead); one that is not a date is not found."""
    if not isinstance(value, str) or not diary.DATE_PATTERN.match(value):
        raise error("not_found", "Not found.", 404)
    return value


# --- The journal ----------------------------------------------------------------------------------------------------


class JournalIn(Strict):
    #: The page before this date (empty: from the newest day).
    before: str = Field(default="", max_length=10)
    limit: int = Field(default=24, ge=1, le=journal.PAGE_MAX)
    #: Only the days with this tag (empty: all). In the body, not in the address: tags are sealed like the text, and an
    #: address ends up in proxy logs and the browser's history.
    tag: str = Field(default="", max_length=diary.TAG_MAX * 4)
    #: Only the days of this year (the volume opened on the shelf); left out: all years.
    year: int | None = Field(default=None, ge=diary.EARLIEST.year, le=9999)


@router.post("/journal", summary="The own days page by page, newest first, for the journal")
def journal_page(payload: JournalIn, account: Account, db: DbSession) -> dict[str, Any]:
    if payload.before:
        diary.check_date(account, payload.before)
    # A tag that is nothing once cleaned (spaces, a lone #, control characters) filters nothing.
    cleaned = diary.clean_tags([payload.tag])
    wanted = cleaned[0] if cleaned else None
    return journal.page(db, account.id, vault.dek_for(account.id), before=payload.before or None, limit=payload.limit,
                        tag=wanted, year=payload.year)


@router.get("/journal/overview", summary="How many own days there are, since when, their tags and the volumes per year")
def journal_overview(account: Account, db: DbSession) -> dict[str, Any]:
    # The year of today in the person's time zone: the volume that is still being written.
    return {**journal.overview(db, account.id, vault.dek_for(account.id)), "year": diary.today_of(account).year}


# --- Sharing: the owner ---------------------------------------------------------------------------------------------


@router.get("/people", summary="The other people on this server a day can be shared with")
def people(account: Account, db: DbSession) -> list[dict[str, Any]]:
    return sharing.people(db, account.id)


@router.get("/days/{date}/shares", summary="Who an own day is shared with, and what they see")
def shares_of_day(date: str, account: Account, db: DbSession) -> dict[str, Any]:
    return sharing.shares_of_day(db, account.id, diary.check_date(account, date))


@router.put("/days/{date}/shares", summary="Share an own day with exactly these people")
def share_day(date: str, payload: ShareIn, account: Account, db: DbSession) -> dict[str, Any]:
    key = diary.check_date(account, date)
    return sharing.share_day(db, account.id, key, payload.to, payload.with_values, payload.with_notes)


@router.delete("/days/{date}/shares", status_code=204, summary="Nobody sees this own day any more")
def stop_sharing(date: str, account: Account, db: DbSession) -> None:
    sharing.stop_sharing(db, account.id, diary.check_date(account, date))


@router.get("/shares", summary="The own days shared with somebody, newest first")
def shared_by_me(account: Account, db: DbSession) -> list[dict[str, Any]]:
    return sharing.shared_by_me(db, account.id, vault.dek_for(account.id))


# --- Sharing: the person a day is shared with -----------------------------------------------------------------------


@router.get("/shared", summary="The days others shared with me, newest first")
def shared_with_me(account: Account, db: DbSession) -> list[dict[str, Any]]:
    return sharing.shared_with_me(db, account.id)


@router.get("/shared/count", summary="How many days shared with me are new")
def shared_count(account: Account, db: DbSession) -> dict[str, int]:
    return {"new": sharing.unseen_count(db, account.id)}


@router.get("/shared/{owner}/{date}", summary="A day somebody shared with me, read only")
def shared_day(owner: str, date: str, account: Account, db: DbSession) -> dict[str, Any]:
    return sharing.shared_day(db, account.id, _owner_id(owner), _shared_date(date))


@router.post("/shared/{owner}/{date}/seen", status_code=204, summary="Mark a day shared with me as opened")
def shared_seen(owner: str, date: str, account: Account, db: DbSession) -> None:
    sharing.mark_seen(db, account.id, _owner_id(owner), _shared_date(date))


@router.put("/shared/{owner}/{date}/heart", summary="Send a heart for a day shared with me")
def heart(owner: str, date: str, account: Account, db: DbSession) -> dict[str, Any]:
    return sharing.set_heart(db, account.id, _owner_id(owner), _shared_date(date), True)


@router.delete("/shared/{owner}/{date}/heart", summary="Take the heart back")
def unheart(owner: str, date: str, account: Account, db: DbSession) -> dict[str, Any]:
    return sharing.set_heart(db, account.id, _owner_id(owner), _shared_date(date), False)


def _picture(account: Any, db: Any, owner: str, date: str, photo_id: str, preview: bool) -> Response:
    data = sharing.shared_photo(db, account.id, _owner_id(owner), _shared_date(date), photos.check_id(photo_id),
                                preview)
    # Not kept by the browser: a share taken back must not leave its pictures in the cache of the one it was for.
    return Response(data, media_type="image/webp", headers={"Cache-Control": "private, no-store",
                                                            "Content-Disposition": "inline"})


@router.get("/shared/{owner}/{date}/photos/{photo_id}", summary="A photo of a day shared with me")
def shared_photo(owner: str, date: str, photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, owner, date, photo_id, preview=False)


@router.get("/shared/{owner}/{date}/photos/{photo_id}/preview", summary="The smaller copy of such a photo")
def shared_preview(owner: str, date: str, photo_id: str, account: Account, db: DbSession) -> Response:
    return _picture(account, db, owner, date, photo_id, preview=True)
