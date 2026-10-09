"""The family question: every day one question for everybody on the server who joined, answered by each for themselves.

The rules, all of them kept here on the server:

* **Only who joined.** Joining is a choice of each person (``profile.family``, off from the start). Whoever has not
  joined sees no question, no answer and nobody's name here, and cannot answer. Blocked accounts are as if they had not
  joined: they are not listed and their answers are not shown.
* **One date for everybody.** The family question belongs to the calendar day of the server's own time zone (``TZ`` of
  the container, the zone the app falls back to for anybody without one), the same for every person whatever their own
  zone: changing the own zone reaches no other day. Answers are taken and shown for that one date only. The question is
  picked from the date; the language only chooses its words.
* **The others' answers only after the own.** The server gives out the answers of the others only to a person who
  answered that day themselves, and only while both have joined. Before that it says who answered, nothing of what
  (not even how long). An answer is final: it cannot be taken back or changed (``family_answered``), so whoever read
  the others has left a trace, and what they read was answered without knowing the others.
* **Read again on the day.** The answers of a date can be read again later (``view_of_date``, the reading page of the
  day), by the same rules: only by a person who answered on that date, only the answers of those who joined and are
  not blocked. Whoever did not answer gets nothing, not even a sign that there were answers.
* **Leaving takes the answers along.** Whoever leaves loses all their answers in the same transaction (``leave``): from
  then on nobody sees them. The notes the answers became stay with the person. Joining again counts from the next day
  of the server's zone (``profile.family_left`` holds the day of leaving): leaving and joining on the same day is no
  way to give today's answer a second time. Until then the person is as if they had not joined.
* **Sealed with the key of the one who answered**, at most ``ANSWER_MAX`` characters, one per person and day. The
  answer is a note as well, with the question, like the question of the day: on the person's own day of notes (after
  midnight the day they said the night belongs to). That note is the person's like any other note: they may change or
  delete it, the answer stays as it was given. Answering is for today only.

The operator has no route here. Answering twice at once leaves one answer and one note (``answer`` writes the answer and
its note in one transaction); the second is refused, unless it is the same press again (same words, same note).
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, tzinfo
from typing import Any

from fastapi import HTTPException
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.orm import Session

from .. import clock
from ..errors import error
from ..models import Account, FamilyAnswer, UtcDateTime
from . import diary, vault

#: The longest answer.
ANSWER_MAX = 500
#: The most people listed: a family is far smaller.
PEOPLE_MAX = 200
#: The prefix of the ids of these questions (``familie.0``); a note keeps the id of the question it answers.
PREFIX = "familie"

#: Light questions for every age (children join in too), in German and English, in the same order. None of them asks
#: for a quarrel or for something that shows anybody up.
QUESTIONS: tuple[tuple[str, str], ...] = (
    ("Was war heute das Leckerste, das du gegessen hast?", "What was the tastiest thing you ate today?"),
    ("Worüber hast du heute gelacht?", "What made you laugh today?"),
    ("Was hast du heute Neues gelernt?", "What did you learn today?"),
    ("Welches Tier hast du heute gesehen?", "Which animal did you see today?"),
    ("Was war heute dein schönster Moment?", "What was your best moment today?"),
    ("Welche Farbe hatte dein Tag?", "What colour was your day?"),
    ("Was hat dich heute überrascht?", "What surprised you today?"),
    ("Wem hast du heute geholfen?", "Who did you help today?"),
    ("Was hast du heute draußen entdeckt?", "What did you discover outside today?"),
    ("Welches Lied ging dir heute durch den Kopf?", "Which song was in your head today?"),
    ("Was hast du heute zum ersten Mal gemacht?", "What did you do for the first time today?"),
    ("Wenn dein Tag ein Wetter wäre, welches wäre er?", "If your day were weather, what would it be?"),
    ("Was war heute ein bisschen lustig?", "What was a little bit funny today?"),
    ("Womit hast du heute am liebsten gespielt oder gearbeitet?",
     "What did you most enjoy playing or working with today?"),
    ("Was hat heute gut gerochen?", "What smelled good today?"),
    ("Welches Geräusch hast du heute gehört, das dir gefallen hat?", "Which sound did you hear today that you liked?"),
    ("Was würdest du morgen gern wieder machen?", "What would you like to do again tomorrow?"),
    ("Wer hat dich heute zum Lächeln gebracht?", "Who made you smile today?"),
    ("Was war heute weich, warm oder gemütlich?", "What was soft, warm or cosy today?"),
    ("Was hast du heute gebaut, gemalt oder gemacht?", "What did you build, draw or make today?"),
    ("Wo war heute dein Lieblingsplatz?", "Where was your favourite spot today?"),
    ("Welches Wort hast du heute oft gesagt?", "Which word did you say a lot today?"),
    ("Was hast du heute am Himmel gesehen?", "What did you see in the sky today?"),
    ("Worauf freust du dich morgen?", "What are you looking forward to tomorrow?"),
    ("Was war heute leichter als gedacht?", "What was easier today than you thought?"),
    ("Welches Spiel würdest du gern mit der Familie spielen?", "Which game would you like to play with the family?"),
    ("Was hast du heute getrunken, das gut war?", "What did you drink today that was good?"),
    ("Was war heute dein Heldenmoment?", "What was your hero moment today?"),
    ("Welche Geschichte, welches Buch oder welcher Film hat dich heute begleitet?",
     "Which story, book or film kept you company today?"),
    ("Was hast du heute geteilt oder verschenkt?", "What did you share or give away today?"),
    ("Was war heute das Bunteste, das du gesehen hast?", "What was the most colourful thing you saw today?"),
    ("Wie bist du heute unterwegs gewesen?", "How did you get around today?"),
    ("Was hast du heute gefunden?", "What did you find today?"),
    ("Was hättest du heute gern gegessen, wenn du es dir hättest aussuchen dürfen?",
     "If you could have chosen, what would you have eaten today?"),
    ("Worauf bist du heute stolz?", "What are you proud of today?"),
    ("Wofür bist du heute dankbar?", "What are you thankful for today?"),
    ("Welches Tier wärst du heute gern gewesen?", "Which animal would you have liked to be today?"),
    ("Was war heute laut, und was war leise?", "What was loud today, and what was quiet?"),
    ("Was hattest du heute an, das du magst?", "What did you wear today that you like?"),
    ("Welche Pflanze oder Blume ist dir heute aufgefallen?", "Which plant or flower caught your eye today?"),
    ("Was hat heute besser geschmeckt als erwartet?", "What tasted better today than you expected?"),
    ("Was hast du heute jemandem erzählt?", "What did you tell somebody today?"),
    ("Welche Superkraft hättest du heute gut gebrauchen können?", "Which superpower could you have used today?"),
    ("Welches Ding hast du heute am meisten benutzt?", "Which thing did you use most today?"),
    ("Was hast du heute aus dem Fenster gesehen?", "What did you see out of the window today?"),
    ("Was war heute deine beste Idee?", "What was your best idea today?"),
    ("Was würdest du einem Freund von heute erzählen?", "What would you tell a friend about today?"),
    ("Welcher Teil des Tages war am ruhigsten?", "Which part of the day was the calmest?"),
    ("Was hat dir heute Spaß gemacht?", "What was fun today?"),
    ("Wenn heute ein Buch wäre, wie hieße es?", "If today were a book, what would it be called?"),
    ("Was hast du heute probiert?", "What did you try today?"),
    ("Was hat dich heute an jemanden aus der Familie erinnert?", "What reminded you of someone in the family today?"),
    ("Was war heute dein schönster Moment beim Essen?", "What was your nicest moment at a meal today?"),
    ("Was hast du heute gesammelt?", "What did you collect today?"),
    ("Wie war heute das Wetter bei dir, und wie fandest du es?",
     "What was the weather like for you today, and how did you like it?"),
    ("Wo warst du heute, wo du gern noch einmal hinmöchtest?",
     "Where were you today that you would like to go back to?"),
    ("Was hast du heute gebacken, gekocht oder geschnippelt?", "What did you bake, cook or chop today?"),
    ("Welches Bild würdest du von heute malen?", "Which picture would you paint of today?"),
    ("Was hat heute geglitzert, geleuchtet oder gestrahlt?", "What sparkled, glowed or shone today?"),
    ("Welcher Witz oder Spruch passt zu heute?", "Which joke or saying fits today?"),
    ("Was war heute schneller vorbei als gedacht?", "What was over sooner than you thought?"),
    ("Was hast du heute mit deinen Händen gemacht?", "What did you do with your hands today?"),
    ("Was hat dir heute Mut gemacht?", "What gave you courage today?"),
    ("Welche Frage würdest du morgen gern der Familie stellen?",
     "Which question would you like to ask the family tomorrow?"),
)

#: Every question once, in an order of its own (a hash of its id), so that the days walk through all of them before
#: one comes again, and neighbouring days do not get neighbouring questions.
_ORDER: tuple[int, ...] = tuple(sorted(range(len(QUESTIONS)),
                                       key=lambda index: hashlib.sha256(f"{PREFIX}|{index}".encode()).digest()))


#: A stored question id that still names one of the questions.
_QUESTION_IDS = frozenset(f"{PREFIX}.{index}" for index in range(len(QUESTIONS)))


def joined(profile: Any) -> bool:
    """Whether the person joined the family question (off from the start)."""
    return isinstance(profile, dict) and profile.get("family") is True


def waits(profile: Any) -> bool:
    """Joined again on the day they left: taking part only from the next day of the server's zone."""
    return joined(profile) and profile.get("family_left") == today()


