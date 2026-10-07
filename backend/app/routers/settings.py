"""The operator's settings: address, sign-in, API tokens, invitation mail, backups; "Ready for the internet?" and
saving the master key.

Secrets (the mail password) are written encrypted and never read back: the answer only says whether one is set.
The OIDC settings live in ``routers/oidc.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import clock
from ..deps import (
    DbSession,
    OperatorAccount,
    behind_unknown_proxy,
    confirm_operator,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
    session_of,
)
from ..errors import error
from ..models import Account as AccountRow
from ..security import encrypt_secret
from ..services import accounts, mailer, passkeys, quota, readiness, settings_service, totp, vault

logger = logging.getLogger("nexdiary.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsOut(BaseModel):
    public_url: str
    password_login: bool
    two_factor_required: bool
    oidc_second_factor_by_provider: bool
    master_key_saved_at: str | None
    backup_schedule: str
    backup_keep: int
    smtp_host: str
    smtp_port: int
    smtp_security: str
    smtp_user: str
    smtp_password_set: bool
    smtp_from: str
    api_tokens_allowed: bool
    update_check: bool
    storage_per_person_gb: float


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=255)
    password_login: bool | None = None
    two_factor_required: bool | None = None
    oidc_second_factor_by_provider: bool | None = None
    #: The operator's password once more: asked when a change makes signing in weaker.
    current_password: str = Field(default="", max_length=200)
    backup_schedule: Literal["off", "daily", "weekly"] | None = None
    backup_keep: int | None = Field(default=None, ge=1, le=365)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] | None = None
    smtp_user: str | None = Field(default=None, max_length=255)
    #: Empty removes the password; left out keeps it.
    smtp_password: str | None = Field(default=None, max_length=500)
    smtp_from: str | None = Field(default=None, max_length=255)
    api_tokens_allowed: bool | None = None
    update_check: bool | None = None
    #: What one person may keep in photos and drafts; 0: no limit.
    storage_per_person_gb: float | None = Field(default=None, ge=0, le=quota.MAX_GB)


class TestMailIn(BaseModel):
    to: str = Field(max_length=255)


def _view(db: DbSession) -> SettingsOut:
    values = settings_service.get_all(db)
    return SettingsOut(
        public_url=values["public_url"],
        password_login=values["password_login"],
        two_factor_required=bool(values["two_factor_required"]),
        oidc_second_factor_by_provider=bool(values["oidc_second_factor_by_provider"]),
        master_key_saved_at=values["master_key_saved_at"],
        backup_schedule=values["backup_schedule"],
        backup_keep=values["backup_keep"],
        smtp_host=values["smtp_host"],
        smtp_port=values["smtp_port"],
        smtp_security=values["smtp_security"],
        smtp_user=values["smtp_user"],
        smtp_password_set=bool(values["smtp_password_enc"]),
        smtp_from=values["smtp_from"],
        api_tokens_allowed=bool(values["api_tokens_allowed"]),
        update_check=bool(values["update_check"]),
        storage_per_person_gb=float(values["storage_per_person_gb"] or 0),
    )


@router.get("", response_model=SettingsOut)
def read(_operator: OperatorAccount, db: DbSession) -> SettingsOut:
    return _view(db)


#: Changes that make signing in weaker: each asks for the operator's password once more.
WEAKER = {"two_factor_required": False, "oidc_second_factor_by_provider": True}


@router.put("", response_model=SettingsOut)
def save(payload: SettingsIn, request: Request, operator: OperatorAccount, db: DbSession) -> SettingsOut:
    sent = payload.model_dump(exclude_unset=True)
    current = settings_service.get_all(db)
    if any(key in sent and sent[key] is weaker and bool(current[key]) is not weaker for key, weaker in WEAKER.items()):
        # A stolen session must not be enough to take the second factor away from everybody.
        confirm_operator(request, db, operator, payload.current_password)
    changes: dict[str, Any] = {}
    for key, value in sent.items():
        if value is None or key == "current_password":
            continue
        if key == "public_url":
            try:
                value = settings_service.normalize_public_url(value)
            except ValueError as exc:
                raise error("invalid_url", "Give an address like https://diary.example.com.", 422) from exc
        elif key == "smtp_from":
            value = value.strip()
            if value and not accounts.EMAIL_PATTERN.match(value):
                raise error("invalid_email", "This is not a mail address.", 422)
        elif key == "two_factor_required" and value and not current["two_factor_required"] and (
            not totp.has_second_factor(db, operator) and not totp.provider_checks(db, operator)
        ):
            # Else the operator would be the first one sent to set it up, with nothing else in reach.
            raise error("own_second_factor_first", "Set up your own second factor first.", 409)
        elif key == "password_login" and not value:
            current = settings_service.get_all(db)
            if not (current["oidc_issuer"] and current["oidc_client_id"]):
                # Without a provider nobody but the operator could sign in any more, and invitations would fail.
                raise error("provider_first", "Set up a sign-in provider first.", 409)
        elif key == "smtp_password":
            changes["smtp_password_enc"] = encrypt_secret(value)
            continue
        elif isinstance(value, str):
            value = value.strip()
        changes[key] = value
    settings_service.save(db, changes)
    logger.info("Settings changed keys=%s by=%s", ",".join(sorted(changes)), operator.name)
    return _view(db)


@router.post("/mail-test", status_code=204, summary="Send a test mail through the configured server")
def mail_test(payload: TestMailIn, _operator: OperatorAccount, db: DbSession) -> None:
    to = payload.to.strip()
    if not accounts.EMAIL_PATTERN.match(to):
        raise error("invalid_email", "This is not a mail address.", 422)
    try:
        mailer.send_test(db, to)
    except mailer.MailError as exc:
        raise error(exc.code, str(exc), 502) from exc


@router.get("/readiness", summary="Ready for the internet? What nexdiary checks about itself")
def ready(request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return readiness.check(db, request, operator, behind_unknown_proxy(request))


class MasterKeyIn(BaseModel):
    current_password: str = Field(default="", max_length=200)
    #: The code from the app, or the browser's answer from an own passkey (``/api/auth/passkeys/confirm/begin``).
    code: str = Field(default="", max_length=32)
    credential: dict[str, Any] | None = None


#: The name the file is saved under; put back, it is ``keys/master.key``.
MASTER_KEY_FILE = "nexdiary-master.key"


@router.post("/master-key", summary="Save the master key: the password and the second factor once more")
def master_key(payload: MasterKeyIn, request: Request, operator: OperatorAccount, db: DbSession) -> Response:
    """The key that opens every diary and every backup of this server. Only the operator, only with the password and
    the second factor given again right now; written to the log, and the moment is kept for "Ready for the
    internet?"."""
    row = db.get(AccountRow, operator.id)
    assert row is not None
    confirm_operator(request, db, row, payload.current_password)
    if not totp.has_second_factor(db, row):
        raise error("own_second_factor_first", "Set up your own second factor first.", 409)
    reauth_guard(request, row)
    passed = False
    if payload.credential is not None:
        passed = passkeys.confirm(db, row, session_of(request).uid, payload.credential)
    elif row.totp_secret_enc and payload.code:
        try:
            step = totp.verify_code(totp.open_seed(row.totp_secret_enc), payload.code, after_step=row.totp_last_step)
        except totp.SeedUnreadable:
            step = None
        passed = step is not None and totp.claim_step(db, row.id, step)
    if not passed:
        db.refresh(row)
        reauth_failed(request, db, row)
        logger.warning("Master key not handed out, second factor wrong by=%s", row.name)
        raise error("second_factor_wrong", "The second factor was not right.", 401)
    reauth_succeeded(request, db, row)
    content = vault.export()
    settings_service.save(db, {"master_key_saved_at": clock.now().isoformat()})
    logger.warning("Master key saved by the operator by=%s", row.name)
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{MASTER_KEY_FILE}"'},
    )
