"""Brakes on writing, per person and minute: a stolen session or a stuck script must not fill the disk or keep the
server busy. Far above what a person does by hand (a draft goes out every few seconds while typing; a photo is picked
one at a time), so nobody writing a diary ever meets one.

Kept in memory, per process: a restart forgets them, which is fine for a brake.
"""

from __future__ import annotations

import threading
import time
from collections import deque

from ..errors import error

#: Per person and minute.
LIMITS = {
    "upload": 30,
    "draft": 120,
    "new_day": 60,
    "new_note": 120,
    #: A look at the own Immich: the photos of a day, a probe, saving the link.
    "immich": 30,
    #: The small pictures of Immich: sixty on a day, a few pages in a minute.
    "immich_thumb": 600,
}
#: The code and the sentence of the answer.
CODES = {
    "upload": ("too_many_uploads", "Too many photos at once. Wait a minute."),
    "draft": ("slow_down_writing", "Too much at once. Wait a minute."),
    "new_day": ("slow_down_writing", "Too much at once. Wait a minute."),
    "new_note": ("slow_down_writing", "Too much at once. Wait a minute."),
    "immich": ("immich_too_often", "Too many requests to Immich. Wait a minute."),
    "immich_thumb": ("immich_too_often", "Too many requests to Immich. Wait a minute."),
}

_lock = threading.Lock()
_seen: dict[tuple[str, int], deque[float]] = {}


def take(kind: str, account_id: int) -> None:
    """One more of ``kind`` for this person, or ``429`` with ``Retry-After`` when the minute is full."""
    moment = time.monotonic()
    with _lock:
        seen = _seen.setdefault((kind, account_id), deque())
        while seen and moment - seen[0] > 60:
            seen.popleft()
        if len(seen) >= LIMITS[kind]:
            code, text = CODES[kind]
            exc = error(code, text, 429)
            exc.headers = {"Retry-After": "60"}
            raise exc
        seen.append(moment)


def forget() -> None:
    """For the tests."""
    with _lock:
        _seen.clear()
