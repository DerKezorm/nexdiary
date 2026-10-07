"""Immich: closed until the operator opens it, only on the hosts allowed (checked at every request), each person with
their own link, the address no way to a metadata service, around a redirect or through a second lookup, answers
bounded in size and time, the photos of a day suggested and copied only when taken, once, without metadata, within the
person's storage. Always against the stand-in (``fake_immich``), a real HTTP server on 127.0.0.1; every key is made for
the run."""

from __future__ import annotations

import gzip
import io
import struct
import threading
import time
import zipfile
import zlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import clock
from app.config import get_settings
from app.models import Account
from app.services import immich, logs, outbound

from .conftest import DATA_DIR, PASSWORD, person
from .fake_immich import Asset, FakeImmich, dribble, jpeg, made_key

HOST = "photos.example.com"
DAY = "2026-10-06"
NOW = datetime(2026, 10, 6, 18, 0, tzinfo=UTC)


class Lookups:
    """The resolver of the tests: the name of the stand-in gives 127.0.0.1, unless a test says otherwise; every
    lookup is counted."""

    def __init__(self) -> None:
        self.names: list[str] = []
        self.answers: dict[str, list[str]] = {HOST: ["127.0.0.1"]}

    def __call__(self, host: str, port: int) -> list[str]:
        self.names.append(host)
        if host not in self.answers:
            raise outbound.Unreachable(host)
        return list(self.answers[host])


@pytest.fixture
def lookups(monkeypatch: pytest.MonkeyPatch) -> Lookups:
    found = Lookups()
    monkeypatch.setattr(immich, "resolver", found)
    monkeypatch.setattr(clock, "now", lambda: NOW)
    return found


@pytest.fixture
def fake(lookups: Lookups) -> Iterator[FakeImmich]:
    double = FakeImmich()
    yield double
    double.close()


def address(fake: FakeImmich, host: str = HOST) -> str:
    return f"http://{host}:{fake.port}"


def open_immich(operator: TestClient, *hosts: str) -> None:
    answer = operator.put("/api/settings/immich", json={"allowed": True, "hosts": list(hosts or (HOST,))})
    assert answer.status_code == 200, answer.text


def connect(client: TestClient, fake: FakeImmich, key: str, url: str | None = None) -> None:
    client.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
    answer = client.put("/api/immich", json={"url": url or address(fake), "key": key})
    assert answer.status_code == 200, answer.text


def day_photos(at: str = "2026-10-06T07:20:00+00:00", *more: str) -> list[Asset]:
    return [Asset(taken=at), *(Asset(taken=moment) for moment in more)]


def code(answer: object) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]  # type: ignore[attr-defined]


@pytest.fixture
def ready(client: TestClient, operator: Account, fake: FakeImmich) -> tuple[str, list[Asset]]:
    """Immich open on the stand-in's host, the operator connected with a library of three photos of the day."""
    key = made_key()
    assets = day_photos("2026-10-06T05:20:00+00:00", "2026-10-06T10:18:00+00:00", "2026-10-06T16:52:00+00:00")
    fake.library(key, *assets, email="jule@example.com")
    open_immich(client)
    connect(client, fake, key)
    return key, assets


# --- The bolt ----------------------------------------------------------------------------------------------------------


def test_immich_is_closed_from_the_start_and_nothing_goes_out(client: TestClient, operator: Account,
                                                              fake: FakeImmich) -> None:
    assert client.get("/api/settings/immich").json() == {"allowed": False, "hosts": [], "connected": 0}
    assert client.get("/api/immich").json() == {"allowed": False, "connected": False}
    assert code(client.put("/api/immich", json={"url": address(fake), "key": made_key()})) == (403, "immich_closed")
    assert code(client.get("/api/immich/photos")) == (403, "immich_closed")
    assert code(client.post("/api/immich/probe")) == (403, "immich_closed")
    assert fake.requests == []


def test_only_the_operator_opens_it(client: TestClient, operator: Account, fake: FakeImmich) -> None:
    with person("ben") as ben:
        for method, body in (("get", None), ("put", {"allowed": True, "hosts": [HOST]})):
            answer = getattr(ben, method)("/api/settings/immich", **({"json": body} if body else {}))
            assert code(answer) == (403, "operator_only")
    assert client.get("/api/settings/immich").json()["allowed"] is False