def taking_part(profile: Any) -> bool:
    """Joined, and not waiting for the next day after joining again."""
    return joined(profile) and not waits(profile)


def question_of(day: str) -> str:
    """The id of the question of a ``YYYY-MM-DD``: the same for everybody on that date."""
    index = _ORDER[date.fromisoformat(day).toordinal() % len(_ORDER)]
    return f"{PREFIX}.{index}"


def words_of(question_id: str, language: str) -> str:
    index = int(question_id.split(".", 1)[1])
    german, english = QUESTIONS[index]
    return german if language.split("-")[0].lower() == "de" else english


def server_zone() -> tzinfo:
    """The time zone of the server: the one the app falls back to for a person without a zone of their own."""
    zone = datetime.now().astimezone().tzinfo
    assert zone is not None
    return zone


def today() -> str:
    """The date of the family question, the same for everybody: the calendar day on the server's clock."""
    return clock.now().astimezone(server_zone()).date().isoformat()


def check_today(day: str) -> str:
    """An answer is for today only: a date that has passed meanwhile (the page was open over midnight) is refused."""
    if day != today():
        raise error("family_day_over", "The day of this question is over.", 409)
    return day


def _aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "family_answers", "text", day)


_PERSON = (Account.id, Account.name, Account.display_name, Account.avatar_at, Account.profile)


