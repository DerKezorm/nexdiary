"""Pflichttests 33 and 34 of the shared sign-in blueprint (part 05), end to end in a headless browser against the built
app: a stand-in provider that speaks OpenID Connect (discovery, authorize, token with an RS256 id token, keys,
userinfo) runs next to it on a port of its own, never the network.

33. Sign-in through the stand-in provider until there is a session: the button on the sign-in page, the provider, the
    way back, signed in.
34. As the operator: add a provider, edit it, remove it after the question with the numbers; the authentik card shows
    the list of steps (with a reason for the one that failed).

    python frontend/e2e/nexoidc_e2e.py [--dist frontend/dist] [--port 18651] [--provider-port 18652]

Needs Python with ``playwright`` and ``cryptography`` (``python -m playwright install chromium``) and the backend's
virtual environment. Exit code 0 only when every check held; everything it started is stopped again.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TAB = {"X-Nexdiary-Client": "tab-e2eoidc0"}
CLIENT_ID = "nexdiary-e2e"
PERSON = {"sub": "person-e2e", "preferred_username": "robin", "name": "Robin Example", "email": "robin@example.com"}


def code_of(seed: str) -> str:
    key = base64.b32decode(seed + "=" * (-len(seed) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class StandInProvider:
    """An OpenID Connect provider in memory, served over plain HTTP on 127.0.0.1."""

    def __init__(self, port: int, secret: str) -> None:
        self.issuer = f"http://127.0.0.1:{port}"
        self.secret = secret
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.codes: dict[str, dict[str, str]] = {}
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def answer(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                if body is not None:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802 - the name http.server calls
                parts = urlsplit(self.path)
                query = {key: values[0] for key, values in parse_qs(parts.query).items()}
                if parts.path == "/.well-known/openid-configuration":
                    self.answer(200, provider.discovery())
                elif parts.path == "/jwks":
                    self.answer(200, {"keys": [provider.jwk()]})
                elif parts.path == "/userinfo":
                    self.answer(200, PERSON)
                elif parts.path == "/authorize":
                    code = secrets.token_urlsafe(16)
                    provider.codes[code] = query
                    back = f"{query['redirect_uri']}?{urlencode({'code': code, 'state': query['state']})}"
                    self.answer(302, None, {"Location": back})
                else:
                    self.answer(404, {"error": "not_found"})

            def do_POST(self) -> None:  # noqa: N802 - the name http.server calls
                length = int(self.headers.get("Content-Length") or 0)
                form = {key: values[0] for key, values in parse_qs(self.rfile.read(length).decode()).items()}
                grant = provider.codes.pop(form.get("code", ""), None)
                if self.path != "/token" or grant is None:
                    self.answer(400, {"error": "invalid_grant"})
                    return
                self.answer(200, {"access_token": secrets.token_urlsafe(16), "token_type": "Bearer",
                                  "id_token": provider.id_token(grant["nonce"])})

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def discovery(self) -> dict[str, Any]:
        return {"issuer": self.issuer, "authorization_endpoint": self.issuer + "/authorize",
                "token_endpoint": self.issuer + "/token", "jwks_uri": self.issuer + "/jwks",
                "userinfo_endpoint": self.issuer + "/userinfo", "id_token_signing_alg_values_supported": ["RS256"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"]}

    def jwk(self) -> dict[str, str]:
        numbers = self.key.public_key().public_numbers()

        def raw(value: int) -> str:
            return b64(value.to_bytes((value.bit_length() + 7) // 8, "big"))

        return {"kty": "RSA", "kid": "e2e", "use": "sig", "alg": "RS256", "n": raw(numbers.n), "e": raw(numbers.e)}

    def id_token(self, nonce: str) -> str:
        now = int(time.time())
        claims = {**PERSON, "iss": self.issuer, "aud": CLIENT_ID, "iat": now, "exp": now + 300, "nonce": nonce}
        head = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": "e2e"}).encode())
        body = b64(json.dumps(claims).encode())
        signature = self.key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{head}.{body}.{b64(signature)}"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def free(port: int) -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) != 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", default=str(ROOT / "frontend" / "dist"))
    parser.add_argument("--port", type=int, default=18651)
    parser.add_argument("--provider-port", type=int, default=18652)
    args = parser.parse_args()
    for port in (args.port, args.provider_port):
        if not free(port):
            print(f"port {port} is taken")
            return 2
    app_url = f"http://localhost:{args.port}"
    python = ROOT / "backend" / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    data = Path(tempfile.mkdtemp(prefix="nexdiary-e2e-oidc-"))
    setup_code = secrets.token_urlsafe(16)
    password = secrets.token_urlsafe(18)
    client_secret = secrets.token_urlsafe(24)
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(data), "NEXDIARY_FRONTEND_DIST": args.dist,
           "NEXDIARY_SETUP_TOKEN": setup_code, "NEXDIARY_DISABLE_BACKGROUND": "1",
           "NEXDIARY_UPDATE_URL": "http://127.0.0.1:9/none", "NEXDIARY_COOKIE_SUFFIX": "_e2e"}
    for name in ("NEXDIARY_MEDIA_DIR", "NEXDIARY_LOCALES_DIR", "NEXDIARY_MASTER_KEY_FILE", "NEXDIARY_PUBLIC_URL"):
        env.pop(name, None)
    provider = StandInProvider(args.provider_port, client_secret)
    provider.start()
    server = subprocess.Popen([str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port",
                               str(args.port), "--no-proxy-headers"], cwd=ROOT / "backend", env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failed: list[str] = []

    def check(condition: bool, what: str) -> None:
        print(("ok:    " if condition else "FAILED:"), what, flush=True)
        if not condition:
            failed.append(what)

    try:
        for _ in range(200):
            try:
                urllib.request.urlopen(app_url + "/api/health", timeout=2)
                break
            except OSError:
                time.sleep(0.3)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            operator = browser.new_context(locale="de-DE", timezone_id="Europe/Berlin")
            api = operator.request
            api.post(app_url + "/api/setup", headers=TAB,
                     data={"name": "jule", "password": password, "code": setup_code, "language": "de"})
            seed = api.post(app_url + "/api/auth/totp/begin", headers=TAB).json()["secret"]
            api.post(app_url + "/api/auth/totp/confirm", headers=TAB, data={"code": code_of(seed)})
            check(api.post(app_url + "/api/auth/setup/done", headers=TAB).ok, "operator set up with a second factor")

            # --- 34: the provider list in the interface ---------------------------------------------------------
            page = operator.new_page()
            errors: list[str] = []
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.goto(app_url + "/einstellungen?tab=signin")
            expect(page.get_by_role("heading", name="Anmeldeanbieter")).to_be_visible(timeout=20000)
            expect(page.get_by_text("Noch kein Anbieter.")).to_be_visible(timeout=15000)
            check(True, "an empty list says so")
            page.get_by_role("button", name="Anbieter hinzufügen").click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Name auf dem Knopf").fill("E2E Login")
            check(dialog.get_by_label("Kurzname").input_value() == "e2e-login", "the short name follows the name")
            dialog.get_by_label("Aussteller (Issuer)").fill(provider.issuer)
            dialog.get_by_label("Client-ID").fill(CLIENT_ID)
            dialog.get_by_label("Client-Geheimnis").fill(client_secret)
            dialog.get_by_role("switch", name="Neue Personen bekommen ein Konto").click()
            dialog.get_by_role("button", name="Speichern").click()
            listed = page.get_by_test_id("provider-list")
            expect(listed).to_contain_text("E2E Login", timeout=15000)
            check(listed.inner_text().count("aktiv") == 1, "the new entry is listed, on")
            page.get_by_role("button", name="Bearbeiten: E2E Login").click()
            page.get_by_role("dialog").get_by_label("Name auf dem Knopf").fill("E2E Anbieter")
            page.get_by_role("dialog").get_by_role("button", name="Speichern").click()
            expect(listed).to_contain_text("E2E Anbieter", timeout=15000)
            check(True, "the entry is edited")

            # --- 33: sign-in through the provider until there is a session ------------------------------------
            visitor = browser.new_context(locale="de-DE", timezone_id="Europe/Berlin")
            person = visitor.new_page()
            person.goto(app_url + "/login")
            person.get_by_role("button", name="Mit E2E Anbieter anmelden").click()
            person.wait_for_url(app_url + "/", timeout=20000)
            me = person.request.get(app_url + "/api/auth/me", headers=TAB)
            check(me.ok and me.json()["name"] == "robin" and me.json()["session_stage"] == "full",
                  "33: through the provider to a session as robin")
            visitor.close()

            # --- 34 continued: remove with the question, the authentik card's steps ---------------------------
            page.reload()
            page.get_by_role("button", name="Entfernen: E2E Anbieter").click()
            question = page.get_by_role("dialog")
            expect(question).to_contain_text("1 Konto verliert die Verknüpfung", timeout=15000)
            question.get_by_role("button", name="Entfernen").click()
            expect(page.get_by_text("Noch kein Anbieter.")).to_be_visible(timeout=15000)
            check(True, "34: removed after the question with the number of accounts")
            page.get_by_label("Adresse von authentik").fill("http://127.0.0.1:9")
            page.get_by_label("API-Token").fill("e2e-token")
            page.get_by_role("button", name="Übernehmen und einrichten").click()
            steps = page.get_by_test_id("authentik-steps")
            expect(steps).to_contain_text("Verbindung zu authentik", timeout=30000)
            check("ist unter dieser Adresse nicht erreichbar" in steps.inner_text(),
                  "34: the authentik card lists its steps, with the reason of the failed one")
            check(not [text for text in errors if "Failed to load resource" not in text], f"no console errors {errors}")
            operator.close()
            browser.close()
    except Exception as exc:  # noqa: BLE001 - the run reports and stops what it started
        check(False, f"{type(exc).__name__}: {str(exc)[:500]}")
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
        provider.stop()
    print("ALL CHECKS HELD" if not failed else f"{len(failed)} CHECKS FAILED")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
