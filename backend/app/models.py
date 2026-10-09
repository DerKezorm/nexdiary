"""The data model.

Everything lives in SQLite. The schema carries a version number (``db.SCHEMA_VERSION``); a change to a table here
comes with a migration step in ``db.MIGRATIONS`` and a new recorded schema in ``tests/schema/``.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    DDL,
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
    event,
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
    #: recovery codes as a JSON list of keyed hashes; the time step of the last code taken (no replay).
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    totp_recovery: Mapped[str] = mapped_column(Text, default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    #: The profile picture (``services/avatars.py``): a square WebP drawn anew, loaded only when asked for.
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Whether the values the app starts with were laid out for this person (``services/diary.py``). Set once, so
    #: that values a person deleted do not come back.
    values_seeded: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))
    #: Whether the account ever signed in: its very first sign-in is no "new device" (``services/notices.py``).
    signed_in_before: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))
    #: The user handle its passkeys carry (``services/passkeys.py``): random, the same for all of its passkeys, so a
    #: passkey names its account without its name or id. Hex; empty until the first passkey.
    passkey_handle: Mapped[str] = mapped_column(String(64), default="", server_default=text("''"))
    #: What the operator allows this person (on from the start; the operator takes single accounts out): the AI
    #: (``services/ai.py``) and a connection to Immich (``services/immich.py``). Both come on top of the operator's
    #: switch for the whole server and, for the AI, the person's own switch.
    ai_allowed: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("1"))
    immich_allowed: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("1"))
    #: The notes written after midnight (``services/diary.py``, ``night_of``): the date of the night the person
    #: answered for (the calendar day the hours between 0:00 and 3:59 belong to) and the day they said its notes
    #: belong to. Only read while that night lasts.
    night_for: Mapped[str | None] = mapped_column(String(10), nullable=True)
    night_day: Mapped[str | None] = mapped_column(String(10), nullable=True)


#: What a session may do (``deps.require_account``): everything; only set up the second factor right after signing in;
#: only confirm that the recovery codes are kept. The last two never become ``full`` themselves: a new session does.
STAGE_FULL = "full"
STAGE_SETUP = "setup"
STAGE_CODES = "codes"


def _session_uid() -> str:
    return secrets.token_hex(16)


class AuthSession(Base):
    """A browser session. Only the hash of the token is stored; the token itself lives in the cookie.

    ``uid`` names the session in the list of signed-in devices (never the token or its hash). ``remember``: the
    person ticked "stay signed in on this device", the session lasts until it was not used for ``session_days``;
    without, it ends with the browser and after twelve hours at the latest."""

    __tablename__ = "auth_sessions"
    __table_args__ = (Index("uq_auth_sessions_uid", "uid", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    uid: Mapped[str] = mapped_column(String(32), default=_session_uid, server_default=text("''"))
    remember: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("1"))
    stage: Mapped[str] = mapped_column(String(8), default=STAGE_FULL, server_default=text("'full'"))


class Passkey(Base):
    """A passkey of an account (WebAuthn, ``services/passkeys.py``): signs in without password and code, and counts
    as a second factor. Only the public key is kept; ``sign_count`` is the authenticator's counter as last seen."""

    __tablename__ = "passkeys"
    __table_args__ = (
        Index("uq_passkeys_uid", "uid", unique=True),
        Index("uq_passkeys_credential", "credential_id", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    credential_id: Mapped[bytes] = mapped_column(LargeBinary)
    public_key: Mapped[bytes] = mapped_column(LargeBinary)
    sign_count: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class Invite(Base):
    """A link that brings somebody in with a new account. Only the hash of the token is stored; used once, then gone."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    email: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class PasswordReset(Base):
    """A link with which a person sets a new password (``services/resets.py``). Only the hash of the token is stored;
    used once, then gone. At most one per account: a new one replaces the one before."""

    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: The operator who sent it; empty when the person asked for it themselves ("Forgot your password?").
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class ApiToken(Base):
    """A token an account made for programs (``/api/v1``). Only the SHA-256 is stored.

    The name is sealed with the owner's data key (``name_enc``); ``name`` stays empty. A token made before that, whose
    name still stands in the clear, is sealed at the next start (``services/apitokens.py``)."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100), default="")
    #: ``read``, the only level there is.
    level: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    name_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)


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
    #: When the person locked the day for good: set once, never cleared. A locked day cannot be changed or deleted, nor
    #: can its notes or photos (``services/diary.py``); only deleting the account takes it away. A trigger holds the
    #: row still, whatever code runs.
    locked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


#: The row of a locked day is never updated again (not its text, not the mark itself): the database says no, whatever
#: asks. Deleting stays possible for the cascade of a deleted account; the application refuses it for the person.
event.listen(
    Day.__table__,
    "after_create",
    DDL(
        "CREATE TRIGGER trg_days_locked_stays BEFORE UPDATE ON days WHEN OLD.locked_at IS NOT NULL "
        "BEGIN SELECT RAISE(ABORT, 'day is locked'); END"
    ),
)


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
    #: The question a note answers (writing prompts), as it was shown.
    prompt_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    #: A photo that came with the note.
    photo_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    #: Which question that was (``schoen.0``, ``own.<hex>``), sealed too: "answered today" holds in every language.
    prompt_ref_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)


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
        #: The same photo of Immich taken over twice (a double tap, two tabs) stays one photo.
        Index("uq_photos_user_asset", "user_id", "asset_id", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    date: Mapped[str] = mapped_column(String(10))
    #: ``upload`` or ``immich``.
    source: Mapped[str] = mapped_column(String(8), default="upload")
    #: Which photo of Immich it was copied from, and for what (the day or a note): a keyed hash of the person
    #: (``services/immich.py``), never the asset's own id.
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
    #: Taken for a picture in the text of the page (the picture button of the editor): such a photo goes when the page
    #: is saved or its draft thrown away and nothing holds it any more (``diary.tidy_text_photos``). Chosen again on
    #: purpose (a photo of the day, a cover), it stays for good.
    for_text: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))


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
    #: Made by the automatic writing in the morning and not touched since: it waits for the person and counts as no
    #: page. Saving the draft from the writing view makes it the person's own (0).
    auto: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))


