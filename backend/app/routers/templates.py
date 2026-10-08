"""Templates for the pages over HTTP: the person's own list, read and replaced as a whole.

Only for the signed-in person, sealed like the diary, and not among the routes an API token reaches. A save names the
revision it was read at: a list changed elsewhere in between is refused (409) and read again, never overwritten unseen.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..services import templates as service
from ..services import vault

router = APIRouter(prefix="/api/templates", tags=["templates"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SectionIn(Strict):
    heading: str = Field(max_length=service.HEADING_MAX * 4)
    question: str = Field(default="", max_length=service.QUESTION_MAX * 4)


class TemplateIn(Strict):
    #: Left out for a new template; the id of one the person has otherwise.
    id: str | None = Field(default=None, max_length=32)
    name: str = Field(max_length=service.NAME_MAX * 4)
    sections: list[SectionIn] = Field(max_length=service.MAX_SECTIONS)


class TemplatesIn(Strict):
    templates: list[TemplateIn] = Field(max_length=service.MAX_TEMPLATES)
    default: str | None = Field(default=None, max_length=32)
    revision: int = Field(strict=True, ge=service.NO_ROW, le=2**31)


@router.get("", summary="The own templates for the pages, the default one, and the revision they stand at")
def read(account: Account, db: DbSession) -> dict[str, Any]:
    return service.read(db, account.id, vault.dek_for(account.id))


@router.put("", summary="Replace the templates and the default, onto the revision that was read")
def save(payload: TemplatesIn, account: Account, db: DbSession) -> dict[str, Any]:
    return service.save(db, account.id, vault.dek_for(account.id), [entry.model_dump() for entry in payload.templates],
                          payload.default, payload.revision)
