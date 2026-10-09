"""A year as a book over HTTP: start setting it, ask how far it is, fetch the PDF once, or give it up.

Everything here is the signed-in person's own: a job of somebody else answers 404 like one that never was. The PDF
goes out only to the person who asked for it, and only once.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..services import book, diary

router = APIRouter(prefix="/api/book", tags=["book"])


class BookIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    year: int = Field(ge=diary.EARLIEST.year, le=9999)
    format: Literal["a5", "a4"] = "a5"
    #: Photos and covers in the book.
    photos: bool = True
    #: The values under each day.
    values: bool = False
    #: The raw notes, gathered in an appendix.
    notes: bool = False


def _language(account: Any, request: Request) -> str:
    from .auth import interface_language

    return (account.language or interface_language(request) or "").split("-")[0].lower()


@router.post("", status_code=202, summary="Start setting the book of a year; it is made in the background")
def start(payload: BookIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    options = book.Options(year=payload.year, format=payload.format, photos=payload.photos, values=payload.values,
                           notes=payload.notes, language=_language(account, request))
    return book.start(db, account, options)


@router.get("/{job_id}", summary="How far the own book is: working, done (with its pages) or failed")
def status(job_id: str, account: Account) -> dict[str, Any]:
    return book.status(job_id, account.id)


@router.get("/{job_id}/pdf", summary="The finished book as a PDF, once; afterwards it is gone from the server")
def pdf(job_id: str, account: Account) -> StreamingResponse:
    year, pieces = book.fetch(job_id, account.id)
    return StreamingResponse(pieces, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="nexdiary-{year}.pdf"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


@router.delete("/{job_id}", status_code=204, summary="Give up the own book: stop setting it, or throw it away")
def discard(job_id: str, account: Account) -> Response:
    book.discard(job_id, account.id)
    return Response(status_code=204)
