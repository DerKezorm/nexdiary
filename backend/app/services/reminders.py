"""Reminders: a gentle push when a person has not written yet, by Web Push to the devices they signed up.

Each person chooses (``profile.reminder``): never, every day at a time, or after a pause of a few days without an
entry, always at that time; not on a day with a note already (every day only); with the question of the day or
without.

The planner looks once a minute (``run_forever``). For each person it reads the clock in the person's own time zone:
a reminder is due from its time on, for ``CATCH_UP`` after it. Summer time cannot make one fall out or come twice:
when the clocks skip the hour, the first minute after the skip is past the time; when they turn the hour back, the
second pass finds the day marked. Marked before sending, by a conditional update (``claim``): of two server
processes, two rounds in the same minute or a restart, exactly one sends.

What a reminder says is written here, never taken from the diary. The question of the day comes along only when the
person chose it, also when it is one of their own questions (those say something about the person).
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select, union_all, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .. import clock
from ..errors import error
from ..models import Account, Day, Note, PushDevice, ReminderMark
from . import diary, prompts, push, vault

logger = logging.getLogger("nexdiary.reminders")

MODES = ("never", "daily", "pause")
DAYS_MIN, DAYS_MAX = 1, 30
#: How long after its time a reminder still goes out: a server that was down at the time, or the hour that summer
#: time skips. Later than that, the day is left alone.
CATCH_UP = timedelta(hours=2)
DEFAULT: dict[str, Any] = {"mode": "daily", "time": "20:30", "days": 2, "skip_if_written": True, "with_prompt": True}
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

#: What a reminder says, in the language of the device; the interface shows the same in its preview.
TEXTS = {
    "de": {
        "daily": "Wie war dein Tag?",
        "pause_one": "Seit gestern nichts geschrieben. Magst du kurz?",
        "pause": "Seit {n} Tagen nichts geschrieben. Magst du kurz?",
        "asked": " Heute gefragt: {question}",
    },
    "en": {
        "daily": "How was your day?",
        "pause_one": "Nothing written since yesterday. Fancy a few lines?",
        "pause": "Nothing written for {n} days. Fancy a few lines?",
        "asked": " Today's question: {question}",
    },
}
TITLE = "nexdiary"
#: Where a tap leads: the quick note on a phone, Today on a computer.
TAP_PHONE = "/schnell"
TAP_DESK = "/"
TAG = "reminder"


def language_of(code: str) -> str:
    return "de" if (code or "").split("-")[0].lower() == "de" else "en"


# --- The choice of a person -----------------------------------------------------------------------------------------


def of(profile: Any) -> dict[str, Any]:
    """The reminder a person chose, every field present: what was stored where it is valid, the default else."""
    stored = profile.get("reminder") if isinstance(profile, dict) else None
    stored = stored if isinstance(stored, dict) else {}
    out = dict(DEFAULT)
    if stored.get("mode") in MODES:
        out["mode"] = stored["mode"]
    if isinstance(stored.get("time"), str) and _TIME.match(stored["time"]):
        out["time"] = stored["time"]
    days = stored.get("days")
    if type(days) is int and DAYS_MIN <= days <= DAYS_MAX:
        out["days"] = days
    for flag in ("skip_if_written", "with_prompt"):
        if type(stored.get(flag)) is bool:
            out[flag] = stored[flag]
    return out


def check(current: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    """``current`` with ``change`` applied, every value checked; ``422 bad_reminder`` names the first wrong field."""
    out = dict(current)
    for key, value in change.items():
        if key == "mode":
            valid = value in MODES
        elif key == "time":
            valid = isinstance(value, str) and bool(_TIME.match(value))
        elif key == "days":
            valid = type(value) is int and DAYS_MIN <= value <= DAYS_MAX
        elif key in ("skip_if_written", "with_prompt"):
            valid = type(value) is bool
        else:
            valid = False
        if not valid:
            raise error("bad_reminder", "This value is not one nexdiary offers.", 422, field=key)
        out[key] = value
    return out


def _target(local_day: date, at: str) -> datetime:
    hour, minute = (int(part) for part in at.split(":"))
    return datetime.combine(local_day, time(hour, minute))


def passed_today(account: Account, reminder: dict[str, Any], now: datetime) -> date | None:
    """The person's today, when its time for a reminder is already past (the wall clock of their zone); else None."""
    local = now.astimezone(diary.zone_of(account))
    if local.replace(tzinfo=None) >= _target(local.date(), reminder["time"]):
        return local.date()
    return None


def after_saving(db: Session, account: Account, before: dict[str, Any], after: dict[str, Any], now: datetime) -> None:
    """A reminder switched on or moved to a time already past today does not go out at once: the person is in the
    app right now. Today counts as reminded."""
    if after["mode"] == "never" or (before["mode"], before["time"]) == (after["mode"], after["time"]):
        return
    today = passed_today(account, after, now)
    if today is None:
        return
    _mark(db, account.id, today.isoformat(), today.isoformat())
    db.commit()


# --- Whether one is due ---------------------------------------------------------------------------------------------


def written_on(db: Session, account_id: int, day: str) -> bool:
    """A note or a page on that day: one note is enough."""
    for model in (Note, Day):
        found = db.scalar(select(model.id).where(model.user_id == account_id, model.date == day).limit(1))
        if found is not None:
            return True
    return False


