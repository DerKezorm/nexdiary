"""The cover of a day: every day has one, a photo of the person's own or one of the illustrations.

An illustration is named ``<motif>.<time>.<season>``: 16 motifs, each at four times of day and in four seasons. The
interface draws them (``frontend/src/covers``); the server only has to know which names exist, so that a day never
stores a cover nobody can draw. The lists here mirror ``frontend/src/covers/catalog.json``, and
``tests/test_covers.py`` fails when the two part. A new motif is one entry there and one here.

A day without a chosen cover, or whose cover photo was deleted, shows the suggestion: the season from the date, the
evening (when one writes), the motif from the tags. So no day is ever without a picture.
"""

from __future__ import annotations

import re

TIMES = ("morgen", "tag", "abend", "nacht")
SEASONS = ("fruehling", "sommer", "herbst", "winter")
#: In the order of the catalog.
MOTIFS = (
    "berge", "wald", "baum", "feld", "weg", "garten", "zelt", "strand",
    "boot", "leuchtturm", "haus", "stadt", "kaffee", "buch", "kuchen", "regen",
)
DEFAULTS = ("baum", "haus", "buch", "weg", "berge", "kaffee")
#: A tag of the day and the motif it calls for, in the order they are looked at.
TAG_MOTIFS: tuple[tuple[str, str], ...] = (
    ("urlaub", "strand"), ("vacation", "strand"), ("holiday", "strand"),
    ("sport", "weg"),
    ("arbeit", "stadt"), ("work", "stadt"),
    ("kochen", "kaffee"), ("cooking", "kaffee"),
    ("familie", "haus"), ("family", "haus"),
    ("freunde", "kuchen"), ("friends", "kuchen"),
    ("gedanken", "buch"), ("thoughts", "buch"),
    ("gesundheit", "garten"), ("health", "garten"),
    ("draußen", "wald"), ("outdoors", "wald"),
    ("herbst", "baum"), ("autumn", "baum"),
)
SUGGESTIONS = 6
DEFAULT_TIME = "abend"

ILLUSTRATIONS: frozenset[str] = frozenset(
    f"{motif}.{time}.{season}" for motif in MOTIFS for time in TIMES for season in SEASONS
)

ILLU_PREFIX = "illu:"
PHOTO_PREFIX = "photo:"
PHOTO_ID = re.compile(r"^[0-9a-f]{32}$")


def season_of(day: str) -> str:
    """The season of a ``YYYY-MM-DD`` (the northern one, as the illustrations are drawn)."""
    month = int(day[5:7])
    if 3 <= month <= 5:
        return "fruehling"
    if 6 <= month <= 8:
        return "sommer"
    if 9 <= month <= 11:
        return "herbst"
    return "winter"


def suggest(day: str, tags: list[str], time: str = DEFAULT_TIME) -> list[str]:
    """The illustrations that fit a day, best first: the motifs its tags call for, then the usual ones."""
    season = season_of(day)
    time = time if time in TIMES else DEFAULT_TIME
    motifs: list[str] = []
    for tag, motif in TAG_MOTIFS:
        if tag in tags and motif not in motifs:
            motifs.append(motif)
    for motif in DEFAULTS:
        if motif not in motifs:
            motifs.append(motif)
    return [f"{motif}.{time}.{season}" for motif in motifs[:SUGGESTIONS]]


def suggested_cover(day: str, tags: list[str]) -> str:
    return ILLU_PREFIX + suggest(day, tags)[0]


def photo_of(cover: str | None) -> str | None:
    """The photo id a cover names, or None."""
    if isinstance(cover, str) and cover.startswith(PHOTO_PREFIX):
        uid = cover[len(PHOTO_PREFIX) :]
        return uid if PHOTO_ID.match(uid) else None
    return None


def is_illustration(cover: str | None) -> bool:
    return isinstance(cover, str) and cover.startswith(ILLU_PREFIX) and cover[len(ILLU_PREFIX) :] in ILLUSTRATIONS
