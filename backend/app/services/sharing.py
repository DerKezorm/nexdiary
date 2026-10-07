"""Sharing one day with other people on the same server.

The rules, all of them kept here on the server and none in the browser:

* **One day, named people.** A share is the owner, a date with a page, and one other active account. Text, tags, the
  cover and the photos of the day always go with it; the ratings only with ``with_values``, the raw notes (and the
  photos that came with them) only with ``with_notes``.
* **Nothing is copied.** Whoever reads a shared day gets the owner's page opened with the owner's data key at that
  moment, and only the parts the share allows. The reader sees the page as it stands now; taking a share back, or
  deleting the page, leaves nothing behind (the rows go by ``ON DELETE CASCADE``).
* **Read only, for that one person.** A shared day of somebody else answers 404 to everybody but the person it is
  shared with, exactly like a day that does not exist. There is no way to pass it on: sharing works on the own pages
  only. The operator has no way in either.
* **Blocked accounts vanish.** Shares from a blocked account are not shown to anybody, shares to a blocked account
  are not shown to the owner and cannot be made; deleting an account deletes its shares both ways.
* **One heart**, from the person a day is shared with, at most one per share, and it can be taken back. The owner
  sees who sent one. No comments.

Writes that could meet are single statements: sharing twice at once leaves one share, two hearts at once one heart,
sharing and taking back at once leave one of the two states, never half of each.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import bindparam, delete, func, select, text
from sqlalchemy.orm import Session

from ..errors import error
from ..models import Account, Day, Heart, Note, Photo, Share, ShareSeen, UtcDateTime
from . import covers, diary, photos, vault

#: The most people one day can be shared with in one go; a family is far smaller.
RECIPIENTS_MAX = 50
#: The most people listed to choose from.
PEOPLE_MAX = 500


# --- People ---------------------------------------------------------------------------------------------------------


def person_view(row: Any) -> dict[str, Any]:
    """What everybody on the server may know of a person: the name, the shown name, whether there is a picture."""
    return {
        "id": row.id,
        "name": row.name,
        "display_name": row.display_name or "",
        "avatar": row.avatar_at.isoformat() if row.avatar_at else None,
    }


_PERSON = (Account.id, Account.name, Account.display_name, Account.avatar_at)


def people(db: Session, account_id: int) -> list[dict[str, Any]]:
    """The other accounts a day can be shared with: every one that is not blocked, in the order they came. Nothing
    else of them."""
    rows = db.execute(select(*_PERSON).where(Account.id != account_id, Account.blocked_at.is_(None))
                      .order_by(Account.id).limit(PEOPLE_MAX)).all()
    return [person_view(row) for row in rows]


def _person(db: Session, account_id: int) -> Any:
    return db.execute(select(*_PERSON).where(Account.id == account_id)).first()


# --- The owner's side -----------------------------------------------------------------------------------------------


def _owner_shares(db: Session, owner_id: int, day: str) -> list[Any]:
    """The shares of one own day, to accounts that are not blocked, with the heart each sent (or None)."""
    return list(db.execute(
        select(Share.id.label("share_id"), Share.to_user_id, Share.with_values, Share.with_notes, Share.created_at,
               Heart.at.label("heart"), *_PERSON)
        .join(Account, Account.id == Share.to_user_id)
        .outerjoin(Heart, Heart.share_id == Share.id)
        .where(Share.owner_id == owner_id, Share.day_date == day, Account.blocked_at.is_(None))
        .order_by(Account.id)
    ).all())


def _recipient_view(row: Any) -> dict[str, Any]:
    return {**person_view(row), "with_values": bool(row.with_values), "with_notes": bool(row.with_notes),
            "heart": row.heart.isoformat() if row.heart else None}


def shares_of_day(db: Session, owner_id: int, day: str) -> dict[str, Any]:
    """Who one own day is shared with, and what they see. ``not_found`` for a day without a page."""
    if not diary.day_exists(db, owner_id, day):
        raise error("not_found", "Not found.", 404)
    rows = _owner_shares(db, owner_id, day)
    return {
        "date": day,
        "people": [_recipient_view(row) for row in rows],
        "with_values": any(row.with_values for row in rows),
        "with_notes": any(row.with_notes for row in rows),
    }


def share_day(db: Session, owner_id: int, day: str, to: list[int], with_values: bool,
              with_notes: bool) -> dict[str, Any]:
    """Shares one own day with exactly these people, each seeing the same parts; anybody else it was shared with no
    longer sees it (an empty list ends sharing the day). One transaction: whoever reads in between sees the old state
    or the new one. Only other accounts that are not blocked can be named; a day without a page cannot be shared."""
    recipients = sorted(set(to))
    if len(recipients) > RECIPIENTS_MAX:
        raise error("too_many_people", "Too many people at once.", 422, max=RECIPIENTS_MAX)
    if owner_id in recipients:
        raise error("person_unknown", "There is no such person to share with.", 422)
    moment = diary.now()
    try:
        if not diary.day_exists(db, owner_id, day):
            raise error("not_found", "Not found.", 404)
        # Everybody not named loses the day: written as "not in", so that one named twice at once stays.
        db.execute(delete(Share).where(Share.owner_id == owner_id, Share.day_date == day,
                                       Share.to_user_id.not_in(recipients)))
        for person in recipients:
            # The person must exist, be somebody else and not be blocked, and the page must stand: all checked in the
            # statement that writes, so that a block or a deletion in between cannot slip through.
            written = db.execute(
                text(
                    "INSERT INTO shares (owner_id, day_date, to_user_id, with_values, with_notes, created_at) "
                    "SELECT :owner, :day, users.id, :values, :notes, :now FROM users "
                    "WHERE users.id = :to AND users.id != :owner AND users.blocked_at IS NULL "
                    "AND EXISTS (SELECT 1 FROM days WHERE days.user_id = :owner AND days.date = :day) "
                    "ON CONFLICT (owner_id, day_date, to_user_id) DO UPDATE SET "
                    "with_values = excluded.with_values, with_notes = excluded.with_notes"
                ).bindparams(bindparam("now", type_=UtcDateTime())),
                {"owner": owner_id, "day": day, "to": person, "values": bool(with_values), "notes": bool(with_notes),
                 "now": moment},
            )
            if written.rowcount != 1:
                if not diary.day_exists(db, owner_id, day):
                    raise error("not_found", "Not found.", 404)
                raise error("person_unknown", "There is no such person to share with.", 422)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return shares_of_day(db, owner_id, day)


def stop_sharing(db: Session, owner_id: int, day: str) -> None:
    """Nobody sees this own day any more. Fine when nobody did."""
    db.execute(text("DELETE FROM shares WHERE owner_id = :owner AND day_date = :day"), {"owner": owner_id, "day": day})
    db.commit()


def recipients_by_day(db: Session, owner_id: int, days: list[str] | None = None) -> dict[str, list[dict[str, Any]]]:
    """For the owner's lists: who each of these own days is shared with (accounts that are not blocked)."""
    query = (select(Share.day_date, Heart.at.label("heart"), *_PERSON, Share.with_values, Share.with_notes)
             .join(Account, Account.id == Share.to_user_id)
             .outerjoin(Heart, Heart.share_id == Share.id)
             .where(Share.owner_id == owner_id, Account.blocked_at.is_(None))
             .order_by(Share.day_date.desc(), Account.id))
    if days is not None:
        if not days:
            return {}
        query = query.where(Share.day_date.in_(days))
    out: dict[str, list[dict[str, Any]]] = {}
    for row in db.execute(query):
        out.setdefault(row.day_date, []).append(_recipient_view(row))
    return out


