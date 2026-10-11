"""Sign-in through providers as nexdiary puts it around the shared module (``vendor/nexoidc``): what the contract tests
in ``tests/nexoidc`` cannot see because it is nexdiary's own. The second factor with its session stages, the device
cookie, the brake, the routes beside the entries, the scheme from a proxy, the public address, "Ready for the
internet?", the operator's unlinking, and above all: a sign-in through a provider opens the diary of exactly the account
its link names, and nothing about providers ever touches a person's data key."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.middleware import ForwardedProtoMiddleware, forwarded_proto
from app.models import SIGN_IN_OIDC, Account, OidcLink, UserKey
from app.security import DEVICE_COOKIE, decrypt_secret, encrypt_secret
from app.services import apitokens, notices, oidc_store, settings_service, totp
from app.vendor.nexoidc import secret_context

from .conftest import PASSWORD, make_account, require_second_factor, sign_in
from .oidc_helpers import (
    FakeProvider,
    add_provider,
    configure,
    error_in,
    fresh_browser,
    location,
    sign_in_via_oidc,
    start,
)

DAY = "2026-10-01"


@pytest.fixture
def boss(client: TestClient) -> Account:
    """The signed-in operator ``boss``, with a second factor of its own (so that "Require a second factor" can go on)."""
    row = make_account("boss", "operator")
    with SessionLocal() as db:
        stored = db.get(Account, row.id)
        assert stored is not None
        stored.totp_secret_enc = totp.seal_seed(totp.generate_seed())
        db.commit()
    sign_in(client, row)
    return row


def link_directly(name: str, slug: str, subject: str) -> None:
    """A link of the account ``name`` at the entry ``slug``, as the module would have made it."""
    with SessionLocal() as db:
        store = oidc_store.SqlStore(db)
        entry = store.provider_by_slug(slug)
        account = db.scalar(select(Account).where(Account.name == name))
        assert entry is not None and account is not None
        db.add(OidcLink(provider_id=entry.id, subject=subject, account_id=account.id, issuer=entry.issuer))
        db.commit()


def me_of(browser: TestClient) -> dict[str, Any]:
    answer = browser.get("/api/auth/me")
    assert answer.status_code == 200, answer.text
    return dict(answer.json())


def provider_only(name: str) -> Account:
    with SessionLocal() as db:
        row = Account(name=name, role="member", sign_in=SIGN_IN_OIDC, password_hash="")
        db.add(row)
        db.commit()
        db.expunge(row)
    return row


# --- The second factor (decided 2026-10-10, zusatz "Zweiten Faktor verlangen") ----------------------------------------


def test_through_a_provider_that_checks_it_a_password_account_is_not_sent_to_set_one_up_but_with_its_password_it_is(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    configure(client, provider, auto_create=False, trusts_second_factor=True)
    make_account("alex")
    link_directly("alex", "sso", "person-1")
    require_second_factor()
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="person-1")
    assert location(answer) == "/"
    seen = me_of(browser)
    assert seen["name"] == "alex" and seen["session_stage"] == "full" and seen["second_factor_setup_required"] is False
    assert browser.get(f"/api/days/{DAY}").status_code == 404, "the diary is open: the day just does not exist yet"
    # The same account with its password: sent to set one up, as before.
    other = fresh_browser()
    signed = other.post("/api/auth/login", json={"name": "alex", "password": PASSWORD})
    assert signed.status_code == 200 and signed.json()["session_stage"] == "setup"
    held = other.get(f"/api/days/{DAY}")
    assert held.status_code == 403 and held.json()["detail"]["code"] == "second_factor_setup_required"


def test_through_a_provider_that_does_not_check_it_a_password_account_sets_one_up_and_one_with_a_factor_gives_the_code(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    configure(client, provider, auto_create=False, trusts_second_factor=False)
    make_account("alex")
    link_directly("alex", "sso", "person-1")
    require_second_factor()
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="person-1")
    assert location(answer) == "/login", "a password account without a factor sets one up first"
    assert me_of(browser)["session_stage"] == "setup"
    # With a factor of its own: the code is asked, nothing opens before.
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == "alex"))
        assert row is not None
        row.totp_secret_enc = totp.seal_seed(totp.generate_seed())
        db.commit()
    later = fresh_browser()
    answer = sign_in_via_oidc(later, provider, sub="person-1")
    assert location(answer) == "/login?step=code"
    assert later.get("/api/auth/me").status_code == 401


@pytest.mark.parametrize("trusts", [True, False])
def test_an_account_through_providers_only_is_never_sent_to_set_one_up(
    client: TestClient, boss: Account, provider: FakeProvider, trusts: bool
) -> None:
    configure(client, provider, auto_create=False, trusts_second_factor=trusts)
    provider_only("olga")
    link_directly("olga", "sso", "person-1")
    require_second_factor()
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="person-1")
    assert location(answer) == "/"
    seen = me_of(browser)
    assert seen["name"] == "olga" and seen["session_stage"] == "full" and seen["second_factor_setup_required"] is False


def test_tokens_of_an_account_sheltered_by_its_provider_wait_for_its_own_factor_and_say_so(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    configure(client, provider, auto_create=False, trusts_second_factor=True)
    settings_service_save({"api_tokens_allowed": True})
    make_account("alex")
    link_directly("alex", "sso", "person-1")
    require_second_factor()
    browser = fresh_browser()
    sign_in_via_oidc(browser, provider, sub="person-1")
    made = browser.post("/api/api-tokens", json={"name": "Dashboard"})
    assert made.status_code == 201 and made.json()["second_factor_pending"] is True
    assert browser.get("/api/api-tokens").json()["second_factor_pending"] is True
    with SessionLocal() as db:
        assert apitokens.authenticate(db, made.json()["secret"]) is None


def settings_service_save(values: dict[str, Any]) -> None:
    with SessionLocal() as db:
        settings_service.save(db, values)


# --- The device cookie, the brake, the routes -------------------------------------------------------------------------


def test_the_device_cookie_of_a_provider_sign_in_lies_where_every_return_comes_back(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    configure(client, provider, auto_create=True)
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="person-1", preferred_username="newcomer")
    paths = sorted(line.lower().split("path=")[1].split(";")[0] for line in answer.headers.get_list("set-cookie")
                   if line.startswith(DEVICE_COOKIE + "="))
    assert paths == ["/api/auth", "/api/oidc"]


def test_a_return_without_an_attempt_of_ours_never_costs_its_sender_a_try(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    """A bare ``?error=``, a slug nobody has, a made-up cookie: free for anybody to send. Counted, they would let a
    stranger lock everybody behind one proxy out of signing in through a provider."""
    configure(client, provider)
    stranger = fresh_browser()
    for _ in range(40):
        assert error_in(stranger.get("/api/oidc/sso/callback?error=access_denied")) == "oidc_provider_error"
        assert error_in(stranger.get("/api/oidc/nobody/callback?code=x&state=y")) == "oidc_not_configured"
        stranger.cookies.set("nexdiary_oidc", "made-up", path="/api/oidc")
        assert error_in(stranger.get("/api/oidc/sso/callback?code=x&state=y")) == "oidc_state_mismatch"
    assert "error=" not in start(fresh_browser())
    assert location(sign_in_via_oidc(fresh_browser(), provider, sub="person-1", preferred_username="newcomer")) == "/"


def test_the_entry_named_authentik_reaches_its_own_routes_beside_the_fixed_ones(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, slug="authentik", label="authentik", auto_create=True)
    assert client.get("/api/oidc/authentik/address").status_code == 200, "the operator's fixed route"
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, slug="authentik", sub="person-1", preferred_username="newcomer")
    assert location(answer) == "/" and me_of(browser)["name"] == "newcomer"
    member = fresh_browser()
    sign_in(member, make_account("alex"))
    linking = member.post("/api/oidc/authentik/link", json={"password": PASSWORD})
    assert linking.status_code == 200 and "url" in linking.json()


# --- The scheme from a proxy (module README "Hinter einem Proxy") -----------------------------------------------------


def test_the_scheme_counts_only_from_a_trusted_proxy_and_then_its_rightmost_value(monkeypatch: pytest.MonkeyPatch) -> None:
    def scope(peer: str, *values: str, kind: str = "http") -> dict[str, Any]:
        return {"type": kind, "client": (peer, 1234), "headers": [(b"x-forwarded-proto", v.encode()) for v in values]}

    monkeypatch.setattr(get_settings(), "trusted_proxies", "")
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "https")) == "", "nobody is trusted from the start"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.0.0.2")
    assert ForwardedProtoMiddleware._scheme(scope("203.0.113.5", "https")) == "", "a stranger is not believed"
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "https")) == "https"
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "https, http")) == "http", "the rightmost value"
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "http", "HTTPS")) == "https", "the last line, any case"
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "javascript")) == ""
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "https", kind="websocket")) == "wss"
    assert ForwardedProtoMiddleware._scheme(scope("10.0.0.2", "http", kind="websocket")) == "ws"
    assert forwarded_proto([(b"x-forwarded-proto", b"https, http")]) == "http"


def test_behind_a_trusted_proxy_the_authentik_card_sees_https(
    client: TestClient, boss: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.0.0.2")
    with TestClient(app, base_url="http://diary.example.com", client=("10.0.0.2", 4000),
                    headers={"X-Nexdiary-Client": "tab-proxytest"}) as behind:
        sign_in(behind, boss)
        seen = behind.get("/api/oidc/authentik/address", headers={"X-Forwarded-Proto": "http, https"}).json()
    assert seen["seen"].startswith("https://diary.example.com")


# --- The public address -----------------------------------------------------------------------------------------------


def test_emptying_the_public_address_asks_first_while_a_provider_by_hand_is_on(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    settings_service_save({"public_url": "https://diary.example.com"})
    configure(client, provider)
    asked = client.put("/api/settings", json={"public_url": ""})
    assert asked.status_code == 409 and asked.json()["detail"]["code"] == "public_url_change"
    assert asked.json()["detail"]["hand"] == 1
    with SessionLocal() as db:
        assert settings_service.get(db, "public_url") == "https://diary.example.com", "nothing saved before the answer"
    done = client.put("/api/settings", json={"public_url": "", "confirm_address": True})
    assert done.status_code == 200 and done.json()["public_url"] == ""


def test_password_sign_in_goes_off_only_while_a_provider_is_on(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    refused = client.put("/api/settings", json={"password_login": False})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "provider_first"
    entry = configure(client, provider, enabled=False)
    assert client.put("/api/settings", json={"password_login": False}).status_code == 409, "an entry that is off"
    client.put(f"/api/oidc/admin/providers/{entry['id']}", json={
        "label": "Test SSO", "issuer": provider.issuer, "client_id": provider.client_id, "enabled": True})
    assert client.put("/api/settings", json={"password_login": False}).status_code == 200


# --- "Ready for the internet?" --------------------------------------------------------------------------------------


def test_ready_for_the_internet_names_the_providers_that_check_the_second_factor(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    require_second_factor()

    def two_factor() -> dict[str, Any]:
        points = client.get("/api/settings/readiness").json()["points"]
        return next(point for point in points if point["key"] == "two_factor")

    assert two_factor()["state"] == "ok"
    entry = configure(client, provider, trusts_second_factor=False)
    assert two_factor()["state"] == "ok", "the code is asked after this provider"
    client.put(f"/api/oidc/admin/providers/{entry['id']}", json={
        "label": "Test SSO", "issuer": provider.issuer, "client_id": provider.client_id, "trusts_second_factor": True})
    point = two_factor()
    assert point["state"] == "warn" and point["values"]["providers"] == "Test SSO"
    require_second_factor(False)
    assert two_factor()["state"] == "bad"


# --- The operator takes a link ----------------------------------------------------------------------------------------


def test_the_operator_takes_a_link_only_with_the_own_password_and_the_person_is_told(
    client: TestClient, boss: Account, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    told: list[tuple[str, str, str]] = []
    monkeypatch.setattr(notices, "provider_unlinked", lambda account, by, label: told.append((account.name, by, label)))
    entry = configure(client, provider)
    alex = make_account("alex")
    link_directly("alex", "sso", "person-1")
    path = f"/api/oidc/admin/accounts/{alex.id}/links/{entry['id']}"
    wrong = client.request("DELETE", path, json={"current_password": "not the password"})
    assert wrong.status_code == 401 and told == []
    marks = {row["name"]: row["providers"] for row in client.get("/api/accounts").json()}
    assert [mark["label"] for mark in marks["alex"]] == ["Test SSO"]
    assert client.request("DELETE", path, json={"current_password": PASSWORD}).status_code == 204
    assert told == [("alex", "boss", "Test SSO")]
    assert client.get("/api/accounts").json()[-1]["providers"] == []


# --- The diaries behind the links (Verschlüsselung je Person) ---------------------------------------------------------


@pytest.fixture
def two_diaries(client: TestClient, boss: Account, provider: FakeProvider) -> Iterator[dict[str, Any]]:
    """alex and bob, each with a page of their own; bob has the address and the name the provider will send."""
    configure(client, provider, auto_create=True)
    pages = {}
    for name, email in (("alex", "alex@example.com"), ("bob", "shared@example.com")):
        row = make_account(name)
        with SessionLocal() as db:
            stored = db.get(Account, row.id)
            assert stored is not None
            stored.email = email
            db.commit()
        browser = fresh_browser()
        sign_in(browser, row)
        text = f"Nur für {name}: {name}-geheim"
        assert browser.put(f"/api/days/{DAY}", json={"text": text}).status_code == 200
        pages[name] = text
    link_directly("alex", "sso", "person-1")
    yield pages


def keys() -> dict[int, bytes]:
    with SessionLocal() as db:
        return {row.user_id: bytes(row.wrapped_dek) for row in db.scalars(select(UserKey))}


def test_a_provider_sign_in_opens_the_diary_of_the_linked_account_and_no_other(
    two_diaries: dict[str, Any], provider: FakeProvider
) -> None:
    before = keys()
    # The identity has bob's address (confirmed, even) and bob's name: it is alex all the same, by its link.
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="person-1", preferred_username="bob", email="shared@example.com",
                              email_verified=True)
    assert location(answer) == "/" and me_of(browser)["name"] == "alex"
    assert browser.get(f"/api/days/{DAY}").json()["text"] == two_diaries["alex"]
    assert "bob-geheim" not in browser.get("/api/days").text
    assert keys() == before


def test_no_address_name_or_invitation_address_reaches_the_key_of_another_account(
    client: TestClient, two_diaries: dict[str, Any], provider: FakeProvider
) -> None:
    before = keys()
    # A new identity with bob's address and name: a new account (auto_create), its own empty diary, never bob's.
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, sub="stranger-1", preferred_username="bob",
                              email="shared@example.com", email_verified=True)
    assert location(answer) == "/"
    seen = me_of(browser)
    assert seen["name"] == "bob-2" and seen["email"] == "", "the address another account has never moves"
    assert browser.get(f"/api/days/{DAY}").status_code == 404
    assert browser.get("/api/days").json() == [] or "bob-geheim" not in browser.get("/api/days").text
    # An invitation sent to bob's address: a new account again, never bob.
    invite = client.post("/api/invites", json={"days": 7, "email": "shared@example.com"}).json()["link"].rsplit("/", 1)[1]
    invited = fresh_browser()
    answer = sign_in_via_oidc(invited, provider, invite=invite, sub="stranger-2", preferred_username="bob",
                              email="shared@example.com")
    assert location(answer) == "/"
    assert me_of(invited)["name"] == "bob-3" and invited.get(f"/api/days/{DAY}").status_code == 404
    old = {key: value for key, value in keys().items() if key in before}
    assert old == before, "the keys of alex and bob stay as they were"


def test_unlinking_another_issuer_and_the_migration_leave_every_data_key_as_it_was(
    client: TestClient, two_diaries: dict[str, Any], provider: FakeProvider
) -> None:
    before = keys()
    entry = client.get("/api/oidc/admin/providers").json()[0]
    alex = next(row for row in client.get("/api/accounts").json() if row["name"] == "alex")
    assert client.request("DELETE", f"/api/oidc/admin/accounts/{alex['id']}/links/{entry['id']}",
                          json={"current_password": PASSWORD}).status_code == 204
    link_directly("alex", "sso", "person-1")
    other = provider.network.add(FakeProvider("https://other.example.com"))  # type: ignore[attr-defined]
    changed = client.put(f"/api/oidc/admin/providers/{entry['id']}", json={
        "label": "Test SSO", "issuer": other.issuer, "client_id": other.client_id, "client_secret": other.client_secret})
    assert changed.status_code == 200 and changed.json()["dropped"] == 1
    oidc_store.migrate_settings(backup=False)
    oidc_store.migrate_settings(backup=False)
    assert keys() == before
    browser = fresh_browser()
    sign_in(browser, make_account("carol"))
    for name in ("alex", "bob"):
        with SessionLocal() as db:
            row = db.scalar(select(Account).where(Account.name == name))
            assert row is not None
        owner = fresh_browser()
        sign_in(owner, row)
        assert owner.get(f"/api/days/{DAY}").json()["text"] == two_diaries[name]


# --- The migration of 0.6's one provider -----------------------------------------------------------------------------


def legacy(provider: FakeProvider, *, trusted: bool, subjects: dict[str, str]) -> None:
    """As 0.6 kept its provider: the settings (the secret sealed without a context), the switch, the column."""
    settings_service_save({
        "oidc_issuer": provider.issuer,
        "oidc_client_id": provider.client_id,
        "oidc_client_secret_enc": encrypt_secret(provider.client_secret),
        "oidc_provider_name": "authentik",
        "oidc_second_factor_by_provider": trusted,
        "oidc_list_migrated": False,
    })
    with SessionLocal() as db:
        for name, subject in subjects.items():
            row = db.scalar(select(Account).where(Account.name == name))
            assert row is not None
            row.oidc_subject = subject
        db.commit()


@pytest.mark.parametrize("trusted", [False, True])
def test_the_migrated_entry_keeps_how_0_6_treated_the_second_factor(
    client: TestClient, boss: Account, provider: FakeProvider, trusted: bool
) -> None:
    make_account("alex")
    legacy(provider, trusted=trusted, subjects={"alex": "person-1"})
    oidc_store.migrate_settings(backup=False)
    with SessionLocal() as db:
        entry = oidc_store.SqlStore(db).provider_by_slug("oidc")
        assert entry is not None and entry.trusts_second_factor is trusted and entry.label == "authentik"
        row = db.scalar(select(provider_secret_column()))
        # The secret sealed anew, under the context of the entry: without it, it opens nothing.
        assert decrypt_secret(row, secret_context(entry.id)) == provider.client_secret
        assert decrypt_secret(row) == ""
        # The way back: in full only when the provider is trusted (an entry that asks the code is "off" for 0.6).
        assert bool(settings_service.get(db, "oidc_second_factor_by_provider")) is trusted
        assert bool(settings_service.get(db, "oidc_client_id")) is trusted
    browser = fresh_browser()
    answer = sign_in_via_oidc(browser, provider, slug="oidc", sub="person-1")
    assert location(answer) == "/" and me_of(browser)["name"] == "alex", "/api/oidc/callback still signs in"


def provider_secret_column() -> Any:
    from app.models import OidcProvider

    return OidcProvider.client_secret_enc


def test_0_6_turning_its_switch_off_makes_the_entry_ask_the_code_again(
    client: TestClient, boss: Account, provider: FakeProvider
) -> None:
    make_account("alex")
    legacy(provider, trusted=True, subjects={"alex": "person-1"})
    oidc_store.migrate_settings(backup=False)
    # 0.6, after a way back: the switch off, the rest as the mirror wrote it.
    settings_service_save({"oidc_second_factor_by_provider": False})
    oidc_store.migrate_settings(backup=False)
    with SessionLocal() as db:
        entry = oidc_store.SqlStore(db).provider_by_slug("oidc")
        assert entry is not None and entry.trusts_second_factor is False
        assert settings_service.get(db, "oidc_client_id") == "", "now off for 0.6 as well"
    # A third start changes nothing.
    oidc_store.migrate_settings(backup=False)
    with SessionLocal() as db:
        entry = oidc_store.SqlStore(db).provider_by_slug("oidc")
        assert entry is not None and entry.trusts_second_factor is False and entry.enabled


# --- The operator's password before trusting a provider with the second factor (switch, off by default) ---------------


def test_trusting_a_provider_with_the_second_factor_asks_the_password_only_where_switched_on(
    client: TestClient, boss: Account, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routers import oidc as oidc_router

    assert oidc_router.TRUSTS_NEEDS_PASSWORD is False, "as the blueprint lays it out"
    entry = configure(client, provider, trusts_second_factor=False)
    form = {"label": "Test SSO", "issuer": provider.issuer, "client_id": provider.client_id}
    monkeypatch.setattr(oidc_router, "TRUSTS_NEEDS_PASSWORD", True)
    refused = client.put(f"/api/oidc/admin/providers/{entry['id']}", json={**form, "trusts_second_factor": True})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "wrong_password"
    added = client.post("/api/oidc/admin/providers", json={**form, "slug": "other", "trusts_second_factor": True})
    assert added.status_code == 401
    done = client.put(f"/api/oidc/admin/providers/{entry['id']}",
                      json={**form, "trusts_second_factor": True, "current_password": PASSWORD})
    assert done.status_code == 200 and done.json()["trusts_second_factor"] is True
    # Turning it off again, or saving while it stays on, asks nothing.
    assert client.put(f"/api/oidc/admin/providers/{entry['id']}", json={**form, "trusts_second_factor": True}).status_code == 200
    assert client.put(f"/api/oidc/admin/providers/{entry['id']}", json={**form, "trusts_second_factor": False}).status_code == 200


# --- Two starts at once ----------------------------------------------------------------------------------------------


def test_a_start_that_meets_the_row_of_another_start_reads_everything_again(monkeypatch: pytest.MonkeyPatch) -> None:
    from sqlalchemy.exc import IntegrityError

    calls: list[int] = []
    real = oidc_store._migrate_once

    def once(backup: bool) -> bool:
        calls.append(1)
        if len(calls) == 1:
            raise IntegrityError("INSERT INTO settings", {}, Exception("UNIQUE constraint failed: settings.key"))
        return real(backup)

    monkeypatch.setattr(oidc_store, "_migrate_once", once)
    oidc_store.migrate_settings(backup=False)
    assert len(calls) == 2


def test_starts_at_once_make_one_entry_and_no_error(boss: Account, provider: FakeProvider) -> None:
    import threading

    make_account("alex")
    legacy(provider, trusted=False, subjects={"alex": "person-1"})
    failed: list[BaseException] = []
    gate = threading.Barrier(4, timeout=10)

    def start() -> None:
        try:
            gate.wait()
            oidc_store.migrate_settings(backup=False)
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever went wrong
            failed.append(exc)

    threads = [threading.Thread(target=start) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failed == []
    with SessionLocal() as db:
        assert [entry.slug for entry in oidc_store.SqlStore(db).list_providers()] == ["oidc"]
