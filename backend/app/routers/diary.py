"""The diary over HTTP: notes, days, values and the search, each only for the signed-in person.

A row of another person answers 404, exactly like one that does not exist. The operator has no route here that would
show more than their own diary. Nothing a person wrote reaches the log: no text, no title, no search word.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from ..deps import Account, DbSession
from ..errors import error
from ..services import diary, vault

router = APIRouter(prefix="/api", tags=["diary"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoteIn(Strict):
    #: Made by the browser (a UUID): the same note sent twice is kept once.
    id: str = Field(max_length=36)
    text: str = Field(max_length=diary.NOTE_MAX * 4)
    #: Empty: today in the person's time zone.
    date: str = Field(default="", max_length=10)
    prompt: str | None = Field(default=None, max_length=diary.PROMPT_MAX * 4)


class NoteChangeIn(Strict):
    text: str = Field(max_length=diary.NOTE_MAX * 4)


class DayIn(Strict):
    title: str | None = Field(default=None, max_length=diary.TITLE_MAX * 4)
    text: str | None = Field(default=None, max_length=diary.TEXT_MAX * 2)
    tags: list[Annotated[str, Field(max_length=diary.TAG_MAX * 4)]] | None = Field(default=None,
                                                                                  max_length=diary.TAGS_MAX * 2)
    #: Value id to a whole number from 1 to 10; null takes a rating back. Only the values sent change.
    values: dict[Annotated[str, Field(max_length=32)], Any] | None = Field(default=None,
                                                                          max_length=diary.VALUE_DEFS_MAX * 2)
    written_by: Literal["ai", "self"] | None = None


class ValuesOfDayIn(Strict):
    values: dict[Annotated[str, Field(max_length=32)], Any] = Field(max_length=diary.VALUE_DEFS_MAX * 2)


class ValueIn(Strict):
    name: str = Field(max_length=diary.VALUE_NAME_MAX * 4)
    low: str = Field(default="", max_length=diary.VALUE_END_MAX * 4)
    high: str = Field(default="", max_length=diary.VALUE_END_MAX * 4)
    hint: str = Field(default="", max_length=diary.VALUE_HINT_MAX * 4)
    active: bool = True


class ValueChangeIn(Strict):
    name: str | None = Field(default=None, max_length=diary.VALUE_NAME_MAX * 4)
    low: str | None = Field(default=None, max_length=diary.VALUE_END_MAX * 4)
    high: str | None = Field(default=None, max_length=diary.VALUE_END_MAX * 4)
    hint: str | None = Field(default=None, max_length=diary.VALUE_HINT_MAX * 4)
    active: bool | None = None


class OrderIn(Strict):
    ids: list[Annotated[str, Field(max_length=32)]] = Field(max_length=diary.VALUE_DEFS_MAX * 2)


class SearchIn(Strict):
    #: In the body, not in the address: an address ends up in proxy logs and the browser's history.
    q: str = Field(max_length=diary.SEARCH_MAX * 4)


def _language(account: Any, request: Request) -> str:
    """The language the starting values are written in: the account's, else the browser's first."""
    if account.language:
        return account.language.split("-")[0].lower()
    accepted = request.headers.get("accept-language", "")
    return accepted.split(",")[0].split(";")[0].strip().split("-")[0].lower()


def _values_ready(db: DbSession, account: Any, request: Request) -> bytes:
    dek = vault.dek_for(account.id)
    diary.ensure_values(db, account, dek, _language(account, request))
    return dek


# --- Today ----------------------------------------------------------------------------------------------------------


@router.get("/today", summary="Today in the person's time zone: its notes, its page, the values, the streak")
def today(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    dek = _values_ready(db, account, request)
    day = diary.today_of(account)
    key = day.isoformat()
    return {
        "date": key,
        "notes": diary.list_notes(db, account.id, dek, key),
        "day": diary.get_day(db, account.id, dek, key),
        "values": diary.list_values(db, account.id, dek),
        "streak": diary.streak(db, account.id, dek, day),
    }


# --- Notes ----------------------------------------------------------------------------------------------------------


@router.get("/notes", summary="The notes of one day, oldest first")
def notes(account: Account, db: DbSession, date: Annotated[str, Query(max_length=10)]) -> list[dict[str, Any]]:
    day = diary.check_date(account, date)
    return diary.list_notes(db, account.id, vault.dek_for(account.id), day)


@router.post("/notes", summary="Keep a note; the same id twice keeps one")
def add_note(payload: NoteIn, response: Response, account: Account, db: DbSession) -> dict[str, Any]:
    uid = diary.check_new_note_id(payload.id)
    day = diary.check_date(account, payload.date) if payload.date else diary.today_of(account).isoformat()
    note, new = diary.add_note(db, account.id, vault.dek_for(account.id), uid, day, payload.text, payload.prompt)
    response.status_code = 201 if new else 200
    return note


@router.put("/notes/{note_id}", summary="Change the text of a note")
def change_note(note_id: str, payload: NoteChangeIn, account: Account, db: DbSession) -> dict[str, Any]:
    uid = diary.check_note_id(note_id)
    return diary.change_note(db, account.id, vault.dek_for(account.id), uid, payload.text)


@router.delete("/notes/{note_id}", status_code=204, summary="Delete a note")
def delete_note(note_id: str, account: Account, db: DbSession) -> None:
    diary.delete_note(db, account.id, diary.check_note_id(note_id))


# --- Days -----------------------------------------------------------------------------------------------------------


@router.get("/days", summary="The own days, newest first: date, title, tags, words, values")
def days(
    account: Account,
    db: DbSession,
    before: Annotated[str, Query(max_length=10)] = "",
    limit: Annotated[int, Query(ge=1, le=diary.DAYS_LIST_MAX)] = 100,
) -> list[dict[str, Any]]:
    if before:
        diary.check_date(account, before)
    return diary.list_days(db, account.id, vault.dek_for(account.id), before=before or None, limit=limit)


@router.get("/days/{date}", summary="The page of one day")
def day(date: str, account: Account, db: DbSession) -> dict[str, Any]:
    key = diary.check_date(account, date)
    found = diary.get_day(db, account.id, vault.dek_for(account.id), key)
    if found is None:
        raise error("not_found", "Not found.", 404)
    return found


@router.put("/days/{date}", summary="Make or change the page of a day; only the fields sent change")
def put_day(date: str, payload: DayIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    key = diary.check_date(account, date)
    dek = _values_ready(db, account, request)
    fields = {name: getattr(payload, name) for name in payload.model_fields_set}
    patch = diary.clean_day_patch(db, account.id, fields)
    return diary.change_day(db, account.id, dek, key, lambda content: diary.merge(content, patch))


@router.put("/days/{date}/values", summary="Rate values of a day; null takes a rating back")
def put_values_of_day(date: str, payload: ValuesOfDayIn, request: Request, account: Account,
                      db: DbSession) -> dict[str, Any]:
    key = diary.check_date(account, date)
    dek = _values_ready(db, account, request)
    patch = {"values": diary.check_values(db, account.id, payload.values)}
    return diary.change_day(db, account.id, dek, key, lambda content: diary.merge(content, patch))


@router.delete("/days/{date}", status_code=204, summary="Delete the page of a day (its notes stay)")
def delete_day(date: str, account: Account, db: DbSession) -> None:
    diary.delete_day(db, account.id, diary.check_date(account, date))


# --- Values ---------------------------------------------------------------------------------------------------------


@router.get("/values", summary="The own values, in their order")
def values(request: Request, account: Account, db: DbSession) -> list[dict[str, Any]]:
    return diary.list_values(db, account.id, _values_ready(db, account, request))


@router.post("/values", status_code=201, summary="Add a value of one's own")
def add_value(payload: ValueIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    dek = _values_ready(db, account, request)
    return diary.create_value(db, account.id, dek, payload.model_dump())


@router.put("/values/order", summary="Put the own values in an order; every value once")
def order_values(payload: OrderIn, request: Request, account: Account, db: DbSession) -> list[dict[str, Any]]:
    dek = _values_ready(db, account, request)
    return diary.order_values(db, account.id, dek, payload.ids)


@router.put("/values/{value_id}", summary="Change a value: name, ends, hint, asked or not")
def change_value(value_id: str, payload: ValueChangeIn, request: Request, account: Account,
                 db: DbSession) -> dict[str, Any]:
    dek = _values_ready(db, account, request)
    fields = {name: getattr(payload, name) for name in payload.model_fields_set if getattr(payload, name) is not None}
    return diary.change_value(db, account.id, dek, value_id, fields)


@router.delete("/values/{value_id}", status_code=204, summary="Delete a value (the ratings on past days stay)")
def delete_value(value_id: str, account: Account, db: DbSession) -> None:
    diary.delete_value(db, account.id, value_id)


# --- Search ---------------------------------------------------------------------------------------------------------


@router.post("/search", summary="Search the own titles, texts, tags and notes")
def search(payload: SearchIn, account: Account, db: DbSession) -> dict[str, Any]:
    with diary.SearchBrake(account.id):
        return diary.search(db, account.id, vault.dek_for(account.id), payload.q)
