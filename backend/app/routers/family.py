"""The family question over HTTP: the question of today, who joined and who answered, and the answers once the own
one is given; the answers of a past date again, for whoever answered then. Only for people who joined
(``profile.family``); the rules are kept in ``services/family.py``. Nothing a person answered reaches the log."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..services import brakes, diary, family
from .prompts import language

router = APIRouter(prefix="/api/family", tags=["family"])


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The day the question was shown for; an answer counts for today only.
    date: str = Field(max_length=10)
    text: str = Field(max_length=family.ANSWER_MAX * 4)
    #: Made by the browser (a UUID): the note the answer becomes. The same answer sent twice keeps one note.
    note_id: str = Field(max_length=36)


@router.get("", summary="The family question of today, who joined, who answered, and the answers after the own")
def today(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return family.view(db, account, language(account, request))


@router.get("/day/{date}", summary="The family question of a date with the answers, for a person who answered then")
def of_date(date: str, request: Request, account: Account, db: DbSession) -> dict[str, Any] | None:
    """Null for a person who did not answer on that date (or has not joined): the same as a date nobody answered on."""
    return family.view_of_date(db, account, diary.check_date(account, date), language(account, request))


@router.put("/answer", summary="Answer the family question of today; an answer is final")
def put_answer(payload: AnswerIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    brakes.take("family", account.id)
    return family.answer(db, account, payload.date, payload.text, payload.note_id, language(account, request))
