"""The family question: every day one question for everybody on the server who joined, answered by each for themselves.

The rules, all of them kept here on the server:

* **Only who joined.** Joining is a choice of each person (``profile.family``, off from the start). Whoever has not
  joined sees no question, no answer and nobody's name here, and cannot answer. Blocked accounts are as if they had not
  joined: they are not listed and their answers are not shown.
* **The same question for everybody on the same date.** The date is the calendar day in each person's own time zone; the
  question is picked from the date alone, so two people on the same date get the same one, whatever their zone. The
  language only chooses its words.
* **The others' answers only after the own.** The server gives out the answers of the others for a date only to a person
  who answered for that date themselves, and only while both have joined. Before that it says who answered, nothing of
  what (not even how long). Taking the own answer back hides the others' again.
* **Leaving takes the answers along.** Whoever leaves loses all their answers in the same transaction (``leave``): from
  then on nobody sees them. The notes the answers became stay with the person.
* **Sealed with the key of the one who answered**, at most ``ANSWER_MAX`` characters, one per person and day (changed
  or taken back on the same day). The answer is a note of the day as well, with the question, like the question of the
  day. Only today counts: there is no archive.

The operator has no route here. Answering twice at once leaves one answer and one note (``answer`` writes the answer and
its note in one transaction).
"""

from __future__ import annotations

import hashlib
from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlalchemy import bindparam, delete, select, text, update
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, FamilyAnswer, Note, UtcDateTime
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


def joined(profile: Any) -> bool:
    """Whether the person joined the family question (off from the start)."""
    return isinstance(profile, dict) and profile.get("family") is True


def question_of(day: str) -> str:
    """The id of the question of a ``YYYY-MM-DD``: the same for everybody on that date."""
    index = _ORDER[date.fromisoformat(day).toordinal() % len(_ORDER)]
    return f"{PREFIX}.{index}"


def words_of(question_id: str, language: str) -> str:
    index = int(question_id.split(".", 1)[1])
    german, english = QUESTIONS[index]
    return german if language.split("-")[0].lower() == "de" else english


def today_of(account: Account) -> str:
    """The date the family question of this person is about: the calendar day of their own time zone."""
    return diary.today_of(account).isoformat()


def check_today(account: Account, day: str) -> str:
    """An answer is for today only: a date that has passed meanwhile (the page was open over midnight) is refused."""
    if day != today_of(account):
        raise error("family_day_over", "The day of this question is over.", 409)
    return day


def _aad(account_id: int, day: str) -> bytes:
    return vault.aad(account_id, "family_answers", "text", day)


_PERSON = (Account.id, Account.name, Account.display_name, Account.avatar_at, Account.profile)


def members(db: Session) -> list[Any]:
    """Everybody who joined and is not blocked, in the order they came."""
    rows = db.execute(select(*_PERSON).where(Account.blocked_at.is_(None)).order_by(Account.id)).all()
    return [row for row in rows if joined(row.profile)][:PEOPLE_MAX]


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


def view(db: Session, account: Account, language: str, day: str | None = None) -> dict[str, Any]:
    """The family question of today as this person may see it. ``family_not_joined`` (403) for anybody who has not
    joined: they see nothing, not even who did."""
    if not joined(account.profile) or account.blocked_at is not None:
        raise error("family_not_joined", "You have not joined the family question.", 403)
    day = day or today_of(account)
    people = members(db)
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


def _error_code(exc: HTTPException) -> str:
    return str(exc.detail.get("code")) if isinstance(exc.detail, dict) else ""


def answer(db: Session, account: Account, day: str, words: str, note_uid: str, language: str) -> dict[str, Any]:
    """Keeps the person's answer for today, or changes it, and makes it a note of the day with the question (a changed
    answer changes that note). The answer and its note are written in one transaction, and only while the person has
    joined and is not blocked: decided in the statement that writes."""
    check_today(account, day)
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
                "ON CONFLICT (user_id, date) DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"user": account.id, "day": day, "question": question, "sealed": sealed, "note": note_uid,
             "now": moment},
        )
        if inserted.rowcount == 1:
            _note_for(db, account, dek, day, words, note_uid, question, language)
        else:
            standing = db.execute(select(FamilyAnswer.id, FamilyAnswer.text_enc, FamilyAnswer.note_uid)
                                  .where(FamilyAnswer.user_id == account.id, FamilyAnswer.date == day)).first()
            if standing is None:
                # Not inserted, and nothing stands: the person has not joined (or left in between).
                raise error("family_not_joined", "You have not joined the family question.", 403)
            try:
                before = vault.open_text(dek, standing.text_enc, _aad(account.id, day))
            except vault.SealError:
                before = None
            if before != words:
                db.execute(update(FamilyAnswer).where(FamilyAnswer.id == standing.id)
                           .values(text_enc=sealed, updated_at=moment))
                _change_note(db, account, dek, day, words, standing.note_uid)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.expire_all()
    return view(db, account, language, day)


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


def _change_note(db: Session, account: Account, dek: bytes, day: str, words: str, note_uid: str | None) -> None:
    """The note of a changed answer, changed with it: only while it stands and its day is open. A note the person
    deleted stays deleted."""
    if note_uid is None or diary.is_locked(db, account.id, day):
        return
    if db.scalar(select(Note.id).where(Note.user_id == account.id, Note.uid == note_uid)) is None:
        return
    try:
        diary.change_note(db, account.id, dek, note_uid, words)
    except HTTPException as exc:
        if _error_code(exc) not in ("not_found", "day_locked"):
            raise


def withdraw(db: Session, account: Account, day: str, language: str) -> dict[str, Any]:
    """Takes the own answer of today back; the note it became stays. The others' answers are hidden again."""
    if not joined(account.profile):
        raise error("family_not_joined", "You have not joined the family question.", 403)
    check_today(account, day)
    db.execute(delete(FamilyAnswer).where(FamilyAnswer.user_id == account.id, FamilyAnswer.date == day))
    db.commit()
    return view(db, account, language, day)


def leave(db: Session, account_id: int) -> None:
    """Every answer of a person who leaves, gone in the caller's transaction (the one that switches it off)."""
    db.execute(delete(FamilyAnswer).where(FamilyAnswer.user_id == account_id))


__all__ = ["ANSWER_MAX", "QUESTIONS", "answer", "hint_due", "joined", "leave", "members", "question_of", "view",
           "withdraw", "words_of"]
