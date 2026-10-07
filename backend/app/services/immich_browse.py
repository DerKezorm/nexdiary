"""The whole collection of a person's own Immich, not only one day of it.

A person may pick any photo of their own Immich for a day: a timeline (newest first, one page at a time, with a day or
a month to jump to), the albums (they need ``album.read``; without it the albums are left out with a word and
everything else works), a search (Immich's smart search, else its search by description, place and file name) and what
was uploaded lately (Immich often receives a phone's photos hours late, so "new" means uploaded, not taken).

Every one of these is a request of the person's own link through ``immich`` and so through ``outbound``: the operator's
bolt and host list are asked again, the address is resolved once and pinned, there is a deadline and a size limit.
A search word travels in the body of a request and is in no address and no log. A photo taken this way belongs to the
day it is taken for, whenever it was shot (``immich.take(..., anywhen=True)``).
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta, tzinfo
from datetime import time as daytime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..errors import error
from . import brakes, photos
from .immich import (
    ASSET_ID,
    DAY_PURPOSE,
    _get_json,
    _moment,
    _usable,
    asset_key,
    fail,
)

#: Needed only for the list of albums.
ALBUM_PERMISSION = "album.read"
#: Photos on one page of the timeline, an album or a search; the albums listed; the photos uploaded lately.
PAGE = 60
PAGES_MAX = 2000
ALBUMS_MAX = 200
SEARCH_WORD_MAX = 100
RECENT_HOURS = 48
RECENT_MAX = 30
RECENT_FETCH = 100
#: Fields of Immich's metadata search that stand in for the smart search where it is not there.
METADATA_FIELDS = ("description", "city", "originalFileName")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

Entry = tuple[str, datetime, Any]


def any_still(item: Any) -> tuple[str, datetime] | None:
    """A photo of Immich that may be offered whenever it was taken: a still picture, not in the bin, not hidden (the
    motion of a live photo) and not locked away. Its id and when it was taken."""
    if not isinstance(item, dict):
        return None
    asset = str(item.get("id") or "").lower()
    if not ASSET_ID.match(asset) or item.get("type") != "IMAGE" or item.get("isTrashed"):
        return None
    if item.get("visibility") in ("hidden", "locked"):
        return None
    taken = _moment(item.get("fileCreatedAt"))
    return (asset, taken) if taken is not None else None


def _page_of(data: Any) -> tuple[list[Entry], int | None]:
    """The photos and the number of the next page out of an answer of Immich's search; ``immich_unreadable`` for any
    other shape. The third part of each entry is the item itself (for the time it was uploaded)."""
    assets = data.get("assets") if isinstance(data, dict) else None
    items = assets.get("items") if isinstance(assets, dict) else None
    if not isinstance(items, list):
        raise fail("immich_unreadable", 502)
    found: list[Entry] = []
    seen: set[str] = set()
    for item in items[: PAGE * 2]:
        still = any_still(item)
        if still is not None and still[0] not in seen:
            seen.add(still[0])
            found.append((still[0], still[1], item))
    following = assets.get("nextPage")
    try:
        number = int(following) if following not in (None, "") else None
    except (TypeError, ValueError):
        number = None
    return found, number


def check_page(page: int) -> int:
    if type(page) is not int or not 1 <= page <= PAGES_MAX:
        raise error("invalid_input", "The input is not valid.", 422, fields=["page"])
    return page


def _until(value: str, zone: tzinfo) -> datetime | None:
    """The end of a day (``YYYY-MM-DD``) or of a month (``YYYY-MM``) in the person's zone, as a moment in UTC: the
    timeline starts with the photos taken before it. Empty: from the newest on."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        if re.fullmatch(r"\d{4}-\d{2}", value):
            first = date.fromisoformat(value + "-01")
            following = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            following = date.fromisoformat(value) + timedelta(days=1)
        else:
            raise ValueError(value)
        if following.year < 1900 or following.year > 2200:
            raise ValueError(value)
    except ValueError as exc:
        raise fail("immich_until_invalid") from exc
    return datetime.combine(following, daytime.min, tzinfo=zone).astimezone(UTC)


def _listing(db: Session, account_id: int, link: Any, body: dict[str, Any], what: str,
             path: str = "metadata") -> tuple[list[Entry], int | None]:
    data = _get_json(db, account_id, link, "POST", f"/api/search/{path}", what, json=body)
    return _page_of(data)


def _entries(found: list[Entry]) -> list[dict[str, str]]:
    return [{"id": asset, "taken_at": moment.isoformat()} for asset, moment, _item in found[:PAGE]]


def timeline(db: Session, account_id: int, dek: bytes, zone: tzinfo, *, until: str, page: int) -> dict[str, Any]:
    """The person's whole collection, newest first, one page at a time; with ``until`` (a day or a month) it starts
    with the photos taken up to the end of it."""
    link = _usable(db, account_id, dek)
    page = check_page(page)
    ended = _until(until, zone)
    brakes.take("immich_browse", account_id)
    body: dict[str, Any] = {"type": "IMAGE", "size": PAGE, "page": page, "order": "desc", "withExif": False,
                            "withDeleted": False}
    if ended is not None:
        body["takenBefore"] = ended.isoformat().replace("+00:00", "Z")
    found, following = _listing(db, account_id, link, body, "timeline")
    return {"photos": _entries(found), "next": following}