def test_a_person_connects_tries_and_sees_the_photos_of_the_day(client: TestClient, ready: tuple[str, list[Asset]],
                                                                fake: FakeImmich) -> None:
    key, assets = ready
    state = client.get("/api/immich").json()
    assert state == {"allowed": True, "connected": True, "url": address(fake), "key_set": True, "suggest": True,
                     "email": "", "version": ""}
    probe = client.post("/api/immich/probe")
    assert probe.status_code == 200, probe.text
    assert probe.json() == {"version": "1.132.3", "today": 3, "more": False, "email": "jule@example.com"}
    assert client.get("/api/immich").json()["email"] == "jule@example.com"
    listed = client.get("/api/immich/photos").json()
    assert listed["date"] == DAY and listed["more"] is False
    assert [entry["id"] for entry in listed["photos"]] == [asset.id for asset in assets]
    assert all(entry["photo_id"] is None for entry in listed["photos"])
    # The connection went to the pinned address with the name kept, and with the person's own key.
    assert {seen.host for seen in fake.requests} == {f"{HOST}:{fake.port}"}
    assert {seen.key for seen in fake.requests if seen.path != "/api/server/version"} == {key}
    assert client.get("/api/settings/immich").json()["connected"] == 1


def test_the_operator_sees_how_many_connected_and_no_address(client: TestClient, ready: tuple[str, list[Asset]],
                                                             fake: FakeImmich) -> None:
    with person("ben") as ben:
        other = made_key()
        fake.library(other)
        connect(ben, fake, other)
    view = client.get("/api/settings/immich").json()
    assert view == {"allowed": True, "hosts": [HOST], "connected": 2}


def test_a_host_the_operator_did_not_allow_is_refused(client: TestClient, operator: Account, fake: FakeImmich,
                                                      lookups: Lookups) -> None:
    open_immich(client, "other.example.com")
    lookups.answers["other.example.com"] = ["127.0.0.1"]
    assert code(client.put("/api/immich", json={"url": address(fake), "key": made_key()})) == (
        403, "immich_host_not_allowed")
    # An allowed host on another port than the one allowed.
    open_immich(client, f"{HOST}:{fake.port + 1}")
    assert code(client.put("/api/immich", json={"url": address(fake), "key": made_key()})) == (
        403, "immich_host_not_allowed")
    open_immich(client, f"{HOST}:{fake.port}")
    assert client.put("/api/immich", json={"url": address(fake), "key": made_key()}).status_code == 200
    assert fake.requests == []


def test_taking_a_host_off_the_list_holds_from_the_next_request(client: TestClient, ready: tuple[str, list[Asset]],
                                                                fake: FakeImmich) -> None:
    assert client.get("/api/immich/photos").status_code == 200
    before = len(fake.requests)
    open_immich(client, "elsewhere.example.com")
    assert code(client.get("/api/immich/photos")) == (403, "immich_host_not_allowed")
    asset = ready[1][0].id
    assert code(client.get(f"/api/immich/photos/{asset}/thumbnail")) == (403, "immich_host_not_allowed")
    assert code(client.post(f"/api/immich/photos/{asset}", json={})) == (403, "immich_host_not_allowed")
    assert len(fake.requests) == before


def test_closing_the_bolt_holds_from_the_next_request(client: TestClient, ready: tuple[str, list[Asset]],
                                                      fake: FakeImmich) -> None:
    before = len(fake.requests)
    assert client.put("/api/settings/immich", json={"allowed": False}).status_code == 200
    assert client.get("/api/immich").json() == {"allowed": False, "connected": False}
    assert code(client.get("/api/immich/photos")) == (403, "immich_closed")
    assert code(client.post("/api/immich/probe")) == (403, "immich_closed")
    assert len(fake.requests) == before
    # Opened again, the link is there as it was.
    assert client.put("/api/settings/immich", json={"allowed": True}).status_code == 200
    assert client.get("/api/immich/photos").status_code == 200


