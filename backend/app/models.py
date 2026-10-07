"""The data model.

Everything lives in SQLite. The schema carries a version number (``db.SCHEMA_VERSION``); a change to a table here
comes with a migration step in ``db.MIGRATIONS`` and a new recorded schema in ``tests/schema/``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator[datetime]):
    """SQLite forgets the time zone. Stored as UTC, read back as UTC with the zone attached."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)


OPERATOR = "operator"
MEMBER = "member"
ROLES = (OPERATOR, MEMBER)

SIGN_IN_PASSWORD = "password"
SIGN_IN_OIDC = "oidc"


class Account(Base):
    """A person. The first account is the operator; the others come by invitation or through OIDC.

    The operator manages accounts and never sees what is written in them."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Lower case, the name people sign in with. What people see is the display name, when there is one.
    name: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(80), default="")
    #: The version whose "What's new" the account has read or put away.
    whats_new_seen: Mapped[str] = mapped_column(String(32), default="")
    role: Mapped[str] = mapped_column(String(16), default=MEMBER)
    sign_in: Mapped[str] = mapped_column(String(16), default=SIGN_IN_PASSWORD)
    #: Argon2id. Empty for accounts that sign in through OIDC only.
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    oidc_subject: Mapped[str] = mapped_column(String(255), default="")
    #: The interface language; empty: the browser's.
    language: Mapped[str] = mapped_column(String(16), default="")
    #: What the person chose for themselves (``routers/auth.py``, ``PROFILE``): only what it chose is kept.
    profile: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Set when the operator blocked the account: no sign-in, sessions and tokens end at once.
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The second factor (``services/totp.py``): the seed encrypted with the server secret, empty while off; the
    #: recovery codes as a JSON list of SHA-256 hashes; the time step of the last code taken (no replay).
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    totp_recovery: Mapped[str] = mapped_column(Text, default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    #: The profile picture (``services/avatars.py``): a square WebP drawn anew, loaded only when asked for.
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Whether the values the app starts with were laid out for this person (``services/diary.py``). Set once, so
    #: that values a person deleted do not come back.
    values_seeded: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))


class AuthSession(Base):
    """A browser session. Only the hash of the token is stored; the token itself lives in the cookie."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")


class Invite(Base):
    """A link that brings somebody in with a new account. Only the hash of the token is stored; used once, then gone."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    email: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class ApiToken(Base):
    """A token an account made for programs (``/api/v1``). Only the SHA-256 is stored."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    #: ``read``, the only level there is.
    level: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


# --- The diary -------------------------------------------------------------------------------------------------------
#
# What a person writes is sealed with their own data key (``services/vault.py``): AES-256-GCM per field, bound to the
# person, the table, the column and the row. In the clear stays only what sorting needs: dates, times, positions.


