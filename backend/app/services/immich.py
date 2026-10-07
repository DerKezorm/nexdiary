"""The photos of a day from a person's own Immich: shown as suggestions, copied only when taken.

* **The operator holds the bolt.** Immich is closed on a new server; the operator opens it and names the hosts that
  may be reached (one per line, with a port: only that port). Every request checks both again, not only the saving:
  a host the operator took off the list is not reached from the next request on.
* **Each person connects their own** Immich: address and API key, sealed with the person's data key in
  ``immich_links``. The key never goes back to the browser, never into the log; only the person's own requests use it,
  so a photo of somebody else's Immich cannot be asked for. The permissions a key needs: ``asset.read`` (the photos of
  a day), ``asset.view`` (their small pictures) and ``asset.download`` (the photo taken).
* **The address is a way into the own network** (SSRF): Immich lies there mostly, so private addresses are fine, but
  only the hosts allowed, resolved once and connected to exactly as checked, never link-local or a metadata service
  (``outbound``), no redirect followed, only http and https, a deadline for every request and its answer, answers read
  up to a size (JSON and pictures alike).
* **The browser never talks to Immich**: the small pictures come through nexdiary, checked to be pictures, with nothing
  kept on the server (not even in memory). Taking a photo fetches its original, draws it anew without anything but its
  pixels and seals it like an upload (``photos``); the same photo taken twice stays one, storage and brakes count.
  The photo keeps a keyed hash of where it came from, never Immich's own id.
* **Only still pictures.** Videos are left out (a diary keeps photos, and a video would need storage of a different
  size); of a live photo the picture is taken, its motion is a video of its own and left out with the others.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import logging
import re
import ssl
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta, tzinfo
from datetime import time as daytime
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, ImmichLink, utcnow
from . import brakes, outbound, photos, pictures, settings_service, vault

logger = logging.getLogger("nexdiary.immich")

#: For the tests: an ``httpx`` transport that stands in for Immich. The tests use a server of their own instead.
transport: httpx.BaseTransport | None = None
#: The clock for deadlines; the tests put their own in.
ticks: Callable[[], float] = time.monotonic

#: The photos of one day that are suggested, oldest first.
LIMIT = 60
#: Deadlines for the whole of a request, its answer read: a list, a small picture, an original (a large photo on a
#: slow line at home).
JSON_SECONDS = 10.0
THUMB_SECONDS = 10.0
ORIGINAL_SECONDS = 60.0
CONNECT_SECONDS = 5.0
#: What an answer may weigh: a list of 60 photos is some 100 KB; a small picture of Immich some 20 KB.
MAX_JSON = 4 * 1024 * 1024
MAX_THUMB = 2 * 1024 * 1024
#: Pixels of a small picture passed on to the browser: Immich makes them 250 pixels wide.
MAX_THUMB_PIXELS = 4096 * 4096
THUMB_KINDS = {"jpeg": "image/jpeg", "webp": "image/webp", "png": "image/png"}
#: Requests to any Immich at once on the server, and per person; a request waits that long for a place.
AT_ONCE = 8
PER_PERSON = 6
WAIT_SECONDS = 10.0
HOSTS_MAX = 50
ENTRY_MAX = 255
URL_MAX = 255
KEY_MAX = 200
EMAIL_MAX = 255
PERMISSIONS = ("asset.read", "asset.view", "asset.download")
DAY_PURPOSE = "day"
NOTE_PURPOSE = "note"

ASSET_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_KEY = re.compile(r"^[\x21-\x7e]+$")

#: The English sentences for whoever uses the API directly; the interface has its own.
MESSAGES = {
    "immich_closed": "Immich is not allowed on this server.",
    "immich_not_allowed": "Your operator has not allowed Immich for your account.",
    "immich_host_not_allowed": "This Immich is not among the addresses the operator allowed.",
    "immich_host_invalid": "This is not a host name or address.",
    "immich_host_refused": "This address is never reached.",
    "immich_too_many_hosts": "Too many addresses.",
    "immich_not_connected": "No Immich is connected.",
    "immich_suggest_off": "The photos of the day are switched off.",
    "immich_address_missing": "Give the address of your Immich.",
    "immich_address_invalid": "This is not an address of an Immich.",
    "immich_address_refused": "This address is never reached.",
    "immich_key_missing": "Give the API key of your Immich.",
    "immich_key_invalid": "This is not an API key.",
    "immich_unreachable": "The server cannot reach your Immich.",
    "immich_timeout": "Your Immich took too long.",
    "immich_redirect": "Your Immich answers with a redirect. Enter the address it leads to.",
    "immich_key_refused": "Your Immich refused the API key.",
    "immich_permission": "The API key lacks a permission: asset.read, asset.view and asset.download are needed.",
    "immich_not_found": "This is not the address of an Immich, or the photo is gone.",
    "immich_failed": "Your Immich answered with an error.",
    "immich_unreadable": "The answer of your Immich could not be read.",
    "immich_too_large": "The answer of your Immich is too large.",
    "immich_not_a_picture": "This photo is not a picture nexdiary takes.",
    "immich_other_day": "This photo was taken on another day.",
    "immich_busy": "Many photos are on their way right now. Try again in a moment.",
}


def fail(code: str, status: int = 422, **values: Any) -> HTTPException:
    return error(code, MESSAGES.get(code, "Immich did not work."), status, **values)


# --- What the operator allows ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Allowed:
    host: str
    port: int | None

    def __str__(self) -> str:
        shown = f"[{self.host}]" if ":" in self.host else self.host
        return shown if self.port is None else f"{shown}:{self.port}"


def normal_host(host: str) -> str:
    """A host as it is compared: an address literal in its one written form, a name in lower case and as ASCII.
    ``ValueError`` for anything that is neither."""
    host = (host or "").strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(outbound.ip_of(host))
    except ValueError:
        pass
    try:
        name = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("not a name") from exc
    if not name or len(name) > 253 or not all(_LABEL.match(label) for label in name.split(".")):
        raise ValueError("not a name")
    return name


def parse_entry(text: str) -> Allowed:
    """One line of the operator's list: ``host``, ``host:port``, ``[v6]:port`` or a whole address
    (``https://photos.example.com:2283``, the scheme is not part of it). ``ValueError`` for anything else."""
    text = text.strip()
    if not text or len(text) > ENTRY_MAX:
        raise ValueError("empty or too long")
    parts = urlsplit(text if "://" in text else "//" + text)
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("more than a host")
    if parts.hostname is None:
        raise ValueError("no host")
    port = parts.port  # ValueError when it is not a port
    return Allowed(normal_host(parts.hostname), port)


def allowed_list(values: dict[str, Any]) -> list[Allowed]:
    out: list[Allowed] = []
    for entry in values.get("immich_hosts") or []:
        try:
            out.append(parse_entry(str(entry)))
        except ValueError:
            continue
    return out


def is_allowed(host: str, port: int, entries: list[Allowed]) -> bool:
    return any(entry.host == host and (entry.port is None or entry.port == port) for entry in entries)


def operator_view(db: Session) -> dict[str, Any]:
    values = settings_service.get_all(db)
    return {
        "allowed": bool(values["immich_allowed"]),
        "hosts": [str(entry) for entry in allowed_list(values)],
        "connected": int(db.scalar(select(func.count()).select_from(ImmichLink)) or 0),
    }


def operator_save(db: Session, *, allowed: bool | None, hosts: list[str] | None) -> dict[str, Any]:
    """The bolt and the list; what is left out stays. An address that is never reached (a metadata service) is
    refused here already, and again at every request."""
    changes: dict[str, Any] = {}
    if allowed is not None:
        changes["immich_allowed"] = bool(allowed)
    if hosts is not None:
        kept: list[str] = []
        for line in hosts:
            if not line.strip():
                continue
            try:
                entry = parse_entry(line)
            except ValueError as exc:
                raise fail("immich_host_invalid", 422, entry=line.strip()[:80]) from exc
            try:
                literal = outbound.ip_of(entry.host)
            except ValueError:
                literal = None
            if literal is not None and outbound.never(literal):
                raise fail("immich_host_refused", 422, entry=str(entry))
            if str(entry) not in kept:
                kept.append(str(entry))
        if len(kept) > HOSTS_MAX:
            raise fail("immich_too_many_hosts", 422, max=HOSTS_MAX)
        changes["immich_hosts"] = kept
    settings_service.save(db, changes)
    logger.info("The operator changed Immich fields=%s", ",".join(sorted(changes)) or "nothing")
    return operator_view(db)


def open_for_all(db: Session) -> bool:
    return bool(settings_service.get(db, "immich_allowed"))


def allowed_for(db: Session, account_id: int) -> bool:
    """Whether the operator allows this account a connection to Immich (on from the start; single accounts can be
    taken out), on top of the switch for the whole server."""
    return bool(db.scalar(select(Account.immich_allowed).where(Account.id == account_id)))


def check_allowed(db: Session, account_id: int) -> None:
    """403 ``immich_not_allowed``; every route that reaches an Immich asks for the server first, then this."""
    if not allowed_for(db, account_id):
        raise fail("immich_not_allowed", 403)


# --- The person's link ----------------------------------------------------------------------------------------------


@dataclass
class Link:
    url: str
    key: str
    suggest: bool = True
    email: str = ""
    version: str = ""


def _aad(account_id: int) -> bytes:
    return vault.aad(account_id, "immich_links", "content", str(int(account_id)))


def load(db: Session, account_id: int, dek: bytes) -> Link | None:
    """The person's link, or None. One that does not open counts as none (and says so in the log)."""
    sealed = db.scalar(select(ImmichLink.content_enc).where(ImmichLink.user_id == account_id))
    if sealed is None:
        return None
    try:
        data = vault.open_json(dek, sealed, _aad(account_id))
        return Link(url=str(data["url"]), key=str(data["key"]), suggest=bool(data.get("suggest", True)),
                    email=str(data.get("email") or ""), version=str(data.get("version") or ""))
    except (vault.SealError, ValueError, KeyError, TypeError):
        logger.warning("A sealed value did not open table=immich_links")
        return None


def _store(db: Session, account_id: int, dek: bytes, link: Link) -> None:
    sealed = vault.seal_json(dek, asdict(link), _aad(account_id))
    db.execute(
        sqlite_insert(ImmichLink)
        .values(user_id=account_id, content_enc=sealed, updated_at=utcnow())
        .on_conflict_do_update(index_elements=[ImmichLink.user_id],
                               set_={"content_enc": sealed, "updated_at": utcnow()})
    )
    db.commit()


def disconnect(db: Session, account_id: int) -> None:
    db.execute(delete(ImmichLink).where(ImmichLink.user_id == account_id))
    db.commit()
    logger.info("A person disconnected Immich")


def state(db: Session, account_id: int, dek_of: Callable[[], bytes]) -> dict[str, Any]:
    """What the card of the person shows. With the bolt closed: only that, nothing of the link."""
    if not open_for_all(db):
        return {"allowed": False, "connected": False}
    if not allowed_for(db, account_id):
        # Nothing of the link: the operator took Immich from this account.
        return {"allowed": False, "connected": False, "account_blocked": True}
    link = load(db, account_id, dek_of())
    if link is None:
        return {"allowed": True, "connected": False, "url": "", "key_set": False, "suggest": True, "email": "",
                "version": ""}
    return {"allowed": True, "connected": True, "url": link.url, "key_set": bool(link.key), "suggest": link.suggest,
            "email": link.email, "version": link.version}


def check_url(url: str) -> str:
    """The address of an Immich, cleaned: http or https, a host, a port if one is written, no credentials, query or
    fragment, and no path but ``/api`` (dropped: the API lies there anyway). Immich answers at the root of its host;
    a path of one's choosing would only be a way to other things on the same host."""
    url = (url or "").strip()
    if not url:
        raise fail("immich_address_missing")
    if len(url) > URL_MAX:
        raise fail("immich_address_invalid")
    try:
        # A broken bracket ("http://[::1"), a name that changes under NFKC: Python refuses them with ValueError.
        parts = urlsplit(url)
        hostname = parts.hostname
        port = parts.port
    except ValueError as exc:
        raise fail("immich_address_invalid") from exc
    if parts.scheme.lower() not in ("http", "https") or not hostname or parts.username or parts.password:
        raise fail("immich_address_invalid")
    if parts.query or parts.fragment:
        raise fail("immich_address_invalid")
    try:
        host = normal_host(hostname)
    except ValueError as exc:
        raise fail("immich_address_invalid") from exc
    if parts.path.rstrip("/").lower() not in ("", "/api"):
        raise fail("immich_address_invalid")
    shown = f"[{host}]" if ":" in host else host
    return f"{parts.scheme.lower()}://{shown}{f':{port}' if port is not None else ''}"


def _clean_key(key: str) -> str:
    key = key.strip()
    if len(key) > KEY_MAX or not _KEY.match(key):
        raise fail("immich_key_invalid")
    return key


def save(db: Session, account_id: int, dek: bytes, *, url: str | None, key: str | None,
         suggest: bool | None) -> dict[str, Any]:
    """Keeps what was sent; left out stays. The address must be one the operator allows, and it is resolved and
    checked now already (every request checks again).

    ⚠️ The key belongs to the address it was given for: a new address without a new key forgets the old one, or a
    changed address would carry the stored key to whatever host it names."""
    if not open_for_all(db):
        raise fail("immich_closed", 403)
    check_allowed(db, account_id)
    current = load(db, account_id, dek)
    next_url = check_url(url) if url is not None else (current.url if current else "")
    if not next_url:
        raise fail("immich_address_missing")
    moved = current is None or next_url != current.url
    if key is not None and key.strip():
        next_key = _clean_key(key)
    else:
        next_key = "" if moved or current is None else current.key
    if not next_key:
        raise fail("immich_key_missing")
    _target(db, next_url, "/api/server/version")
    link = Link(
        url=next_url,
        key=next_key,
        suggest=(current.suggest if current else True) if suggest is None else bool(suggest),
        email="" if moved else (current.email if current else ""),
        version="" if moved else (current.version if current else ""),
    )
    _store(db, account_id, dek, link)
    logger.info("A person saved Immich fields=%s", ",".join(
        name for name, value in (("url", url), ("key", key), ("suggest", suggest)) if value is not None) or "nothing")
    return state(db, account_id, lambda: dek)


def _usable(db: Session, account_id: int, dek: bytes) -> Link:
    if not open_for_all(db):
        raise fail("immich_closed", 403)
    check_allowed(db, account_id)
    link = load(db, account_id, dek)
    if link is None or not link.key:
        raise fail("immich_not_connected", 409)
    return link


# --- Where a request goes -------------------------------------------------------------------------------------------


def _resolve(host: str, port: int) -> list[str]:
    return outbound.resolve(host, port)


#: Resolves a name to its addresses; the tests put their own in.
resolver: Callable[[str, int], list[str]] = _resolve


def _no_rule(_ip: Any) -> None:
    """Private and public alike: Immich lies in the own network mostly. What may be reached is the operator's list."""


def _target(db: Session, base: str, path: str) -> outbound.Target:
    """The address checked against the bolt and the operator's list as they stand now, then resolved once and pinned
    (``outbound.pin``)."""
    values = settings_service.get_all(db)
    if not values["immich_allowed"]:
        raise fail("immich_closed", 403)
    url = base + path
    parts = urlsplit(url)
    try:
        host = normal_host(parts.hostname or "")
        port = outbound.port_of(url)
    except ValueError as exc:
        raise fail("immich_address_invalid") from exc
    if parts.scheme not in ("http", "https"):
        raise fail("immich_address_invalid")
    if not is_allowed(host, port, allowed_list(values)):
        raise fail("immich_host_not_allowed", 403)
    try:
        return outbound.pin(url, resolver, _no_rule)
    except outbound.Refused as exc:
        raise fail("immich_address_refused") from exc
    except outbound.Unreachable as exc:
        raise fail("immich_unreachable", 502) from exc


_server_slots = threading.BoundedSemaphore(AT_ONCE)
_people: dict[int, int] = {}
_people_lock = threading.Lock()


@contextmanager
def _slot(account_id: int) -> Iterator[None]:
    """A place for one request: at most ``PER_PERSON`` of one person (a page with sixty small pictures) and
    ``AT_ONCE`` on the server; waited for a little, then the server says it is busy."""
    with _people_lock:
        if _people.get(account_id, 0) >= PER_PERSON:
            raise fail("immich_busy", 503)
        _people[account_id] = _people.get(account_id, 0) + 1
    try:
        if not _server_slots.acquire(timeout=WAIT_SECONDS):
            raise fail("immich_busy", 503)
        try:
            yield
        finally:
            _server_slots.release()
    finally:
        with _people_lock:
            _people[account_id] -= 1
            if _people[account_id] <= 0:
                del _people[account_id]


#: Small pictures of one person on their way at once; the others wait in line (``waiting``) without holding a thread.
THUMBS_AT_ONCE = 4
#: Small pictures of one person that may wait in line: a day's photos and a few more.
THUMBS_WAITING = LIMIT + 20
_lines: dict[int, tuple[asyncio.Semaphore, list[int]]] = {}


@asynccontextmanager
async def waiting(account_id: int) -> AsyncIterator[None]:
    """A place in the line of one person's small pictures: a page asks for sixty at once, and each would otherwise
    hold a thread of the server while it waits for Immich. ``immich_busy`` when the line is longer than a day."""
    line = _lines.get(account_id)
    if line is None:
        line = _lines[account_id] = (asyncio.Semaphore(THUMBS_AT_ONCE), [0])
    if line[1][0] >= THUMBS_WAITING:
        raise fail("immich_busy", 503)
    line[1][0] += 1
    try:
        async with line[0]:
            yield
    finally:
        line[1][0] -= 1
        if line[1][0] == 0 and _lines.get(account_id) is line:
            del _lines[account_id]


def forget() -> None:
    """For the tests."""
    with _people_lock:
        _people.clear()
    _lines.clear()


def _log(what: str, status: str, started: float) -> None:
    # What and how it ended, never the address, the key or a photo's id.
    logger.info("Immich %s status=%s seconds=%.1f", what, status, ticks() - started)


def _judge(answer: httpx.Response) -> None:
    status = answer.status_code
    if status == 200:
        return
    if 300 <= status < 400:
        raise fail("immich_redirect", 502)
    if status == 401:
        raise fail("immich_key_refused", 502)
    if status == 403:
        raise fail("immich_permission", 502, needed=list(PERMISSIONS))
    if status in (400, 404):
        # Immich answers 400 for a photo that is not the key's to read, 404 for an address that is not its API.
        raise fail("immich_not_found", 502)
    raise fail("immich_failed", 502, answered=status)


def _wants(kinds: tuple[str, ...]) -> Callable[[httpx.Response], None]:
    """Refuses an answer of 200 whose type is not one of ``kinds`` before its body is read."""

    def accept(answer: httpx.Response) -> None:
        if answer.status_code != 200:
            return
        kind = answer.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if not any(kind == wanted or (wanted.endswith("/") and kind.startswith(wanted)) for wanted in kinds):
            raise fail("immich_unreadable", 502)

    return accept


def _exchange(db: Session, account_id: int, link: Link, method: str, path: str, what: str, *, seconds: float,
              limit: int, accept: Callable[[httpx.Response], None] | None, **sent: Any) -> httpx.Response:
    """One request to the person's own Immich, with the person's own key, judged; every way it ends is logged
    without anything of the person."""
    place = _target(db, link.url, path)
    # No read transaction held while Immich answers.
    db.rollback()
    headers = {"x-api-key": link.key, "accept": "application/json" if limit == MAX_JSON else "image/*"}
    with _slot(account_id):
        started = ticks()
        try:
            with outbound.client(transport) as session:
                answer = outbound.send(session, method, place, headers, deadline=started + seconds, ticks=ticks,
                                       limit=limit, connect_seconds=CONNECT_SECONDS, accept=accept, **sent)
        except (outbound.Late, httpx.TimeoutException) as exc:
            _log(what, "timeout", started)
            raise fail("immich_timeout", 504) from exc
        except outbound.TooLarge as exc:
            _log(what, "too-large", started)
            raise fail("immich_too_large", 502) from exc
        except outbound.Refused as exc:
            _log(what, "unreadable", started)
            raise fail("immich_unreadable", 502) from exc
        except httpx.HTTPError as exc:
            if _certificate_refused(exc):
                # Checked, never switched off: a certificate the server does not trust (made by oneself) is said as
                # such, with the way out (http in the home network, or a valid certificate).
                _log(what, "tls", started)
                raise fail("immich_tls", 502) from exc
            _log(what, "unreachable", started)
            raise fail("immich_unreachable", 502) from exc
        except HTTPException as exc:
            _log(what, str(exc.detail.get("code") if isinstance(exc.detail, dict) else exc.status_code), started)
            raise
    try:
        _judge(answer)
    except HTTPException:
        _log(what, f"http-{answer.status_code}", started)
        raise
    _log(what, "ok", started)
    return answer


def _certificate_refused(exc: BaseException) -> bool:
    """Whether a failed connection failed on the certificate, however deep in the chain of causes."""
    seen: BaseException | None = exc
    for _ in range(10):
        if seen is None:
            return False
        if isinstance(seen, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(seen):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _json(answer: httpx.Response) -> Any:
    try:
        return answer.json()
    except ValueError as exc:
        raise fail("immich_unreadable", 502) from exc


def _get_json(db: Session, account_id: int, link: Link, method: str, path: str, what: str, **sent: Any) -> Any:
    answer = _exchange(db, account_id, link, method, path, what, seconds=JSON_SECONDS, limit=MAX_JSON,
                       accept=_wants(("application/json",)), **sent)
    return _json(answer)


# --- The photos of a day --------------------------------------------------------------------------------------------


def _window(day: str, zone: tzinfo) -> tuple[datetime, datetime]:
    """The day in the person's own time zone, as two moments in UTC."""
    first = date.fromisoformat(day)
    start = datetime.combine(first, daytime.min, tzinfo=zone)
    end = datetime.combine(first + timedelta(days=1), daytime.min, tzinfo=zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def _moment(value: Any) -> datetime | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def _still(item: Any, day: str, zone: tzinfo) -> tuple[str, datetime] | None:
    """A photo of Immich that is suggested: a still picture of this very day in the person's zone, not in the bin,
    not hidden (the motion of a live photo) and not locked away. Its id and when it was taken."""
    if not isinstance(item, dict):
        return None
    asset = str(item.get("id") or "").lower()
    if not ASSET_ID.match(asset) or item.get("type") != "IMAGE" or item.get("isTrashed"):
        return None
    if item.get("visibility") in ("hidden", "locked"):
        return None
    taken = _moment(item.get("fileCreatedAt"))
    if taken is None or taken.astimezone(zone).date().isoformat() != day:
        return None
    return asset, taken


def asset_key(dek: bytes, asset: str, day: str, purpose: str) -> str:
    """What a photo keeps of where it came from: a hash keyed with the person's own data key, of the photo of Immich,
    the day and what it was taken for. The same again finds it; nobody else can tell which photo it was."""
    keyed = hmac.new(dek, b"nexdiary|immich|asset", hashlib.sha256).digest()
    return hmac.new(keyed, f"{asset}|{day}|{purpose}".encode(), hashlib.sha256).hexdigest()


def _search(db: Session, account_id: int, link: Link, day: str, zone: tzinfo,
            what: str) -> tuple[list[tuple[str, datetime]], bool]:
    start, end = _window(day, zone)
    body = {
        "takenAfter": start.isoformat().replace("+00:00", "Z"),
        "takenBefore": end.isoformat().replace("+00:00", "Z"),
        "type": "IMAGE",
        "size": LIMIT,
        "page": 1,
        "order": "asc",
        "withExif": False,
        "withDeleted": False,
    }
    data = _get_json(db, account_id, link, "POST", "/api/search/metadata", what, json=body)
    assets = data.get("assets") if isinstance(data, dict) else None
    items = assets.get("items") if isinstance(assets, dict) else None
    if not isinstance(items, list):
        raise fail("immich_unreadable", 502)
    found: list[tuple[str, datetime]] = []
    for item in items[:LIMIT]:
        still = _still(item, day, zone)
        if still is not None and still[0] not in {asset for asset, _ in found}:
            found.append(still)
    found.sort(key=lambda entry: entry[1])
    return found, bool(assets.get("nextPage")) or len(items) > LIMIT


def photos_of_day(db: Session, account_id: int, dek: bytes, day: str, zone: tzinfo) -> dict[str, Any]:
    """The photos of Immich of one day, each with the id of the photo taken from it for the day, if one was."""
    link = _usable(db, account_id, dek)
    if not link.suggest:
        raise fail("immich_suggest_off", 409)
    brakes.take("immich", account_id)
    found, more = _search(db, account_id, link, day, zone, "list")
    keys = {asset: asset_key(dek, asset, day, DAY_PURPOSE) for asset, _ in found}
    taken = photos.taken_from_immich(db, account_id, keys.values())
    return {
        "date": day,
        "photos": [{"id": asset, "taken_at": moment.isoformat(), "photo_id": taken.get(keys[asset])}
                   for asset, moment in found],
        "more": more,
    }


def check_asset(value: str) -> str:
    value = value.lower() if isinstance(value, str) else ""
    if not ASSET_ID.match(value):
        raise error("not_found", "Not found.", 404)
    return value


def _picture_head(data: bytes) -> str:
    """The kind of a small picture, by its first bytes and its header (nothing is unpacked): a picture of a kind a
    browser shows, and not larger than ``MAX_THUMB_PIXELS``. ``immich_unreadable`` else."""
    kind = pictures.sniff(data[:64])
    if kind not in THUMB_KINDS:
        raise fail("immich_unreadable", 502)
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_THUMB_PIXELS:
                raise fail("immich_unreadable", 502)
    except HTTPException:
        raise
    except Exception as exc:  # a broken picture fails in the decoder's own way
        raise fail("immich_unreadable", 502) from exc
    return THUMB_KINDS[kind]


def thumbnail(db: Session, account_id: int, dek: bytes, asset: str) -> tuple[bytes, str]:
    """The small picture of a photo of the person's own Immich, passed on and never kept."""
    link = _usable(db, account_id, dek)
    brakes.take("immich_thumb", account_id)
    answer = _exchange(db, account_id, link, "GET", f"/api/assets/{asset}/thumbnail", "thumbnail",
                       seconds=THUMB_SECONDS, limit=MAX_THUMB, accept=_wants(("image/",)),
                       params={"size": "thumbnail"})
    data = answer.content
    return data, _picture_head(data)


def _download(db: Session, account_id: int, link: Link, asset: str, original: bool) -> bytes | None:
    """The original of a photo, or the large picture Immich made of it; None when the original is too large to
    take."""
    path = f"/api/assets/{asset}/original" if original else f"/api/assets/{asset}/thumbnail"
    try:
        answer = _exchange(db, account_id, link, "GET", path, "original" if original else "preview",
                           seconds=ORIGINAL_SECONDS, limit=pictures.MAX_BYTES, accept=None,
                           **({} if original else {"params": {"size": "preview"}}))
    except HTTPException as exc:
        if original and isinstance(exc.detail, dict) and exc.detail.get("code") == "immich_too_large":
            return None
        raise
    return answer.content


def take(db: Session, account_id: int, dek: bytes, asset: str, day: str, zone: tzinfo, moment: datetime,
         on_note: bool = False) -> tuple[dict[str, Any], bool]:
    """Copies one photo of the person's own Immich to a day: checked to be a still picture of that day, fetched,
    drawn anew without anything but its pixels and sealed (``photos``). The same photo taken again for the same
    purpose returns the photo that stands. An original nexdiary does not take (a RAW file, one too large) is taken
    from the large picture Immich made of it."""
    link = _usable(db, account_id, dek)
    brakes.take("upload", account_id)
    key = asset_key(dek, asset, day, NOTE_PURPOSE if on_note else DAY_PURPOSE)
    existing = photos.by_asset(db, account_id, key)
    if existing is not None:
        return existing, False
    info = _get_json(db, account_id, link, "GET", f"/api/assets/{asset}", "asset")
    if isinstance(info, dict) and str(info.get("id") or "").lower() != asset:
        raise fail("immich_unreadable", 502)
    if _still(info, day, zone) is None:
        if isinstance(info, dict) and info.get("type") == "IMAGE" and not info.get("isTrashed"):
            raise fail("immich_other_day", 422)
        raise fail("immich_not_a_picture", 422)
    with pictures.admitted():
        data = _download(db, account_id, link, asset, original=True)
        drawn = None
        if data is not None:
            try:
                drawn = photos.draw(data)
            except pictures.PictureError:
                drawn = None
        if drawn is None:
            preview = _download(db, account_id, link, asset, original=False)
            try:
                drawn = photos.draw(preview or b"")
            except pictures.PictureError as exc:
                raise fail("immich_not_a_picture", 422) from exc
    return photos.add(db, account_id, dek, day, None, drawn, moment, on_note, source="immich", asset_key=key)


def probe(db: Session, account_id: int, dek: bytes, day: str, zone: tzinfo) -> dict[str, Any]:
    """Whether the person's Immich answers with the key: its version, how many photos it has of today, and the
    account's mail address where the key may read it. The version and the address are kept with the link."""
    link = _usable(db, account_id, dek)
    brakes.take("immich", account_id)
    version_data = _get_json(db, account_id, link, "GET", "/api/server/version", "version")
    version = ""
    if isinstance(version_data, dict):
        parts = [version_data.get(name) for name in ("major", "minor", "patch")]
        if all(isinstance(part, int) and 0 <= part < 100_000 for part in parts):
            version = ".".join(str(part) for part in parts)
    found, more = _search(db, account_id, link, day, zone, "probe")
    email = ""
    try:
        me = _get_json(db, account_id, link, "GET", "/api/users/me", "me")
        candidate = me.get("email") if isinstance(me, dict) else None
        if isinstance(candidate, str) and 0 < len(candidate) <= EMAIL_MAX and candidate.isprintable():
            email = candidate
    except HTTPException as exc:
        # A key with only the permissions nexdiary needs may not read the account: no address then.
        if not (isinstance(exc.detail, dict) and exc.detail.get("code") in ("immich_permission", "immich_not_found")):
            raise
    current = load(db, account_id, dek)
    if current is not None and current.url == link.url and current.key == link.key:
        current.version, current.email = version, email
        _store(db, account_id, dek, current)
    return {"version": version, "today": len(found), "more": more, "email": email}

