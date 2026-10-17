"""nexdiary's side of the shared sign-in module ``vendor/nexoidc``: the ``Store`` over its tables, the start-up
configuration, and the migration from the single provider of the settings to the list, with the way back to 0.6.

The shared module runs the protocol, decides who an identity is
and keeps the provider list; it never sees a database. What is nexdiary's own lives here: accounts and their names,
the address an invitation went to, the address a provider-only account follows, and the encryption of the client
secrets with the server secret.

Nothing here touches a diary. A person's data key lies in ``user_keys``, wrapped with the master key, never with a
password or anything a provider sends; a sign-in through a provider is a session of the account its link names
(``(provider_id, subject)``), exactly like a sign-in with that account's password.

A ``SqlStore`` works inside one SQLAlchemy session, one request. The module commits when an outcome is settled and
rolls back when it refuses after a write (a consumed invitation comes back that way). A store made with ``hold`` only
flushes where the module commits: its caller commits once, together with what it writes itself (the migration).
"""

from __future__ import annotations

import logging
import re
import threading
import unicodedata

from sqlalchemy import delete, event, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..db import SessionLocal
from ..models import (
    MEMBER,
    SIGN_IN_OIDC,
    Account,
    OidcLink,
    OidcProvider,
    utcnow,
)
from ..models import Invite as InviteRow
from ..security import decrypt_secret, encrypt_secret
from ..vendor import nexoidc
from ..vendor.nexoidc import (
    AccountState,
    Invite,
    Link,
    Provider,
    ProviderValues,
    migrate,
    protocol,
    secret_context,
)
from . import accounts, settings_service, totp

logger = logging.getLogger("nexdiary.oidc")

APP_NAME = "nexdiary"
#: Where nexdiary's sign-in and account pages are, as the module sends the browser there.
LOGIN_PAGE = "/login"
ACCOUNT_PAGE = "/konto"
HOME = "/"
#: Longest account name (``accounts.NAME_PATTERN``).
NAME_MAX = 64
_NUMBERED = re.compile(r"^(.*?)(-\d+)$")


def _public_url() -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db)


def save_public_url(url: str) -> None:
    """The address the operator confirmed in the authentik card becomes the public address (the setting
    ``public_url`` reads first), in a transaction of its own and committed at once: it outlives a restart, and a run
    of the button that fails later keeps it."""
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": url})


def _server_secret() -> str:
    return get_settings().resolved_secret_key()


def configure() -> None:
    """Tell the module who it runs in; called once at start-up (and by the tests)."""
    nexoidc.configure(
        nexoidc.AppConfig(
            app_name=APP_NAME,
            server_secret=_server_secret,
            public_url=_public_url,
            save_public_url=save_public_url,
            login_page=LOGIN_PAGE,
            account_page=ACCOUNT_PAGE,
            home=HOME,
            # Two instances on one host keep their attempts apart, as their sessions (``NEXDIARY_COOKIE_SUFFIX``).
            cookie_suffix=get_settings().cookie_name_suffix(),
        )
    )


def clean_name(raw: str) -> str:
    """An account name from what the provider suggests: lower case, nexdiary's characters, at most 64; a number at the
    end (``max-2``) survives the cut. Empty when nothing usable is left."""
    cleaned = re.sub(r"[^a-z0-9._-]", "-", raw.strip().lower()).strip("-._")
    if len(cleaned) > NAME_MAX:
        numbered = _NUMBERED.match(cleaned)
        suffix = numbered.group(2) if numbered else ""
        stem = numbered.group(1) if numbered else cleaned
        cleaned = stem[: NAME_MAX - len(suffix)].rstrip("-._") + suffix
    return cleaned if accounts.NAME_PATTERN.match(cleaned) else ""


def provider_only(account: Account) -> bool:
    """The account signs in through providers only (no password of its own here)."""
    return not totp.password_account(account)


