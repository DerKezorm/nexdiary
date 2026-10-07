"""A stand-in for Immich, as a real HTTP server on 127.0.0.1 (a port of its own), with the routes nexdiary uses as the
real API has them: the server version, the search by date, an asset, its small and large picture, its original, the
own account. Every key is made for the run; each key sees only its own photos, as in Immich. A test can make it
misbehave (``misbehave``) and reads what came (``requests``)."""

from __future__ import annotations

import io
import json
import secrets
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from PIL import Image

VERSION = {"major": 1, "minor": 132, "patch": 3}
ALL = ("asset.read", "asset.view", "asset.download", "user.read", "album.read")


def made_key() -> str:
    return secrets.token_urlsafe(32)


def jpeg(size: tuple[int, int], colour: tuple[int, int, int], word: str = "") -> bytes:
    """A JPEG; with ``word`` it carries the word in its EXIF description and a place (GPS) of its own."""
    image = Image.new("RGB", size, colour)
    out = io.BytesIO()
    if word:
        exif = Image.Exif()
        exif[0x010E] = f"Bild {word}"
        exif[0x010F] = f"Kamera {word}"
        gps = exif.get_ifd(0x8825)
        gps[1], gps[2], gps[3], gps[4] = "N", (52.0, 31.0, 12.0), "E", (13.0, 24.0, 36.0)
        image.save(out, "JPEG", exif=exif.tobytes(), xmp=f"<x>{word}</x>".encode())
    else:
        image.save(out, "JPEG")
    return out.getvalue()


@dataclass
class Asset:
    taken: str
    type: str = "IMAGE"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    trashed: bool = False
    visibility: str = "timeline"
    original: bytes | None = None
    word: str = ""
    #: When it reached Immich (``createdAt``); empty: when it was taken.
    uploaded: str = ""
    #: What the smart search and the metadata search find it by.
    about: str = ""

    def json(self) -> dict[str, Any]:
        return {"id": self.id, "type": self.type, "fileCreatedAt": self.taken, "localDateTime": self.taken,
                "createdAt": self.uploaded or self.taken,
                "isTrashed": self.trashed, "visibility": self.visibility, "originalFileName": "IMG_0001.JPG",
                "originalMimeType": "image/jpeg", "livePhotoVideoId": None}


@dataclass
class Seen:
    method: str
    path: str
    host: str
    key: str
    body: Any


