""""Ready for the internet?" checks itself, each point good and not; saving the master key asks for the password and
the second factor, only of the operator, goes to the log, and the file it gives opens a backup of this server on a
fresh one; the switch that turns the second factor off for everybody asks for the password."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import backups, notices, readiness, settings_service, totp, vault

from .conftest import PASSWORD, TAB, make_account, sign_in
from .test_passkeys import ORIGIN, SoftKey, add_key

WRONG = PASSWORD[::-1]


def points(client: TestClient, **kwargs: object) -> dict[str, dict]:
    answer = client.get("/api/settings/readiness", **kwargs)  # type: ignore[arg-type]
    assert answer.status_code == 200, answer.text
    return {point["key"]: point for point in answer.json()["points"]}


def enrol(client: TestClient) -> str:
    seed = client.post("/api/auth/totp/begin").json()["secret"]
    done = client.post("/api/auth/totp/confirm", json={"code": totp.code_at(seed, time.time()), "password": PASSWORD})
    assert done.status_code == 200, done.text
    return seed


def next_code(seed: str, steps: int = 1) -> str:
    return totp.code_at(seed, time.time() + steps * totp.STEP_SECONDS)


def https_client(account: Account) -> TestClient:
    browser = TestClient(app, base_url="https://testserver", headers=TAB)
    sign_in(browser, account)
    return browser


def save(values: dict) -> None:
    with SessionLocal() as db:
        settings_service.save(db, values)


# --- Ready for the internet? ------------------------------------------------------------------------------------------


def test_only_the_operator_sees_the_check(client: TestClient, operator: Account) -> None:
    anna = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(anna, make_account("anna"))
    assert anna.get("/api/settings/readiness").status_code == 403


def test_https_needs_the_public_address_and_the_request_on_https(client: TestClient, operator: Account) -> None:
    assert points(client)["https"]["state"] == "bad"
    save({"public_url": "http://diary.example.com"})
    assert points(client)["https"]["state"] == "bad"
    save({"public_url": "https://diary.example.com"})
    assert points(client)["https"]["state"] == "warn", "the address says https, the request did not come over it"
    assert points(https_client(operator))["https"]["state"] == "ok"
    assert points(client, headers={"X-Forwarded-Proto": "https"})["https"]["state"] == "ok"


def test_the_second_factor_for_everybody_and_for_the_operator(client: TestClient, operator: Account) -> None:
    found = points(client)
    assert found["two_factor"]["state"] == "bad" and found["own_account"]["state"] == "bad"
    enrol(client)
    assert points(client)["own_account"]["state"] == "ok"
    assert client.put("/api/settings", json={"two_factor_required": True}).status_code == 200
    assert points(client)["two_factor"]["state"] == "ok"


def test_the_brake_and_the_proxy(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    found = points(client)
    assert found["brake"]["state"] == "ok" and found["proxy"]["state"] == "ok"
    behind = points(client, headers={"X-Forwarded-For": "203.0.113.5"})
    assert behind["brake"]["state"] == "warn" and behind["proxy"]["state"] == "warn"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "172.18.0.0/16")
    proxy = TestClient(app, base_url="http://testserver", headers=TAB, client=("172.18.0.2", 50000))
    sign_in(proxy, operator)
    trusted = points(proxy, headers={"X-Forwarded-For": "203.0.113.5"})
    assert trusted["proxy"]["state"] == "ok" and trusted["brake"]["state"] == "ok"


def test_the_master_key_is_there_and_only_the_owners(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(readiness, "CHECK_MODE", False)
    assert points(client)["encryption"]["state"] == "ok"
    monkeypatch.setattr(vault, "master_key_path", lambda: tmp_path / "missing.key")
    assert points(client)["encryption"]["state"] == "bad"
    # Where modes say something: a key the group or the world may read is red, one only the owner reads is green.
    loose = tmp_path / "loose.key"
    loose.write_bytes(b"x")
    loose.chmod(0o644)
    monkeypatch.setattr(vault, "master_key_path", lambda: loose)
    monkeypatch.setattr(readiness, "CHECK_MODE", True)
    assert points(client)["encryption"]["state"] == "bad"
    if os.name != "nt":
        loose.chmod(0o600)
        assert points(client)["encryption"]["state"] == "ok"


def test_cookies_are_secure_only_over_https(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    assert points(client)["cookies"]["state"] == "warn"
    assert points(https_client(operator))["cookies"]["state"] == "ok"
    monkeypatch.setattr(get_settings(), "cookie_secure", "off")
    assert points(https_client(operator))["cookies"]["state"] == "bad"


def test_everything_green_at_once(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(readiness, "CHECK_MODE", False)
    seed = enrol(client)
    client.put("/api/settings", json={"two_factor_required": True, "public_url": "https://diary.example.com"})
    browser = https_client(operator)
    assert browser.post("/api/settings/master-key",
                        json={"current_password": PASSWORD, "code": next_code(seed)}).status_code == 200
    answer = browser.get("/api/settings/readiness").json()
    assert answer["open"] == 0, answer
    assert all(point["state"] == "ok" for point in answer["points"]) and len(answer["points"]) == 8


# --- Saving the master key ------------------------------------------------------------------------------------------


def test_only_the_operator_with_password_and_second_factor_gets_the_master_key(
    client: TestClient, operator: Account, caplog: pytest.LogCaptureFixture
) -> None:
    anna = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(anna, make_account("anna"))
    assert anna.post("/api/settings/master-key", json={"current_password": PASSWORD}).status_code == 403
    # Without a second factor of its own the operator sets one up first.
    first = client.post("/api/settings/master-key", json={"current_password": PASSWORD})
    assert first.status_code == 409 and first.json()["detail"]["code"] == "own_second_factor_first"
    seed = enrol(client)
    wrong = client.post("/api/settings/master-key", json={"current_password": WRONG, "code": next_code(seed)})
    assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "wrong_password"
    no_code = client.post("/api/settings/master-key", json={"current_password": PASSWORD})
    assert no_code.status_code == 401 and no_code.json()["detail"]["code"] == "second_factor_wrong"
    bad_code = client.post("/api/settings/master-key", json={"current_password": PASSWORD, "code": "000000"})
    assert bad_code.status_code == 401
    assert points(client)["master_key_saved"]["state"] == "warn"
    with caplog.at_level(logging.INFO, logger="nexdiary.settings"):
        code = next_code(seed)
        saved = client.post("/api/settings/master-key", json={"current_password": PASSWORD, "code": code})
    assert saved.status_code == 200
    assert saved.content == vault.master_key_path().read_bytes() == vault.export()
    assert 'filename="nexdiary-master.key"' in saved.headers["content-disposition"]
    assert saved.headers["cache-control"] == "no-store"
    assert "Master key saved by the operator by=tester" in caplog.text
    assert vault.master().hex() not in caplog.text
    found = points(client)["master_key_saved"]
    assert found["state"] == "ok" and found["values"]["when"]
    assert client.get("/api/settings").json()["master_key_saved_at"]
    # The same code a second time is spent.
    again = client.post("/api/settings/master-key", json={"current_password": PASSWORD, "code": code})
    assert again.status_code == 401


def test_a_passkey_confirms_saving_the_master_key(client: TestClient, operator: Account) -> None:
    save({"public_url": ORIGIN})
    key = SoftKey()
    assert add_key(client, key).status_code == 201
    begun = client.post("/api/auth/passkeys/confirm/begin")
    options = json.loads(begun.json()["options"])
    assert [entry["id"] for entry in options["allowCredentials"]]
    saved = client.post("/api/settings/master-key",
                        json={"current_password": PASSWORD, "credential": key.get(options)})
    assert saved.status_code == 200 and saved.content == vault.export()
    # The challenge counted once.
    replay = client.post("/api/settings/master-key",
                         json={"current_password": PASSWORD, "credential": key.get(options)})
    assert replay.status_code == 401


def run_probe(archive: Path, key_file: Path, folder: Path) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(folder), "NEXDIARY_MEDIA_DIR": str(folder / "media"),
           "NEXDIARY_LOCALES_DIR": str(folder / "locales")}
    env.pop("NEXDIARY_MASTER_KEY_FILE", None)
    backend = Path(__file__).parent.parent
    return subprocess.run([sys.executable, "-m", "tests.restore_probe", str(archive), str(key_file), "tester",
                           PASSWORD, "2026-10-06"], cwd=backend, env=env, capture_output=True, text=True, timeout=180, check=False)


def test_the_saved_master_key_opens_a_backup_on_a_fresh_server(
    client: TestClient, operator: Account, tmp_path: Path
) -> None:
    seed = enrol(client)
    assert client.put("/api/days/2026-10-06", json={"title": "Kastanien", "text": "Ein langer Tag."}).status_code == 200
    saved = client.post("/api/settings/master-key", json={"current_password": PASSWORD, "code": next_code(seed)})
    key_file = tmp_path / "nexdiary-master.key"
    key_file.write_bytes(saved.content)
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        # The fresh server signs in with the password alone here; the second factor is not what is probed.
        row.totp_secret_enc, row.totp_recovery = "", ""
        db.commit()
    archive = backups.create(kind=backups.MANUAL)
    restored = run_probe(archive, key_file, tmp_path / "fresh")
    assert restored.returncode == 0, restored.stdout[-2000:] + restored.stderr[-2000:]
    assert restored.stdout.strip().splitlines()[-1] == "Kastanien"
    # With any other key the backup stays shut, and nothing is restored.
    other = tmp_path / "other.key"
    other.write_bytes(vault._encode(os.urandom(vault.KEY_BYTES)))
    refused = run_probe(archive, other, tmp_path / "fresh-other")
    assert refused.returncode == 3 and "backup_other_master_key" in refused.stdout


# --- The switches that make signing in weaker ----------------------------------------------------------------------


def test_turning_the_second_factor_off_for_everybody_asks_for_the_password(client: TestClient, operator: Account) -> None:
    enrol(client)
    assert client.put("/api/settings", json={"two_factor_required": True}).status_code == 200
    refused = client.put("/api/settings", json={"two_factor_required": False})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "wrong_password"
    wrong = client.put("/api/settings", json={"two_factor_required": False, "current_password": WRONG})
    assert wrong.status_code == 401
    off = client.put("/api/settings", json={"two_factor_required": False, "current_password": PASSWORD})
    assert off.status_code == 200 and off.json()["two_factor_required"] is False
    # Turning it on again asks for nothing: it makes signing in stronger.
    assert client.put("/api/settings", json={"two_factor_required": True}).status_code == 200


def test_the_operators_reset_tells_the_person(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    told: list[tuple[str, str]] = []
    monkeypatch.setattr(notices, "factor_reset", lambda account, by: told.append((account.name, by)))
    anna = TestClient(app, base_url="http://testserver", headers=TAB)
    member = make_account("anna")
    sign_in(anna, member)
    enrol(anna)
    assert client.post(f"/api/accounts/{member.id}/totp/reset", json={"current_password": WRONG}).status_code == 401
    assert told == []
    assert client.post(f"/api/accounts/{member.id}/totp/reset", json={"current_password": PASSWORD}).status_code == 200
    assert told == [("anna", "tester")]