def clean_address(value: str | None) -> str:
    """A provider's address as nexdiary keeps addresses: one line, no control or format characters, the form of
    ``accounts.EMAIL_PATTERN``, at most 255 characters; "" when it is none of that."""
    text = str(value or "").strip()
    if not text or len(text) > 255 or any(unicodedata.category(char) in ("Cc", "Cf") for char in text):
        return ""
    return text if accounts.EMAIL_PATTERN.match(text) else ""


def address_taken(db: Session, address: str, own_id: int) -> bool:
    """Another account has this address already: a provider's address never moves to a second account."""
    found = db.scalar(
        select(Account.id).where(func.lower(Account.email) == address.lower(), Account.id != own_id).limit(1)
    )
    return found is not None


def from_provider(db: Session, account: Account, raw: str | None) -> None:
    """What a provider says about the address at a sign-in (the caller commits). ``email_verified`` is never read and
    the address finds nobody: it is only where the account is mailed. An account through
    providers only follows it, never to an address another account has; an account with a password keeps its own."""
    address = clean_address(raw)
    if not address or not provider_only(account) or account.email.lower() == address.lower():
        return
    if address_taken(db, address, account.id):
        logger.warning("Provider address not taken, another account has it name=%s address=%s",
                       account.name, protocol.masked(address))
        return
    account.email = address


#: Set on a session when the entry ``oidc`` or a link changed: the way back to 0.6 is written before its commit.
TOUCHED = "nexoidc_touched"


def touched(db: Session) -> None:
    db.info[TOUCHED] = True


