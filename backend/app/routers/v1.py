"""The API for programs (``/api/v1``): a dashboard card, scripts. A token in ``Authorization: Bearer``. Reading only.

**The promise.** What is under ``/api/v1`` stays as it is: new fields may come, nothing is renamed or taken away. A
change that would break a program goes to ``/api/v2`` beside it. ``docs/api.md`` describes every route.

Walls, in this order: a request that carries an ``Origin`` is refused (browsers send one, programs do not; no web page
can use a token it found); API tokens must be switched on by the operator; the token must be valid; the token must stay
under its rate. The session cookie counts for nothing here.

A token reads as its account and never more. The numbers of the diary come with the blocks that make the diary.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request

from .. import __version__
from ..db import SessionLocal
from ..errors import error
from ..services import apitokens, logs
from ..services.apitokens import Caller

logger = logging.getLogger("nexdiary.api")

router = APIRouter(prefix="/api/v1", tags=["api v1"])


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def caller(request: Request) -> Caller:
    if request.headers.get("origin"):
        raise error("origin_refused", "The API is for programs, not web pages.", 403)
    with SessionLocal() as db:
        if not apitokens.allowed(db):
            raise error("api_off", "The operator has not switched API tokens on.", 401)
        found = apitokens.authenticate(db, _token(request))
    if found is None:
        raise error("token_invalid", "No valid API token.", 401)
    if not apitokens.brake(found.token_id):
        exc = error("slow_down", "Too many requests with this token. Wait a minute.", 429)
        exc.headers = {"Retry-After": "60"}
        raise exc
    logs.set_actor(found.account.name)
    return found


Reader = Annotated[Caller, Depends(caller)]


@router.get("/me", summary="Who the token speaks for, and what it may")
def me(found: Reader) -> dict[str, Any]:
    return {
        "name": found.account.name,
        "display_name": found.account.display_name,
        "level": found.level,
        "version": __version__,
    }
