"""What one person may keep: the operator sets a limit in GB (Settings, Server, Accounts; 0: none) over the sealed
photo files and the drafts. Counted inside the statement that writes, so two uploads at the same moment cannot pass
the limit together."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import error
from . import settings_service

GB = 1024**3
MAX_GB = 10_000

#: What a person holds now, in bytes; ``:user`` is the person. Used inside the writing statements.
USED = (
    "((SELECT coalesce(sum(size + preview_size), 0) FROM photos WHERE user_id = :user) + "
    "(SELECT coalesce(sum(length(content_enc)), 0) FROM drafts WHERE user_id = :user))"
)


def limit_bytes(db: Session) -> int | None:
    """The limit per person in bytes; None when there is none."""
    try:
        gb = float(settings_service.get(db, "storage_per_person_gb") or 0)
    except (TypeError, ValueError):
        gb = 0
    return int(gb * GB) if gb > 0 else None


def used(db: Session, account_id: int) -> int:
    return int(db.execute(text(f"SELECT {USED}"), {"user": account_id}).scalar() or 0)


def full(db: Session) -> Exception:
    """The answer when a write would pass the limit."""
    gb = settings_service.get(db, "storage_per_person_gb")
    return error("storage_full", "Your storage is full.", 409, max_gb=gb)