class UserKey(Base):
    """A person's data key, wrapped with the master key. Deleting it makes everything the person wrote unreadable."""

    __tablename__ = "user_keys"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    wrapped_dek: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Day(Base):
    """The page of one day: title, text, tags, values and how it came about, sealed in one field."""

    __tablename__ = "days"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_days_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    #: ``YYYY-MM-DD`` in the person's own time zone.
    date: Mapped[str] = mapped_column(String(10))
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    #: Counts every change: a change is written only onto the revision it was read from (no lost update).
    revision: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Note(Base):
    """A note thrown down during the day. ``uid`` comes from the browser, so sending the same note twice keeps one."""

    __tablename__ = "notes"
    __table_args__ = (
        UniqueConstraint("user_id", "uid", name="uq_notes_user_uid"),
        Index("ix_notes_user_date", "user_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(36))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    date: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    text_enc: Mapped[bytes] = mapped_column(LargeBinary)
    #: The question a note answers (writing prompts).
    prompt_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    #: A photo that came with the note.
    photo_id: Mapped[str | None] = mapped_column(String(40), nullable=True)


class ValueDef(Base):
    """One of the things a person rates from 1 to 10 each day. Its name says something about the person: sealed."""

    __tablename__ = "value_defs"
    __table_args__ = (UniqueConstraint("user_id", "uid", name="uq_value_defs_user_uid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    #: Name, the words for 1 and for 10, a hint, whether it is asked.
    data_enc: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Photo(Base):
    """A photo of a day. The picture itself lies sealed in the media folder (``services/photos.py``): the original,
    drawn anew without anything but its pixels, and a smaller copy for lists. Its file names are the random ``uid``
    (and ``uid.p``); what the database keeps in the clear is what sorting and laying out need."""

    __tablename__ = "photos"
    __table_args__ = (
        UniqueConstraint("uid", name="uq_photos_uid"),
        UniqueConstraint("user_id", "upload_id", name="uq_photos_user_upload"),
        Index("ix_photos_user_date", "user_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    date: Mapped[str] = mapped_column(String(10))
    #: ``upload`` or ``immich``.
    source: Mapped[str] = mapped_column(String(8), default="upload")
    #: The asset a photo was copied from (Immich).
    asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: Made by the browser for one upload: the same upload sent twice keeps one photo.
    upload_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    #: Bytes on disk, sealed: the original and the smaller copy.
    size: Mapped[int] = mapped_column(Integer)
    preview_size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: Taken for a note (a raw note of the day), not for the page: it goes with the notes, never with the photos of
    #: the day, whether or not a note still holds it. Set once, never taken back.
    on_note: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))


class Draft(Base):
    """What is being written on a day and not saved yet, sealed like the day: kept while typing, so that a closed tab,
    an empty battery or a lost connection loses nothing. ``base_revision`` is the revision of the day the writing
    started from (-1: there was no page), so that saving it later does not silently overwrite a newer page."""

    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_drafts_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    date: Mapped[str] = mapped_column(String(10))
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    base_revision: Mapped[int] = mapped_column(Integer, default=-1)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


# --- Sharing ---------------------------------------------------------------------------------------------------------
#
# A share lets one other person read one day of the owner. Nothing is copied: whoever reads a shared day gets it opened
# from the owner's own sealed page at that moment (``services/sharing.py``), and only the parts the share allows.


class Share(Base):
    """One day of ``owner_id``, shown to ``to_user_id``. Bound to the day itself: deleting the page deletes its shares,
    deleting either account too. Read only for the person it is shared with; they cannot pass it on."""

    __tablename__ = "shares"
    __table_args__ = (
        UniqueConstraint("owner_id", "day_date", "to_user_id", name="uq_shares_owner_day_to"),
        ForeignKeyConstraint(["owner_id", "day_date"], ["days.user_id", "days.date"], ondelete="CASCADE"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    day_date: Mapped[str] = mapped_column(String(10))
    to_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    #: The ratings of the day go with it.
    with_values: Mapped[bool] = mapped_column(Boolean, default=False)
    #: The raw notes of the day go with it, and the photos that came with them.
    with_notes: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Heart(Base):
    """The one sign a person can send back for a day shared with them; at most one per share."""

    __tablename__ = "hearts"

    share_id: Mapped[int] = mapped_column(ForeignKey("shares.id", ondelete="CASCADE"), primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ShareSeen(Base):
    """When the person a day is shared with first opened it: until then it counts as new."""

    __tablename__ = "share_seen"

    share_id: Mapped[int] = mapped_column(ForeignKey("shares.id", ondelete="CASCADE"), primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


__all__ = [
    "MEMBER",
    "OPERATOR",
    "ROLES",
    "SIGN_IN_OIDC",
    "SIGN_IN_PASSWORD",
    "Account",
    "ApiToken",
    "AuthSession",
    "Base",
    "Day",
    "Draft",
    "Heart",
    "Invite",
    "Note",
    "Photo",
    "Setting",
    "Share",
    "ShareSeen",
    "UserKey",
    "ValueDef",
    "utcnow",
]
