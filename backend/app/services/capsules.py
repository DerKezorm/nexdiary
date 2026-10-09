"""Time capsules: a letter that opens on a date, to oneself or to other people on the server. Not tied to a day of the
diary.

The rules, all of them kept here on the server and none in the browser:

* **Before the day** a recipient sees who sent it, its title and the day it opens; never its text or its photo, on no
  way (the lists, the capsule itself, the photo). The day begins at 00:00 in the recipient's own time zone, as "today"
  does everywhere in nexdiary; with recipients in several zones it opens for each at their own midnight.
* **Only to oneself** (the sender is the one recipient): sealed once closed. Until the day the sender can neither read
  nor change it, only take it back.
* **To others** (the sender among them or not): the sender can read, change (recipients, day, title, text, photo) and
  take it back until it has opened for any one of its recipients. The first moment the server sees it open for
  somebody is marked on the capsule (``first_opened_at``), and every change and every taking back is written only
  where that mark is still empty: a change and an opening that meet never pass each other.
* **Who else** asks for a capsule gets 404, exactly as for one that does not exist; the operator has no way in.
  Blocked accounts cannot be chosen, and the capsules of a blocked sender are not shown to anybody.

Sealing: the title, the text and the photo are sealed with a key of the capsule's own (AES-256-GCM, bound to the
capsule's id and the part). That key is sealed once for every person who holds the capsule, with that person's data
key (``capsule_keys``): each recipient, and the sender. A capsule to Mia for her 18th birthday so outlives the account
that wrote it (the sender's id is emptied, the capsule says "from a deleted account"); deleting a recipient's account
deletes only their copy of the key. In the clear stay only the people, the days and the times.

Pushes: when a capsule comes, its recipients (never the sender) hear who sent it and when it opens; on its day, each
recipient hears at 08:00 of their own zone (or at the first round of the planner after that) that it has opened.
Neither says what is in it. Each is marked before it goes out, by a conditional update: never twice.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import bindparam, delete, exists, select, text, update
from sqlalchemy.orm import Session

from .. import clock
from ..errors import error
from ..models import Account, Capsule, CapsuleKey, CapsuleUpload, UtcDateTime
from . import diary, notices, photos, push, quota, vault

logger = logging.getLogger("nexdiary.capsules")

TITLE_MAX = 200
TEXT_MAX = 50_000
#: The most people one capsule goes to.
RECIPIENTS_MAX = 50
#: The most capsules one person keeps sent at a time.
CAPSULES_MAX = 500
#: The furthest a capsule may open.
YEARS_MAX = 50
#: Photos chosen for capsules not closed yet, per person at a time; and how long such a photo waits.
UPLOADS_MAX = 20
UPLOAD_KEEP = timedelta(hours=24)
#: How long after closing a letter only to oneself the same request may be sent again (a double click, a lost
#: answer) and be answered with the capsule: later, the answer would tell its sender whether a guess of its words
#: is right.
RETRY_WINDOW = timedelta(minutes=10)
#: When the push "it has opened" goes out, on the clock of the recipient.
OPEN_PUSH_AT = time(8, 0)
KEY_BYTES = 32
UID = re.compile(r"^[0-9a-f]{32}$")
TAP = "/zeitkapseln"

TEXTS = {
    "de": {
        "title": "Zeitkapsel",
        "arrived": "{name} hat dir eine Zeitkapsel geschickt. Sie öffnet sich am {date}.",
        "opened": "Eine Zeitkapsel von {name} hat sich geöffnet.",
        "opened_self": "Dein Brief an dich selbst hat sich geöffnet.",
        "opened_gone": "Eine Zeitkapsel von einem gelöschten Konto hat sich geöffnet.",
    },
    "en": {
        "title": "Time capsule",
        "arrived": "{name} sent you a time capsule. It opens on {date}.",
        "opened": "A time capsule from {name} has opened.",
        "opened_self": "Your letter to yourself has opened.",
        "opened_gone": "A time capsule from a deleted account has opened.",
    },
}


def language_of(code: str) -> str:
    return "de" if (code or "").split("-")[0].lower() == "de" else "en"


def check_uid(value: str) -> str:
    """A capsule id in an address: one that cannot exist is not found."""
    value = value.lower() if isinstance(value, str) else ""
    if not UID.match(value):
        raise error("not_found", "Not found.", 404)
    return value


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


# --- Sealing --------------------------------------------------------------------------------------------------------


def _content_aad(uid: str, part: str, opens_on: str, sealed: bool) -> bytes:
    """Bound to the capsule, the part, its day and whether it is sealed: a day or a seal changed in the database
    alone leaves a capsule that does not open."""
    return f"nexdiary|capsules|{uid}|{part}|{opens_on}|{int(bool(sealed))}".encode()


def _photo_aad(uid: str, photo_uid: str, preview: bool, opens_on: str, sealed: bool) -> bytes:
    part = "preview" if preview else "original"
    return f"nexdiary|capsules|{uid}|photo|{photo_uid}|{part}|{opens_on}|{int(bool(sealed))}".encode()


def _key_aad(user_id: int, uid: str) -> bytes:
    return vault.aad(user_id, "capsule_keys", "key", uid)


def _upload_aad(user_id: int, uid: str, preview: bool) -> bytes:
    return vault.aad(user_id, "capsule_uploads", "preview" if preview else "original", uid)


def _seal_key(user_id: int, uid: str, key: bytes) -> bytes:
    try:
        dek = vault.dek_for(user_id)
    except vault.SealError as exc:
        # The account went in the meantime.
        raise error("person_unknown", "There is no such person.", 422) from exc
    return vault.seal(dek, key, _key_aad(user_id, uid))


def _key_of(db: Session, capsule: Any, user_id: int) -> bytes | None:
    """The capsule's key from this person's copy; None when the person holds none or it does not open."""
    sealed = db.scalar(select(CapsuleKey.key_enc).where(CapsuleKey.capsule_id == capsule.id,
                                                        CapsuleKey.user_id == user_id))
    if sealed is None:
        return None
    try:
        return vault.open_sealed(vault.dek_of(user_id), sealed, _key_aad(user_id, capsule.uid))
    except vault.SealError:
        diary.unreadable("capsule_keys")
        return None


def _open_part(key: bytes, capsule: Any, part: str) -> str | None:
    try:
        return vault.open_text(key, getattr(capsule, f"{part}_enc"),
                               _content_aad(capsule.uid, part, capsule.opens_on, capsule.sealed))
    except vault.SealError:
        diary.unreadable("capsules")
        return None


# --- People and days ------------------------------------------------------------------------------------------------


def person_view(row: Any) -> dict[str, Any]:
    return {"id": row.id, "name": row.name, "display_name": row.display_name or "",
            "avatar": row.avatar_at.isoformat() if row.avatar_at else None}


def name_of(account: Any) -> str:
    return account.display_name or account.name


def zone_name(account: Account) -> str:
    """The person's time zone as it stands now (an IANA name; empty: the server's own), to be kept with the capsule."""
    profile = account.profile if isinstance(account.profile, dict) else {}
    name = profile.get("timezone")
    return name if diary.valid_time_zone(name) else ""


def _zone(name: str) -> tzinfo:
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    zone = datetime.now().astimezone().tzinfo
    assert zone is not None
    return zone


def today_in(zone: str, moment: datetime | None = None) -> str:
    """Today on the clock of a kept time zone."""
    return (moment or clock.now()).astimezone(_zone(zone)).date().isoformat()


def is_open_in(zone: str, opens_on: str) -> bool:
    """Whether the day has come in the time zone kept for a holder of the capsule. Only that zone counts: a recipient
    who changes their own zone later opens nothing earlier."""
    return today_in(zone) >= opens_on


def _years_later(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # 29 February
        return day.replace(year=day.year + years, day=28)


def check_opens(sender: Account, zones: list[str], value: str) -> str:
    """A day a capsule may open on: a real date from tomorrow in the sender's zone on, at most ``YEARS_MAX`` years
    away, and not one that has come already in a recipient's zone somewhere further east (it would open at once)."""
    if not isinstance(value, str) or not diary.DATE_PATTERN.match(value):
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422)
    try:
        day = date.fromisoformat(value)
    except ValueError as exc:
        raise error("date_invalid", "Not a date of the form YYYY-MM-DD.", 422) from exc
    today = diary.today_of(sender)
    if day <= today or any(is_open_in(zone, value) for zone in zones):
        raise error("capsule_date_past", "A time capsule opens on a day still to come.", 422)
    if day > _years_later(today, YEARS_MAX):
        raise error("capsule_date_far", "A time capsule opens within 50 years.", 422, max=YEARS_MAX)
    return value


