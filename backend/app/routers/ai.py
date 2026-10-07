"""The AI over HTTP: what a person may know about it, writing a day up, and the operator's settings.

Only ``POST /api/ai/formulate`` sends notes anywhere, and only the asking person's own notes of the day asked for, read
here from the database (nothing the browser sends goes out). Loading a page never reaches the service: the state comes
from the settings alone. The operator's routes are the only way to choose a service, and they never show the key.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession, OperatorAccount
from ..services import ai, diary, vault
from .auth import profile_of

router = APIRouter(prefix="/api", tags=["ai"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FormulateIn(Strict):
    date: str = Field(max_length=10)
    length: Literal["short", "long"] = "long"


class AiSettingsIn(Strict):
    provider: Literal["none", "local", "openai", "messages"] | None = None
    url: str | None = Field(default=None, max_length=255)
    model: str | None = Field(default=None, max_length=200)
    #: Empty removes the key; left out keeps it (unless the address or the kind of service changes).
    key: str | None = Field(default=None, max_length=500)
    #: Whether people may have the day before written up in the morning on their own (off from the start).
    auto_allowed: bool | None = None


class ModelsIn(Strict):
    provider: Literal["local", "openai", "messages"] | None = None
    url: str | None = Field(default=None, max_length=255)
    key: str | None = Field(default=None, max_length=500)


def own_switch(account: Any) -> bool:
    return bool(profile_of(account.profile)["ai"])


@router.get("/ai", summary="Whether this person can have a day written up, by which kind of service, and where to")
def state(account: Account, db: DbSession) -> dict[str, Any]:
    return ai.state(db, own_switch(account), bool(account.ai_allowed))


@router.post("/ai/formulate", summary="A suggestion for the page of a day, made from its notes by the AI")
def formulate(payload: FormulateIn, account: Account, db: DbSession) -> dict[str, str]:
    """Never on its own: only when the person presses the button. The notes stay as they are; the suggestion goes
    back to the writing view and is saved only when the person saves the page."""
    switch = own_switch(account)
    # The refusals that need no notes come first: a person who switched the AI off is not even asked for a date.
    ai.check_allowed(db, account.id)
    ai.usable(db, switch)
    day = diary.check_date(account, payload.date)
    notes = diary.list_notes(db, account.id, vault.dek_for(account.id), day)
    return ai.formulate(db, account.id, switch, notes, diary.zone_of(account), payload.length)


# --- The operator ---------------------------------------------------------------------------------------------------


@router.get("/settings/ai", summary="The AI service of the server, without its key")
def settings(_operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return ai.operator_view(db)


@router.put("/settings/ai", summary="Choose the AI service of the server; only the fields sent change")
def save(payload: AiSettingsIn, _operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return ai.save(db, provider=payload.provider, url=payload.url, model=payload.model, key=payload.key,
                   auto_allowed=payload.auto_allowed)


@router.post("/settings/ai/models", summary="The models a service offers, with the address typed or stored")
def models(payload: ModelsIn, operator: OperatorAccount, db: DbSession) -> list[dict[str, str]]:
    return ai.list_models(db, operator.id, provider=payload.provider, url=payload.url, key=payload.key)


@router.post("/settings/ai/probe", summary="One tiny question to the stored service, with nothing of a diary in it")
def probe(operator: OperatorAccount, db: DbSession) -> dict[str, float]:
    return {"seconds": ai.probe(db, operator.id)}
