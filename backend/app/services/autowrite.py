"""Writing up the day before on its own, in the morning, for the people who asked for it.

This is the one place where notes go to the AI without a press of a button, so it has three bolts and a leash:

* **The operator** opens it (``ai_auto_allowed``, closed from the start), on top of the AI service they set up and the
  per-account permission (``users.ai_allowed``); **the person** switches it on for themselves (``profile.autowrite``,
  off from the start; the interface asks first where the notes will go, and the server wants that confirmation).
* The planner looks once a minute (``run_forever``), like the reminders: from the chosen time on, for ``CATCH_UP``
  after it, in the person's own time zone and on the injected clock. A day is **tried once**: the mark is set by a
  conditional update before the AI is asked, so two server processes, two rounds or a restart ask once, and a failure
  is not tried again. Only the day before (the notes of a night that the person put on yesterday are on it).
* It goes through ``ai.formulate(..., automatic=True)``, the same road as the button (same rules, same limits for the
  notes, the permission of the account asked again, the person's default template if there is one), with a limit of
  its own. A failure is said in the log by its code, never with a word of the notes or of the answer.
* The result is a **draft** that waits for the person (``drafts.auto``): no page, so no streak, no statistics, nothing
  to share, nothing in the journal, until the person takes it. It is only made where the day has notes, no page, no
  draft and is not locked, and only onto the revision that was read: a page saved in between wins.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime, time, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .. import clock
from ..errors import error
from ..models import Account, AutoMark, Day, Draft
from . import ai, diary, push, settings_service, templates, vault

logger = logging.getLogger("nexdiary.autowrite")

DEFAULT: dict[str, Any] = {"on": False, "time": "07:00", "length": "long"}
_TIME = re.compile(r"^(?:0[4-9]|1[01]):[0-5]\d$")
#: How long after its time the morning writing still goes out: a server that was down at the time.
CATCH_UP = timedelta(hours=4)

TEXTS = {
    "de": "Ein Entwurf für gestern wartet auf dich.",
    "en": "A draft for yesterday is waiting for you.",
}
TITLE = "nexdiary"
TAG = "auto-draft"


# --- The choice of a person -----------------------------------------------------------------------------------------


def of(profile: Any) -> dict[str, Any]:
    """The choice a person made, every field present: what was stored where it is valid, the default else."""
    stored = profile.get("autowrite") if isinstance(profile, dict) else None
    stored = stored if isinstance(stored, dict) else {}
    out = dict(DEFAULT)
    if type(stored.get("on")) is bool:
        out["on"] = stored["on"]
    if isinstance(stored.get("time"), str) and _TIME.match(stored["time"]):
        out["time"] = stored["time"]
    if stored.get("length") in ai.LENGTHS:
        out["length"] = stored["length"]
    return out


def check(current: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    """``current`` with ``change`` applied, every value checked; ``422 bad_autowrite`` names the first wrong field.
    ``confirmed`` is not stored: it only comes with the switch being turned on."""
    out = dict(current)
    for key, value in change.items():
        if key == "on":
            valid = type(value) is bool
        elif key == "time":
            valid = isinstance(value, str) and bool(_TIME.match(value))
        elif key == "length":
            valid = value in ai.LENGTHS
        elif key == "confirmed":
            valid = type(value) is bool
        else:
            valid = False
        if not valid:
            raise error("bad_autowrite", "This value is not one nexdiary offers.", 422, field=key)
        if key != "confirmed":
            out[key] = value
    if out["on"] and not current["on"] and change.get("confirmed") is not True:
        raise error("autowrite_unconfirmed", "Switching this on needs the confirmation of where the notes go.", 422)
    return out


def own_switch(account: Account) -> bool:
    """The person's own switch for the AI (on from the start)."""
    profile = account.profile if isinstance(account.profile, dict) else {}
    return profile.get("ai", True) is not False


def may_switch_on(db: Session, account: Account, own_switch: bool) -> None:
    """Whatever has to be open for the morning writing to work, said as the AI says it: the account's permission, the
    person's own switch, a working service, and the operator's second bolt."""
    ai.check_allowed(db, account.id)
    ai.usable(db, own_switch)
    if not settings_service.get(db, "ai_auto_allowed"):
        raise ai.fail("ai_auto_off", 403)


def usable_for(db: Session, account: Account) -> bool:
    """Whether the morning writing may run for this person now (the planner's question)."""
    try:
        may_switch_on(db, account, own_switch(account))
    except HTTPException:
        return False
    return True


# --- When ------------------------------------------------------------------------------------------------------------


def _target(local_day: date, at: str) -> datetime:
    hour, minute = (int(part) for part in at.split(":"))
    return datetime.combine(local_day, time(hour, minute))