def _chosen(db: Session, sender: Account, ids: list[int], keep: set[int] | None = None) -> list[Account]:
    """The accounts a capsule goes to: each one there, and not blocked (``keep``: blocked recipients a change leaves
    where they are, since the sender does not see them to choose them again)."""
    keep = keep or set()
    wanted = sorted(set(ids) | keep)
    if not ids:
        raise error("capsule_nobody", "A time capsule needs somebody it is for.", 422)
    if len(wanted) > RECIPIENTS_MAX:
        raise error("too_many_people", "Too many people at once.", 422, max=RECIPIENTS_MAX)
    rows = list(db.scalars(select(Account).where(Account.id.in_(wanted))))
    found = {row.id: row for row in rows if row.blocked_at is None or row.id in keep}
    if set(found) != set(wanted):
        raise error("person_unknown", "There is no such person.", 422)
    return [found[person] for person in wanted]


def _clean(title: str, body: str) -> tuple[str, str]:
    title = diary.clean_line(title, TITLE_MAX, "capsule_title_too_long")
    body = diary.clean_text(body, TEXT_MAX, "capsule_text_too_long")
    if not title or not body:
        raise error("capsule_empty", "A time capsule needs a title and a text.", 422)
    return title, body


def _recipients_of(db: Session, capsule_id: int) -> list[Account]:
    return list(db.scalars(select(Account).join(CapsuleKey, CapsuleKey.user_id == Account.id)
                           .where(CapsuleKey.capsule_id == capsule_id, CapsuleKey.recipient.is_(True))
                           .order_by(Account.id)))


def _zones_of(db: Session, capsule_id: int) -> dict[int, str]:
    """The kept time zone of every holder of the capsule, by account."""
    return {row.user_id: row.zone for row in db.execute(
        select(CapsuleKey.user_id, CapsuleKey.zone).where(CapsuleKey.capsule_id == capsule_id))}


def opened_anywhere(db: Session, capsule: Any) -> bool:
    """Whether the capsule is open for one of its recipients: marked so, or its day has come in a recipient's kept
    zone."""
    if capsule.first_opened_at is not None:
        return True
    zones = db.scalars(select(CapsuleKey.zone).where(CapsuleKey.capsule_id == capsule.id,
                                                    CapsuleKey.recipient.is_(True)))
    return any(is_open_in(zone, capsule.opens_on) for zone in zones)


def _mark_opened(db: Session, capsule_id: int, today: str | None = None) -> bool:
    """From now on the capsule stays as it is: set once, in its own commit. With ``today`` only while the capsule
    still opens on or before that day: a change that moved its day a moment earlier is not overtaken. True when the
    mark stands afterwards."""
    query = update(Capsule).where(Capsule.id == capsule_id, Capsule.first_opened_at.is_(None))
    if today is not None:
        query = query.where(Capsule.opens_on <= today)
    db.execute(query.values(first_opened_at=diary.now()))
    db.commit()
    return db.scalar(select(Capsule.first_opened_at).where(Capsule.id == capsule_id)) is not None


def _refuse_when_open(db: Session, capsule: Any) -> None:
    if opened_anywhere(db, capsule):
        _mark_opened(db, capsule.id)
        raise error("capsule_open", "This time capsule has opened already.", 409)


# --- Photos ---------------------------------------------------------------------------------------------------------