class WritingPrompts(Base):
    """The writing prompts a person chose, sealed like the diary: whether questions are shown, which groups, the own
    questions (they say something about the person), and how often "another question" was asked on which day. One row
    per person; a change is written only onto the revision it was read from."""

    __tablename__ = "writing_prompts"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class WritingTemplates(Base):
    """The templates a person made for their pages, sealed like the diary: names and headings say something about the
    person. One row per person with every template and the choice of the default; a change is written only onto the
    revision it was read from."""

    __tablename__ = "writing_templates"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ImmichLink(Base):
    """A person's own Immich: its address, the API key and the choices of the card, sealed in one field with the
    person's data key. Only the person's own requests use it; the operator sees how many there are, never one."""

    __tablename__ = "immich_links"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


# --- Web Push and reminders ----------------------------------------------------------------------------------------


class PushDevice(Base):
    """A browser or an app on the home screen that gets reminders (``services/push.py``). What the browser handed
    over (the address at its push service and the two keys) and the name of the device are sealed with the person's
    data key: the address is a key in itself, whoever has it may send to the device. ``endpoint_key`` is a keyed
    hash of the address, so that the same browser signing up twice stays one device."""

    __tablename__ = "push_devices"
    __table_args__ = (
        UniqueConstraint("uid", name="uq_push_devices_uid"),
        UniqueConstraint("user_id", "endpoint_key", name="uq_push_devices_user_endpoint"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint_key: Mapped[str] = mapped_column(String(64))
    content_enc: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: The last message the push service took for this device.
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class ReminderMark(Base):
    """The day the last reminder went out for, in the person's own time zone. Set before sending, and only where it
    stood earlier (a conditional update): two server processes, two rounds in the same minute or a restart send one
    reminder, never two."""

    __tablename__ = "reminder_marks"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    #: ``YYYY-MM-DD``; empty while none went out.
    sent_for: Mapped[str] = mapped_column(String(10), default="")


class AutoMark(Base):
    """The day the automatic writing last tried for, in the person's own time zone: set before the AI is asked, and
    only where it stood earlier (a conditional update), so that each day is tried once, whatever comes of it."""

    __tablename__ = "auto_marks"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    #: ``YYYY-MM-DD``; empty while none was tried.
    tried_for: Mapped[str] = mapped_column(String(10), default="")


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


# --- Time capsules ---------------------------------------------------------------------------------------------------
#
# A letter that opens on a date, to oneself or to others on the server (``services/capsules.py``). Its title, text and
# photo are sealed with a key of the capsule's own; that key is sealed once for every person who holds the capsule,
# with that person's data key. So the capsule outlives the account that wrote it, and a person who goes takes only
# their own copy of the key.


class Capsule(Base):
    """One time capsule. In the clear only what sorting, opening and the rules need: who sent it, the day it opens, the
    day it was written, whether it is sealed for its sender, and the size of its photo."""

    __tablename__ = "capsules"
    __table_args__ = (
        UniqueConstraint("uid", name="uq_capsules_uid"),
        #: Made by the browser for one capsule: "Verschließen" sent twice keeps one capsule.
        UniqueConstraint("sender_id", "client_id", name="uq_capsules_sender_client"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[str] = mapped_column(String(32))
    #: Empty once the account that wrote it is deleted: the capsule stays with the people it was for.
    sender_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
                                                  index=True)
    client_id: Mapped[str] = mapped_column(String(36))
    #: A keyed hash (with the sender's data key) of what the browser asked to close, to answer the same request sent
    #: again without opening the capsule: never its words in the clear.
    request_mac: Mapped[str] = mapped_column(String(64))
    #: ``YYYY-MM-DD``: from 00:00 of this day in each recipient's own time zone the capsule is open for them.
    opens_on: Mapped[str] = mapped_column(String(10))
    #: ``YYYY-MM-DD`` in the sender's time zone, the day it was first closed.
    written_on: Mapped[str] = mapped_column(String(10))
    #: Only for the sender: until the day nobody can read or change it, the sender neither.
    sealed: Mapped[bool] = mapped_column(Boolean, default=False)
    title_enc: Mapped[bytes] = mapped_column(LargeBinary)
    text_enc: Mapped[bytes] = mapped_column(LargeBinary)
    #: The photo in the media folder (``uid`` and ``uid.p``), sealed with the capsule's key.
    photo_uid: Mapped[str | None] = mapped_column(String(32), nullable=True)
    photo_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    photo_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Bytes of both photo files on disk; counted in the sender's storage.
    photo_size: Mapped[int] = mapped_column(Integer, default=0)
    #: Counts every change: a change is written only onto the revision it was read from.
    revision: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: The first moment the server saw it open for one of its recipients: from then on it cannot be changed or taken
    #: back. Set in the same statement order as a change, so the two never pass each other.
    first_opened_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class CapsuleKey(Base):
    """The key of one capsule, sealed with the data key of one person who holds it: each recipient, and the sender
    (who may be a recipient too). Deleting the account deletes this copy only."""

    __tablename__ = "capsule_keys"

    capsule_id: Mapped[int] = mapped_column(ForeignKey("capsules.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    #: The capsule is for this person; false: the sender's own copy of a capsule only for others.
    recipient: Mapped[bool] = mapped_column(Boolean, default=True)
    #: The person's time zone when the capsule came to them (an IANA name; empty: the server's own). Opening and the
    #: push of the day follow it: changing one's zone later opens nothing earlier.
    zone: Mapped[str] = mapped_column(String(64), default="")
    key_enc: Mapped[bytes] = mapped_column(LargeBinary)
    #: The push "a capsule came for you" went out (or is not owed: the sender's own copy).
    arrival_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    #: The push "it has opened" went out on its day.
    open_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    #: When the recipient first read it, once it was open: until then it counts as new.
    read_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class CapsuleUpload(Base):
    """A photo chosen for a capsule that is not closed yet, sealed with the uploader's data key. Taken over (sealed
    anew with the capsule's key) when the capsule is closed or changed; gone after a day when nothing took it."""

    __tablename__ = "capsule_uploads"
    __table_args__ = (UniqueConstraint("user_id", "upload_id", name="uq_capsule_uploads_user_upload"),)

    uid: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    upload_id: Mapped[str] = mapped_column(String(36))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    size: Mapped[int] = mapped_column(Integer)
    preview_size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


# --- The family question ---------------------------------------------------------------------------------------------


class FamilyAnswer(Base):
    """The answer of one person to the family question of one day (``services/family.py``), sealed with that person's
    data key. In the clear only the day and which question it was: the question follows from the day for everybody."""

    __tablename__ = "family_answers"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_family_answers_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    #: ``YYYY-MM-DD`` in the answering person's own time zone.
    date: Mapped[str] = mapped_column(String(10))
    question: Mapped[str] = mapped_column(String(16))
    text_enc: Mapped[bytes] = mapped_column(LargeBinary)
    #: The note of the day the answer also became (its id), so that changing the answer changes that note too.
    note_uid: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


__all__ = [
    "MEMBER",
    "OPERATOR",
    "ROLES",
    "SIGN_IN_OIDC",
    "SIGN_IN_PASSWORD",
    "STAGE_CODES",
    "STAGE_FULL",
    "STAGE_SETUP",
    "Account",
    "ApiToken",
    "AuthSession",
    "Base",
    "Capsule",
    "CapsuleKey",
    "CapsuleUpload",
    "Day",
    "Draft",
    "FamilyAnswer",
    "Heart",
    "ImmichLink",
    "Invite",
    "Note",
    "Passkey",
    "Photo",
    "PushDevice",
    "ReminderMark",
    "Setting",
    "Share",
    "ShareSeen",
    "UserKey",
    "ValueDef",
    "WritingPrompts",
    "WritingTemplates",
    "utcnow",
]