def members(db: Session, keep: int | None = None) -> list[Any]:
    """Everybody who joined and is not blocked, in the order they came; at most ``PEOPLE_MAX``, with the person
    ``keep`` always among them."""
    rows = db.execute(select(*_PERSON).where(Account.blocked_at.is_(None)).order_by(Account.id)).all()
    present = [row for row in rows if taking_part(row.profile)]
    if len(present) <= PEOPLE_MAX:
        return present
    own = [row for row in present if row.id == keep]
    return [row for row in present if row.id != keep][:PEOPLE_MAX - len(own)] + own


def hint_due(db: Session, account: Account) -> bool:
    """Whether "Today" may tell this person once about the family question: they have not joined, did not put the hint
    away, and somebody else joined."""
    profile = account.profile if isinstance(account.profile, dict) else {}
    if joined(profile) or profile.get("family_hint") is False:
        return False
    return any(row.id != account.id for row in members(db))


def _open(row: Any) -> str | None:
    """The words of one answer, opened with the key of the person who wrote it; None when they do not open."""
    try:
        return vault.open_text(vault.dek_of(row.user_id), row.text_enc, _aad(row.user_id, row.date))
    except vault.SealError:
        diary.unreadable("family_answers")
        return None


def view(db: Session, account: Account, language: str) -> dict[str, Any]:
    """The family question of today as this person may see it. ``family_not_joined`` (403) for anybody who has not
    joined: they see nothing, not even who did. The same for whoever joined again today after leaving today."""
    if not taking_part(account.profile) or account.blocked_at is not None:
        raise error("family_not_joined", "You have not joined the family question.", 403)
    day = today()
    people = members(db, keep=account.id)
    ids = [row.id for row in people]
    if account.id not in ids:
        raise error("family_not_joined", "You have not joined the family question.", 403)
    rows = db.execute(select(FamilyAnswer.user_id, FamilyAnswer.date, FamilyAnswer.text_enc, FamilyAnswer.created_at,
                             FamilyAnswer.updated_at)
                      .where(FamilyAnswer.date == day, FamilyAnswer.user_id.in_(ids))
                      .order_by(FamilyAnswer.created_at, FamilyAnswer.id)).all()
    answered = {row.user_id for row in rows}
    own = next((row for row in rows if row.user_id == account.id), None)
    mine = None
    answers = None
    if own is not None:
        words = _open(own)
        mine = {"text": words or "", "unreadable": words is None, "at": own.updated_at.isoformat()}
        # Only now, and only of those who joined: what the others wrote.
        answers = []
        for row in rows:
            if row.user_id == account.id:
                continue
            words = _open(row)
            if words is not None:
                answers.append({"from": row.user_id, "text": words, "at": row.updated_at.isoformat()})
    question = question_of(day)
    return {
        "date": day,
        "question": {"id": question, "text": words_of(question, language)},
        "people": [
            {"id": row.id, "name": row.name, "display_name": row.display_name or "",
             "avatar": row.avatar_at.isoformat() if row.avatar_at else None,
             "me": row.id == account.id, "answered": row.id in answered}
            for row in people
        ],
        "mine": mine,
        "answers": answers,
    }


