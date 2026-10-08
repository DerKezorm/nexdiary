"""The statistics over HTTP: one read, only the signed-in person's own days, worked out on the server."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..deps import Account, DbSession
from ..services import brakes, diary, stats, streaks, vault

router = APIRouter(prefix="/api", tags=["statistics"])


@router.get("/stats", summary="The statistics of the own days, worked out on the server")
def get_stats(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """A look opens every sealed day of the person once, so it is braked per person and minute. Nothing is kept."""
    brakes.take("stats", account.id)
    dek = vault.dek_for(account.id)
    # The starting values are laid out on the first look at the diary, so a person who opens this page first has them.
    diary.ensure_values(db, account, dek, _language(account, request))
    return stats.compute(db, account.id, dek, diary.today_of(account), streaks.goal_of(account.profile))


def _language(account: Any, request: Request) -> str:
    """The language the starting values are written in: the account's, else the one the page is shown in."""
    from .auth import interface_language

    return (account.language or interface_language(request)).split("-")[0].lower()