def add_upload(db: Session, account: Account, upload_id: str, drawn: photos.Drawn) -> tuple[dict[str, Any], bool]:
    """Keeps a photo chosen for a capsule, sealed with the person's own key until the capsule takes it. The same upload
    id again returns the photo that stands. Within the person's storage, and at most ``UPLOADS_MAX`` at a time."""
    existing = db.execute(select(CapsuleUpload).where(CapsuleUpload.user_id == account.id,
                                                      CapsuleUpload.upload_id == upload_id)).scalar_one_or_none()
    if existing is not None:
        return _upload_view(existing), False
    dek = vault.dek_for(account.id)
    uid = secrets.token_hex(16)
    original = vault.seal(dek, drawn.original, _upload_aad(account.id, uid, False))
    preview = vault.seal(dek, drawn.preview, _upload_aad(account.id, uid, True))
    photos._write(photos._path(uid, False), original)
    photos._write(photos._path(uid, True), preview)
    limit = quota.limit_bytes(db)
    try:
        inserted = db.execute(
            text(
                "INSERT INTO capsule_uploads (uid, user_id, upload_id, width, height, size, preview_size, created_at) "  # noqa: S608 - constants
                "SELECT :uid, :user, :upload, :width, :height, :size, :preview, :now "
                "WHERE (SELECT count(*) FROM capsule_uploads WHERE user_id = :user) < :limit "
                f"AND (:quota IS NULL OR {quota.USED} + :size + :preview <= :quota) "
                "ON CONFLICT DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"uid": uid, "user": account.id, "upload": upload_id, "width": drawn.width, "height": drawn.height,
             "size": len(original), "preview": len(preview), "now": diary.now(), "limit": UPLOADS_MAX,
             "quota": limit},
        )
        db.commit()
    except Exception:
        db.rollback()
        photos.remove_files([uid])
        raise
    if inserted.rowcount != 1:
        photos.remove_files([uid])
        found = db.execute(select(CapsuleUpload).where(CapsuleUpload.user_id == account.id,
                                                       CapsuleUpload.upload_id == upload_id)).scalar_one_or_none()
        if found is not None:
            return _upload_view(found), False
        if limit is not None and quota.used(db, account.id) + len(original) + len(preview) > limit:
            raise quota.full(db)
        raise error("capsule_photos_waiting", "Too many photos are waiting for a time capsule.", 409,
                    max=UPLOADS_MAX)
    row = db.get(CapsuleUpload, uid)
    assert row is not None
    return _upload_view(row), True


def drop_upload(db: Session, account: Account, upload_uid: str) -> None:
    """A photo chosen for a capsule that is not going to be closed with it (the dialog was left, another photo was
    chosen): gone at once, row and files. Only the person's own; any other answers 404."""
    gone = db.execute(delete(CapsuleUpload).where(CapsuleUpload.uid == upload_uid,
                                                  CapsuleUpload.user_id == account.id))
    db.commit()
    if gone.rowcount != 1:  # type: ignore[attr-defined]
        raise _not_found()
    photos.remove_files([upload_uid])


def _upload_view(row: CapsuleUpload) -> dict[str, Any]:
    return {"id": row.uid, "width": row.width, "height": row.height}


@dataclass
class _Moved:
    """A photo sealed anew with a capsule's key, its files written, waiting for the transaction that takes it."""

    uid: str
    upload: str
    width: int
    height: int
    size: int


def _take_upload(db: Session, account: Account, upload_uid: str, capsule_uid: str, key: bytes, opens_on: str,
                 sealed: bool) -> _Moved:
    """The chosen photo, opened with the person's key and sealed anew with the capsule's, under a new name. The upload
    itself stays until the transaction that takes it deletes its row."""
    row = db.get(CapsuleUpload, upload_uid) if UID.match(upload_uid or "") else None
    if row is None or row.user_id != account.id:
        raise error("capsule_photo_missing", "This photo is no longer there. Choose it again.", 422)
    dek = vault.dek_for(account.id)
    try:
        parts = [vault.open_sealed(dek, photos._path(row.uid, preview).read_bytes(), _upload_aad(account.id, row.uid,
                                                                                                     preview))
                 for preview in (False, True)]
    except (OSError, vault.SealError) as exc:
        logger.warning("A photo chosen for a time capsule did not open")
        raise error("capsule_photo_missing", "This photo is no longer there. Choose it again.", 422) from exc
    return _write_photo(parts, capsule_uid, key, opens_on, sealed, row.uid, row.width, row.height)


def _write_photo(parts: list[bytes], capsule_uid: str, key: bytes, opens_on: str, sealed: bool, upload: str,
                 width: int, height: int) -> _Moved:
    uid = secrets.token_hex(16)
    files = [vault.seal(key, data, _photo_aad(capsule_uid, uid, preview, opens_on, sealed))
             for data, preview in zip(parts, (False, True), strict=True)]
    photos._write(photos._path(uid, False), files[0])
    photos._write(photos._path(uid, True), files[1])
    return _Moved(uid=uid, upload=upload, width=width, height=height, size=len(files[0]) + len(files[1]))


def _reseal_photo(capsule: Any, key: bytes, opens_on: str, sealed: bool) -> _Moved:
    """The capsule's photo sealed anew for another day or seal, under a new name; the old files stay until the change
    is written."""
    try:
        parts = [vault.open_sealed(key, photos._path(capsule.photo_uid, preview).read_bytes(),
                                   _photo_aad(capsule.uid, capsule.photo_uid, preview, capsule.opens_on,
                                              capsule.sealed))
                 for preview in (False, True)]
    except (OSError, vault.SealError) as exc:
        logger.warning("A photo of a time capsule did not open")
        raise error("capsule_unreadable", "This time capsule cannot be read; it can only be taken back.", 409) from exc
    return _write_photo(parts, capsule.uid, key, opens_on, sealed, "", capsule.photo_width or 0,
                        capsule.photo_height or 0)


def _drop_upload(db: Session, account_id: int, upload_uid: str) -> None:
    """Deletes the row of a photo the capsule took, in the transaction that takes it; refused when it is gone."""
    gone = db.execute(delete(CapsuleUpload).where(CapsuleUpload.uid == upload_uid, CapsuleUpload.user_id == account_id))
    if gone.rowcount != 1:  # type: ignore[attr-defined]
        raise error("capsule_photo_missing", "This photo is no longer there. Choose it again.", 422)


