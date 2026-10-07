"""The app on the home screen: the manifest with its shortcut "Notiz" and the share target into the quick note, the
service worker for Web Push only (no fetch handler: it keeps nothing and swallows nothing), and a Content Security
Policy that lets it register in the built app, where it counts."""

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
    assert (share["action"], share["method"]) == ("/schnell", "GET")
    assert share["params"]["text"] == "text" and "files" not in share["params"]


def test_the_service_worker_serves_push_only() -> None:
    worker = (PUBLIC / "sw.js").read_text(encoding="utf-8")
    code = "\n".join(line for line in worker.splitlines() if not line.lstrip().startswith("//"))
    assert "addEventListener('push'" in code and "addEventListener('notificationclick'" in code
    # Nothing between the page and the server: no fetch handler, no cache, no request of its own.
    for never in ("'fetch'", '"fetch"', "caches", "fetch(", "importScripts", "respondWith"):
        assert never not in code, never
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