def shared_by_me(db: Session, owner_id: int, dek: bytes) -> list[dict[str, Any]]:
    """The own days shared with somebody, newest first: date, title, cover and who sees each."""
    shared = recipients_by_day(db, owner_id)
    if not shared:
        return []
    rows = db.execute(select(Day.date, Day.content_enc).where(Day.user_id == owner_id, Day.date.in_(list(shared)))
                      .order_by(Day.date.desc())).all()
    photo_ids = diary.photo_ids_of(db, owner_id)
    out = []
    for row in rows:
        content = diary._readable_content(owner_id, dek, row.date, row.content_enc)
        shown = content or diary.empty_day()
        out.append({"date": row.date, "title": shown["title"],
                    "cover": diary.effective_cover(row.date, shown, photo_ids)[0],
                    "people": shared[row.date], "unreadable": content is None})
    return out


# --- The side of the person a day is shared with -------------------------------------------------------------------


def _share_for(db: Session, viewer_id: int, owner_id: int, day: str) -> Any:
    """The share of this day of ``owner_id`` with ``viewer_id``, from an owner who is not blocked; ``not_found`` for
    anything else, exactly as for a day that does not exist."""
    row = db.execute(
        select(Share.id, Share.with_values, Share.with_notes, Share.created_at)
        .join(Account, Account.id == Share.owner_id)
        .where(Share.owner_id == owner_id, Share.day_date == day, Share.to_user_id == viewer_id,
               Share.owner_id != viewer_id, Account.blocked_at.is_(None))
    ).first()
    if row is None:
        raise error("not_found", "Not found.", 404)
    return row


