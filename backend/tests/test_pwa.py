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
