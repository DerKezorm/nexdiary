"""The server's clock, in one place so that tests can set it (``monkeypatch.setattr(clock, "now", ...)``)."""

from __future__ import annotations

from datetime import UTC, datetime


def now() -> datetime:
    """The current moment, in UTC."""
    return datetime.now(UTC)