def _open_day(db: Session, owner_id: int, day: str) -> tuple[bytes, dict[str, Any]]:
    """The owner's page, opened with the owner's key. A page that does not open is not shown at all."""
    sealed = db.scalar(select(Day.content_enc).where(Day.user_id == owner_id, Day.date == day))
    if sealed is None:
        raise error("not_found", "Not found.", 404)
    try:
        dek = vault.dek_of(owner_id)
    except vault.SealError as exc:
        raise error("not_found", "Not found.", 404) from exc
    content = diary._readable_content(owner_id, dek, day, sealed)
    if content is None:
        raise error("not_found", "Not found.", 404)
    return dek, content


def _note_photo_ids(db: Session, owner_id: int, day: str) -> set[str]:
    query = select(Note.photo_id).where(Note.user_id == owner_id, Note.photo_id.is_not(None), Note.date == day)
    return {uid for uid in db.scalars(query) if uid}


def visible_photos(db: Session, owner_id: int, day: str, content: dict[str, Any],
                   with_notes: bool) -> tuple[str, list[dict[str, Any]], set[str]]:
    """What of the owner's photos a shared day shows: the cover (always; only a photo of that very day can be one),
    the photos taken for the day itself (never one taken for a note, whether a note still holds it or not), and with
    ``with_notes`` the photos the day's notes hold. The cover, the photos to list (the cover not among them) and every
    id that may be fetched through the share."""
    rows = db.execute(select(Photo.uid, Photo.date, Photo.source, Photo.width, Photo.height, Photo.created_at,
                             Photo.on_note)
                      .where(Photo.user_id == owner_id, Photo.date == day)
                      .order_by(Photo.created_at, Photo.id)).all()
    cover, _chosen = diary.effective_cover(day, content, {row.uid for row in rows})
    of_the_day = [photos.view(row) for row in rows if not row.on_note]
    allowed = {item["id"] for item in of_the_day}
    cover_photo = covers.photo_of(cover)
    if cover_photo is not None:
        allowed.add(cover_photo)
    if with_notes:
        allowed |= _note_photo_ids(db, owner_id, day) & diary.photo_ids_of(db, owner_id)
    listed = [{key: item[key] for key in ("id", "width", "height")} for item in of_the_day if item["id"] != cover_photo]
    return cover, listed, allowed


def _values_shown(db: Session, owner_id: int, dek: bytes, ratings: dict[str, Any]) -> list[dict[str, Any]]:
    """The owner's ratings of the day with the names of the values, in the owner's order."""
    out = []
    for value in diary.list_values(db, owner_id, dek):
        rating = ratings.get(value["id"])
        if isinstance(rating, int) and not value["unreadable"]:
            out.append({"name": value["name"], "low": value["low"], "high": value["high"], "value": rating})
    return out


def _notes_shown(db: Session, owner_id: int, dek: bytes, day: str, allowed: set[str]) -> list[dict[str, Any]]:
    out = []
    for note in diary.list_notes(db, owner_id, dek, day):
        if note["unreadable"]:
            continue
        photo = note["photo_id"] if note["photo_id"] in allowed else None
        if not note["text"] and photo is None:
            continue
        out.append({"text": note["text"], "prompt": note["prompt"], "photo_id": photo,
                    "created_at": note["created_at"]})
    return out


def shared_day(db: Session, viewer_id: int, owner_id: int, day: str) -> dict[str, Any]:
    """A day somebody shared with the viewer, with exactly the parts the share allows."""
    share = _share_for(db, viewer_id, owner_id, day)
    dek, content = _open_day(db, owner_id, day)
    cover, listed, allowed = visible_photos(db, owner_id, day, content, bool(share.with_notes))
    owner = _person(db, owner_id)
    hearted = db.scalar(select(Heart.at).where(Heart.share_id == share.id))
    out: dict[str, Any] = {
        "from": person_view(owner),
        "date": day,
        "title": content["title"],
        "text": content["text"],
        "tags": content["tags"],
        "cover": cover,
        "photos": listed,
        "with_values": bool(share.with_values),
        "with_notes": bool(share.with_notes),
        "heart": hearted.isoformat() if hearted else None,
        "shared_at": share.created_at.isoformat(),
    }
    if share.with_values:
        out["values"] = _values_shown(db, owner_id, dek, content["values"])
    if share.with_notes:
        out["notes"] = _notes_shown(db, owner_id, dek, day, allowed)
    return out


