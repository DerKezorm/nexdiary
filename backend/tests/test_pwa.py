"""The app on the home screen: the manifest with its shortcut "Notiz" and the share target into the quick note (texts,
links and photos), the service worker for Web Push and for that one share (it keeps no pictures and no answers, and lets
every other request past), and a Content Security Policy that lets it register in the built app, where it counts."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import main
from app.middleware import CSP

PUBLIC = Path(__file__).resolve().parents[2] / "frontend" / "public"


def test_the_policy_lets_the_service_worker_and_the_manifest_in(client: TestClient) -> None:
    policy = client.get("/api/health").headers["content-security-policy"]
    assert "worker-src 'self'" in policy and "manifest-src 'self'" in policy
    assert "worker-src 'none'" not in policy and "'unsafe-eval'" not in policy
    assert policy.encode() == CSP


def test_the_manifest_has_the_shortcut_and_shares_into_the_quick_note() -> None:
    manifest = json.loads((PUBLIC / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["start_url"] == "/" and manifest["display"] == "standalone"
    assert manifest["icons"][0]["src"] == "/logo.svg"
    [shortcut] = manifest["shortcuts"]
    assert (shortcut["name"], shortcut["url"]) == ("Notiz", "/schnell")
    share = manifest["share_target"]
    assert (share["action"], share["method"], share["enctype"]) == ("/schnell", "POST", "multipart/form-data")
    params = share["params"]
    assert (params["title"], params["text"], params["url"]) == ("title", "text", "url")
    assert params["files"] == [{"name": "photos", "accept": ["image/*"]}]


def test_the_service_worker_serves_push_and_the_share_and_nothing_else() -> None:
    worker = (PUBLIC / "sw.js").read_text(encoding="utf-8")
    code = "\n".join(line for line in worker.splitlines() if not line.lstrip().startswith("//"))
    assert "addEventListener('push'" in code and "addEventListener('notificationclick'" in code
    # One answer of its own, for the share only; no request of its own, nothing loaded from elsewhere, one cache.
    assert code.count("respondWith") == 1 and "if (!isShare(event.request)) return" in code
    for never in ("fetch(", "importScripts"):
        assert never not in code, never
    assert code.count("caches.") == 1 and "self.caches.open(SHARE_CACHE)" in code
    # A tap opens a path of nexdiary, never another site.
    assert "startsWith('//')" in code


def test_the_built_app_serves_the_worker_and_the_manifest_fresh(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>nexdiary</title>", encoding="utf-8")
    (dist / "sw.js").write_text((PUBLIC / "sw.js").read_text(encoding="utf-8"), encoding="utf-8")
    (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    (dist / "logo.svg").write_text("<svg/>", encoding="utf-8")
    built = FastAPI()
    main._mount_frontend(built, dist)
    with TestClient(built) as browser:
        worker = browser.get("/sw.js")
        assert worker.status_code == 200 and "javascript" in worker.headers["content-type"]
        assert worker.headers["cache-control"] == "no-cache"
        assert browser.get("/manifest.webmanifest").headers["cache-control"] == "no-cache"
        assert "cache-control" not in browser.get("/logo.svg").headers


def test_a_share_that_no_service_worker_took_leads_to_the_quick_note_unread(tmp_path: Path) -> None:
    """Without a worker the share target's POST reaches the server: it is led to the quick note, which says to share
    once more. Nothing of the body is read or kept, and no session is needed for that."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>nexdiary</title>", encoding="utf-8")
    built = FastAPI()
    main._mount_frontend(built, dist)
    with TestClient(built) as browser:
        files = [("photos", (f"{index}.jpg", b"\xff\xd8" + bytes(2048), "image/jpeg")) for index in range(3)]
        answer = browser.post("/schnell", data={"text": "mittag im park"}, files=files, follow_redirects=False)
        assert answer.status_code == 303
        assert answer.headers["location"] == "/schnell?geteilt=verloren"
        assert answer.content == b""
        # The quick note itself is still the app's page.
        assert browser.get("/schnell").text.startswith("<!doctype html>")


def test_phones_get_png_symbols_and_notifications_a_png_icon_and_a_badge() -> None:
    """Review of B6: iPhone and Android want PNG for the home screen, a maskable one, and notifications draw no SVG."""
    import struct

    def size_of(name: str) -> tuple[int, int]:
        data = (PUBLIC / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", name
        return struct.unpack(">II", data[16:24])

    manifest = json.loads((PUBLIC / "manifest.webmanifest").read_text(encoding="utf-8"))
    pngs = {icon["src"]: icon for icon in manifest["icons"] if icon["type"] == "image/png"}
    assert {(src, icon["sizes"], icon["purpose"]) for src, icon in pngs.items()} == {
        ("/icon-192.png", "192x192", "any"), ("/icon-512.png", "512x512", "any"),
        ("/icon-maskable-512.png", "512x512", "maskable")}
    for src, icon in pngs.items():
        width, height = size_of(src.lstrip("/"))
        assert f"{width}x{height}" == icon["sizes"], src
    assert size_of("apple-touch-icon.png") == (180, 180) and size_of("badge-96.png") == (96, 96)
    index = (PUBLIC.parent / "index.html").read_text(encoding="utf-8")
    assert '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />' in index
    worker = (PUBLIC / "sw.js").read_text(encoding="utf-8")
    assert "icon: '/icon-192.png'" in worker and "badge: '/badge-96.png'" in worker
