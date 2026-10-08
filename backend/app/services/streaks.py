"""The streak of a person, their weekly goal and the shields that keep a streak alive.

Everything here is worked out from the written pages of the person and nothing else; nothing is stored apart from the
goal itself (``profile.goal``). A different goal, a page written afterwards or a page taken away simply gives another
result the next time: the history is walked again from its first day.

* **The goal** is how many pages a week the person wants to write, 1 to 7 (7 from the start: every day). A page counts
  when it has text; the automatic draft of the morning is no page until it is taken.
* **The streak** counts days in a row at goal 7, and weeks in a row (Monday to Sunday, ISO weeks on the person's clock)
  that reached the goal at goal 1 to 6. The week that is running breaks nothing while the goal is still within reach
  (the days left, today included unless it is already written, are enough); it counts as soon as the goal is reached.
* **Shields** are used up on their own. At goal 7 one shield saves one missed day, below that one shield saves one
  missed week. When there are not enough, the streak breaks (and the shields are gone with it). A saved day or week
  holds the streak but does not count into it. Shields are earned by 10 days in a row (goal 7) or 4 weeks in a row
  (below), and by every page of 300 words or more, at most one such shield for each ISO week.

The clock is a parameter (``today``) and the arithmetic takes no database, so the rules are tested with fixed days.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Day
from . import diary

GOAL_MIN, GOAL_MAX = 1, 7
#: Seven pages a week is "every day": the streak counts days.
DAILY = GOAL_MAX
#: A page this long, or longer, earns a shield (pictures do not count as words).
LONG_WORDS = 300
DAYS_PER_SHIELD = 10
WEEKS_PER_SHIELD = 4
#: How many saved days or weeks the statistics tell of.
RESCUES_SHOWN = 5
#: 300 words need 299 gaps between them: a shorter text is never long, and is not counted word by word.
_LONG_CHARS = 2 * LONG_WORDS - 1

_DAY = timedelta(days=1)
_WEEK = timedelta(days=7)


def goal_of(profile: Any) -> int:
    """The goal a person chose; 7 where nothing valid is stored."""
    stored = profile.get("goal") if isinstance(profile, dict) else None
    return stored if type(stored) is int and GOAL_MIN <= stored <= GOAL_MAX else DAILY


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


@dataclass
class _Walk:
    """The streak while the history is walked forward, one day or one week at a time."""

    per_shield: int
    streak: int = 0
    longest: int = 0
    longest_end: date | None = None
    shields: int = 0
    #: The days or weeks saved in the streak that is running (a break forgets them).
    rescued: list[date] = field(default_factory=list)
    long_weeks: set[tuple[int, int]] = field(default_factory=set)

    def reach(self, unit: date) -> None:
        """A day (goal 7) or a week (below) that counts: the streak grows, every so many of them earn a shield."""
        self.streak += 1
        if self.streak >= self.longest:
            self.longest, self.longest_end = self.streak, unit
        if self.streak % self.per_shield == 0:
            self.shields += 1

    def long_page(self, day: date) -> None:
        """A page of 300 words or more: a shield, but only the first one in its ISO week."""
        key = day.isocalendar()[:2]
        if key not in self.long_weeks:
            self.long_weeks.add(key)
            self.shields += 1

    def miss(self, first: date, count: int, step: timedelta) -> None:
        """``count`` units in a row that did not count, the first one at ``first``: shields save them, or the streak
        breaks. Nothing is asked while there is no streak (long gaps cost nothing to walk)."""
        if count <= 0 or self.streak == 0:
            return
        if self.shields >= count:
            self.shields -= count
            self.rescued.extend(first + step * index for index in range(count))
        else:
            self.shields = 0
            self.streak = 0
            # Whatever was saved belonged to a streak that is gone now.
            self.rescued.clear()


def _walk_days(written: dict[date, int]) -> _Walk:
    walk = _Walk(DAYS_PER_SHIELD)
    previous: date | None = None
    for day in sorted(written):
        if previous is not None:
            walk.miss(previous + _DAY, (day - previous).days - 1, _DAY)
        walk.reach(day)
        if written[day] >= LONG_WORDS:
            walk.long_page(day)
        previous = day
    return walk


def _walk_weeks(written: dict[date, int], today: date, goal: int) -> _Walk:
    walk = _Walk(WEEKS_PER_SHIELD)
    counts: dict[date, int] = {}
    long_day: dict[date, date] = {}
    for day, words in written.items():
        week = monday_of(day)
        counts[week] = counts.get(week, 0) + 1
        if words >= LONG_WORDS and (week not in long_day or day < long_day[week]):
            long_day[week] = day
    if not counts:
        return walk
    this = monday_of(today)
    # Days that can still be written this week: those after today, and today itself while it is open.
    left = 6 - today.weekday() + (0 if today in written else 1)
    previous: date | None = None
    for week in sorted(set(counts) | {this}):
        if previous is not None:
            walk.miss(previous + _WEEK, (week - previous).days // 7 - 1, _WEEK)
        if week in long_day:
            walk.long_page(long_day[week])
        count = counts.get(week, 0)
        if count >= goal:
            walk.reach(week)
        elif week < this or goal - count > left:
            walk.miss(week, 1, _WEEK)
        previous = week
    return walk


def compute(written: dict[date, int], today: date, goal: int) -> dict[str, Any]:
    """The streak as of ``today``: ``written`` maps every written page to its number of words.

    ``unit`` is what the streak counts ("days" at goal 7, else "weeks"), ``current`` and ``longest`` are in that unit,
    ``longest_end`` is the day (or the Monday of the week) the longest one ended, ``shields`` those in hand,
    ``week`` this week's pages against the goal, and ``rescues`` the last days or weeks saved in the running streak,
    newest first."""
    pages = {day: words for day, words in written.items() if day <= today}
    walk = _walk_days(pages) if goal >= DAILY else _walk_weeks(pages, today, goal)
    if goal >= DAILY:
        # The days after the last page, up to yesterday, are missed; today is still open and costs nothing.
        last = max(pages, default=None)
        if last is not None and last < today:
            walk.miss(last + _DAY, (today - last).days - 1, _DAY)
    this = monday_of(today)
    return {
        "unit": "days" if goal >= DAILY else "weeks",
        "goal": goal,
        "current": walk.streak,
        "longest": walk.longest,
        "longest_end": walk.longest_end.isoformat() if walk.longest_end else None,
        "today_done": today in pages,
        "shields": walk.shields,
        "week": {"count": sum(1 for day in pages if day >= this), "goal": goal},
        "rescues": [day.isoformat() for day in reversed(walk.rescued[-RESCUES_SHOWN:])],
    }


# --- From the diary -------------------------------------------------------------------------------------------------


def words_of(text: Any) -> int | None:
    """The words of a page that counts (it has text), else None. Short texts are not counted word by word."""
    if not isinstance(text, str) or not text.strip():
        return None
    return diary.words_in(text) if len(text) >= _LONG_CHARS else 1


def written_days(db: Session, account_id: int, dek: bytes, today: date, since: date | None = None) -> dict[date, int]:
    """The written pages of the person up to ``today`` (from ``since`` on, when given) with their words. A page that
    does not open is left out. For the short ones the number is only a stand-in below the limit of a long page."""
    query = select(Day.date, Day.content_enc).where(Day.user_id == account_id, Day.date <= today.isoformat())
    if since is not None:
        query = query.where(Day.date >= since.isoformat())
    out: dict[date, int] = {}
    for row in db.execute(query):
        content = diary._readable_content(account_id, dek, row.date, row.content_enc)
        words = words_of(content["text"]) if content is not None else None
        if words is not None:
            out[date.fromisoformat(row.date)] = words
    return out


def state(db: Session, account_id: int, dek: bytes, today: date, goal: int) -> dict[str, Any]:
    """The streak of the person as of ``today``, read from their own pages."""
    return compute(written_days(db, account_id, dek, today), today, goal)