def due(account: Account, choice: dict[str, Any], now: datetime) -> str | None:
    """The day to write up (yesterday in the person's zone) when its time has come; None otherwise. The time is a
    wall clock of the person's zone: a skipped hour (summer time) is past at the first minute after it, a repeated one
    finds the day marked."""
    if not choice["on"]:
        return None
    local = now.astimezone(diary.zone_of(account))
    late = local.replace(tzinfo=None) - _target(local.date(), choice["time"])
    if late < timedelta(0) or late >= CATCH_UP:
        return None
    return (local.date() - timedelta(days=1)).isoformat()


def claim(db: Session, account_id: int, day: str) -> bool:
    """Marks the day as tried, only where an earlier day stood. True for the one caller that set the mark."""
    db.execute(sqlite_insert(AutoMark).values(user_id=account_id, tried_for="")
               .on_conflict_do_nothing(index_elements=[AutoMark.user_id]))
    taken = db.execute(update(AutoMark).where(AutoMark.user_id == account_id, AutoMark.tried_for < day)
                       .values(tried_for=day))
    db.commit()
    return bool(taken.rowcount)  # type: ignore[attr-defined]


# --- Writing ---------------------------------------------------------------------------------------------------------


def write_up(db: Session, account: Account, day: str, length: str) -> bool:
    """One try for one day: the draft is made, or nothing is, and the reason goes to the log as a code. True when a
    draft stands afterwards."""
    dek = vault.dek_for(account.id)
    row = db.execute(select(Day.id, Day.content_enc, Day.revision, Day.locked_at)
                     .where(Day.user_id == account.id, Day.date == day)).first()
    revision = -1
    if row is not None:
        if row.locked_at is not None:
            return False
        content = diary._readable_content(account.id, dek, day, row.content_enc)
        if content is None or diary.has_page(content):
            return False
        revision = row.revision
    if db.scalar(select(Draft.id).where(Draft.user_id == account.id, Draft.date == day)) is not None:
        return False
    notes = diary.list_notes(db, account.id, dek, day)
    if not any(note["text"] and not note["unreadable"] for note in notes):
        return False
    try:
        chosen = templates.default_of(db, account.id, dek)
        suggestion = ai.formulate(db, account.id, own_switch(account), notes, diary.zone_of(account), length,
                                  automatic=True, sections=chosen["sections"] if chosen else None)
    except HTTPException as exc:
        code = exc.detail.get("code") if isinstance(exc.detail, dict) else exc.status_code
        logger.warning("Automatic writing did not work code=%s", code)
        return False
    draft = {"title": suggestion["title"], "text": suggestion["text"], "tags": [], "cover": None, "written_by": "ai",
             "ai_length": length}
    return diary.save_auto_draft(db, account.id, dek, day, draft, revision)


def message(language: str, day: str) -> Any:
    """The notice that a draft waits, in the language of each device; it names no day and carries no word of it."""

    def for_lang(lang: str) -> push.Message:
        chosen = "de" if (lang or language or "").split("-")[0].lower() == "de" else "en"
        return push.Message(title=TITLE, body=TEXTS[chosen], url=f"/tag/{day}/schreiben", desk=f"/tag/{day}/schreiben",
                            tag=TAG)

    return for_lang


# --- The planner -----------------------------------------------------------------------------------------------------


def run_once(now: datetime | None = None) -> int:
    """One round: every person whose morning has come gets yesterday written up, once. Gives how many drafts were
    made."""
    from ..db import SessionLocal

    moment = now or clock.now()
    made = 0
    with SessionLocal() as db:
        people = [account_id for account_id, profile in db.execute(select(Account.id, Account.profile))
                  if isinstance(profile, dict) and of(profile)["on"]]
    for account_id in people:
        try:
            with SessionLocal() as db:
                account = db.get(Account, account_id)
                if account is None or account.blocked_at is not None:
                    continue
                choice = of(account.profile)
                day = due(account, choice, moment)
                if day is None:
                    continue
                if not usable_for(db, account):
                    continue
                if not claim(db, account_id, day):
                    continue
                if not write_up(db, account, day, choice["length"]):
                    continue
                language = account.language
            made += 1
            result = push.send_to_person(account_id, message(language, day))
            logger.info("Automatic draft made, devices=%s gone=%s failed=%s", result.sent, result.gone, result.failed)
        except Exception:
            # One person's trouble never stops the others.
            logger.exception("Automatic writing failed")
    return made


async def run_forever(stop: asyncio.Event) -> None:
    """Once a minute, a little after it begins."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            logger.exception("The round of automatic writing failed")
        moment = clock.now()
        wait = 60 - moment.second - moment.microsecond / 1_000_000 + 2
        try:
            await asyncio.wait_for(stop.wait(), max(1.0, wait))
        except TimeoutError:
            continue