def view_of_date(db: Session, account: Account, day: str, language: str) -> dict[str, Any] | None:
    """The family question of a date (``YYYY-MM-DD``, checked by the caller) as the reading page of that day shows it:
    the question, the own answer and the answers of the others. None, and so the same as a date without any answers,
    for a person who has not joined, is blocked or did not answer on that date themselves: they learn nothing, not even
    that others answered. Only the answers of people who joined and are not blocked, as on "Today" (whoever left took
    their answers along)."""
    if not joined(account.profile) or account.blocked_at is not None:
        return None
    own = db.execute(select(FamilyAnswer.question, FamilyAnswer.text_enc, FamilyAnswer.user_id, FamilyAnswer.date,
                            FamilyAnswer.updated_at)
                     .where(FamilyAnswer.user_id == account.id, FamilyAnswer.date == day)).first()
    if own is None:
        return None
    people = members(db, keep=account.id)
    if account.id not in {row.id for row in people}:
        return None
    by_id = {row.id: row for row in people}
    rows = db.execute(select(FamilyAnswer.user_id, FamilyAnswer.date, FamilyAnswer.text_enc, FamilyAnswer.updated_at)
                      .where(FamilyAnswer.date == day, FamilyAnswer.user_id.in_(list(by_id)),
                             FamilyAnswer.user_id != account.id)
                      .order_by(FamilyAnswer.created_at, FamilyAnswer.id)).all()
    words = _open(own)
    answers = []
    for row in rows:
        text_of = _open(row)
        if text_of is not None:
            answers.append({"from": row.user_id, "text": text_of, "at": row.updated_at.isoformat()})
    # The question as it was asked that day; the words in the language of the reader.
    question = own.question if own.question in _QUESTION_IDS else question_of(day)
    shown = {account.id} | {item["from"] for item in answers}
    return {
        "date": day,
        "question": {"id": question, "text": words_of(question, language)},
        # Only who answered: whoever did not stays unnamed here.
        "people": [
            {"id": row.id, "name": row.name, "display_name": row.display_name or "",
             "avatar": row.avatar_at.isoformat() if row.avatar_at else None,
             "me": row.id == account.id, "answered": True}
            for row in people if row.id in shown
        ],
        "mine": {"text": words or "", "unreadable": words is None, "at": own.updated_at.isoformat()},
        "answers": answers,
    }