def test_the_operator_cannot_allow_a_metadata_service(client: TestClient, operator: Account) -> None:
    for entry in ("169.254.169.254", "[fd00:ec2::254]", "http://169.254.169.254/latest", "100.100.100.200:80",
                  "[::ffff:169.254.169.254]", "0.0.0.0"):
        answer = client.put("/api/settings/immich", json={"allowed": True, "hosts": [entry]})
        assert answer.status_code == 422, entry
        assert answer.json()["detail"]["code"] in ("immich_host_refused", "immich_host_invalid"), entry
    for entry in ("photos example com", "a" * 300, "https://user:pw@photos.example.com", "photos.example.com/path"):
        assert code(client.put("/api/settings/immich", json={"hosts": [entry]}))[0] == 422, entry
    assert client.get("/api/settings/immich").json()["hosts"] == []


@pytest.mark.parametrize("answer", [
    ["169.254.169.254"], ["::ffff:169.254.169.254"], ["64:ff9b::a9fe:a9fe"], ["2002:a9fe:a9fe::1"],
    ["fd00:ec2::254"], ["100.100.100.200"], ["127.0.0.1", "169.254.170.2"], ["0.0.0.0"], ["224.0.0.1"],
])
def test_an_allowed_name_that_leads_to_a_metadata_service_is_never_reached(
        client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich, lookups: Lookups,
        answer: list[str]) -> None:
    before = len(fake.requests)
    lookups.answers[HOST] = answer
    assert code(client.get("/api/immich/photos")) == (422, "immich_address_refused")
    assert code(client.put("/api/immich", json={"url": address(fake), "key": made_key()})) == (
        422, "immich_address_refused")
    assert len(fake.requests) == before


def test_a_redirect_is_never_followed(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                      lookups: Lookups) -> None:
    lookups.answers["evil.example.com"] = ["127.0.0.1"]

    def away(handler: object, op: str) -> bool:
        handler.send_response(302)  # type: ignore[attr-defined]
        handler.send_header("Location", f"http://evil.example.com:{fake.port}/api/search/metadata")  # type: ignore
        handler.send_header("Content-Length", "0")  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        return True

    fake.misbehave = away
    before = len(fake.requests)
    assert code(client.get("/api/immich/photos")) == (502, "immich_redirect")
    assert len(fake.requests) == before + 1
    assert "evil.example.com" not in lookups.names


def test_the_name_is_looked_up_once_and_the_connection_goes_where_it_was_checked(
        client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich, lookups: Lookups) -> None:
    """DNS rebinding: a second lookup would answer with the metadata service. There is none: the request goes to the
    address checked."""
    answers = iter([["127.0.0.1"]])

    def rebinding(host: str, port: int) -> list[str]:
        lookups.names.append(host)
        return next(answers, ["169.254.169.254"])

    immich.resolver = rebinding
    lookups.names.clear()
    try:
        before = len(fake.requests)
        assert client.get("/api/immich/photos").status_code == 200
        assert len(fake.requests) == before + 1
        assert lookups.names.count(HOST) == 1
        # The next request looks up again, and is refused.
        assert code(client.get("/api/immich/photos")) == (422, "immich_address_refused")
        assert len(fake.requests) == before + 1
    finally:
        immich.resolver = lookups


def test_a_huge_answer_is_cut_off(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(immich, "MAX_JSON", 50_000)
    monkeypatch.setattr(immich, "MAX_THUMB", 50_000)

    def huge(handler: object, op: str) -> bool:
        if op == "/api/server/version":
            return False
        packed = "gzip" in op or "thumbnail" in op
        body = b"[" + b" " * 2_000_000 + b"]"
        if packed:
            body = gzip.compress(body)
        handler.send_response(200)  # type: ignore[attr-defined]
        handler.send_header("Content-Type", "application/json" if "thumbnail" not in op else "image/jpeg")  # type: ignore
        if "thumbnail" in op:
            handler.send_header("Content-Encoding", "gzip")  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        try:
            handler.wfile.write(body)  # type: ignore[attr-defined]
        except OSError:
            pass
        handler.close_connection = True  # type: ignore[attr-defined]
        return True

    fake.misbehave = huge
    assert code(client.get("/api/immich/photos")) == (502, "immich_too_large")
    # Packed small and unpacked huge: unpacked in steps, never at once.
    assert code(client.get(f"/api/immich/photos/{ready[1][0].id}/thumbnail")) == (502, "immich_too_large")


def test_a_slow_answer_ends_at_the_deadline(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                            monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(immich, "JSON_SECONDS", 1.0)
    fake.misbehave = lambda handler, op: op == "/api/search/metadata" and (dribble(handler, 4.0) or True)
    started = time.monotonic()
    assert code(client.get("/api/immich/photos")) == (504, "immich_timeout")
    assert time.monotonic() - started < 3.0


def gif() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), (1, 2, 3)).save(out, "GIF")
    return out.getvalue()