def last_written(db: Session, account_id: int, up_to: str) -> str | None:
    """The last day with a note or a page, not after ``up_to``."""
    dates = union_all(
        select(Note.date.label("day")).where(Note.user_id == account_id, Note.date <= up_to),
        select(Day.date.label("day")).where(Day.user_id == account_id, Day.date <= up_to),
    ).subquery()
    found = db.scalar(select(func.max(dates.c.day)))
    return str(found) if found else None


def due(db: Session, account: Account, reminder: dict[str, Any], now: datetime) -> tuple[date, int, int] | None:
    """Whether a reminder is due for the person now: its day (in the person's zone), the days that must lie between
    two reminders, and how many days nothing was written (for the text). None when not."""
    if reminder["mode"] not in ("daily", "pause"):
        return None
    zone = diary.zone_of(account)
    local = now.astimezone(zone)
    today = local.date()
    late = local.replace(tzinfo=None) - _target(today, reminder["time"])
    if late < timedelta(0) or late >= CATCH_UP:
        return None
    if reminder["mode"] == "daily":
        if reminder["skip_if_written"] and written_on(db, account.id, today.isoformat()):
            return None
        return today, 1, 0
    last = last_written(db, account.id, today.isoformat())
    since = date.fromisoformat(last) if last else account.created_at.astimezone(zone).date()
    pause = (today - since).days
    if pause < reminder["days"]:
        return None
    # Once in so many days while the pause lasts, not every day.
    return today, reminder["days"], pause


def _mark(db: Session, account_id: int, day: str, limit: str) -> bool:
    db.execute(sqlite_insert(ReminderMark).values(user_id=account_id, sent_for="")
               .on_conflict_do_nothing(index_elements=[ReminderMark.user_id]))
    taken = db.execute(update(ReminderMark)
                       .where(ReminderMark.user_id == account_id, ReminderMark.sent_for <= limit)
                       .values(sent_for=day))
    return bool(taken.rowcount)  # type: ignore[attr-defined]


def claim(db: Session, account_id: int, day: date, step: int) -> bool:
    """Marks the day as reminded, only where the last reminder was at least ``step`` days before it. True for the one
    caller that set the mark; every other one (a second process, a second round, after a restart) gets False."""
    taken = _mark(db, account_id, day.isoformat(), (day - timedelta(days=step)).isoformat())
    db.commit()
    return taken


# --- What it says ---------------------------------------------------------------------------------------------------


def text(lang: str, mode: str, pause: int, question: str | None) -> str:
    words = TEXTS[language_of(lang)]
    if mode == "pause":
        out = words["pause_one"] if pause == 1 else words["pause"].format(n=pause)
    else:
        out = words["daily"]
    if question:
        out += words["asked"].format(question=question)
    return out


def _questions(db: Session, account: Account, day: date, wanted: bool) -> dict[str, str | None]:
    """The question of the day in both languages, when the person wants it along; none else."""
    if not wanted:
        return {"de": None, "en": None}
    dek = vault.dek_for(account.id)
    out: dict[str, str | None] = {}
    for lang in ("de", "en"):
        found = prompts.question_of_day(db, account.id, dek, day, lang)
        out[lang] = found["text"] if found else None
    return out


def message(db: Session, account: Account, reminder: dict[str, Any], day: date, pause: int) -> Any:
    """The message for each language of the person's devices."""
    questions = _questions(db, account, day, reminder["with_prompt"])

    def for_lang(lang: str) -> push.Message:
        chosen = language_of(lang or account.language)
        return push.Message(title=TITLE, body=text(chosen, reminder["mode"], pause, questions[chosen]),
                            url=TAP_PHONE, desk=TAP_DESK, tag=TAG)

    return for_lang


def probe(db: Session, account: Account) -> push.Result:
    """A probe to every device of the person: the reminder as it would come now, whatever the time."""
    reminder = of(account.profile)
    mode = reminder["mode"] if reminder["mode"] != "never" else "daily"
    day = diary.today_of(account)
    pause = reminder["days"] if mode == "pause" else 0
    send = message(db, account, {**reminder, "mode": mode}, day, pause)
    db.rollback()
    return push.send_to_person(account.id, send)


# --- The planner ----------------------------------------------------------------------------------------------------


def run_once(now: datetime | None = None) -> int:
    """One round: every person with a device whose reminder is due gets it, once. Gives how many went out."""
    from ..db import SessionLocal

    moment = now or clock.now()
    sent = 0
    with SessionLocal() as db:
        people = list(db.scalars(select(PushDevice.user_id).distinct()))
    for account_id in people:
        try:
            with SessionLocal() as db:
                account = db.get(Account, account_id)
                if account is None or account.blocked_at is not None:
                    continue
                reminder = of(account.profile)
                found = due(db, account, reminder, moment)
                if found is None:
                    continue
                day, step, pause = found
                if not claim(db, account_id, day, step):
                    continue
                send = message(db, account, reminder, day, pause)
            result = push.send_to_person(account_id, send)
            logger.info("Reminder sent devices=%s gone=%s failed=%s", result.sent, result.gone, result.failed)
            sent += 1
        except Exception:
            # One person's trouble never stops the reminders of the others.
            logger.exception("A reminder failed")
    return sent


async def run_forever(stop: asyncio.Event) -> None:
    """Once a minute, shortly after it begins."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            # The planner keeps running.
            logger.exception("The reminder round failed")
        moment = clock.now()
        wait = 60 - moment.second - moment.microsecond / 1_000_000 + 1
        try:
            await asyncio.wait_for(stop.wait(), max(1.0, wait))
        except TimeoutError:
            continue