def recent(db: Session, account_id: int, dek: bytes, day: str, moment: datetime) -> dict[str, Any]:
    """What was uploaded lately, newest upload first (``RECENT_HOURS``, at most ``RECENT_MAX``), each with when it was
    taken and the photo taken from it for ``day``, if one was."""
    link = _usable(db, account_id, dek)
    brakes.take("immich_browse", account_id)
    since = (moment - timedelta(hours=RECENT_HOURS)).astimezone(UTC)
    body = {"type": "IMAGE", "size": RECENT_FETCH, "page": 1, "order": "desc", "withExif": False,
            "withDeleted": False, "createdAfter": since.isoformat().replace("+00:00", "Z")}
    found, following = _listing(db, account_id, link, body, "recent")

    def uploaded(entry: Entry) -> datetime:
        stamp = _moment(entry[2].get("createdAt") if isinstance(entry[2], dict) else None)
        return stamp or entry[1]

    found.sort(key=uploaded, reverse=True)
    chosen = found[:RECENT_MAX]
    keys = {asset: asset_key(dek, asset, day, DAY_PURPOSE) for asset, _taken, _item in chosen}
    taken = photos.taken_from_immich(db, account_id, keys.values())
    return {
        "date": day,
        "photos": [{"id": entry[0], "taken_at": entry[1].isoformat(), "uploaded_at": uploaded(entry).isoformat(),
                    "photo_id": taken.get(keys[entry[0]])} for entry in chosen],
        "more": bool(following) or len(found) > RECENT_MAX,
    }


def albums(db: Session, account_id: int, dek: bytes) -> dict[str, Any]:
    """The person's albums. ``available: false`` when the key lacks ``album.read`` (everything else still works): the
    interface leaves the albums out and says why."""
    link = _usable(db, account_id, dek)
    brakes.take("immich_browse", account_id)
    try:
        data = _get_json(db, account_id, link, "GET", "/api/albums", "albums")
    except HTTPException as exc:
        if isinstance(exc.detail, dict) and exc.detail.get("code") == "immich_permission":
            return {"available": False, "needed": ALBUM_PERMISSION, "albums": []}
        raise
    if not isinstance(data, list):
        raise fail("immich_unreadable", 502)
    out: list[dict[str, Any]] = []
    for item in data[:ALBUMS_MAX]:
        if not isinstance(item, dict):
            continue
        album = str(item.get("id") or "").lower()
        if not ASSET_ID.match(album):
            continue
        name = " ".join(str(item.get("albumName") or "").split())[:120]
        count = item.get("assetCount")
        cover = str(item.get("albumThumbnailAssetId") or "").lower()
        out.append({"id": album, "name": name, "count": count if type(count) is int and count >= 0 else 0,
                    "cover": cover if ASSET_ID.match(cover) else None})
    return {"available": True, "albums": out}


def check_album(value: str) -> str:
    value = value.lower() if isinstance(value, str) else ""
    if not ASSET_ID.match(value):
        raise error("not_found", "Not found.", 404)
    return value


def album_photos(db: Session, account_id: int, dek: bytes, album: str, *, page: int) -> dict[str, Any]:
    """The photos of one album, newest first, one page at a time."""
    link = _usable(db, account_id, dek)
    page = check_page(page)
    wanted = check_album(album)
    brakes.take("immich_browse", account_id)
    body = {"type": "IMAGE", "size": PAGE, "page": page, "order": "desc", "withExif": False, "withDeleted": False,
            "albumIds": [wanted]}
    found, following = _listing(db, account_id, link, body, "album")
    return {"photos": _entries(found), "next": following}


def check_word(value: str) -> str:
    word = " ".join(_CONTROL.sub(" ", value or "").split())
    if not word:
        raise fail("immich_search_empty")
    if len(word) > SEARCH_WORD_MAX:
        raise error("search_too_long", "The text is too long.", 422, max=SEARCH_WORD_MAX)
    return word


def search(db: Session, account_id: int, dek: bytes, word: str, *, page: int) -> dict[str, Any]:
    """The photos Immich finds for a word: its smart search (by what a photo shows), and where that is not there, its
    search by description, place and file name (one page). The word goes in the body of the request and nowhere else,
    and is never logged."""
    link = _usable(db, account_id, dek)
    word = check_word(word)
    page = check_page(page)
    brakes.take("immich_browse", account_id)
    try:
        found, following = _listing(db, account_id, link,
                                    {"query": word, "type": "IMAGE", "size": PAGE, "page": page, "withExif": False,
                                     "withDeleted": False}, "search", "smart")
        mode = "smart"
    except HTTPException as exc:
        # Switched off in Immich (or an Immich without it): the answer is an error of its own, not of the key.
        code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
        if code not in ("immich_not_found", "immich_failed"):
            raise
        mode = "metadata"
        found, following = [], None
        if page == 1:
            seen: set[str] = set()
            for name in METADATA_FIELDS:
                part, _more = _listing(db, account_id, link,
                                       {name: word, "type": "IMAGE", "size": PAGE, "page": 1, "order": "desc",
                                        "withExif": False, "withDeleted": False}, "search")
                for entry in part:
                    if entry[0] not in seen:
                        seen.add(entry[0])
                        found.append(entry)
            found.sort(key=lambda entry: entry[1], reverse=True)
    return {"photos": _entries(found), "next": following, "mode": mode}
