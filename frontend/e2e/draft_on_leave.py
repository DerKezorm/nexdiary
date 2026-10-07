"""A draft typed on the writing page arrives when the page is left at once, with the service worker registered and in
control, and without one. Runs headless against the built app on a data folder of its own, then stops what it started.

    python frontend/e2e/draft_on_leave.py [--dist frontend/dist] [--port 18581]

Needs Python with ``playwright`` (``python -m playwright install chromium``) and the backend's virtual environment.
Exit code 0 only when every check held.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import os
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TAB = {"X-Nexdiary-Client": "tab-e2e00000"}


def code_of(seed: str) -> str:
    key = base64.b32decode(seed + "=" * (-len(seed) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", default=str(ROOT / "frontend" / "dist"))
    parser.add_argument("--port", type=int, default=18581)
    args = parser.parse_args()
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", args.port)) == 0:
            print(f"port {args.port} is taken")
            return 2
    app_url = f"http://localhost:{args.port}"
    python = ROOT / "backend" / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    data = Path(tempfile.mkdtemp(prefix="nexdiary-e2e-"))
    setup_code = secrets.token_urlsafe(16)
    password = secrets.token_urlsafe(18)
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(data), "NEXDIARY_FRONTEND_DIST": args.dist,
           "NEXDIARY_SETUP_TOKEN": setup_code, "NEXDIARY_DISABLE_BACKGROUND": "1",
           "NEXDIARY_UPDATE_URL": "http://127.0.0.1:9/none", "NEXDIARY_COOKIE_SUFFIX": "_e2e"}
    for name in ("NEXDIARY_MEDIA_DIR", "NEXDIARY_LOCALES_DIR", "NEXDIARY_MASTER_KEY_FILE", "NEXDIARY_PUBLIC_URL"):
        env.pop(name, None)
    server = subprocess.Popen([str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port",
                               str(args.port)], cwd=ROOT / "backend", env=env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
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
            context = browser.new_context(locale="de-DE", timezone_id="Europe/Berlin")
            api = context.request
            api.post(app_url + "/api/setup", headers=TAB,
                     data={"name": "jule", "password": password, "code": setup_code, "language": "de"})
            seed = api.post(app_url + "/api/auth/totp/begin", headers=TAB).json()["secret"]
            api.post(app_url + "/api/auth/totp/confirm", headers=TAB, data={"code": code_of(seed)})
            check(api.post(app_url + "/api/auth/setup/done", headers=TAB).ok, "operator set up with a second factor")
            api.put(app_url + "/api/me/preferences", headers=TAB, data={"timezone": "Europe/Berlin"})
            # "Today" as the server counts it, in the time zone of the account.
            today = api.get(app_url + "/api/today", headers=TAB).json()["date"]

            def leave_after_typing(page: Page, title: str) -> str:
                page.goto(app_url + f"/tag/{today}/schreiben")
                field = page.get_by_label("Überschrift", exact=True)
                expect(field).to_be_visible(timeout=20000)
                field.fill(title)
                # Leaving at once, long before the pause after typing would send it.
                page.goto("about:blank")
                for _ in range(40):
                    found = api.get(app_url + f"/api/days/{today}/draft", headers=TAB).json()
                    if found and found.get("title") == title:
                        return title
                    time.sleep(0.25)
                return ""

            page = context.new_page()
            page.goto(app_url + "/")
            # Registered the way the page does it for Web Push, under the built app's Content Security Policy.
            page.evaluate("async () => { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); "
                          "await navigator.serviceWorker.ready }")
            for _ in range(10):
                page.reload()
                if page.evaluate("() => !!navigator.serviceWorker.controller"):
                    break
                page.wait_for_timeout(300)
            check(page.evaluate("() => !!navigator.serviceWorker.controller"), "the service worker controls the page")
            check(leave_after_typing(page, "Abendlicht am See") == "Abendlicht am See",
                  "the draft arrives on leaving, worker in control")
            blocked = browser.new_context(locale="de-DE", timezone_id="Europe/Berlin", service_workers="block",
                                          storage_state=context.storage_state())
            without = blocked.new_page()
            without.goto(app_url + "/")
            check(not without.evaluate("() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)"),
                  "counter check: no worker there")
            check(leave_after_typing(without, "Gegenprobe ohne Worker") == "Gegenprobe ohne Worker",
                  "the draft arrives on leaving, without a worker")
            blocked.close()
            context.close()
            browser.close()
    except Exception as exc:  # noqa: BLE001 - the run reports and stops what it started
        check(False, f"{type(exc).__name__}: {str(exc)[:500]}")
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
    print("ALL CHECKS HELD" if not failed else f"{len(failed)} CHECKS FAILED")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