def read_photo(db: Session, viewer: Account, uid: str, preview: bool) -> bytes:
    """The photo of a capsule, for whoever may read it now; 404 for anybody else and before the day."""
    capsule, key = _readable(db, viewer, uid)
    if capsule.photo_uid is None:
        raise _not_found()
    try:
        sealed = photos._path(capsule.photo_uid, preview).read_bytes()
        return vault.open_sealed(key, sealed, _photo_aad(capsule.uid, capsule.photo_uid, preview, capsule.opens_on,
                                                         capsule.sealed))
    except (OSError, vault.SealError) as exc:
        logger.warning("A photo of a time capsule did not open")
        raise _not_found() from exc


# --- Reading --------------------------------------------------------------------------------------------------------


def _capsule(db: Session, uid: str) -> Capsule | None:
    return db.execute(select(Capsule).where(Capsule.uid == uid)).scalar_one_or_none()


def _sender_blocked(db: Session, capsule: Any) -> bool:
    if capsule.sender_id is None:
        return False
    return db.scalar(select(Account.blocked_at).where(Account.id == capsule.sender_id)) is not None


def _visible(db: Session, viewer: Account, uid: str) -> tuple[Capsule, CapsuleKey]:
    """The capsule and the viewer's copy of its key, when the viewer holds one and may see it at all; ``not_found``
    else, exactly as for a capsule that does not exist."""
    capsule = _capsule(db, uid)
    if capsule is None:
        raise _not_found()
    own = db.execute(select(CapsuleKey).where(CapsuleKey.capsule_id == capsule.id,
                                              CapsuleKey.user_id == viewer.id)).scalar_one_or_none()
    if own is None:
        raise _not_found()
    if capsule.sender_id != viewer.id and _sender_blocked(db, capsule):
        raise _not_found()
    return capsule, own


def _may_read(viewer: Account, capsule: Any, own: Any) -> bool:
    """Its day has come for the viewer as a recipient, or the viewer sent it to others (not sealed)."""
    if own.recipient and is_open_in(own.zone, capsule.opens_on):
        return True
    return capsule.sender_id == viewer.id and not capsule.sealed


def _opened_now(db: Session, viewer: Account, uid: str) -> tuple[Capsule, CapsuleKey]:
    """The capsule and the viewer's copy of its key, as they stand once a recipient whose day has come marked it
    opened: a change that comes later is refused, and one that came a moment earlier (another day, another text) is
    what the viewer is judged by and reads, never the capsule as it was before."""
    capsule, own = _visible(db, viewer, uid)
    if own.recipient and is_open_in(own.zone, capsule.opens_on) and capsule.first_opened_at is None:
        _mark_opened(db, capsule.id, today_in(own.zone))
        db.expire_all()
        capsule, own = _visible(db, viewer, uid)
    return capsule, own


def _readable(db: Session, viewer: Account, uid: str) -> tuple[Capsule, bytes]:
    """The capsule as it stands, with its key, for a viewer who may read it now; 404 otherwise."""
    capsule, own = _opened_now(db, viewer, uid)
    if not _may_read(viewer, capsule, own):
        raise _not_found()
    key = _key_of(db, capsule, viewer.id)
    if key is None:
        raise _not_found()
    return capsule, key


def _from(db: Session, capsule: Any) -> dict[str, Any] | None:
    if capsule.sender_id is None:
        return None
    row = db.get(Account, capsule.sender_id)
    return person_view(row) if row is not None else None


def one(db: Session, viewer: Account, uid: str) -> dict[str, Any]:
    """One capsule as the viewer may see it: always who sent it, its title and its days; the text and whether it holds
    a photo only once the viewer may read it; the recipients and the revision only for its sender."""
    capsule, own = _opened_now(db, viewer, uid)
    readable = _may_read(viewer, capsule, own)
    key = _key_of(db, capsule, viewer.id)
    if key is None:
        raise _not_found()
    title = _open_part(key, capsule, "title")
    if title is None:
        raise _not_found()
    mine = capsule.sender_id == viewer.id
    out: dict[str, Any] = {
        "id": capsule.uid,
        "from": _from(db, capsule),
        "self": mine,
        "title": title,
        "opens_on": capsule.opens_on,
        "written_on": capsule.written_on,
        "sealed": bool(capsule.sealed),
        "for_me": bool(own.recipient),
        "open": bool(own.recipient) and is_open_in(own.zone, capsule.opens_on),
    }
    if readable:
        body = _open_part(key, capsule, "text")
        if body is None:
            raise _not_found()
        out["text"] = body
        out["photo"] = capsule.photo_uid is not None
    if mine:
        everyone = _recipients_of(db, capsule.id)
        out["to"] = [person_view(person) for person in everyone if person.blocked_at is None]
        #: Recipients the sender cannot see or choose now (blocked): they keep the capsule.
        out["hidden"] = sum(1 for person in everyone if person.blocked_at is not None)
        out["revision"] = capsule.revision
        out["opened"] = opened_anywhere(db, capsule)
    return out