GIF = gif()


def bomb() -> bytes:
    """A PNG that is tiny on disk and claims 7,000 by 7,000 pixels: more than nexdiary unpacks, and still below the
    decoder's own limit, so that only nexdiary's count stops it (its few bytes of data unpack to zeros)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", 7_000, 7_000, 8, 0, 0, 0, 0)
    rows = zlib.compress(b"\x00" * 70_000, 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", rows) + chunk(b"IEND", b"")


@pytest.mark.parametrize(("op", "kind", "body"), [
    ("/api/search/metadata", "text/html", b"<html><script>alert(1)</script></html>"),
    ("thumbnail", "text/html", b"<html><script>alert(1)</script></html>"),
    ("thumbnail", "image/svg+xml", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
    ("thumbnail", "image/jpeg", b"<html><script>alert(1)</script></html>"),
    # Good bodies under a wrong name, and a picture of a kind that is no small picture: each check on its own.
    ("/api/search/metadata", "text/html", b'{"assets": {"items": [], "nextPage": null}}'),
    ("thumbnail", "text/html", jpeg((40, 30), (1, 2, 3))),
    ("thumbnail", "image/gif", GIF),
])
def test_a_wrong_kind_of_answer_is_refused(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                           op: str, kind: str, body: bytes) -> None:
    def wrong(handler: object, path: str) -> bool:
        if op not in path:
            return False
        handler.send_response(200)  # type: ignore[attr-defined]
        handler.send_header("Content-Type", kind)  # type: ignore[attr-defined]
        handler.send_header("Content-Length", str(len(body)))  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        handler.wfile.write(body)  # type: ignore[attr-defined]
        return True

    fake.misbehave = wrong
    target = "/api/immich/photos" if "search" in op else f"/api/immich/photos/{ready[1][0].id}/thumbnail"
    assert code(client.get(target)) == (502, "immich_unreadable")


def test_a_picture_bomb_from_immich_is_neither_passed_on_nor_unpacked(
        client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich) -> None:
    exploding = bomb()
    assert len(exploding) < 1_000_000

    def bombs(handler: object, op: str) -> bool:
        if "thumbnail" not in op and "original" not in op:
            return False
        handler.send_response(200)  # type: ignore[attr-defined]
        handler.send_header("Content-Type", "image/png")  # type: ignore[attr-defined]
        handler.send_header("Content-Length", str(len(exploding)))  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        handler.wfile.write(exploding)  # type: ignore[attr-defined]
        return True

    fake.misbehave = bombs
    asset = ready[1][0].id
    assert code(client.get(f"/api/immich/photos/{asset}/thumbnail")) == (502, "immich_unreadable")
    assert code(client.post(f"/api/immich/photos/{asset}", json={})) == (422, "immich_not_a_picture")
    assert client.get("/api/photos", params={"date": DAY}).json() == []


# --- Rights ------------------------------------------------------------------------------------------------------------


def test_a_person_only_ever_uses_their_own_link(client: TestClient, ready: tuple[str, list[Asset]],
                                                fake: FakeImmich) -> None:
    _key, assets = ready
    with person("ben") as ben:
        # Without a link of his own: nothing, never the operator's.
        assert code(ben.get("/api/immich/photos")) == (409, "immich_not_connected")
        assert code(ben.get(f"/api/immich/photos/{assets[0].id}/thumbnail")) == (409, "immich_not_connected")
        assert code(ben.post(f"/api/immich/photos/{assets[0].id}", json={})) == (409, "immich_not_connected")
        assert ben.get("/api/immich").json()["connected"] is False
        own = made_key()
        fake.library(own, Asset(taken="2026-10-06T09:00:00+00:00"))
        connect(ben, fake, own)
        before = len(fake.requests)
        # A photo of somebody else, asked for with his own link: his Immich does not know it.
        assert code(ben.post(f"/api/immich/photos/{assets[0].id}", json={})) == (502, "immich_not_found")
        assert code(ben.get(f"/api/immich/photos/{assets[0].id}/thumbnail")) == (502, "immich_not_found")
        assert {seen.key for seen in fake.requests[before:]} == {own}
        assert ben.get("/api/photos", params={"date": DAY}).json() == []
        assert [entry["id"] for entry in ben.get("/api/immich/photos").json()["photos"]] != [a.id for a in assets]


def test_the_key_is_never_shown_logged_or_kept_in_the_clear(client: TestClient, ready: tuple[str, list[Asset]],
                                                            fake: FakeImmich) -> None:
    logs.set_mode("trace", 30)
    try:
        key, assets = ready
        answers = [client.get("/api/immich"), client.post("/api/immich/probe"), client.get("/api/immich/photos"),
                   client.post(f"/api/immich/photos/{assets[0].id}", json={}), client.get("/api/settings/immich"),
                   client.put("/api/immich", json={"suggest": True})]
        for answer in answers:
            assert answer.status_code in (200, 201), answer.text
            assert key not in answer.text
        database = get_settings().database_path
        for path in Path(DATA_DIR).rglob("*"):
            if path.is_file() and path.suffix != ".zip":
                assert key.encode() not in path.read_bytes(), path
                # The person's own address is sealed too (the operator's list of hosts is not a secret).
                assert f"{HOST}:{fake.port}".encode() not in path.read_bytes(), path
        assert database.is_file() and logs.log_file().stat().st_size > 0
        name = client.post("/api/backups", json={"note": ""}).json()["name"]
        archive = client.post(f"/api/backups/{name}/download", json={"password": PASSWORD}).content
        with zipfile.ZipFile(io.BytesIO(archive)) as unpacked:
            for entry in unpacked.namelist():
                assert key.encode() not in unpacked.read(entry), entry
        # Floor: the key works, it is stored.
        assert client.get("/api/immich/photos").status_code == 200
    finally:
        logs.set_mode(logs.DEFAULT_MODE)


def test_a_new_address_forgets_the_key(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                       lookups: Lookups) -> None:
    open_immich(client, HOST, "other.example.com")
    lookups.answers["other.example.com"] = ["127.0.0.1"]
    moved = client.put("/api/immich", json={"url": address(fake, "other.example.com")})
    assert code(moved) == (422, "immich_key_missing")
    # Kept as it was.
    assert client.get("/api/immich").json()["url"] == address(fake)
    assert client.put("/api/immich", json={"suggest": False}).json()["suggest"] is False
    assert client.get("/api/immich").json()["key_set"] is True


def test_disconnecting_forgets_the_link_and_keeps_the_photos(client: TestClient, ready: tuple[str, list[Asset]],
                                                             fake: FakeImmich) -> None:
    photo = client.post(f"/api/immich/photos/{ready[1][0].id}", json={}).json()
    assert client.delete("/api/immich").status_code == 204
    assert client.get("/api/immich").json()["connected"] is False
    assert client.get("/api/settings/immich").json()["connected"] == 0
    assert client.get(f"/api/photos/{photo['id']}").status_code == 200


# --- The photos of the day -------------------------------------------------------------------------------------------


def test_only_still_pictures_of_the_day_in_the_persons_own_time_zone(client: TestClient, operator: Account,
                                                                     fake: FakeImmich) -> None:
    key = made_key()
    morning = Asset(taken="2026-10-05T22:30:00+00:00")  # 00:30 in Berlin on the 6th
    evening = Asset(taken="2026-10-06T21:30:00+00:00")  # 23:30 in Berlin
    late = Asset(taken="2026-10-06T22:30:00+00:00")  # the 7th in Berlin
    video = Asset(taken="2026-10-06T08:00:00+00:00", type="VIDEO")
    motion = Asset(taken="2026-10-06T08:00:00+00:00", visibility="hidden")
    locked = Asset(taken="2026-10-06T08:30:00+00:00", visibility="locked")
    binned = Asset(taken="2026-10-06T09:00:00+00:00", trashed=True)
    fake.library(key, morning, evening, late, video, motion, locked, binned)
    open_immich(client)
    connect(client, fake, key)
    listed = client.get("/api/immich/photos").json()["photos"]
    assert [entry["id"] for entry in listed] == [morning.id, evening.id]
    assert code(client.post(f"/api/immich/photos/{video.id}", json={})) == (422, "immich_not_a_picture")
    assert code(client.post(f"/api/immich/photos/{late.id}", json={})) == (422, "immich_other_day")
    yesterday = client.get("/api/immich/photos", params={"date": "2026-10-05"}).json()["photos"]
    assert yesterday == []


def test_at_most_sixty_photos_are_suggested(client: TestClient, operator: Account, fake: FakeImmich) -> None:
    key = made_key()
    fake.library(key, *(Asset(taken=f"2026-10-06T{hour:02d}:{minute:02d}:00+00:00")
                        for hour in range(6, 16) for minute in range(0, 60, 9)))
    open_immich(client)
    connect(client, fake, key)
    listed = client.get("/api/immich/photos").json()
    assert len(listed["photos"]) == immich.LIMIT and listed["more"] is True


def test_switched_off_suggestions_are_not_fetched(client: TestClient, ready: tuple[str, list[Asset]],
                                                  fake: FakeImmich) -> None:
    client.put("/api/immich", json={"suggest": False})
    before = len(fake.requests)
    assert code(client.get("/api/immich/photos")) == (409, "immich_suggest_off")
    assert len(fake.requests) == before


def test_taking_a_photo_copies_it_once_without_metadata(client: TestClient, operator: Account,
                                                        fake: FakeImmich) -> None:
    key = made_key()
    word = "Qx" + made_key()[:10] + "Zy"
    asset = Asset(taken="2026-10-06T07:20:00+00:00", word=word)
    fake.library(key, asset)
    open_immich(client)
    connect(client, fake, key)
    assert fake.calls("/original") == 0, "nothing is copied before it is taken"
    first = client.post(f"/api/immich/photos/{asset.id}", json={"date": DAY})
    assert first.status_code == 201, first.text
    again = client.post(f"/api/immich/photos/{asset.id}", json={})
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert fake.calls("/original") == 1
    photo = first.json()
    assert (photo["source"], photo["date"], photo["on_note"]) == ("immich", DAY, False)
    picture = client.get(f"/api/photos/{photo['id']}").content
    assert word.encode() not in picture
    with Image.open(io.BytesIO(picture)) as opened:
        assert opened.format == "WEBP" and not opened.getexif() and "xmp" not in opened.info
    # The list knows it was taken; the database knows only a keyed hash of where from.
    assert client.get("/api/immich/photos").json()["photos"][0]["photo_id"] == photo["id"]
    raw = get_settings().database_path.read_bytes()
    assert asset.id.encode() not in raw
    # For a note it is a photo of its own, also once.
    on_note = client.post(f"/api/immich/photos/{asset.id}", json={"note": True})
    assert on_note.status_code == 201 and on_note.json()["on_note"] is True
    assert client.post(f"/api/immich/photos/{asset.id}", json={"note": True}).json()["id"] == on_note.json()["id"]
    # A cover from Immich: the photo taken is a photo of the day.
    cover = client.put(f"/api/days/{DAY}", json={"cover": f"photo:{photo['id']}"})
    assert cover.status_code == 200 and cover.json()["cover"] == f"photo:{photo['id']}"


def test_taking_the_same_photo_twice_at_once_keeps_one(client: TestClient, ready: tuple[str, list[Asset]],
                                                       fake: FakeImmich) -> None:
    asset = ready[1][1].id
    results: list[int] = []
    gate = threading.Barrier(2)

    def take() -> None:
        gate.wait()
        results.append(client.post(f"/api/immich/photos/{asset}", json={}).status_code)

    threads = [threading.Thread(target=take) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) in ([200, 201], [201, 201]), results
    listed = client.get("/api/photos", params={"date": DAY}).json()
    assert len(listed) == 1
    files = sorted(path.name for path in (Path(DATA_DIR) / "media").iterdir() if not path.name.startswith("."))
    assert files == [listed[0]["id"], listed[0]["id"] + ".p"]


def test_the_storage_limit_holds_for_photos_of_immich(client: TestClient, ready: tuple[str, list[Asset]],
                                                      fake: FakeImmich) -> None:
    assert client.put("/api/settings", json={"storage_per_person_gb": 0.000001}).status_code == 200
    assert code(client.post(f"/api/immich/photos/{ready[1][0].id}", json={})) == (409, "storage_full")
    assert client.get("/api/photos", params={"date": DAY}).json() == []
    assert [path for path in (Path(DATA_DIR) / "media").iterdir() if not path.name.startswith(".")] == []


def test_an_original_nexdiary_does_not_take_comes_from_the_large_picture(
        client: TestClient, operator: Account, fake: FakeImmich) -> None:
    key = made_key()
    raw = Asset(taken="2026-10-06T07:20:00+00:00", original=b"II*\x00" + b"\x00" * 4000)  # a TIFF-like RAW file
    fake.library(key, raw)
    open_immich(client)
    connect(client, fake, key)
    taken = client.post(f"/api/immich/photos/{raw.id}", json={})
    assert taken.status_code == 201, taken.text
    assert (taken.json()["width"], taken.json()["height"]) == (1440, 1080)


def test_a_small_picture_comes_through_as_a_picture(client: TestClient, ready: tuple[str, list[Asset]]) -> None:
    answer = client.get(f"/api/immich/photos/{ready[1][0].id}/thumbnail")
    assert answer.status_code == 200
    assert answer.headers["content-type"] == "image/jpeg"
    assert answer.headers["cache-control"] == "private, max-age=600"
    assert answer.headers["x-content-type-options"] == "nosniff"
    assert code(client.get("/api/immich/photos/not-an-id/thumbnail")) == (404, "not_found")


def test_a_missing_permission_is_named(client: TestClient, operator: Account, fake: FakeImmich) -> None:
    key = made_key()
    asset = Asset(taken="2026-10-06T07:20:00+00:00")
    fake.library(key, asset, permissions=("asset.read",))
    open_immich(client)
    connect(client, fake, key)
    probe = client.post("/api/immich/probe")
    assert probe.status_code == 200 and probe.json()["email"] == ""
    answer = client.get(f"/api/immich/photos/{asset.id}/thumbnail")
    assert code(answer) == (502, "immich_permission")
    assert answer.json()["detail"]["needed"] == ["asset.read", "asset.view", "asset.download"]
    wrong = made_key()
    client.put("/api/immich", json={"key": wrong})
    assert code(client.post("/api/immich/probe")) == (502, "immich_key_refused")


def test_today_stays_usable_when_immich_is_away(client: TestClient, ready: tuple[str, list[Asset]],
                                                fake: FakeImmich) -> None:
    fake.close()
    assert code(client.get("/api/immich/photos")) == (502, "immich_unreachable")
    assert client.get("/api/today").status_code == 200


def test_the_small_pictures_have_a_brake(client: TestClient, ready: tuple[str, list[Asset]],
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import brakes

    monkeypatch.setitem(brakes.LIMITS, "immich_thumb", 2)
    asset = ready[1][0].id
    assert client.get(f"/api/immich/photos/{asset}/thumbnail").status_code == 200
    assert client.get(f"/api/immich/photos/{asset}/thumbnail").status_code == 200
    assert code(client.get(f"/api/immich/photos/{asset}/thumbnail")) == (429, "immich_too_often")


# --- The address itself ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("typed", "kept"), [
    ("https://Photos.Example.com/", "https://photos.example.com"),
    ("http://photos.example.com:2283/api", "http://photos.example.com:2283"),
    ("https://photos.example.com/api/", "https://photos.example.com"),
    ("http://[::1]:2283", "http://[::1]:2283"),
])
def test_an_address_is_cleaned(typed: str, kept: str) -> None:
    assert immich.check_url(typed) == kept


@pytest.mark.parametrize("typed", [
    "", "ftp://photos.example.com", "https://user:pw@photos.example.com", "https://photos.example.com/?a=1",
    "https://photos.example.com/#x", "https://photos.example.com:99999", "javascript:alert(1)", "photos.example.com",
    "https://photos.example.com/a b", "https://photos.example.com/%2e%2e",
    # No path of one's choosing: Immich answers at the root (review of B5).
    "https://photos.example.com/immich", "https://photos.example.com/other/api",
    # Python refuses these with ValueError; they are a wrong address, never a fault of the server (review of B5).
    "http://[::1", "http://[photos.example.com]:2283", "http://a℀b.example.com/", "https://[fcm.googleapis.com]/x",
])
def test_an_address_that_is_none_is_refused(typed: str) -> None:
    with pytest.raises(Exception) as caught:
        immich.check_url(typed)
    assert caught.value.detail["code"] in ("immich_address_missing", "immich_address_invalid")  # type: ignore


def test_never_knows_the_metadata_service_in_every_disguise() -> None:
    for address in ("169.254.169.254", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::",
                    "fd00:ec2::254", "100.100.100.200", "fe80::1", "0.0.0.0", "::", "ff02::1"):
        assert outbound.never(outbound.ip_of(address)), address
    for address in ("127.0.0.1", "192.168.1.20", "10.0.0.5", "93.184.216.34", "fd12:3456::1"):
        assert not outbound.never(outbound.ip_of(address)), address


def test_a_tiny_api_key_with_spaces_or_lines_is_refused(client: TestClient, operator: Account,
                                                        fake: FakeImmich) -> None:
    open_immich(client)
    for key in ("with space", "line\nbreak", "x" * 201):
        assert code(client.put("/api/immich", json={"url": address(fake), "key": key}))[1] in (
            "immich_key_invalid", "invalid_input"), repr(key)
    assert fake.requests == []


def test_jpeg_of_the_double_carries_a_place() -> None:
    """Floor for the metadata test: the original of the stand-in does carry what must go."""
    data = jpeg((40, 30), (1, 2, 3), "Wort")
    with Image.open(io.BytesIO(data)) as opened:
        assert opened.getexif().get_ifd(0x8825)
    assert b"Wort" in data


def test_the_line_of_small_pictures_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """A page asks for a day's small pictures at once: a few go, the others wait without a thread, and a line longer
    than a day is turned away."""
    import asyncio

    monkeypatch.setattr(immich, "THUMBS_AT_ONCE", 2)
    monkeypatch.setattr(immich, "THUMBS_WAITING", 3)
    running = {"now": 0, "most": 0}

    async def one() -> str:
        try:
            async with immich.waiting(7):
                running["now"] += 1
                running["most"] = max(running["most"], running["now"])
                await asyncio.sleep(0.05)
                running["now"] -= 1
                return "ok"
        except Exception as exc:  # noqa: BLE001
            return exc.detail["code"]  # type: ignore[attr-defined]

    async def many() -> list[str]:
        return await asyncio.gather(*(one() for _ in range(5)))

    answers = asyncio.run(many())
    assert sorted(answers) == ["immich_busy", "immich_busy", "ok", "ok", "ok"]
    assert running["most"] == 2
    assert immich._lines == {}


def test_a_packed_bomb_is_unpacked_in_steps(client: TestClient, ready: tuple[str, list[Asset]], fake: FakeImmich,
                                            monkeypatch: pytest.MonkeyPatch) -> None:
    """200 MB of zeros packed into some 200 KB: refused while unpacking, never unpacked whole into memory."""
    import tracemalloc

    packer = zlib.compressobj(9, zlib.DEFLATED, 31)
    zeros = b"\x00" * (1024 * 1024)
    packed = b"".join(packer.compress(zeros) for _ in range(200)) + packer.flush()
    assert len(packed) < 1_000_000

    def packed_answer(handler: object, op: str) -> bool:
        if "thumbnail" not in op:
            return False
        handler.send_response(200)  # type: ignore[attr-defined]
        handler.send_header("Content-Type", "image/jpeg")  # type: ignore[attr-defined]
        handler.send_header("Content-Encoding", "gzip")  # type: ignore[attr-defined]
        handler.send_header("Content-Length", str(len(packed)))  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        handler.wfile.write(packed)  # type: ignore[attr-defined]
        return True

    fake.misbehave = packed_answer
    tracemalloc.start()
    try:
        answer = client.get(f"/api/immich/photos/{ready[1][0].id}/thumbnail")
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert code(answer) == (502, "immich_too_large")
    assert peak < 40 * 1024 * 1024, peak


def test_a_certificate_the_server_does_not_trust_is_said_as_such(client: TestClient, ready: tuple[str, list[Asset]],
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """Review of B5: a self-made certificate of the own Immich gets a sentence of its own; the check stays on."""
    import ssl

    import httpx

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("certificate verify failed") from ssl.SSLCertVerificationError(
            1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate")

    monkeypatch.setattr(immich, "transport", httpx.MockTransport(refuse))
    assert code(client.get("/api/immich/photos")) == (502, "immich_tls")
