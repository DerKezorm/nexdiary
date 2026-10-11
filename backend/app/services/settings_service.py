"""Operator settings in the database, with defaults."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Setting
from ..vendor.nexoidc import flow

DEFAULTS: dict[str, Any] = {
    "log_mode": "normal",
    "log_mode_until": None,
    #: off | daily | weekly. Daily in the night unless the operator decides otherwise.
    "backup_schedule": "daily",
    "backup_keep": 7,
    #: The address people use to reach nexdiary: invitation links, the redirect address of the sign-in providers.
    #: Empty means ``NEXDIARY_PUBLIC_URL``, and without that the request's own.
    "public_url": "",
    #: Members may sign in with a password. The operator always may: the emergency exit when a provider fails. Off
    #: only while a sign-in provider is on.
    "password_login": True,
    #: Every account needs a second factor (a code from an app or a passkey), on from the start: right after the
    #: password, an account without one sets it up before it gets anywhere. Turning it off asks for the password.
    "two_factor_required": True,
    #: Before the provider list: "the provider checks a second factor itself" for the one provider of the settings.
    #: The entry ``oidc`` took its value over (``trusts_second_factor``); it stays for one version as the way back to
    #: 0.6 and is written from the entry (``services/oidc_store.mirror_way_back``).
    "oidc_second_factor_by_provider": False,
    #: When the operator last saved the master key (ISO time), for "Ready for the internet?"; None: never.
    "master_key_saved_at": None,
    #: The single OIDC provider before the provider list (``oidc_providers``): read once by the migration
    #: (``services/oidc_store.migrate_settings``) and left for one version as the way back to 0.6, then gone. Nothing
    #: reads them to sign anybody in.
    "oidc_issuer": "",
    "oidc_client_id": "",
    "oidc_client_secret_enc": "",
    "oidc_provider_name": "",
    "oidc_auto_create": False,
    #: What the way back to 0.6 said when this version last wrote it (``migrate.fingerprint``): sums only. At the next
    #: start the difference to what stands there now is what 0.6 changed.
    "oidc_legacy_fingerprint": None,
    #: The issuer 0.6 knows, or "-" (closed): with the entry ``oidc`` it decides what the way back shows (module
    #: ``migrate.way_back``). nexdiary only stores it.
    "oidc_legacy_anchor": None,
    #: The settings above were looked at once and, where there was a provider, became the entry ``oidc``.
    "oidc_list_migrated": False,
    #: Tokens for programs such as a dashboard card (``/api/v1``): closed until the operator opens it.
    "api_tokens_allowed": False,
    #: Ask GitHub once a day whether a newer nexdiary is out (services/updates). Only the question goes out, so on.
    "update_check": True,
    #: Invitation mail: without a host nothing is sent, the link to copy is enough.
    "smtp_host": "",
    "smtp_port": 587,
    #: starttls | tls | none
    "smtp_security": "starttls",
    "smtp_user": "",
    "smtp_password_enc": "",
    "smtp_from": "",
    #: What one person may keep in photos and drafts, in GB; 0: no limit.
    "storage_per_person_gb": 5,
    #: The AI that writes a day up from its notes (``services/ai.py``), one for everybody, set up by the operator only:
    #: none | local | openai | messages. None from the start: notes leave the server only when the operator wants it.
    "ai_provider": "none",
    "ai_url": "",
    "ai_model": "",
    #: Sealed with the server's secret (context ``operator:ai-key``); never shown again.
    "ai_key_enc": "",
    #: Whether a person may let the AI write up the day before on its own, in the morning (``services/autowrite.py``).
    #: Off from the start: the operator opens it, and each person still has to switch it on for themselves.
    "ai_auto_allowed": False,
    #: Immich (``services/immich.py``): closed from the start. Open, each person may connect their own Immich, but
    #: only on one of these hosts (``host`` or ``host:port``): the address is a way into the own network.
    "immich_allowed": False,
    "immich_hosts": [],
    #: Web Push (``services/webpush.py``, ``services/push.py``): nexdiary's own key pair, made at the first need and
    #: sealed with the server's secret; who the push services may contact (empty: the public https address, else a
    #: placeholder); and push services beyond the known ones, as host names.
    "push_key_enc": "",
    "push_contact": "",
    "push_hosts": [],
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        values[row.key] = row.value
    return values


def save(db: Session, changes: dict[str, Any], *, commit: bool = True) -> None:
    """Writes the values; ``commit`` False leaves the transaction open (flushed) for a caller that commits once."""
    for key, value in changes.items():
        if key not in DEFAULTS:
            raise KeyError(key)
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    if commit:
        db.commit()
    else:
        db.flush()


def normalize_public_url(value: str) -> str:
    """``scheme://host[:port]`` and nothing else, or empty. ``ValueError`` for anything people could not type into
    a browser: no other schemes, no credentials, no path, no query, nothing the shared sign-in module refuses."""
    text = value.strip()
    if not text:
        return ""
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("scheme or host")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("path, query or credentials")
    try:
        parts.port  # noqa: B018 - raises ValueError when the port is not a number
    except ValueError as exc:
        raise ValueError("port") from exc
    # Never more than the sign-in module takes (the host's letters, at most 199 characters): what it refuses is no
    # address here either, or the authentik card and the sign-in would disagree about it.
    return flow.clean_public_url(f"{parts.scheme.lower()}://{parts.netloc}")


def public_url(db: Session) -> str:
    """The public address without a trailing slash: the setting, otherwise the environment, otherwise empty."""
    stored = str(get(db, "public_url") or "").strip().rstrip("/")
    return stored or get_settings().public_url.strip().rstrip("/")
