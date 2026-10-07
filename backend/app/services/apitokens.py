"""API tokens: programs such as a dashboard card read nexdiary over ``/api/v1`` (``routers/v1.py``).

**Closed until the operator opens it** (``api_tokens_allowed``). Then every account makes tokens of its own, under
My account, Connections. A token acts as its account and never sees more.

**Reading only.** No route under ``/api/v1`` changes anything; the level ``read`` is the only one there is.

A token may run out (``expires_at``); the list marks it a week before. The operator sees every token and may block
one for good (``blocked_at``); a blocked token answers like none.

**The name** (what the person calls the token) is sealed with their data key, like what they write: the operator sees
whose token it is and its first characters, never what it is called. A name that still stands in the clear from before
is sealed at the next start (``seal_legacy_names``).

**The token.** ``nxa_`` and 43 random characters, shown once. Only its SHA-256 is stored, and its first characters to
tell tokens apart. It travels in ``Authorization: Bearer``, never in an address, and never reaches the log.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, ApiToken, utcnow
from . import settings_service, totp, vault

logger = logging.getLogger("nexdiary.api")

LEVELS = ("read",)
TOKEN_PREFIX = "nxa_"
#: How many tokens an account may hold.
MAX_TOKENS = 20
#: The choices for running out, in days; None: never (the default, design answer).
LIFETIMES = (30, 90, 365)
#: Requests one token may make per minute.
PER_MINUTE = 600
#: ``last_used_at`` is written at most this often.
USED_EVERY = timedelta(minutes=1)


class TokenError(Exception):
    def __init__(self, code: str, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "api_tokens_allowed"))


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make(db: Session, account: Account, name: str, level: str, days: int | None = None) -> tuple[ApiToken, str]:
    """A new token; the token itself is returned once and never stored. ``days``: runs out then; None: never."""
    if level not in LEVELS:
        raise TokenError("invalid_input", "No such level.", 422)
    if days is not None and days not in LIFETIMES:
        raise TokenError("invalid_input", "A token runs out after 30, 90 or 365 days, or never.", 422)
    count = len(db.scalars(select(ApiToken.id).where(ApiToken.account_id == account.id)).all())
    if count >= MAX_TOKENS:
        raise TokenError("too_many_tokens", "An account holds at most 20 tokens.", 409)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = utcnow()
    # The data key before anything is written: making it takes a session of its own, which would wait for ours.
    dek = vault.dek_for(account.id)
    row = ApiToken(account_id=account.id, name="", level=level, token_hash=digest(token),
                   prefix=token[: len(TOKEN_PREFIX) + 4], created_at=now,
                   expires_at=None if days is None else now + timedelta(days=days))
    db.add(row)
    db.flush()
    row.name_enc = vault.seal_text(dek, name.strip()[:100] or "API", _bound(row))
    db.commit()
    db.refresh(row)
    logger.info("API token made token_id=%s level=%s days=%s", row.id, level, days or "never")
    return row, token


def _bound(row: ApiToken) -> bytes:
    return vault.aad(row.account_id, "api_tokens", "name_enc", str(row.id))


def name_of(row: ApiToken, dek: bytes | None = None) -> str:
    """What the person called the token. Empty when the name cannot be opened (never someone else's, never a guess)."""
    if row.name_enc is None:
        return row.name
    try:
        return vault.open_text(dek or vault.dek_of(row.account_id), row.name_enc, _bound(row))
    except vault.SealError:
        logger.warning("The name of an API token did not open token_id=%s", row.id)
        return ""


def seal_legacy_names() -> int:
    """At the start, after the master key is there: names that still stand in the clear are sealed and the clear text
    is overwritten, then the write-ahead log is emptied so that no old page keeps it. Gives how many."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        todo = [(row.id, row.account_id) for row in db.scalars(
            select(ApiToken).where(ApiToken.name_enc.is_(None), ApiToken.name != ""))]
    done = 0
    for token_id, account_id in todo:
        dek = vault.dek_for(account_id)
        with SessionLocal() as db:
            row = db.get(ApiToken, token_id)
            if row is None or row.name_enc is not None or not row.name:
                continue
            row.name_enc = vault.seal_text(dek, row.name, _bound(row))
            row.name = ""
            db.commit()
            done += 1
    if done:
        vault.shred_leftovers()
        logger.info("API token names sealed count=%s", done)
    return done


@dataclass
class Caller:
    """Who calls ``/api/v1``: the account, detached, and its token."""

    account: Account
    token_id: int
    level: str



def authenticate(db: Session, token: str | None) -> Caller | None:
    """The account behind a token, or None: no such token, run out, blocked, or the account locked or waiting for
    its second factor. Tokens being switched off is the caller's to check (``allowed``)."""
    if not token or not token.startswith(TOKEN_PREFIX) or len(token) > 200:
        return None
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == digest(token)))
    now = utcnow()
    if row is None or row.blocked_at is not None or (row.expires_at is not None and row.expires_at <= now):
        return None
    account = db.get(Account, row.account_id)
    if account is None or account.blocked_at is not None or (
            account.locked_until is not None and account.locked_until > now):
        # Blocked means no way in at all, a token included.
        return None
    if totp.setup_required(db, account):
        # The operator requires a second factor this account has not set up: its tokens wait like its sessions.
        return None
    if row.last_used_at is None or now - row.last_used_at >= USED_EVERY:
        row.last_used_at = now
        db.commit()
    level = row.level if row.level in LEVELS else "read"
    token_id = row.id
    db.expunge(account)
    return Caller(account=account, token_id=token_id, level=level)


_calls_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def brake(token_id: int, now: float | None = None) -> bool:
    """True while the token stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[token_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()
