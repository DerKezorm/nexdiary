"""The few numbers a dashboard card shows (``GET /api/v1/dashboard``), worked out for one account and nothing else.

Only counts and dates leave here: no text, no title, no value, no tag, no mood, no name of anybody, no capsule's
title or sender. Everything comes from the account's own rows, so that no other person's page, note or capsule can
change a number.

* **today_written**, **streak**: the pages of the account with text, as the streak of the interface counts them
  (``streaks.py``). ``streak`` is in days at a weekly goal of 7 and in weeks below that; ``streak_unit`` says which.
* **entries_month**: pages with text in the calendar month of "today" in the account's time zone, up to today.
* **notes_month**: notes of that month, up to today.
* **next_capsule**: the earliest day a capsule for the account opens that has not opened for it yet (its own letters
  to itself included, capsules of blocked senders left out as in the lists); only the day, and the days to it counted
  on the clock the capsule kept for the account.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import __version__
from ..models import Account, Capsule, CapsuleKey, Note
from . import capsules, diary, streaks, vault

logger = logging.getLogger("nexdiary.api")


def _written(db: Session, account_id: int, today: date) -> dict[date, int]:
    """The pages with text, up to today. An account that never wrote has no data key yet (and none is made here: the
    API only reads); one whose key does not open has no readable page."""
    try:
        dek = vault.dek_of(account_id)
    except vault.SealError:
        return {}
    return streaks.written_days(db, account_id, dek, today)


def _notes_in_month(db: Session, account_id: int, first: date, today: date) -> int:
    count = db.scalar(select(func.count()).select_from(Note).where(
        Note.user_id == account_id, Note.date >= first.isoformat(), Note.date <= today.isoformat()))
    return int(count or 0)


def _next_capsule(db: Session, account_id: int) -> tuple[str | None, int | None]:
    rows = db.execute(
        select(Capsule.opens_on, CapsuleKey.zone)
        .join(CapsuleKey, CapsuleKey.capsule_id == Capsule.id)
        .outerjoin(Account, Account.id == Capsule.sender_id)
        .where(CapsuleKey.user_id == account_id, CapsuleKey.recipient.is_(True), Account.blocked_at.is_(None))
        .order_by(Capsule.opens_on)
    ).all()
    for opens_on, zone in rows:
        if capsules.is_open_in(zone, opens_on):
            continue
        try:
            days = (date.fromisoformat(opens_on) - date.fromisoformat(capsules.today_in(zone))).days
        except ValueError:
            continue
        return opens_on, max(days, 0)
    return None, None


def numbers(db: Session, account: Account) -> dict[str, Any]:
    today = diary.today_of(account)
    written = _written(db, account.id, today)
    first = today.replace(day=1)
    series = streaks.compute(written, today, streaks.goal_of(account.profile))
    next_day, next_days = _next_capsule(db, account.id)
    return {
        "version": __version__,
        "today_written": bool(series["today_done"]),
        "streak": series["current"],
        "streak_unit": series["unit"],
        "entries_month": sum(1 for day in written if day >= first),
        "notes_month": _notes_in_month(db, account.id, first, today),
        "next_capsule": next_day,
        "next_capsule_days": next_days,
    }