def lists(db: Session, viewer: Account) -> dict[str, Any]:
    """The capsules for the viewer (from senders who are not blocked) and the ones the viewer sent, each sorted by the
    day they open. Never a text or a photo here."""
    dek = vault.dek_for(viewer.id)
    today = diary.today_of(viewer).isoformat()
    received = db.execute(
        select(Capsule, CapsuleKey.key_enc, CapsuleKey.read_at, CapsuleKey.zone)
        .join(CapsuleKey, CapsuleKey.capsule_id == Capsule.id)
        .outerjoin(Account, Account.id == Capsule.sender_id)
        .where(CapsuleKey.user_id == viewer.id, CapsuleKey.recipient.is_(True), Account.blocked_at.is_(None))
        .order_by(Capsule.opens_on, Capsule.id)
    ).all()
    senders: dict[int, dict[str, Any]] = {}
    for_me = []
    for capsule, sealed, read_at, zone in received:
        title = _title(dek, viewer.id, capsule, sealed)
        if title is None:
            continue
        if capsule.sender_id is not None and capsule.sender_id not in senders:
            row = db.get(Account, capsule.sender_id)
            if row is not None:
                senders[capsule.sender_id] = person_view(row)
        is_open = is_open_in(zone, capsule.opens_on)
        item: dict[str, Any] = {
            "id": capsule.uid,
            "from": senders.get(capsule.sender_id) if capsule.sender_id is not None else None,
            "self": capsule.sender_id == viewer.id,
            "title": title,
            "opens_on": capsule.opens_on,
            "written_on": capsule.written_on,
            "open": is_open,
            "new": is_open and read_at is None,
        }
        if is_open:
            item["photo"] = capsule.photo_uid is not None
        for_me.append(item)
    sent = db.execute(
        select(Capsule, CapsuleKey.key_enc).join(CapsuleKey, CapsuleKey.capsule_id == Capsule.id)
        .where(Capsule.sender_id == viewer.id, CapsuleKey.user_id == viewer.id)
        .order_by(Capsule.opens_on, Capsule.id)
    ).all()
    people = _recipients_by_capsule(db, [capsule.id for capsule, _sealed in sent])
    from_me = []
    for capsule, sealed in sent:
        title = _title(dek, viewer.id, capsule, sealed)
        if title is None:
            continue
        everyone = people.get(capsule.id, [])
        opened = capsule.first_opened_at is not None or any(is_open_in(zone, capsule.opens_on)
                                                           for _person, zone in everyone)
        from_me.append({
            "id": capsule.uid,
            "title": title,
            "opens_on": capsule.opens_on,
            "written_on": capsule.written_on,
            "to": [person_view(person) for person, _zone in everyone if person.blocked_at is None],
            "hidden": sum(1 for person, _zone in everyone if person.blocked_at is not None),
            "sealed": bool(capsule.sealed),
            "opened": opened,
            "revision": capsule.revision,
        })
    return {"today": today, "for_me": for_me, "from_me": from_me, "new": sum(1 for item in for_me if item["new"])}


def _title(dek: bytes, user_id: int, capsule: Any, sealed: bytes) -> str | None:
    try:
        key = vault.open_sealed(dek, sealed, _key_aad(user_id, capsule.uid))
    except vault.SealError:
        diary.unreadable("capsule_keys")
        return None
    return _open_part(key, capsule, "title")


def _recipients_by_capsule(db: Session, ids: list[int]) -> dict[int, list[tuple[Account, str]]]:
    """The recipients of these capsules with their kept zones."""
    if not ids:
        return {}
    out: dict[int, list[tuple[Account, str]]] = {}
    for capsule_id, account, zone in db.execute(
            select(CapsuleKey.capsule_id, Account, CapsuleKey.zone).join(Account, Account.id == CapsuleKey.user_id)
            .where(CapsuleKey.capsule_id.in_(ids), CapsuleKey.recipient.is_(True)).order_by(Account.id)).all():
        out.setdefault(capsule_id, []).append((account, zone))
    return out


def unread_count(db: Session, viewer: Account) -> int:
    """How many capsules for the viewer have opened (in the zone kept for them) and are not read yet. Opens nothing."""
    # No zone is more than a day ahead of UTC: only capsules up to tomorrow can have opened.
    horizon = (clock.now().date() + timedelta(days=1)).isoformat()
    rows = db.execute(
        select(Capsule.opens_on, CapsuleKey.zone).select_from(CapsuleKey)
        .join(Capsule, Capsule.id == CapsuleKey.capsule_id)
        .outerjoin(Account, Account.id == Capsule.sender_id)
        .where(CapsuleKey.user_id == viewer.id, CapsuleKey.recipient.is_(True), CapsuleKey.read_at.is_(None),
               Capsule.opens_on <= horizon, Account.blocked_at.is_(None))
    ).all()
    return sum(1 for row in rows if is_open_in(row.zone, row.opens_on))


def mark_read(db: Session, viewer: Account, uid: str) -> None:
    """The viewer read a capsule that has opened for them: no longer new. Before its day: ``capsule_closed``."""
    capsule, own = _visible(db, viewer, uid)
    if not own.recipient:
        raise _not_found()
    if not is_open_in(own.zone, capsule.opens_on):
        raise error("capsule_closed", "This time capsule has not opened yet.", 409)
    db.execute(update(CapsuleKey).where(CapsuleKey.capsule_id == capsule.id, CapsuleKey.user_id == viewer.id,
                                        CapsuleKey.read_at.is_(None)).values(read_at=diary.now()))
    db.commit()


# --- Closing, changing, taking back ---------------------------------------------------------------------------------


def _insert_key(db: Session, capsule_id: int, sender_id: int, person: int, recipient: bool, sealed: bytes,
                zone: str) -> None:
    """One copy of the key, only for an account that is there and not blocked (the sender's own always): checked in the
    statement that writes, so a block or a deletion in between cannot slip through."""
    written = db.execute(
        text(
            "INSERT INTO capsule_keys (capsule_id, user_id, recipient, zone, key_enc, arrival_sent, open_sent) "
            "SELECT :capsule, users.id, :recipient, :zone, :key, :arrived, 0 FROM users "
            "WHERE users.id = :person AND (users.blocked_at IS NULL OR users.id = :sender)"
        ),
        {"capsule": capsule_id, "recipient": recipient, "zone": zone, "key": sealed, "person": person,
         "sender": sender_id,
         # Nobody tells the sender that their own capsule came.
         "arrived": person == sender_id},
    )
    if written.rowcount != 1:  # type: ignore[attr-defined]
        raise error("person_unknown", "There is no such person.", 422)


