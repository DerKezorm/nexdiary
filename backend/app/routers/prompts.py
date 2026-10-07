"""Writing prompts over HTTP: the own choice of questions, the question of the day and the questions to insert while
writing. Each only for the signed-in person; the own questions are sealed like the diary.

Every change is a single one (questions on or off, one group, one own question added or removed), made on what
stands: two tabs or two devices never overwrite each other's choice with a whole list."""

from __future__ import annotations

from datetime import date as Day
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..services import diary, prompts, vault

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OnIn(Strict):
    on: bool


class OwnIn(Strict):
    text: str = Field(max_length=prompts.QUESTION_MAX * 4)


def language(account: Any, request: Request) -> str:
    """The language the questions come in: the account's, else the page's, else the browser's."""
    from .auth import interface_language

    return account.language or interface_language(request)


def _view(choice: dict[str, Any], account: Any, request: Request) -> dict[str, Any]:
    return prompts.view(choice, language(account, request))


@router.get("", summary="The own choice of questions: on or off, the groups, the own questions")
def read(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return _view(prompts.choice_of(db, account.id, vault.dek_for(account.id)), account, request)


@router.put("", summary="Questions on or off")
def switch(payload: OnIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return _view(prompts.switch(db, account.id, vault.dek_for(account.id), payload.on), account, request)


@router.put("/sets/{set_id}", summary="One group of questions on or off")
def switch_set(set_id: str, payload: OnIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    choice = prompts.switch_set(db, account.id, vault.dek_for(account.id), set_id[:32], payload.on)
    return _view(choice, account, request)


@router.post("/own", status_code=201, summary="Add an own question")
def add_own(payload: OwnIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    return _view(prompts.add_own(db, account.id, vault.dek_for(account.id), payload.text), account, request)


@router.delete("/own/{question_id}", summary="Remove an own question")
def remove_own(question_id: str, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    choice = prompts.remove_own(db, account.id, vault.dek_for(account.id), question_id[:32])
    return _view(choice, account, request)


@router.post("/another", summary="Another question of the day, kept for the rest of the day")
def another(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    question = prompts.another(db, account.id, vault.dek_for(account.id), diary.today_of(account),
                               language(account, request))
    return {"question": question}


@router.get("/pool", summary="The questions to insert while writing a day, the question of that day first")
def pool(request: Request, account: Account, db: DbSession,
         date: Annotated[str, Query(max_length=10)]) -> dict[str, Any]:
    day = diary.check_date(account, date)
    questions = prompts.pool(db, account.id, vault.dek_for(account.id), Day.fromisoformat(day),
                             language(account, request))
    return {"questions": questions}
