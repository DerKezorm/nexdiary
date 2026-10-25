"""nexoidc contract tests: nexdiary's adapter (copied once from the module's template, from then on nexdiary's own
file).

The contract tests in ``tests/nexoidc/`` are the same in every nex app and never edited here. They reach nexdiary only
through this class: its real routes, its database, its accounts, invitations and second factor. The test run's own
data directory and the cleaning between tests come from ``tests/conftest.py``. Passwords and seeds are made at run
time; none is written into this file.

nexdiary's invitations carry nothing but the address they went to (no role): "editor" in the words of the tests is an
invitation with an address, which an account without one takes (and keeps: an invitation adds, never takes away);
"member" is one without.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Any

import httpx
from fastapi.testclient import TestClient
from oidc_contract import StandardAdapter
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import normal_address
from app.main import app
from app.models import MEMBER, OPERATOR, SIGN_IN_OIDC, SIGN_IN_PASSWORD, Account
from app.routers.auth import PENDING_COOKIE
from app.security import Brake, brake, encrypt_secret, hash_password
from app.services import accounts, oidc_store, settings_service, totp

OPERATOR_NAME = "operator"
#: The address an invitation with the rights "editor" went to.
EDITOR_ADDRESS = "invited-editor@example.com"
#: Every request of the interface names its tab; changes are refused without it.
TAB = {"X-Nexdiary-Client": "tab-nexoidc00"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexoidc"
    api = "/api"
    single_account = False
    has_invitations = True
    only_authentik = False
    #: nexdiary is never coupled to an outside identity provider of a suite.
    supports_coupling = False
    has_second_factor = True
    legacy_model = "single"
    #: 0.6 asked nexdiary's code after the provider unless its operator switched that off (off from the start).
    trusted_before = False
    old_callback_paths: tuple[str, ...] = ()
    operator_name = OPERATOR_NAME
    account_page = "/konto"

    def start(self) -> None:
        # tests/conftest.py emptied the database before this test.
        oidc_store.configure()
        self._operator: TestClient | None = None
        self._seeds: dict[str, str] = {}
        self.make_account(OPERATOR_NAME, role=OPERATOR)

    def stop(self) -> None:
        pass

    def browser(self) -> TestClient:
        return TestClient(app, base_url="http://testserver", follow_redirects=False, headers=TAB)

    def operator(self) -> TestClient:
        if self._operator is None:
            self._operator = self.browser()
            self.sign_in_with_password(self._operator, OPERATOR_NAME)
        return self._operator

    def make_account(self, name: str, *, password: bool = True, second_factor: bool = False,
                     role: str = MEMBER) -> int:
        with SessionLocal() as db:
            row = Account(name=name, role=role, sign_in=SIGN_IN_PASSWORD if password else SIGN_IN_OIDC,
                          password_hash=hash_password(self.password_for(name)) if password else "")
            if second_factor:
                seed = totp.generate_seed()
                self._seeds[name] = seed
                row.totp_secret_enc = totp.seal_seed(seed)
            db.add(row)
            db.commit()
            return row.id

    def sign_in_with_password(self, client: Any, name: str) -> None:
        answer = client.post("/api/auth/login", json={"name": name, "password": self.password_for(name)})
        assert answer.status_code == 200, answer.text
        if answer.json().get("second_factor"):
            # A code of the step after the last one taken, so that no two sign-ins in one step collide.
            code = totp.code_at(self._seeds[name], time.time() + 30 * self._codes_used(name))
            done = client.post("/api/auth/login/totp", json={"code": code})
            assert done.status_code == 200, done.text

    def _codes_used(self, name: str) -> int:
        with SessionLocal() as db:
            row = accounts.by_name(db, name)
            assert row is not None
            return 1 if row.totp_last_step else 0

    def who(self, client: Any) -> str | None:
        answer = client.get("/api/auth/me")
        if answer.status_code != 200 or answer.json().get("session_stage") != "full":
            return None
        return str(answer.json()["name"])

    def second_factor_asked(self, client: Any, response: httpx.Response) -> bool:
        waiting = client.cookies.get(PENDING_COOKIE)
        return (
            response.headers.get("location", "") == "/login?step=code"
            and waiting is not None
            and totp.get_pending(waiting) is not None
        )

    def make_invite(self, rights: str) -> str:
        with SessionLocal() as db:
            operator = accounts.by_name(db, OPERATOR_NAME)
            assert operator is not None
            _invite, token = accounts.create_invite(
                db, operator, days=7, email=EDITOR_ADDRESS if rights == "editor" else ""
            )
        return token

    def rights_of(self, name: str) -> str | None:
        with SessionLocal() as db:
            row = accounts.by_name(db, name)
            if row is None:
                return None
            return "editor" if row.email == EDITOR_ADDRESS else "member"

    def account_names(self) -> list[str]:
        with SessionLocal() as db:
            return sorted(db.scalars(select(Account.name)))

    def store(self) -> AbstractContextManager[Any]:
        @contextmanager
        def opened() -> Iterator[oidc_store.SqlStore]:
            with SessionLocal() as db:
                yield oidc_store.SqlStore(db)

        return opened()

    def set_public_url(self, url: str) -> None:
        with SessionLocal() as db:
            settings_service.save(db, {"public_url": url})

    def read_public_url(self) -> str:
        # The setting as a restart would find it (the environment variable is none of the test's).
        with SessionLocal() as db:
            return str(settings_service.get(db, "public_url") or "")

    def save_public_url_route(self, url: str, *, confirm: bool = False) -> httpx.Response:
        # Card 1 of the interface: the settings route that saves the address with the other settings. It asks first
        # (409 ``public_url_change``) and saves nothing until the operator confirms.
        return self.operator().put("/api/settings", json={"public_url": url, "confirm_address": confirm})

    def legacy_setup(
        self, *, issuer: str, client_id: str, client_secret: str, label: str, subjects: dict[str, str]
    ) -> None:
        # As nexdiary 0.6 kept its one provider: in the settings, the secret sealed without a context.
        with SessionLocal() as db:
            settings_service.save(db, {
                "oidc_issuer": issuer,
                "oidc_client_id": client_id,
                "oidc_client_secret_enc": encrypt_secret(client_secret),
                "oidc_provider_name": label,
            })
            for name, subject in subjects.items():
                row = accounts.by_name(db, name)
                assert row is not None
                row.oidc_subject = subject
            db.commit()

    def run_migration(self) -> None:
        # The whole start: the migration once, then what 0.6 changed since, then the way back and its fingerprint.
        oidc_store.migrate_settings(backup=False)

    def legacy_read(self) -> dict[str, Any]:
        with SessionLocal() as db:
            legacy, subjects = oidc_store.read_legacy(db)
            names = {row.id: row.name for row in db.scalars(select(Account))}
        return {
            "issuer": legacy.issuer,
            "client_id": legacy.client_id,
            "client_secret": legacy.client_secret,
            "label": legacy.label,
            "auto_create": legacy.auto_create,
            "subjects": {names[account_id]: subject for account_id, subject in subjects},
        }

    def delete_account(self, name: str) -> None:
        # The operator's route, as the accounts list calls it (the operator's own password again).
        with SessionLocal() as db:
            row = accounts.by_name(db, name)
            assert row is not None
            account_id = row.id
        answer = self.operator().request(
            "DELETE", f"/api/accounts/{account_id}", json={"current_password": self.password_for(OPERATOR_NAME)}
        )
        assert answer.status_code == 204, answer.text

    def trip_throttle(self, client: Any) -> None:
        # As many failed runs at the provider from this sender as the brake lets pass (every TestClient is the
        # sender "testclient"): the next start, return and linking wait.
        key = "oidc:" + normal_address("testclient")
        for _ in range(Brake.FREE + 1):
            brake.failed(key)

    def operator_unlink(self, client: Any, account_id: int, provider_id: int, password: str) -> httpx.Response:
        # nexdiary's acts on another account carry the operator's password as ``current_password``.
        path = self.path("operator_unlink", account=account_id, provider=provider_id)
        return client.request("DELETE", path, json={"current_password": password})