def request_mac(account_id: int, to: list[int], opens_on: str, title: str, body: str, with_photo: bool) -> str:
    """A keyed hash (the sender's data key) of what was asked to be closed: the same request sent again is known
    without opening the capsule, and the database holds nothing of the words."""
    asked = json.dumps({"to": sorted(set(to)), "opens_on": opens_on, "title": title, "text": body,
                        "photo": bool(with_photo)}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hmac.new(vault.dek_for(account_id), b"capsule-request|" + asked.encode("utf-8"), hashlib.sha256).hexdigest()


def _again(db: Session, account: Account, client_id: str, mac: str) -> dict[str, Any] | None:
    """The capsule closed before under this id of the browser (a double click, a retry after a lost answer): it, when
    the request asks for the same; ``capsule_id_taken`` when it asks for another. A letter only to oneself is answered
    so only for a short while after closing: later the difference would confirm a guess of its sealed words."""
    found = db.execute(select(Capsule).where(Capsule.sender_id == account.id,
                                             Capsule.client_id == client_id)).scalar_one_or_none()
    if found is None:
        return None
    late = found.sealed and diary.now() - found.created_at > RETRY_WINDOW
    if late or not hmac.compare_digest(found.request_mac, mac):
        raise error("capsule_id_taken", "A time capsule with this id holds something else.", 409)
    return one(db, account, found.uid)


def create(db: Session, sender: Account, client_id: str, to: list[int], opens_on: str, title: str, body: str,
           photo: str | None) -> tuple[dict[str, Any], bool]:
    """Closes a new capsule; the capsule as its sender sees it, and whether it is new."""
    if not diary.NOTE_ID.match(client_id or ""):
        raise error("invalid_input", "The input is not valid.", 422, fields=["id"])
    title, body = _clean(title, body)
    mac = request_mac(sender.id, to, opens_on, title, body, photo is not None)
    same = _again(db, sender, client_id, mac)
    if same is not None:
        return same, False
    recipients = _chosen(db, sender, to)
    zones = {person.id: zone_name(person) for person in recipients}
    zones.setdefault(sender.id, zone_name(sender))
    check_opens(sender, [zones[person.id] for person in recipients], opens_on)
    only_me = [person.id for person in recipients] == [sender.id]
    key = secrets.token_bytes(KEY_BYTES)
    uid = secrets.token_hex(16)
    sealed_keys = {person.id: _seal_key(person.id, uid, key) for person in recipients}
    if sender.id not in sealed_keys:
        sealed_keys[sender.id] = _seal_key(sender.id, uid, key)
    title_enc = vault.seal_text(key, title, _content_aad(uid, "title", opens_on, only_me))
    text_enc = vault.seal_text(key, body, _content_aad(uid, "text", opens_on, only_me))
    moved = None
    if photo is not None:
        try:
            moved = _take_upload(db, sender, photo, uid, key, opens_on, only_me)
        except Exception:
            # Taken by a request with the same id a moment ago (a double click): that capsule is the answer.
            same = _again(db, sender, client_id, mac)
            if same is not None:
                return same, False
            raise
    moment = diary.now()
    limit = quota.limit_bytes(db)
    sizes = len(title_enc) + len(text_enc) + (moved.size if moved else 0)
    try:
        inserted = db.execute(
            text(
                "INSERT INTO capsules (uid, sender_id, client_id, request_mac, opens_on, written_on, sealed, "  # noqa: S608 - constants
                "title_enc, text_enc, photo_uid, photo_width, photo_height, photo_size, revision, created_at, "
                "updated_at) "
                "SELECT :uid, :sender, :client, :mac, :opens, :written, :sealed, :title, :text, :photo, :width, "
                ":height, "
                ":photo_size, 0, :now, :now "
                "WHERE (SELECT count(*) FROM capsules WHERE sender_id = :sender) < :max "
                # The photo moves from the upload into the capsule: only the texts are new.
                f"AND (:quota IS NULL OR {quota.USED.replace(':user', ':sender')} + :growth <= :quota) "
                "ON CONFLICT DO NOTHING"
            ).bindparams(bindparam("now", type_=UtcDateTime())),
            {"uid": uid, "sender": sender.id, "client": client_id, "mac": mac, "opens": opens_on,
             "written": diary.today_of(sender).isoformat(), "sealed": only_me, "title": title_enc, "text": text_enc,
             "photo": moved.uid if moved else None, "width": moved.width if moved else None,
             "height": moved.height if moved else None, "photo_size": moved.size if moved else 0, "now": moment,
             "max": CAPSULES_MAX, "quota": limit, "growth": sizes - (_upload_size(db, moved.upload) if moved else 0)},
        )
        if inserted.rowcount != 1:  # type: ignore[attr-defined]
            db.rollback()
            if moved:
                photos.remove_files([moved.uid])
            same = _again(db, sender, client_id, mac)
            if same is not None:
                return same, False
            count = len(db.scalars(select(Capsule.id).where(Capsule.sender_id == sender.id)).all())
            if count >= CAPSULES_MAX:
                raise error("too_many_capsules", "There are as many time capsules as there may be.", 409,
                            max=CAPSULES_MAX)
            raise quota.full(db)
        capsule_id = db.scalar(select(Capsule.id).where(Capsule.uid == uid))
        assert capsule_id is not None
        recipient_ids = {person.id for person in recipients}
        for person, sealed in sealed_keys.items():
            _insert_key(db, capsule_id, sender.id, person, person in recipient_ids, sealed, zones[person])
        if moved:
            _drop_upload(db, sender.id, moved.upload)
        db.commit()
    except Exception:
        db.rollback()
        if moved:
            photos.remove_files([moved.uid])
        raise
    if moved:
        photos.remove_files([moved.upload])
    logger.info("Time capsule closed recipients=%s", len(recipients))
    announce_later(capsule_id)
    return one(db, sender, uid), True


def _upload_size(db: Session, upload_uid: str) -> int:
    row = db.get(CapsuleUpload, upload_uid)
    return (row.size + row.preview_size) if row is not None else 0


KEEP: Any = object()


def change(db: Session, sender: Account, uid: str, revision: int, to: list[int], opens_on: str, title: str,
           body: str, photo: Any = KEEP) -> dict[str, Any]:
    """Changes a capsule to others before it opened anywhere: the recipients, the day, the title, the text and the
    photo (``KEEP``: as it is; None: none; an upload id: that one). All in one transaction, written only onto the
    revision it was read from and only while nobody has opened it. People added hear that it came; nobody else."""
    capsule = _capsule(db, uid)
    if capsule is None or capsule.sender_id != sender.id:
        raise _not_found()
    _refuse_when_open(db, capsule)
    if capsule.sealed:
        raise error("capsule_sealed", "A letter to yourself stays closed until its day.", 409)
    if capsule.revision != revision:
        raise error("capsule_changed", "This time capsule was changed meanwhile.", 409, revision=capsule.revision)
    title, body = _clean(title, body)
    standing = {person.id: person for person in _recipients_of(db, capsule.id)}
    blocked = {person for person, row in standing.items() if row.blocked_at is not None}
    recipients = _chosen(db, sender, to, keep=blocked)
    kept_zones = _zones_of(db, capsule.id)
    # The zone kept for who holds it already; the zone of now for who comes in.
    zones = {person.id: kept_zones.get(person.id, zone_name(person)) for person in recipients}
    check_opens(sender, [zones[person.id] for person in recipients], opens_on)
    key = _key_of(db, capsule, sender.id)
    if key is None:
        raise error("capsule_unreadable", "This time capsule cannot be read; it can only be taken back.", 409)
    holders = set(kept_zones)
    wanted = {person.id for person in recipients}
    sealed = wanted == {sender.id}
    added = {person: _seal_key(person, capsule.uid, key) for person in wanted - holders}
    title_enc = vault.seal_text(key, title, _content_aad(capsule.uid, "title", opens_on, sealed))
    text_enc = vault.seal_text(key, body, _content_aad(capsule.uid, "text", opens_on, sealed))
    moved = None
    resealed = False
    if photo is not KEEP and photo is not None:
        moved = _take_upload(db, sender, photo, capsule.uid, key, opens_on, sealed)
    elif photo is KEEP and capsule.photo_uid and (opens_on != capsule.opens_on or sealed != bool(capsule.sealed)):
        # The photo is bound to the day and the seal like the words: sealed anew for the new ones.
        moved = _reseal_photo(capsule, key, opens_on, sealed)
        resealed = True
    values: dict[str, Any] = {"opens_on": opens_on, "title_enc": title_enc, "text_enc": text_enc,
                              "sealed": sealed, "revision": capsule.revision + 1, "updated_at": diary.now()}
    old_photo = capsule.photo_uid
    replaced = photo is not KEEP or resealed
    if replaced:
        values.update(photo_uid=moved.uid if moved else None, photo_width=moved.width if moved else None,
                      photo_height=moved.height if moved else None, photo_size=moved.size if moved else 0)
    growth = (len(title_enc) + len(text_enc) - len(capsule.title_enc) - len(capsule.text_enc)
              + (values.get("photo_size", capsule.photo_size) - capsule.photo_size)
              - (_upload_size(db, moved.upload) if moved and moved.upload else 0))
    try:
        written = db.execute(update(Capsule).where(Capsule.id == capsule.id, Capsule.sender_id == sender.id,
                                                   Capsule.revision == revision,
                                                   Capsule.first_opened_at.is_(None)).values(**values))
        if written.rowcount != 1:  # type: ignore[attr-defined]
            db.rollback()
            db.expire_all()
            again = _capsule(db, uid)
            if again is None:
                raise _not_found()
            if again.first_opened_at is not None:
                raise error("capsule_open", "This time capsule has opened already.", 409)
            raise error("capsule_changed", "This time capsule was changed meanwhile.", 409, revision=again.revision)
        db.execute(delete(CapsuleKey).where(CapsuleKey.capsule_id == capsule.id,
                                            CapsuleKey.user_id.not_in(wanted | {sender.id})))
        db.execute(update(CapsuleKey).where(CapsuleKey.capsule_id == capsule.id)
                   .values(recipient=CapsuleKey.user_id.in_(wanted)))
        for person, sealed_key in added.items():
            _insert_key(db, capsule.id, sender.id, person, True, sealed_key, zones[person])
        if moved and moved.upload:
            _drop_upload(db, sender.id, moved.upload)
        quota.check_after_write(db, sender.id, growth)
        db.commit()
    except Exception:
        db.rollback()
        if moved:
            photos.remove_files([moved.uid])
        raise
    if moved and moved.upload:
        photos.remove_files([moved.upload])
    if replaced and old_photo:
        photos.remove_files([old_photo])
    if added:
        announce_later(capsule.id)
    return one(db, sender, uid)


def withdraw(db: Session, sender: Account, uid: str) -> None:
    """Takes a capsule back before it opened anywhere: it is gone for everybody, with its photo."""
    capsule = _capsule(db, uid)
    if capsule is None or capsule.sender_id != sender.id:
        raise _not_found()
    _refuse_when_open(db, capsule)
    # The photo as the deleting statement finds it: a change that swapped it a moment ago leaves no file behind.
    gone = db.execute(delete(Capsule).where(Capsule.id == capsule.id, Capsule.sender_id == sender.id,
                                            Capsule.first_opened_at.is_(None)).returning(Capsule.photo_uid)).first()
    db.commit()
    if gone is None:
        if _capsule(db, uid) is None:
            raise _not_found()
        raise error("capsule_open", "This time capsule has opened already.", 409)
    if gone.photo_uid:
        photos.remove_files([gone.photo_uid])
    logger.info("Time capsule taken back")


# --- Accounts that go -----------------------------------------------------------------------------------------------


def files_of(db: Session, account_id: int) -> list[str]:
    """The photo files chosen by this person for capsules not closed yet: they go with the account."""
    return list(db.scalars(select(CapsuleUpload.uid).where(CapsuleUpload.user_id == account_id)))


def tidy_after_deletion(db: Session) -> list[str]:
    """After an account was deleted: the capsules nobody is left to receive go too (the sender's own to themselves,
    those whose last recipient went). Gives the photo files to delete."""
    nobody = ~exists(select(CapsuleKey.capsule_id).where(CapsuleKey.capsule_id == Capsule.id,
                                                         CapsuleKey.recipient.is_(True)))
    rows = db.execute(select(Capsule.id, Capsule.photo_uid).where(nobody)).all()
    if not rows:
        return []
    db.execute(delete(Capsule).where(Capsule.id.in_([row.id for row in rows])))
    db.commit()
    return [row.photo_uid for row in rows if row.photo_uid]


# --- Pushes ---------------------------------------------------------------------------------------------------------


def _date_words(day: str, lang: str) -> str:
    moment = date.fromisoformat(day)
    month = notices.MONTHS[lang][moment.month - 1]
    return f"{moment.day}. {month} {moment.year}" if lang == "de" else f"{moment.day} {month} {moment.year}"


def _claim(db: Session, capsule_id: int, user_id: int, column: str) -> bool:
    """Marks one push as gone out, only where it was not yet: the one caller that sets the mark sends it."""
    taken = db.execute(update(CapsuleKey).where(CapsuleKey.capsule_id == capsule_id, CapsuleKey.user_id == user_id,
                                                getattr(CapsuleKey, column).is_(False)).values(**{column: True}))
    db.commit()
    return bool(taken.rowcount)  # type: ignore[attr-defined]


def announce(capsule_id: int) -> int:
    """Tells every recipient of the capsule who has not heard of it yet that it came (never the sender). Gives how
    many were told."""
    from ..db import SessionLocal

    told = 0
    with SessionLocal() as db:
        capsule = db.get(Capsule, capsule_id)
        if capsule is None or capsule.sender_id is None:
            return 0
        sender = db.get(Account, capsule.sender_id)
        if sender is None or sender.blocked_at is not None:
            return 0
        name, opens_on = name_of(sender), capsule.opens_on
        waiting = list(db.scalars(
            select(CapsuleKey.user_id).join(Account, Account.id == CapsuleKey.user_id)
            .where(CapsuleKey.capsule_id == capsule_id, CapsuleKey.recipient.is_(True),
                   CapsuleKey.arrival_sent.is_(False), CapsuleKey.user_id != capsule.sender_id,
                   Account.blocked_at.is_(None))))
    for person in waiting:
        with SessionLocal() as db:
            if not _claim(db, capsule_id, person, "arrival_sent"):
                continue
            account = db.get(Account, person)
            language = account.language if account is not None else ""

        def for_lang(lang: str, fallback: str = language) -> push.Message:
            chosen = language_of(lang or fallback)
            words = TEXTS[chosen]
            return push.Message(title=words["title"], url=TAP, desk=TAP, tag=f"capsule-{capsule_id}",
                                body=words["arrived"].format(name=name, date=_date_words(opens_on, chosen)))

        result = push.send_to_person(person, for_lang)
        logger.info("Time capsule arrival pushed devices=%s", result.sent)
        told += 1
    return told


def announce_later(capsule_id: int) -> None:
    """``announce`` in the background: a slow push service never holds the closing up."""
    notices.later(announce, capsule_id)


def _due(zone: str, opens_on: str, now: datetime) -> bool:
    """Whether the push of the day is due for this recipient: on its day from 08:00 of the clock kept for them, or any
    time after (a server that was down at eight)."""
    local = now.astimezone(_zone(zone))
    today = local.date().isoformat()
    return today > opens_on or (today == opens_on and local.time() >= OPEN_PUSH_AT)


def run_once(now: datetime | None = None) -> int:
    """One round of the planner: every recipient whose capsule opened gets its push, once; photos chosen for capsules
    that were never closed go after a day. Gives how many pushes went out."""
    from ..db import SessionLocal

    moment = now or clock.now()
    # No zone is more than a day ahead of UTC: only capsules up to tomorrow can have opened anywhere.
    horizon = (moment.date() + timedelta(days=1)).isoformat()
    sent = 0
    with SessionLocal() as db:
        rows = db.execute(
            select(CapsuleKey.capsule_id, CapsuleKey.user_id, CapsuleKey.zone, Capsule.opens_on, Capsule.sender_id)
            .join(Capsule, Capsule.id == CapsuleKey.capsule_id)
            .where(CapsuleKey.recipient.is_(True), CapsuleKey.open_sent.is_(False), Capsule.opens_on <= horizon)
        ).all()
    for row in rows:
        try:
            with SessionLocal() as db:
                account = db.get(Account, row.user_id)
                if account is None or account.blocked_at is not None or not _due(row.zone, row.opens_on, moment):
                    continue
                sender = db.get(Account, row.sender_id) if row.sender_id is not None else None
                if sender is not None and sender.blocked_at is not None:
                    continue
                # Marked opened first, only while the capsule still opens by today: a change that moved its day in
                # between is never told as opened, and once the mark stands no change can move it any more.
                if not _mark_opened(db, row.capsule_id, today_in(row.zone, moment)):
                    continue
                if not _claim(db, row.capsule_id, row.user_id, "open_sent"):
                    continue
                language = account.language
                kind = "opened_self" if row.sender_id == row.user_id else "opened" if sender else "opened_gone"
                name = name_of(sender) if sender else ""

            def for_lang(lang: str, fallback: str = language, kind: str = kind, name: str = name,
                         capsule_id: int = row.capsule_id) -> push.Message:
                words = TEXTS[language_of(lang or fallback)]
                return push.Message(title=words["title"], body=words[kind].format(name=name), url=TAP, desk=TAP,
                                    tag=f"capsule-{capsule_id}")

            result = push.send_to_person(row.user_id, for_lang)
            logger.info("Time capsule opening pushed devices=%s", result.sent)
            sent += 1
        except Exception:
            # One person's trouble never stops the others.
            logger.exception("A time capsule push failed")
    _tidy_uploads(moment)
    return sent


def _tidy_uploads(moment: datetime) -> None:
    """Photos chosen for a capsule that was never closed, older than a day: gone, files and rows."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        old = list(db.scalars(select(CapsuleUpload.uid).where(CapsuleUpload.created_at < moment - UPLOAD_KEEP)))
        if not old:
            return
        db.execute(delete(CapsuleUpload).where(CapsuleUpload.uid.in_(old)))
        db.commit()
    photos.remove_files(old)


async def run_forever(stop: asyncio.Event) -> None:
    """Once a minute, shortly after it begins."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            logger.exception("The time capsule round failed")
        moment = clock.now()
        wait = 60 - moment.second - moment.microsecond / 1_000_000 + 2
        try:
            await asyncio.wait_for(stop.wait(), max(1.0, wait))
        except TimeoutError:
            continue