def _error_code(exc: HTTPException) -> str:
    return str(exc.detail.get("code")) if isinstance(exc.detail, dict) else ""


def answer(db: Session, account: Account, day: str, words: str, note_uid: str, language: str) -> dict[str, Any]:
    """Keeps the person's answer for today and makes it a note with the question, on the person's own day of notes.
    The answer and its note are written in one transaction, and only while the person has joined and is not blocked:
    decided in the statement that writes. An answer is final: a second one for the same date is refused
    (``family_answered``), decided by the same statement (two at once: one is kept, the other refused). The same press
    again (the same words with the same note, a retry after a lost reply) answers like the first."""
    check_today(day)
    words = diary.clean_text(words, ANSWER_MAX, "answer_too_long")
    if not words:
        raise error("answer_empty", "An answer needs words.", 422)
    note_uid = diary.check_new_note_id(note_uid)
    dek = vault.dek_for(account.id)
    question = question_of(day)
    sealed = vault.seal_text(dek, words, _aad(account.id, day))
    moment = diary.now()
    try:
        inserted = db.execute(
            text(
                "INSERT INTO family_answers (user_id, date, question, text_enc, note_uid, created_at, updated_at) "
                "SELECT users.id, :day, :question, :sealed, :note, :now, :now FROM users "
                "WHERE users.id = :user AND users.blocked_at IS NULL "
                "AND json_extract(users.profile, '$.family') = 1 "
                # Joined again today after leaving today: from tomorrow on. Decided in this statement, so leaving and
                # joining again on another device in between changes nothing.
                "AND coalesce(json_extract(users.profile, '$.family_left'), '') != :day "
                "ON CONFLICT (user_id, date) DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"user": account.id, "day": day, "question": question, "sealed": sealed, "note": note_uid,
             "now": moment},
        )
        if inserted.rowcount == 1:
            _note_for(db, account, dek, diary.note_day(account).isoformat(), words, note_uid, question, language)
        else:
            standing = db.execute(select(FamilyAnswer.text_enc, FamilyAnswer.note_uid)
                                  .where(FamilyAnswer.user_id == account.id, FamilyAnswer.date == day)).first()
            if standing is None:
                # Not inserted, and nothing stands: the person has not joined (or left in between).
                raise error("family_not_joined", "You have not joined the family question.", 403)
            try:
                before = vault.open_text(dek, standing.text_enc, _aad(account.id, day))
            except vault.SealError:
                before = None
            if before != words or standing.note_uid != note_uid:
                raise error("family_answered", "You have answered this question already; an answer stays as given.",
                            409)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.expire_all()
    return view(db, account, language)


def _note_for(db: Session, account: Account, dek: bytes, day: str, words: str, note_uid: str, question: str,
              language: str) -> None:
    """The note the answer becomes, unless the day is locked or full; it never stops the answer itself."""
    if diary.is_locked(db, account.id, day):
        return
    try:
        diary.add_note(db, account.id, dek, note_uid, day, words, words_of(question, language), prompt_id=question)
    except HTTPException as exc:
        # Full (the answer is kept, there is no room for a note) or locked meanwhile: decided before anything of the
        # note was written. Anything else (the storage of the person full, say) undoes the answer too.
        if _error_code(exc) not in ("too_many_notes", "day_locked"):
            raise


def leave(db: Session, account_id: int) -> None:
    """Every answer of a person who leaves, gone in the caller's transaction (the one that switches it off)."""
    db.execute(delete(FamilyAnswer).where(FamilyAnswer.user_id == account_id))


__all__ = ["ANSWER_MAX", "QUESTIONS", "answer", "hint_due", "joined", "leave", "members", "question_of", "taking_part",
           "today", "view", "view_of_date", "waits", "words_of"]