class SqlStore:
    """``nexoidc.Store`` over ``oidc_providers`` and ``oidc_links``, inside one session."""

    def __init__(self, db: Session, *, hold: bool = False) -> None:
        self.db = db
        self.hold = hold

    # --- Providers -------------------------------------------------------------------------------------------------

    def _provider(self, row: OidcProvider | None) -> Provider | None:
        if row is None:
            return None
        return Provider(
            id=row.id,
            slug=row.slug,
            label=row.label,
            issuer=row.issuer,
            client_id=row.client_id,
            client_secret=decrypt_secret(row.client_secret_enc, secret_context(row.id)),
            scopes=row.scopes,
            enabled=row.enabled,
            auto_create=row.auto_create,
            trusts_second_factor=row.trusts_second_factor,
            managed=row.managed,
            position=row.position,
            redirect_path=row.redirect_path,
            created_at=row.created_at,
            registered_redirect=row.registered_redirect or "",
        )

    def list_providers(self) -> list[Provider]:
        rows = self.db.scalars(select(OidcProvider).order_by(OidcProvider.position, OidcProvider.id))
        return [provider for provider in (self._provider(row) for row in rows) if provider is not None]

    def get_provider(self, provider_id: int) -> Provider | None:
        return self._provider(self.db.get(OidcProvider, provider_id))

    def provider_by_slug(self, slug: str) -> Provider | None:
        return self._provider(self.db.scalar(select(OidcProvider).where(OidcProvider.slug == slug)))

    @staticmethod
    def _apply(row: OidcProvider, values: ProviderValues) -> None:
        row.slug, row.label, row.issuer, row.client_id = values.slug, values.label, values.issuer, values.client_id
        row.scopes, row.enabled, row.auto_create = values.scopes, values.enabled, values.auto_create
        row.trusts_second_factor, row.managed, row.position = (
            values.trusts_second_factor,
            values.managed,
            values.position,
        )
        row.redirect_path = values.redirect_path
        if values.registered_redirect is not None:
            # None keeps what the button registered last; only the button writes it.
            row.registered_redirect = values.registered_redirect

    def insert_provider(self, values: ProviderValues) -> Provider:
        touched(self.db)
        row = OidcProvider()
        self._apply(row, values)
        self.db.add(row)
        self.db.flush()
        row.client_secret_enc = encrypt_secret(values.client_secret or "", secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def update_provider(self, provider_id: int, values: ProviderValues) -> Provider:
        touched(self.db)
        row = self.db.get(OidcProvider, provider_id)
        assert row is not None
        self._apply(row, values)
        if values.client_secret is not None:
            row.client_secret_enc = encrypt_secret(values.client_secret, secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def delete_provider(self, provider_id: int) -> None:
        # Foreign keys are on (db.py), the links would go anyway; said here so that nothing depends on a pragma.
        touched(self.db)
        self.drop_links(provider_id)
        self.db.execute(delete(OidcProvider).where(OidcProvider.id == provider_id))
        self.db.flush()

    # --- Links -----------------------------------------------------------------------------------------------------

    @staticmethod
    def _link(row: OidcLink) -> Link:
        return Link(row.provider_id, row.subject, row.account_id, row.issuer, row.email, row.created_at,
                    row.last_used_at)

    def find_link(self, provider_id: int, subject: str) -> Link | None:
        row = self.db.scalar(select(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject))
        return self._link(row) if row else None

    def links_of_provider(self, provider_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.provider_id == provider_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def links_of_account(self, account_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.account_id == account_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def add_link(self, link: Link) -> None:
        touched(self.db)
        self.db.add(OidcLink(provider_id=link.provider_id, subject=link.subject, account_id=link.account_id,
                             issuer=link.issuer, email=link.email))
        self.db.flush()

    def remove_link(self, provider_id: int, account_id: int) -> bool:
        touched(self.db)
        result = self.db.execute(
            delete(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.account_id == account_id)
        )
        self.db.flush()
        return bool(result.rowcount)  # type: ignore[attr-defined]

    def drop_links(self, provider_id: int) -> int:
        touched(self.db)
        result = self.db.execute(delete(OidcLink).where(OidcLink.provider_id == provider_id))
        self.db.flush()
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    def touch_link(self, provider_id: int, subject: str, email: str | None) -> None:
        self.db.execute(
            update(OidcLink)
            .where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
            .values(last_used_at=utcnow(), email=email)
        )
        account_id = self.db.scalar(
            select(OidcLink.account_id).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
        )
        account = self.db.get(Account, account_id) if account_id is not None else None
        if account is not None:
            from_provider(self.db, account, email)

    # --- Accounts --------------------------------------------------------------------------------------------------

    def account_state(self, account_id: int) -> AccountState | None:
        row = self.db.get(Account, account_id)
        if row is None:
            return None
        return AccountState(
            id=row.id,
            name=row.name,
            blocked=row.blocked_at is not None,
            has_password=totp.password_account(row),
            # A code from an app or a passkey: either is nexdiary's own second factor.
            has_second_factor=totp.has_second_factor(self.db, row),
        )

    def clean_name(self, raw: str) -> str:
        return clean_name(raw)

    def name_taken(self, name: str) -> bool:
        return accounts.by_name(self.db, name) is not None

    def create_account(self, name: str, *, invite: Invite | None, email: str | None) -> int:
        """A new account through a provider only. The address an invitation went to comes first (the operator chose
        it); else the provider's, never one another account has. Its diary's data key is made with its first page, as
        for every account, wrapped with the master key."""
        row = Account(name=name, role=MEMBER, sign_in=SIGN_IN_OIDC, password_hash="", whats_new_seen=__version__)
        self.db.add(row)
        self.db.flush()
        invitation = invite.rights if invite is not None and isinstance(invite.rights, InviteRow) else None
        if invitation is not None and invitation.email:
            row.email = invitation.email
        else:
            from_provider(self.db, row, email)
        logger.info("Account created name=%s role=%s sign_in=oidc", row.name, MEMBER)
        return row.id

    # --- Invitations -----------------------------------------------------------------------------------------------

    def find_invite(self, key: str) -> Invite | None:
        row = accounts.find_invite(self.db, key)
        return Invite(key=key, id=row.id, rights=row) if row is not None else None

    def consume_invite(self, invite: Invite) -> bool:
        row = invite.rights
        return isinstance(row, InviteRow) and accounts.consume(self.db, row)

    def accept_invite(self, account_id: int, invite: Invite) -> None:
        """A known identity that came through an invitation: what the invitation brings comes on top of what the
        account has, never instead. A nexdiary invitation brings nothing but the address it went to: an account
        without one takes it (as with a password, ``accounts.accept_invite``)."""
        row = invite.rights
        account = self.db.get(Account, account_id)
        if account is not None and isinstance(row, InviteRow) and row.email and not account.email:
            account.email = row.email

    # --- Transaction -----------------------------------------------------------------------------------------------

    def commit(self) -> None:
        if self.hold:
            self.db.flush()
        else:
            self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def linked_providers(db: Session) -> dict[int, list[dict[str, object]]]:
    """Per account the providers it is linked to, in the order of the list (marks in the operator's account list)."""
    linked: dict[int, list[dict[str, object]]] = {}
    for link, entry in db.execute(
        select(OidcLink, OidcProvider)
        .join(OidcProvider, OidcProvider.id == OidcLink.provider_id)
        .order_by(OidcProvider.position, OidcProvider.id)
    ):
        linked.setdefault(link.account_id, []).append({"id": entry.id, "slug": entry.slug, "label": entry.label})
    return linked


def has_links(db: Session, account_id: int) -> bool:
    return db.scalar(select(OidcLink.id).where(OidcLink.account_id == account_id).limit(1)) is not None


# --- The migration from the single provider of the settings --------------

#: The settings of the single provider before the list. They stay readable for one version (the way back), then go.
LEGACY_KEYS = ("oidc_issuer", "oidc_client_id", "oidc_client_secret_enc", "oidc_provider_name", "oidc_auto_create",
               "oidc_second_factor_by_provider")
#: Set once the settings were looked at: an operator who later removes every entry must not get the old provider
#: back at the next start.
MIGRATED = "oidc_list_migrated"
#: What the way back said when the app last wrote it (``migrate.fingerprint``): only sums, no secret, no subject.
FINGERPRINT = "oidc_legacy_fingerprint"
#: The issuer 0.6 knows, or ``migrate.CLOSED`` (module 1.0.10): with the entry ``oidc`` it decides what the way back
#: shows (``migrate.way_back``). nexdiary only stores it.
ANCHOR = "oidc_legacy_anchor"
#: 0.6's own switch "the provider checks the second factor": off, nexdiary asked its code after the provider. The
#: entry ``oidc`` takes the value it has at the migration (nexdiary asked the code); written
#: back with the way back.
TRUSTED_SWITCH = "oidc_second_factor_by_provider"


def trusted_before(db: Session) -> bool:
    """How 0.6 behaved after its provider: no code asked only when its operator switched that on."""
    return bool(settings_service.get(db, TRUSTED_SWITCH))


def _legacy(values: dict[str, object]) -> migrate.Legacy:
    label = str(values.get("oidc_provider_name") or "")
    return migrate.Legacy(
        issuer=str(values.get("oidc_issuer") or ""),
        client_id=str(values.get("oidc_client_id") or ""),
        client_secret=decrypt_secret(str(values.get("oidc_client_secret_enc") or "")),
        label=label,
        auto_create=bool(values.get("oidc_auto_create")),
        # The authentik button of nexdiary 0.1 to 0.6 named the provider "authentik"; the form never did by itself.
        set_up_by_button=label == "authentik",
    )


def read_legacy(db: Session) -> tuple[migrate.Legacy, list[tuple[int, str]]]:
    """The old settings and the old column, read the one way the migration, the fingerprint and ``resync`` read them
    (the secret decrypted)."""
    subjects = [
        (account_id, subject)
        for account_id, subject in db.execute(
            select(Account.id, Account.oidc_subject).where(Account.oidc_subject != "").order_by(Account.id)
        )
    ]
    return _legacy(settings_service.get_all(db)), subjects


def legacy_plan(db: Session) -> migrate.Plan | None:
    """The entry ``oidc`` and its links the old settings become; None when no provider was set up."""
    legacy, subjects = read_legacy(db)
    return migrate.plan(legacy, subjects, trusts_second_factor=trusted_before(db))


def migration_due(db: Session) -> bool:
    if settings_service.get(db, MIGRATED) or db.scalar(select(func.count()).select_from(OidcProvider)):
        return False
    return legacy_plan(db) is not None


#: One start of the sign-in at a time in this process.
_start_lock = threading.Lock()


def migrate_settings(*, backup: bool = True) -> Provider | None:
    """The whole start-up of the sign-in: once, at the first start with the list, the provider of the settings becomes
    the entry ``oidc`` with a link per stored subject (``/api/oidc/callback`` keeps signing in; a backup goes first).
    At every start, what 0.6 changed in its settings and its column while the app ran there is taken over
    (``migrate.resync``); then the way back is written again, always, and its fingerprint stored. The entry ``oidc``
    is returned when this start made it, else None.

    Two starts at once (the tests start the app from several threads; a second container) take turns here; one that
    still meets the other's row in the settings reads everything again once."""
    with _start_lock:
        for attempt in (1, 2):
            try:
                migrated = _migrate_once(backup)
                up_again(backup=backup)
                break
            except IntegrityError:
                if attempt == 2:
                    raise
                logger.info("OIDC: another start wrote the sign-in settings at the same moment; reading them again")
    if not migrated:
        return None
    with SessionLocal() as db:
        return SqlStore(db).provider_by_slug(nexoidc.LEGACY_SLUG)


def _migrate_once(backup: bool) -> bool:
    with SessionLocal() as db:
        if not migration_due(db):
            if not settings_service.get(db, MIGRATED):
                # No provider to move: the way back starts closed, and a provider 0.6 sets up later comes in through
                # ``resync`` (which opens it).
                settings_service.save(db, {MIGRATED: True, ANCHOR: migrate.CLOSED})
            return False
    if backup:
        from . import backups

        backups.create(kind=backups.UPDATE, note="before the sign-in provider list")
    with SessionLocal() as db:
        if not migration_due(db):
            return False
        plan = legacy_plan(db)
        # The anchor first: the commit inside ``apply`` writes the way back, and it must see it.
        settings_service.save(db, {ANCHOR: migrate.anchor_of(read_legacy(db)[0])}, commit=False)
        migrate.apply(SqlStore(db, hold=True), plan)
        settings_service.save(db, {MIGRATED: True})
        logger.warning("OIDC: the provider of the settings became the entry oidc (second factor %s)",
                       "checked by the provider" if trusted_before(db) else "asked by nexdiary")
    return True


# --- The way back to 0.6 and up again (module README "Rückweg und wieder hoch") ---------------------------------------


def mirror_way_back(db: Session) -> None:
    """The way back to 0.6: what the old settings and the column show is ``migrate.way_back``'s (one rule in the
    module: the entry ``oidc`` and the stored anchor decide). nexdiary writes it in the old form, the switch "the
    provider checks the second factor" on exactly when the entry is there in full (rule 1: on, trusted, the same
    issuer; an entry that does not trust it counts as off for 0.6), stores the anchor that comes
    back, and then the fingerprint of what it reads back. Called at every commit that touched the entry, a link or an
    account (``_write_the_way_back``) and at every start; **not** before the migration (the settings and the column are
    still 0.6's own and wait to be read). Flushes; the caller commits."""
    db.flush()
    if not settings_service.get(db, MIGRATED):
        return
    store = SqlStore(db)
    entry = store.provider_by_slug(nexoidc.LEGACY_SLUG)
    links = [(link.account_id, link.subject) for link in store.links_of_provider(entry.id)] if entry else []
    mirror = migrate.way_back(entry, links, str(settings_service.get(db, ANCHOR) or "") or None)
    secret = mirror.legacy.client_secret
    kept = str(settings_service.get(db, "oidc_client_secret_enc") or "")
    # Sealed afresh only when it changed: the same secret would give another text each time.
    sealed = "" if not secret else (kept if kept and decrypt_secret(kept) == secret else encrypt_secret(secret))
    settings_service.save(
        db,
        {
            "oidc_issuer": mirror.legacy.issuer,
            "oidc_client_id": mirror.legacy.client_id,
            "oidc_client_secret_enc": sealed,
            "oidc_provider_name": mirror.legacy.label,
            "oidc_auto_create": bool(mirror.legacy.auto_create),
            TRUSTED_SWITCH: bool(mirror.legacy.client_id),
            ANCHOR: mirror.anchor,
        },
        commit=False,
    )
    for account in db.scalars(
        select(Account).where((Account.oidc_subject != "") | Account.id.in_(list(mirror.subjects)))
    ):
        wanted = mirror.subjects.get(account.id, "")
        if account.oidc_subject != wanted:
            account.oidc_subject = wanted
    db.flush()
    legacy, subjects = read_legacy(db)
    settings_service.save(db, {FINGERPRINT: migrate.fingerprint(legacy, subjects)}, commit=False)


def _switch_turned_off_in_0_6(db: Session) -> None:
    """0.6 turned its switch "the provider checks the second factor" off while its provider was there in full. The
    fingerprint does not hold the switch; this does: the way back writes the switch on exactly when it writes the
    client (rule 1), so a client with the switch off was left so by 0.6. The entry ``oidc`` follows, and asks the
    code after the provider again (never the other way round: on comes back only with a provider 0.6 sets up, through
    ``resync``)."""
    legacy, _subjects = read_legacy(db)
    if not legacy.client_id or trusted_before(db):
        return
    store = SqlStore(db, hold=True)
    entry = store.provider_by_slug(nexoidc.LEGACY_SLUG)
    if entry is None or not entry.trusts_second_factor or not protocol.same_issuer(entry.issuer, legacy.issuer):
        return
    store.update_provider(entry.id, ProviderValues(
        slug=entry.slug, label=entry.label, issuer=entry.issuer, client_id=entry.client_id, client_secret=None,
        scopes=entry.scopes, enabled=entry.enabled, auto_create=entry.auto_create, trusts_second_factor=False,
        managed=entry.managed, position=entry.position, redirect_path=entry.redirect_path,
    ))
    logger.warning("OIDC: 0.6 switched off that the provider checks the second factor; the entry oidc asks it again")


def up_again(*, backup: bool = True) -> None:
    """At every start after the migration: take over what 0.6 changed since the fingerprint of the last time (and
    nothing else; a backup goes first when there is something), then write the way back again, always, also without
    a single provider, and store the new fingerprint. Without a stored fingerprint (the first start of this version)
    nothing is taken over."""
    with SessionLocal() as db:
        legacy, subjects = read_legacy(db)
        previous = str(settings_service.get(db, FINGERPRINT) or "") or None
        found = migrate.changes_since(previous, legacy, subjects)
    if found.any and backup:
        from . import backups

        backups.create(kind=backups.UPDATE, note="before taking over the old sign-in settings")
    with SessionLocal() as db:
        legacy, subjects = read_legacy(db)

        def keep_anchor(value: str) -> None:
            settings_service.save(db, {ANCHOR: value}, commit=False)

        migrate.resync(
            SqlStore(db, hold=True), legacy, subjects, previous=previous, trusts_second_factor=trusted_before(db),
            anchor=str(settings_service.get(db, ANCHOR) or "") or None, keep_anchor=keep_anchor,
        )
        _switch_turned_off_in_0_6(db)
        mirror_way_back(db)
        db.commit()


@event.listens_for(Session, "before_flush")
def _note_changes(session: Session, _context: object, _instances: object) -> None:
    """A change the store does not make itself: an entry or a link changed by the ORM, an account deleted (its links
    go with it). The column of 0.6 is not watched: nothing here writes it but the mirror; a change there is 0.6's."""
    for item in (*session.new, *session.dirty, *session.deleted):
        if isinstance(item, OidcProvider | OidcLink) or (isinstance(item, Account) and item in session.deleted):
            session.info[TOUCHED] = True
            return


@event.listens_for(Session, "before_commit")
def _write_the_way_back(session: Session) -> None:
    # What is still waiting is flushed first: the changes are seen at the flush, which comes after this event.
    session.flush()
    if session.info.pop(TOUCHED, False):
        mirror_way_back(session)
        # Its own writes are no change of the entry.
        session.info.pop(TOUCHED, None)

