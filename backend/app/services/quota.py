"""What one person may keep: the operator sets a limit in GB (Settings, Server, Accounts; 0: none) over everything
the person has stored: the sealed photo files, and the sealed texts of their days, notes, drafts, values and own
questions (counted as the bytes that lie in the database, the seal included). Counted inside the transaction that
writes, so two writes at the same moment cannot pass the limit together: a statement that inserts checks it in its own
condition, a write of a sealed text checks right after (``check_after_write``)."""

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
    "(SELECT coalesce(sum(length(content_enc)), 0) FROM drafts WHERE user_id = :user) + "
    "(SELECT coalesce(sum(length(content_enc)), 0) FROM days WHERE user_id = :user) + "
    "(SELECT coalesce(sum(length(text_enc) + coalesce(length(prompt_enc), 0) "
    "+ coalesce(length(prompt_ref_enc), 0)), 0) FROM notes WHERE user_id = :user) + "
    "(SELECT coalesce(sum(length(data_enc)), 0) FROM value_defs WHERE user_id = :user) + "
    "(SELECT coalesce(sum(length(content_enc)), 0) FROM writing_prompts WHERE user_id = :user))"
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


def check_after_write(db: Session, account_id: int, growth: int) -> None:
    """Right after a write in the open transaction that made the person's data grow by ``growth`` bytes: when the
    person now holds more than the limit allows, the transaction is rolled back and the write refused. SQLite lets one
    writer in at a time and this one holds the lock from its write on, so no other write lands between the two. A
    write that does not grow anything is never refused, a person above a lowered limit can still shorten a page."""
    if growth <= 0:
        return
    limit = limit_bytes(db)
    if limit is not None and used(db, account_id) > limit:
        db.rollback()
        raise full(db)


def full(db: Session) -> Exception:
    """The answer when a write would pass the limit."""
    gb = settings_service.get(db, "storage_per_person_gb")
    return error("storage_full", "Your storage is full.", 409, max_gb=gb)
