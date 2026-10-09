"""Looking back over HTTP: a week or a month of the own pages, the strip on "Today", and the summary by the AI.

Like the statistics: one request opens the days of one period of the signed-in person and nothing of anybody else.
The summary goes to the AI only on a press of the button, made from the pages read here from the database (nothing
the browser sends goes out), and is never stored.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..services import ai, brakes, diary, review, vault
from .ai import own_switch

router = APIRouter(prefix="/api/review", tags=["review"])

Kind = Literal["week", "month"]


class SummaryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The first day of the period: a Monday, or the 1st of the month.
    start: str = Field(max_length=10)


def _language(account: Any, request: Request) -> str:
    from .auth import interface_language

    return (account.language or interface_language(request) or "").split("-")[0].lower()


@router.get("/teaser", summary="The strip on Today: last week or last month, when there is something to look back on")
def teaser(account: Account, db: DbSession) -> dict[str, Any]:
    brakes.take("stats", account.id)
    return {"teaser": review.teaser(db, account.id, vault.dek_for(account.id), diary.today_of(account))}


@router.get("/{kind}", summary="A week or a month of the own pages, worked out on the server")
def period(kind: Kind, account: Account, db: DbSession,
           start: Annotated[str, Query(max_length=10)] = "") -> dict[str, Any]:
    """Empty ``start``: the last one that is over. Only periods that are over; a later one answers 404."""
    brakes.take("stats", account.id)
    today = diary.today_of(account)
    first = review.check_start(kind, start, today)
    return review.compute(db, account.id, vault.dek_for(account.id), kind, first, today)


@router.post("/{kind}/summary", summary="The period in a few sentences, by the AI, from the own pages")
def summary(kind: Kind, payload: SummaryIn, request: Request, account: Account, db: DbSession) -> dict[str, str]:
    """Never on its own, never stored. Refused like writing a day up when the AI is off for the person."""
    switch = own_switch(account)
    ai.check_allowed(db, account.id)
    ai.usable(db, switch)
    first = review.check_start(kind, payload.start, diary.today_of(account))
    pages = review.summary_pages(db, account.id, vault.dek_for(account.id), kind, first)
    return ai.summarize(db, account.id, switch, pages, kind, _language(account, request), diary.zone_of(account))