def shared_photo(db: Session, viewer_id: int, owner_id: int, day: str, uid: str, preview: bool) -> bytes:
    """A photo of a day shared with the viewer: only one the shared day shows; any other answers 404."""
    share = _share_for(db, viewer_id, owner_id, day)
    dek, content = _open_day(db, owner_id, day)
    _cover, _listed, allowed = visible_photos(db, owner_id, day, content, bool(share.with_notes))
    if uid not in allowed:
        raise error("not_found", "Not found.", 404)
    return photos.read(db, owner_id, dek, uid, preview)


def _received(db: Session, viewer_id: int) -> list[Any]:
    return list(db.execute(
        select(Share.id.label("share_id"), Share.owner_id, Share.day_date, Share.created_at, ShareSeen.at.label("seen"),
               Heart.at.label("heart"), *_PERSON)
        .join(Account, Account.id == Share.owner_id)
        .outerjoin(ShareSeen, ShareSeen.share_id == Share.id)
        .outerjoin(Heart, Heart.share_id == Share.id)
        .where(Share.to_user_id == viewer_id, Share.owner_id != viewer_id, Account.blocked_at.is_(None))
        .order_by(Share.day_date.desc(), Share.created_at.desc(), Share.id.desc())
    ).all())


def shared_with_me(db: Session, viewer_id: int) -> list[dict[str, Any]]:
    """The days others shared with the viewer, newest day first: who, when, the title, the start of the text, the
    cover, whether it is new and whether a heart went back. No ratings, no notes: those only on the day itself."""
    out = []
    keys: dict[int, bytes | None] = {}
    for row in _received(db, viewer_id):
        if row.owner_id not in keys:
            try:
                keys[row.owner_id] = vault.dek_of(row.owner_id)
            except vault.SealError:
                keys[row.owner_id] = None
        dek = keys[row.owner_id]
        sealed = db.scalar(select(Day.content_enc).where(Day.user_id == row.owner_id, Day.date == row.day_date))
        content = diary._readable_content(row.owner_id, dek, row.day_date, sealed) if dek and sealed else None
        if content is None:
            continue
        cover, _listed, _allowed = visible_photos(db, row.owner_id, row.day_date, content, False)
        out.append({
            "from": person_view(row),
            "date": row.day_date,
            "title": content["title"],
            "excerpt": diary.excerpt(content["text"]),
            "cover": cover,
            "new": row.seen is None,
            "heart": row.heart.isoformat() if row.heart else None,
        })
    return out


def unseen_count(db: Session, viewer_id: int) -> int:
    """How many shared days the viewer has not opened yet. Opens nothing."""
    return int(db.scalar(
        select(func.count()).select_from(Share)
        .join(Account, Account.id == Share.owner_id)
        .outerjoin(ShareSeen, ShareSeen.share_id == Share.id)
        .where(Share.to_user_id == viewer_id, Share.owner_id != viewer_id, Account.blocked_at.is_(None),
               ShareSeen.share_id.is_(None))
    ) or 0)


def _mark(db: Session, table: str, share_id: int) -> None:
    """A row for the share in ``hearts`` or ``share_seen``, once, and only while the share stands: taken back in the
    same moment, the statement writes nothing instead of failing on the missing share."""
    db.execute(
        text(f"INSERT INTO {table} (share_id, at) SELECT id, :now FROM shares WHERE id = :share "  # noqa: S608 - constant
             "ON CONFLICT (share_id) DO NOTHING").bindparams(bindparam("now", type_=UtcDateTime())),
        {"share": share_id, "now": diary.now()},
    )


def mark_seen(db: Session, viewer_id: int, owner_id: int, day: str) -> None:
    share = _share_for(db, viewer_id, owner_id, day)
    _mark(db, "share_seen", share.id)
    db.commit()


def set_heart(db: Session, viewer_id: int, owner_id: int, day: str, on: bool) -> dict[str, Any]:
    """Sends the heart for a day shared with the viewer, or takes it back; twice is the same as once."""
    share = _share_for(db, viewer_id, owner_id, day)
    if on:
        _mark(db, "hearts", share.id)
    else:
        db.execute(delete(Heart).where(Heart.share_id == share.id))
    db.commit()
    hearted = db.scalar(select(Heart.at).where(Heart.share_id == share.id))
    if on and hearted is None:
        # No heart after sending one: the share was taken back in between (404), or the heart was taken back in the
        # same moment from another tab, which leaves the share standing and no heart.
        _share_for(db, viewer_id, owner_id, day)
    return {"heart": hearted.isoformat() if hearted else None}
