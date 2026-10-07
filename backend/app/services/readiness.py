""""Ready for the internet?": what nexdiary checks about itself before it is reachable from outside.

Each point is ``ok``, ``warn`` or ``bad`` with the values its sentence needs; the interface says what it means and
what helps. Checked at every call, from the request that asks and the server as it stands: nothing is remembered but
when the master key was last saved.
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from fastapi import Request
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account
from . import settings_service, totp, vault

OK, WARN, BAD = "ok", "warn", "bad"
#: Whether file modes say anything here: Windows has no owner-only mode to read, the folder's rights decide there.
CHECK_MODE = os.name != "nt"


@dataclass
class Point:
    key: str
    state: str
    values: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"key": self.key, "state": self.state, "values": self.values}


def came_over_https(request: Request) -> bool:
    """The request reached nexdiary over https, or the proxy in front says it did."""
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


def _https(db: Session, request: Request) -> Point:
    public = settings_service.public_url(db)
    if urlsplit(public).scheme != "https":
        return Point("https", BAD, {"address": public})
    if not came_over_https(request):
        return Point("https", WARN, {"address": public})
    return Point("https", OK, {"address": public})


def _two_factor(db: Session) -> Point:
    return Point("two_factor", OK if settings_service.get(db, "two_factor_required") else BAD)


def _own_account(db: Session, operator: Account) -> Point:
    return Point("own_account", OK if totp.has_second_factor(db, operator) else BAD)


def _brake(unknown_proxy: bool) -> Point:
    # Always on, not to be switched off; but behind a proxy nexdiary was not told about, every sender looks alike
    # and only the lock per account is left.
    return Point("brake", WARN if unknown_proxy else OK)


def _encryption() -> Point:
    path = vault.master_key_path()
    try:
        info = path.stat()
    except OSError:
        return Point("encryption", BAD, {"path": str(path), "missing": True})
    if not CHECK_MODE:
        return Point("encryption", OK, {"path": str(path), "mode": None})
    mode = stat.S_IMODE(info.st_mode)
    open_to_others = bool(mode & 0o077)
    return Point("encryption", BAD if open_to_others else OK, {"path": str(path), "mode": f"{mode:04o}"})


def _cookies(request: Request) -> Point:
    mode = get_settings().cookie_secure.lower()
    if mode == "off":
        return Point("cookies", BAD, {"mode": mode})
    if not came_over_https(request):
        return Point("cookies", WARN, {"mode": mode})
    return Point("cookies", OK, {"mode": mode})


def _proxy(request: Request, unknown_proxy: bool) -> Point:
    if unknown_proxy:
        peer = request.client.host if request.client else ""
        return Point("proxy", WARN, {"proxy": peer})
    trusted = get_settings().trusted_proxies.strip()
    return Point("proxy", OK, {"proxies": trusted, "forwarded": bool(request.headers.get("x-forwarded-for"))})


def _master_key_saved(db: Session) -> Point:
    when = settings_service.get(db, "master_key_saved_at")
    return Point("master_key_saved", OK if when else WARN, {"when": when})


def check(db: Session, request: Request, operator: Account, unknown_proxy: bool) -> dict[str, Any]:
    points = [
        _https(db, request),
        _two_factor(db),
        _own_account(db, operator),
        _brake(unknown_proxy),
        _encryption(),
        _cookies(request),
        _proxy(request, unknown_proxy),
        _master_key_saved(db),
    ]
    return {"points": [point.as_dict() for point in points], "open": sum(point.state != OK for point in points)}
