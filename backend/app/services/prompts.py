"""Writing prompts: small questions for the days when nothing comes to mind.

Six groups ship with nexdiary, each in German and English; a person switches groups on and off and adds questions of
their own. What a person chose is sealed with their data key like the diary (``WritingPrompts``): the own questions
say something about the person, and so do the groups.

The question of the day is the same all day for the same person, on every device and in every language, and not the
same for everybody: every question has a stable id (``schoen.0`` for the first of a group, ``own.<hex>`` for an own
one), the questions of the groups switched on stand in an order of the person's own (a hash of person and id, so it
does not change when another group is switched on or the language changes), and the day picks its place in that
order; the language only chooses the words. A note keeps the id of the question it answers. "Another question"
moves one place on, for that day only. A question already answered today is passed over. On Sundays the group
"Looking back on Sunday" has the day, if it is on; on the other days its questions are not asked.

``question_for`` gives the question of a day to whoever needs one without a request, such as a reminder.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import date
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, WritingPrompts
from . import diary, vault

#: The own questions a person may keep, and how long one may be (as long as the question a note keeps).
OWN_MAX = 50
QUESTION_MAX = diary.PROMPT_MAX
#: How often a change is tried again when another change came in between.
CHANGE_TRIES = 8
#: The group that belongs to Sundays.
SUNDAY = "rueckblick"

#: The groups, in their order. ``on``: switched on for a new account.
SETS: list[dict[str, Any]] = [
    {
        "id": "schoen",
        "on": True,
        "de": ("Schöne Momente", [
            "Was hat dich heute glücklich gemacht?",
            "Worüber hast du heute gelacht?",
            "Welcher Moment von heute soll bleiben?",
            "Was war heute leichter als gedacht?",
        ]),
        "en": ("Lovely moments", [
            "What made you happy today?",
            "What did you laugh about today?",
            "Which moment of today should stay?",
            "What was easier today than you thought?",
        ]),
    },
    {
        "id": "gefuehle",
        "on": True,
        "de": ("Gefühle", [
            "Was hat dich heute traurig gemacht?",
            "Was hat dich geärgert, und warum?",
            "Wovor hattest du heute Angst?",
            "Was liegt dir gerade auf dem Herzen?",
        ]),
        "en": ("Feelings", [
            "What made you sad today?",
            "What annoyed you, and why?",
            "What were you afraid of today?",
            "What is on your mind right now?",
        ]),
    },
    {
        "id": "wuensche",
        "on": True,
        "de": ("Wünsche und Ziele", [
            "Was ist gerade dein größter Wunsch?",
            "Worauf freust du dich?",
            "Was möchtest du morgen anders machen?",
            "Wo willst du in einem Jahr stehen?",
        ]),
        "en": ("Wishes and goals", [
            "What is your biggest wish right now?",
            "What are you looking forward to?",
            "What would you like to do differently tomorrow?",
            "Where do you want to be in a year?",
        ]),
    },
    {
        "id": "dank",
        "on": True,
        "de": ("Dankbarkeit", [
            "Wofür bist du heute dankbar?",
            "Wer hat dir heute gutgetan?",
            "Welche Kleinigkeit hat deinen Tag besser gemacht?",
        ]),
        "en": ("Gratitude", [
            "What are you grateful for today?",
            "Who was good for you today?",
            "Which small thing made your day better?",
        ]),
    },
    {
        "id": "menschen",
        "on": False,
        "de": ("Familie und Freunde", [
            "Mit wem hast du heute gern Zeit verbracht?",
            "Wem möchtest du mal wieder schreiben?",
            "Was hat jemand heute Schönes zu dir gesagt?",
        ]),
        "en": ("Family and friends", [
            "Who did you enjoy spending time with today?",
            "Who would you like to write to again?",
            "What kind thing did someone say to you today?",
        ]),
    },
    {
        "id": SUNDAY,
        "on": False,
        "de": ("Rückblick am Sonntag", [
            "Was war das Beste an dieser Woche?",
            "Was hast du diese Woche gelernt?",
            "Was nimmst du dir für nächste Woche vor?",
        ]),
        "en": ("Looking back on Sunday", [
            "What was the best thing about this week?",
            "What did you learn this week?",
            "What do you plan for next week?",
        ]),
    },
]
SET_IDS = tuple(entry["id"] for entry in SETS)
_OWN_ID = re.compile(r"^own\.[0-9a-f]{12}$")


def language_of(code: str) -> str:
    """The language the shipped questions come in: German for German, English for every other."""
    return "de" if (code or "").split("-")[0].lower() == "de" else "en"


def default_choice() -> dict[str, Any]:
    return {"on": True, "sets": [entry["id"] for entry in SETS if entry["on"]], "own": [], "day": "", "shift": 0}


def new_own_id() -> str:
    return "own." + secrets.token_hex(6)


def _aad(account_id: int) -> bytes:
    return vault.aad(account_id, "writing_prompts", "content", str(account_id))


def _clean(stored: Any) -> dict[str, Any]:
    """What was stored, with anything that is not as it should be put back to the default."""
    out = default_choice()
    if not isinstance(stored, dict):
        return out
    if isinstance(stored.get("on"), bool):
        out["on"] = stored["on"]
    if isinstance(stored.get("sets"), list):
        out["sets"] = [entry for entry in SET_IDS if entry in stored["sets"]]
    if isinstance(stored.get("own"), list):
        own = []
        for entry in stored["own"]:
            if isinstance(entry, dict) and isinstance(entry.get("text"), str) and _OWN_ID.match(str(entry.get("id"))):
                own.append({"id": entry["id"], "text": entry["text"]})
        out["own"] = own[:OWN_MAX]
    if isinstance(stored.get("day"), str):
        out["day"] = stored["day"]
    if type(stored.get("shift")) is int and stored["shift"] >= 0:
        out["shift"] = stored["shift"]
    return out


def _row(db: Session, account_id: int) -> Any:
    return db.execute(select(WritingPrompts.content_enc, WritingPrompts.revision)
                      .where(WritingPrompts.user_id == account_id)).first()


def choice_of(db: Session, account_id: int, dek: bytes) -> dict[str, Any]:
    """What the person chose; the default while nothing was chosen, and when the stored choice does not open."""
    row = _row(db, account_id)
    if row is None:
        return default_choice()
    try:
        return _clean(vault.open_json(dek, row.content_enc, _aad(account_id)))
    except vault.SealError:
        diary.unreadable("writing_prompts")
        return default_choice()


def _change(db: Session, account_id: int, dek: bytes, apply: Any) -> dict[str, Any]:
    """Reads the choice, lets ``apply`` change it and writes it back onto exactly the revision it was read from: two
    tabs changing it at once both count."""
    for _ in range(CHANGE_TRIES):
        row = _row(db, account_id)
        if row is None:
            content = _clean(apply(default_choice()))
            written = db.execute(
                sqlite_insert(WritingPrompts)
                .values(user_id=account_id, revision=0, updated_at=diary.now(),
                        content_enc=vault.seal_json(dek, content, _aad(account_id)))
                .on_conflict_do_nothing(index_elements=[WritingPrompts.user_id])
            )
        else:
            try:
                standing = _clean(vault.open_json(dek, row.content_enc, _aad(account_id)))
            except vault.SealError:
                diary.unreadable("writing_prompts")
                standing = default_choice()
            content = _clean(apply(standing))
            written = db.execute(
                update(WritingPrompts)
                .where(WritingPrompts.user_id == account_id, WritingPrompts.revision == row.revision)
                .values(content_enc=vault.seal_json(dek, content, _aad(account_id)), revision=row.revision + 1,
                        updated_at=diary.now())
            )
        db.commit()
        if written.rowcount == 1:
            return content
    raise error("busy", "nexdiary is busy. Try again in a moment.", 503)


# --- Changes, one at a time: two tabs never overwrite each other's ---------------------------------------------------


def switch(db: Session, account_id: int, dek: bytes, on: bool) -> dict[str, Any]:
    def apply(content: dict[str, Any]) -> dict[str, Any]:
        content["on"] = on
        return content

    return _change(db, account_id, dek, apply)


def switch_set(db: Session, account_id: int, dek: bytes, set_id: str, on: bool) -> dict[str, Any]:
    """One group on or off; the others as they stand."""
    if set_id not in SET_IDS:
        raise error("prompt_set_unknown", "There is no such group of questions.", 422)

    def apply(content: dict[str, Any]) -> dict[str, Any]:
        chosen = set(content["sets"]) | {set_id} if on else set(content["sets"]) - {set_id}
        content["sets"] = [entry for entry in SET_IDS if entry in chosen]
        return content

    return _change(db, account_id, dek, apply)


def add_own(db: Session, account_id: int, dek: bytes, text: Any) -> dict[str, Any]:
    """An own question, with an id of its own; the same words twice stay one question."""
    if not isinstance(text, str):
        raise error("invalid_input", "The input is not valid.", 422, fields=["text"])
    line = diary.clean_line(text, QUESTION_MAX, "question_too_long")
    if not line:
        raise error("question_empty", "A question needs words.", 422)

    def apply(content: dict[str, Any]) -> dict[str, Any]:
        if any(entry["text"] == line for entry in content["own"]):
            return content
        if len(content["own"]) >= OWN_MAX:
            raise error("too_many_questions", "There are as many own questions as there may be.", 409, max=OWN_MAX)
        content["own"] = [*content["own"], {"id": new_own_id(), "text": line}]
        return content

    return _change(db, account_id, dek, apply)


def remove_own(db: Session, account_id: int, dek: bytes, question_id: str) -> dict[str, Any]:
    """An own question gone; one that is gone already changes nothing."""
    def apply(content: dict[str, Any]) -> dict[str, Any]:
        content["own"] = [entry for entry in content["own"] if entry["id"] != question_id]
        return content

    return _change(db, account_id, dek, apply)


def view(choice: dict[str, Any], language: str) -> dict[str, Any]:
    """The choice as the settings show it: every group with its name, its questions and whether it is on."""
    lang = language_of(language)
    return {
        "on": choice["on"],
        "sets": [
            {"id": entry["id"], "name": entry[lang][0], "questions": list(entry[lang][1]),
             "on": entry["id"] in choice["sets"]}
            for entry in SETS
        ],
        "own": [dict(entry) for entry in choice["own"]],
    }


# --- The question of the day ---------------------------------------------------------------------------------------


def _shipped(lang: str) -> dict[str, str]:
    """Every shipped question by its id, in one language."""
    return {f"{entry['id']}.{index}": text for entry in SETS for index, text in enumerate(entry[lang][1])}


def _ordered(account_id: int, ids: list[str]) -> list[str]:
    """The questions in the person's own order, from the person and each question's id: the same every day and in
    every language, another one for another person."""
    return sorted(dict.fromkeys(ids), key=lambda qid: hashlib.sha256(f"{account_id}|{qid}".encode()).digest())


def _groups(choice: dict[str, Any], day: date) -> tuple[list[str], list[str]]:
    """The ids the day asks first, and the others. On a Sunday the Sunday group first, if it is on."""
    sunday = day.isoweekday() == 7 and SUNDAY in choice["sets"]
    first: list[str] = []
    rest: list[str] = []
    for entry in SETS:
        if entry["id"] not in choice["sets"]:
            continue
        ids = [f"{entry['id']}.{index}" for index in range(len(entry["de"][1]))]
        if entry["id"] == SUNDAY:
            if sunday:
                first.extend(ids)
            continue
        rest.extend(ids)
    rest.extend(entry["id"] for entry in choice["own"])
    return (first, rest) if sunday else (rest, [])


def _answered(db: Session, account_id: int, dek: bytes, day: str, choice: dict[str, Any]) -> set[str]:
    """The ids answered on a day. A note keeps the id of its question; a note from before the ids is known by its
    words in either language."""
    by_words = {text: qid for lang in ("de", "en") for qid, text in _shipped(lang).items()}
    by_words.update({entry["text"]: entry["id"] for entry in choice["own"]})
    found: set[str] = set()
    for note in diary.list_notes(db, account_id, dek, day):
        if note.get("prompt_id"):
            found.add(note["prompt_id"])
        elif note.get("prompt") in by_words:
            found.add(by_words[note["prompt"]])
    return found


def pool(db: Session, account_id: int, dek: bytes, day: date, language: str) -> list[dict[str, str]]:
    """Every question of the day with its id, the question of the day first, then the rest of its group in order,
    then the others: for writing the day up. Empty when the person switched questions off."""
    choice = choice_of(db, account_id, dek)
    if not choice["on"]:
        return []
    key = day.isoformat()
    shift = choice["shift"] if choice["day"] == key else 0
    answered = _answered(db, account_id, dek, key, choice)
    out: list[str] = []
    for group in _groups(choice, day):
        ordered = _ordered(account_id, group)
        if not ordered:
            continue
        start = (day.toordinal() + shift) % len(ordered)
        turned = ordered[start:] + ordered[:start]
        # The questions answered today go to the end of their group: the question of the day is a new one.
        out.extend([qid for qid in turned if qid not in answered] + [qid for qid in turned if qid in answered])
    texts = {**_shipped(language_of(language)), **{entry["id"]: entry["text"] for entry in choice["own"]}}
    return [{"id": qid, "text": texts[qid], "answered": qid in answered} for qid in dict.fromkeys(out)]


def question_of_day(db: Session, account_id: int, dek: bytes, day: date, language: str) -> dict[str, str] | None:
    """The question of the day (id and words), or None: questions switched off, none chosen, or every one answered
    today."""
    for question in pool(db, account_id, dek, day, language):
        if not question["answered"]:
            return {"id": question["id"], "text": question["text"]}
    return None


def another(db: Session, account_id: int, dek: bytes, day: date, language: str) -> dict[str, str] | None:
    """Moves the question of ``day`` one place on, for that day, and gives the new one."""
    key = day.isoformat()

    def apply(content: dict[str, Any]) -> dict[str, Any]:
        content["shift"] = content["shift"] + 1 if content["day"] == key else 1
        content["day"] = key
        return content

    _change(db, account_id, dek, apply)
    return question_of_day(db, account_id, dek, day, language)


def question_for(db: Session, account: Account, day: date | None = None) -> dict[str, str] | None:
    """The question of the day for a person, in their language, without a request (a reminder brings it along)."""
    return question_of_day(db, account.id, vault.dek_for(account.id), day or diary.today_of(account),
                           account.language or "")


__all__ = ["add_own", "another", "choice_of", "pool", "question_for", "question_of_day", "remove_own", "switch",
           "switch_set", "view"]