class FakeImmich:
    def __init__(self, port: int = 0) -> None:
        #: Photos per key: a key sees only its own.
        self.libraries: dict[str, list[Asset]] = {}
        self.permissions: dict[str, tuple[str, ...]] = {}
        self.emails: dict[str, str] = {}
        #: Albums per key: ``(album id, name, [asset ids])``.
        self.albums: dict[str, list[tuple[str, str, list[str]]]] = {}
        #: Whether the smart search is there (Immich answers 500 for it where it is switched off).
        self.smart = True
        self.requests: list[Seen] = []
        #: ``(handler, op)``: True when it answered itself.
        self.misbehave: Callable[[BaseHTTPRequestHandler, str], bool] | None = None
        self.server = ThreadingHTTPServer(("127.0.0.1", port), self._handler())
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def library(self, key: str, *assets: Asset, permissions: tuple[str, ...] = ALL, email: str = "") -> None:
        self.libraries.setdefault(key, []).extend(assets)
        self.permissions[key] = permissions
        if email:
            self.emails[key] = email

    def calls(self, op: str) -> int:
        return sum(1 for seen in self.requests if op in seen.path)

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def send_json(self, status: int, data: Any) -> None:
                body = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def send_bytes(self, status: int, body: bytes, kind: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _serve(self, method: str) -> None:
                parts = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                key = self.headers.get("x-api-key") or ""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                fake.requests.append(Seen(method, parts.path, self.headers.get("Host") or "", key, body))
                path = parts.path
                op = path
                if fake.misbehave is not None and fake.misbehave(self, op):
                    return
                if path == "/api/server/version" and method == "GET":
                    return self.send_json(200, VERSION)
                if key not in fake.libraries:
                    return self.send_json(401, {"message": "Invalid API key", "statusCode": 401})
                allowed = fake.permissions[key]
                own = {asset.id: asset for asset in fake.libraries[key]}
                if path == "/api/users/me" and method == "GET":
                    if "user.read" not in allowed:
                        return self.send_json(403, {"message": "Missing required permission: user.read"})
                    return self.send_json(200, {"id": "u1", "email": fake.emails.get(key, "")})
                if path == "/api/albums" and method == "GET":
                    if "album.read" not in allowed:
                        return self.send_json(403, {"message": "Missing required permission: album.read"})
                    return self.send_json(200, [{"id": aid, "albumName": name, "assetCount": len(ids),
                                                 "albumThumbnailAssetId": ids[0] if ids else None}
                                                for aid, name, ids in fake.albums.get(key, [])])
                if path in ("/api/search/metadata", "/api/search/smart") and method == "POST":
                    if "asset.read" not in allowed:
                        return self.send_json(403, {"message": "Missing required permission: asset.read"})
                    if path.endswith("smart") and not fake.smart:
                        return self.send_json(500, {"message": "Smart search is not enabled"})
                    found = [asset for asset in fake.libraries[key]
                             if (not body.get("type") or asset.type == body["type"])
                             and (body.get("withDeleted") or not asset.trashed)]
                    if body.get("takenAfter"):
                        found = [a for a in found if datetime.fromisoformat(a.taken) >= datetime.fromisoformat(body["takenAfter"])]
                    if body.get("takenBefore"):
                        found = [a for a in found if datetime.fromisoformat(a.taken) < datetime.fromisoformat(body["takenBefore"])]
                    if body.get("createdAfter"):
                        found = [a for a in found if datetime.fromisoformat(a.uploaded or a.taken)
                                 >= datetime.fromisoformat(body["createdAfter"])]
                    if body.get("albumIds"):
                        inside = {i for aid, _n, ids in fake.albums.get(key, []) if aid in body["albumIds"] for i in ids}
                        found = [a for a in found if a.id in inside]
                    if body.get("query"):
                        found = [a for a in found if body["query"].lower() in a.about.lower()]
                    for field_name in ("description", "city", "originalFileName"):
                        if body.get(field_name):
                            found = [a for a in found if body[field_name].lower() in a.about.lower()]
                    found.sort(key=lambda asset: asset.taken, reverse=body.get("order") == "desc")
                    size = int(body.get("size") or 250)
                    number = int(body.get("page") or 1)
                    page = found[(number - 1) * size: number * size]
                    more = len(found) > number * size
                    return self.send_json(200, {"assets": {"total": len(found), "count": len(page),
                                                           "items": [asset.json() for asset in page],
                                                           "nextPage": str(number + 1) if more else None},
                                                "albums": {"total": 0, "count": 0, "items": []}})
                if path.startswith("/api/assets/"):
                    rest = path[len("/api/assets/"):].split("/")
                    asset = own.get(rest[0])
                    if asset is None:
                        return self.send_json(400, {"message": "Not found or no asset.read access"})
                    if len(rest) == 1:
                        return self.send_json(200, asset.json())
                    if rest[1] == "thumbnail":
                        if "asset.view" not in allowed:
                            return self.send_json(403, {"message": "Missing required permission: asset.view"})
                        size = parse_qs(parts.query).get("size", ["thumbnail"])[0]
                        edge = (250, 188) if size == "thumbnail" else (1440, 1080)
                        return self.send_bytes(200, jpeg(edge, (90, 120, 80)), "image/jpeg")
                    if rest[1] == "original":
                        if "asset.download" not in allowed:
                            return self.send_json(403, {"message": "Missing required permission: asset.download"})
                        data = asset.original or jpeg((1200, 900), (200, 150, 60), asset.word)
                        return self.send_bytes(200, data, "image/jpeg")
                return self.send_json(404, {"message": "Not found"})

            def do_GET(self) -> None:
                self._serve("GET")

            def do_POST(self) -> None:
                self._serve("POST")

        return Handler


def dribble(handler: BaseHTTPRequestHandler, seconds: float) -> None:
    """An answer that sends a byte now and then, for ``seconds``."""
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", "100000")
    handler.end_headers()
    end = time.monotonic() + seconds
    try:
        while time.monotonic() < end:
            handler.wfile.write(b" ")
            handler.wfile.flush()
            time.sleep(0.05)
    except OSError:
        pass
