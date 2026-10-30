"""Attachments of a day over HTTP: videos, sounds, PDFs and links; what is taken and what not, how a file comes back
(whole or a range at a time), the limits, the lock, the storage, and that nobody but the owner gets one."""

from __future__ import annotations

import contextlib
import subprocess
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import clock
from app.db import SessionLocal
from app.models import Account, Attachment
from app.services import attachments, media_tools, sealed_file, settings_service

from . import media_samples as samples
from .conftest import MEDIA, new_client

DAY = "2026-10-20"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime

    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 22, 10, 0, tzinfo=UTC))


def send(client: TestClient, data: bytes, kind: str, *, day: str | None = DAY, name: str = "Ein Name",
         upload_id: str | None = None) -> Any:
    params = {"upload_id": upload_id or str(uuid.uuid4()), "kind": kind, "name": name}
    if day is not None:
        params["date"] = day
    return client.post("/api/attachments", params=params, content=data)


def link(client: TestClient, url: str, title: str | None = None, *, day: str | None = DAY,
         upload_id: str | None = None) -> Any:
    return client.post("/api/attachments/link", json={"date": day, "url": url, "title": title,
                                                      "upload_id": upload_id or str(uuid.uuid4())})


def media_files() -> list[str]:
    return sorted(path.name for path in MEDIA.iterdir())


def lock(client: TestClient, day: str = DAY) -> None:
    assert client.put(f"/api/days/{day}", json={"title": "Fest", "text": "Für immer."}).status_code == 200
    assert client.post(f"/api/days/{day}/lock").status_code == 200


# --- What is taken ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("make", "kind", "container", "codec", "content_type"), [
    (samples.h264_mp4, "video", "mp4", "h264", "video/mp4"),
    (samples.hevc_mp4, "video", "mp4", "hevc", "video/mp4"),
    (samples.webm_vp9, "video", "webm", "vp9", "video/webm"),
    (samples.webm_opus, "audio", "webm", "opus", "audio/webm"),
    (samples.ogg_opus, "audio", "ogg", "opus", "audio/ogg"),
    (samples.wav, "audio", "wav", "pcm", "audio/wav"),
    (samples.mp3, "audio", "mp3", "mp3", "audio/mpeg"),
    (samples.m4a, "audio", "mp4", "aac", "audio/mp4"),
])
def test_videos_and_sounds_are_taken_packed_anew_and_given_back(
        client: TestClient, account: Account, make: Any, kind: str, container: str, codec: str,
        content_type: str) -> None:
    data = make()
    answer = send(client, data, kind, name="C:\\fakepath\\Urlaub am See.mov")
    assert answer.status_code == 201, answer.text
    item = answer.json()
    assert item["kind"] == kind and item["codec"] == codec and item["date"] == DAY
    assert item["name"] == "Urlaub am See.mov", "the last part of the path, nothing before it"
    assert item["status"] == "ready" and item["progress"] is None
    assert item["playable"] is (codec != "hevc")
    assert item["seconds"] and 0.5 < item["seconds"] < 3
    assert "url" not in item
    if kind == "video":
        assert item["width"] == 160 and item["height"] == 120 and item["has_preview"] is True
        preview = client.get(f"/api/attachments/{item['id']}/preview")
        assert preview.status_code == 200 and preview.headers["content-type"] == "image/webp"
        assert preview.content[:4] == b"RIFF" and preview.content[8:12] == b"WEBP"
    else:
        assert item["width"] is None and item["height"] is None and item["has_preview"] is False
        assert client.get(f"/api/attachments/{item['id']}/preview").status_code == 404
    whole = client.get(f"/api/attachments/{item['id']}")
    assert whole.status_code == 200
    assert whole.headers["content-type"] == content_type
    assert whole.headers["accept-ranges"] == "bytes"
    assert whole.headers["content-security-policy"] == "sandbox"
    assert whole.headers["x-content-type-options"] == "nosniff"
    assert int(whole.headers["content-length"]) == len(whole.content) == item["size"]
    assert whole.headers["content-disposition"].startswith("inline; filename*=UTF-8''Urlaub%20am%20See.")
    # What came back is a file ffprobe reads as the same kind, packed anew.
    probe = probe_bytes(whole.content, media_tools.demuxer_of_container(container))
    assert (probe.video is not None) is (kind == "video")


def probe_bytes(data: bytes, demuxer: str) -> media_tools.Probe:
    path = MEDIA.parent / f"probe-{uuid.uuid4().hex}"
    path.write_bytes(data)
    try:
        return media_tools.probe(path, demuxer)
    finally:
        path.unlink()


def test_a_pdf_is_kept_as_it_came_and_always_goes_out_as_a_download(client: TestClient, account: Account) -> None:
    data = samples.pdf("Konzertprogramm")
    answer = send(client, data, "pdf", name="Programm.pdf")
    assert answer.status_code == 201, answer.text
    item = answer.json()
    assert item["kind"] == "pdf" and item["codec"] is None and item["seconds"] is None and item["size"] == len(data)
    assert item["has_preview"] is False and item["can_convert"] is False and item["playable"] is True
    got = client.get(f"/api/attachments/{item['id']}")
    assert got.content == data
    assert got.headers["content-type"] == "application/pdf"
    assert got.headers["content-disposition"] == "attachment; filename*=UTF-8''Programm.pdf"
    assert got.headers["content-security-policy"] == "sandbox"
    download = client.get(f"/api/attachments/{item['id']}", params={"download": 1})
    assert download.headers["content-disposition"] == "attachment; filename*=UTF-8''Programm.pdf"


def test_a_pdf_works_without_ffmpeg_and_videos_are_then_not_taken(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media_tools, "available", lambda: False)
    assert send(client, samples.pdf(), "pdf").status_code == 201
    for kind in ("video", "audio"):
        refused = send(client, b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100, kind)
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachment_not_supported"
    assert link(client, "https://example.com/fest").status_code == 201
    assert operator_view(client)["ffmpeg"] is False


def test_the_kind_is_what_the_file_is_not_what_the_browser_says(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    for data, said in ((samples.pdf(), "video"), (samples.pdf(), "audio"), (samples.h264_mp4(), "pdf"),
                       (samples.h264_mp4(), "audio"), (samples.mp3(), "video"), (samples.wav(), "pdf")):
        refused = send(client, data, said)
        assert refused.status_code == 422, (said, refused.text)
        assert refused.json()["detail"]["code"] == "attachment_wrong_kind", said
    assert media_files() == []


@pytest.mark.parametrize("make", [samples.mkv_h264, samples.avi, samples.mp4_mpeg4])
def test_containers_and_codecs_nexdiary_does_not_keep_are_refused(client: TestClient, account: Account,
                                                                  make: Any) -> None:
    refused = send(client, make(), "video")
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachment_not_supported"
    assert media_files() == []


@pytest.mark.parametrize("data", [b"", b"plain words, nothing else", b"<html><script>1</script></html>",
                                  b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, b"%PDX-1.4"])
def test_anything_else_is_not_taken(client: TestClient, account: Account, data: bytes) -> None:
    for kind in ("pdf", "video", "audio"):
        refused = send(client, data, kind)
        assert refused.status_code == 422, (kind, data[:10])
        assert refused.json()["detail"]["code"] in ("attachment_not_supported", "attachment_wrong_kind")
    assert media_files() == []


def test_a_broken_video_that_looks_right_is_not_taken(client: TestClient, account: Account) -> None:
    good = samples.h264_mp4()
    for data in (good[:200], good[:40] + b"\x00" * 4000):
        refused = send(client, data, "video")
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachment_not_supported"
    assert media_files() == []


def test_the_place_the_titles_and_the_subtitles_of_a_phone_video_do_not_survive(client: TestClient,
                                                                               account: Account) -> None:
    word = "Seeufer" + uuid.uuid4().hex[:6]
    data = samples.mov_with_place(word)
    source = probe_bytes(data, "mov")
    assert source.places and source.streams == 3, "the sample carries a place and a subtitle stream"
    answer = send(client, data, "video")
    assert answer.status_code == 201, answer.text
    item = answer.json()
    assert item["codec"] == "hevc" and item["playable"] is False
    kept = client.get(f"/api/attachments/{item['id']}").content
    probe = probe_bytes(kept, "mov")
    assert not probe.places and probe.streams == 2, "one picture, one sound, nothing else"
    assert not {tag for tag in probe.tags if "creation" in tag or "title" in tag or "make" in tag}
    for needle in (word.encode(), PLACE_BYTES, b"Untertitel", b"Phone"):
        assert needle not in kept


PLACE_BYTES = samples.PLACE.encode()


def test_a_packed_file_that_still_names_a_place_is_not_kept(client: TestClient, account: Account,
                                                             monkeypatch: pytest.MonkeyPatch) -> None:
    """Should packing ever keep a place (another ffmpeg, another file), the check of the result refuses it."""
    import shutil

    data = samples.mov_with_place("Probe")
    monkeypatch.setattr(media_tools, "remux", lambda checked, source, target: shutil.copyfile(source, target))
    refused = send(client, data, "video")
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachment_not_supported"
    assert media_files() == []


def test_the_tags_of_a_sound_do_not_survive(client: TestClient, account: Account) -> None:
    word = "Liedtitel" + uuid.uuid4().hex[:6]
    data = samples.mp3(title=word)
    assert word.encode() in data
    item = send(client, data, "audio").json()
    assert word.encode() not in client.get(f"/api/attachments/{item['id']}").content


# --- Ranges ----------------------------------------------------------------------------------------------------------


@pytest.fixture
def big(client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> tuple[str, bytes]:
    """A PDF of a little more than three pieces of a sealed file, with small pieces so that the test stays small."""
    monkeypatch.setattr(sealed_file, "CHUNK", 4096)
    original = sealed_file.write

    def small(source: Path, target: Path, dek: bytes, bound: bytes, *, chunk: int = 4096) -> int:
        return original(source, target, dek, bound, chunk=4096)

    monkeypatch.setattr(sealed_file, "write", small)
    data = b"%PDF-1.4\n" + bytes(range(256)) * 50
    answer = send(client, data, "pdf")
    assert answer.status_code == 201
    return answer.json()["id"], data


@pytest.mark.parametrize(("asked", "first", "last"), [
    ("bytes=0-0", 0, 0),
    ("bytes=0-", 0, None),
    ("bytes=4095-4096", 4095, 4096),
    ("bytes=4000-8300", 4000, 8300),
    ("bytes=12000-99999999", 12000, None),
    ("bytes=-1", -1, None),
    ("bytes=-500", -500, None),
    ("bytes=-999999", 0, None),
])
def test_a_range_comes_back_as_206_with_exactly_those_bytes(client: TestClient, big: tuple[str, bytes], asked: str,
                                                            first: int, last: int | None) -> None:
    uid, data = big
    size = len(data)
    start = first if first >= 0 else size + first
    end = size - 1 if last is None else last
    got = client.get(f"/api/attachments/{uid}", headers={"Range": asked})
    assert got.status_code == 206
    assert got.content == data[start:end + 1]
    assert got.headers["content-range"] == f"bytes {start}-{end}/{size}"
    assert int(got.headers["content-length"]) == end - start + 1


@pytest.mark.parametrize("asked", ["bytes=13209-", "bytes=13209-13300", "bytes=99999-", "bytes=5-4", "bytes=-0", "bytes=-", "bytes=a-b",
                                   "bytes=0-5,10-20", "bytes= 0-5", "bytes=0x10-"])
def test_a_range_that_cannot_be_served_is_416(client: TestClient, big: tuple[str, bytes], asked: str) -> None:
    uid, data = big
    # "13209" stands for the size of the file: the first byte past its end.
    got = client.get(f"/api/attachments/{uid}", headers={"Range": asked.replace("13209", str(len(data)))})
    assert got.status_code == 416
    assert got.headers["content-range"] == f"bytes */{len(data)}"


def test_the_range_parser_on_its_own() -> None:
    assert attachments.parse_range(None, 10) is None
    assert attachments.parse_range("bytes=9-9", 10) == (9, 9)
    assert attachments.parse_range("bytes=9-", 10) == (9, 9)
    assert attachments.parse_range("bytes=-10", 10) == (0, 9)
    for bad in ("bytes=10-", "bytes=10-12", "bytes=0-1,2-3", "bytes=", "bytes=--1", "bytes=-0", "bytes=3-2"):
        with pytest.raises(attachments.RangeInvalid):
            attachments.parse_range(bad, 10)
    with pytest.raises(attachments.RangeInvalid):
        attachments.parse_range("bytes=0-0", 0)


def test_a_file_that_changed_is_sent_whole_and_an_unchanged_one_not_again(client: TestClient,
                                                                         big: tuple[str, bytes]) -> None:
    uid, data = big
    first = client.get(f"/api/attachments/{uid}")
    etag = first.headers["etag"]
    assert first.headers["cache-control"] == "private, no-cache"
    assert client.get(f"/api/attachments/{uid}", headers={"If-None-Match": etag}).status_code == 304
    again = client.get(f"/api/attachments/{uid}", headers={"Range": "bytes=0-9", "If-Range": etag})
    assert again.status_code == 206 and again.content == data[:10]
    changed = client.get(f"/api/attachments/{uid}", headers={"Range": "bytes=0-9", "If-Range": '"other"'})
    assert changed.status_code == 200 and changed.content == data


# --- Sizes, bodies, places -------------------------------------------------------------------------------------------


def operator_view(client: TestClient) -> dict[str, Any]:
    answer = client.get("/api/admin/attachments")
    assert answer.status_code == 200, answer.text
    return dict(answer.json())


def work_folders() -> list[Path]:
    return [path for path in MEDIA.iterdir() if path.name.startswith(attachments.WORK_PREFIX)]


def test_a_body_larger_than_the_limit_is_given_up_while_it_comes_and_leaves_nothing(
        client: TestClient, account: Account) -> None:
    assert client.put("/api/admin/attachments", json={"other_max_mb": 1}).status_code == 200
    declared = send(client, b"%PDF-" + b"x" * (1024 * 1024), "pdf")
    assert declared.status_code == 413
    assert declared.json()["detail"] == {"code": "attachment_too_large", "message": "The file is too large.",
                                         "max_mb": 1}
    def chunks() -> Iterator[bytes]:
        # No length said in advance: counted while it comes.
        yield b"%PDF-1.4\n"
        for _ in range(64):
            yield b"y" * 65536

    streamed = client.post("/api/attachments", params={"upload_id": str(uuid.uuid4()), "kind": "pdf",
                                                       "date": DAY}, content=chunks())
    assert streamed.status_code == 413 and streamed.json()["detail"]["code"] == "attachment_too_large"
    assert media_files() == [] and work_folders() == []
    # Just below the limit is taken.
    assert send(client, b"%PDF-" + b"x" * (1024 * 1024 - 10), "pdf").status_code == 201


def test_the_limit_of_videos_is_its_own(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    data = samples.h264_mp4()
    assert client.put("/api/admin/attachments", json={"video_max_mb": 1, "other_max_mb": 1000}).status_code == 200
    big_video = data + b"\x00" * (1024 * 1024)
    refused = send(client, big_video, "video")
    assert refused.status_code == 413 and refused.json()["detail"]["max_mb"] == 1
    assert send(client, samples.pdf(), "pdf").status_code == 201


def test_every_place_is_taken_then_the_next_upload_waits_outside(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(attachments, "_admitted", attachments.UPLOAD_SLOTS)
    refused = send(client, samples.pdf(), "pdf")
    assert refused.status_code == 503 and refused.headers["retry-after"] == "5"
    monkeypatch.setattr(attachments, "_admitted", 0)
    assert send(client, samples.pdf(), "pdf").status_code == 201


def test_the_same_upload_twice_at_once_keeps_one(client: TestClient, account: Account) -> None:
    upload = str(uuid.uuid4())
    data = samples.pdf("einmal")
    answers: list[Any] = []
    start = threading.Barrier(4)

    def one() -> None:
        with new_client(account) as other:
            start.wait()
            answers.append(send(other, data, "pdf", upload_id=upload))

    threads = [threading.Thread(target=one) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    codes = sorted(answer.status_code for answer in answers)
    assert codes.count(201) == 1 and set(codes) <= {200, 201, 503}, codes
    ids = {answer.json()["id"] for answer in answers if answer.status_code in (200, 201)}
    assert len(ids) == 1
    with SessionLocal() as db:
        assert db.query(Attachment).count() == 1
    assert len(media_files()) == 1, "no file of the second one stays"
    # And once more, later: the same answer, 200.
    again = send(client, data, "pdf", upload_id=upload)
    assert again.status_code == 200 and again.json()["id"] in ids


def test_fifty_a_day_and_not_one_more_even_at_once(client: TestClient, account: Account,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import brakes

    monkeypatch.setitem(brakes.LIMITS, "attachment", 1000)
    for index in range(attachments.PER_DAY - 3):
        assert link(client, f"https://example.com/{index}").status_code == 201
    answers: list[int] = []
    start = threading.Barrier(6)

    def one(index: int) -> None:
        with new_client(account) as other:
            start.wait()
            answers.append(link(other, f"https://example.com/late/{index}").status_code)

    threads = [threading.Thread(target=one, args=(index,)) for index in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers) == [201, 201, 201, 422, 422, 422]
    refused = send(client, samples.pdf(), "pdf")
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachments_per_day"
    assert refused.json()["detail"]["max"] == attachments.PER_DAY
    assert media_files() == []
    # Photos do not count, another day has room.
    assert link(client, "https://example.com/next", day="2026-10-21").status_code == 201


def test_the_storage_counts_attachments_with_photos_and_holds_at_once(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    from .test_nothing_in_the_clear import photo_with

    with SessionLocal() as db:
        settings_service.save(db, {"storage_per_person_gb": 0})
    data = samples.pdf("Platz")
    before = client.get("/api/photos/storage").json()["used"]
    first = send(client, data, "pdf").json()
    held = client.get("/api/photos/storage").json()
    assert held["by_kind"]["pdf"] > len(data) and held["attachments"] == 1
    assert held["by_kind"]["video"] == 0 and held["by_kind"]["audio"] == 0 and held["by_kind"]["photos"] == 0
    assert held["used"] >= held["by_kind"]["pdf"]
    assert {"used", "limit", "count"} <= set(held)
    # Room for exactly one more of the same size: of two at once one is taken.
    room = held["used"] + (held["used"] - before) + 10
    # The one place a person has would put the two in a row: here they are meant to meet in the database.
    monkeypatch.setattr(attachments, "admitted", lambda _account: contextlib.nullcontext())
    with SessionLocal() as db:
        settings_service.save(db, {"storage_per_person_gb": room / (1024**3)})
    answers: list[Any] = []
    start = threading.Barrier(2)

    def one() -> None:
        with new_client(account) as other:
            start.wait()
            answers.append(send(other, data, "pdf"))

    threads = [threading.Thread(target=one) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answer.status_code for answer in answers) == [201, 409]
    full = next(answer for answer in answers if answer.status_code == 409)
    assert full.json()["detail"]["code"] == "storage_full"
    # A photo does not fit either now: they share the storage.
    photo = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY}, content=photo_with("x"))
    assert photo.status_code == 409 and photo.json()["detail"]["code"] == "storage_full"
    assert client.delete(f"/api/attachments/{first['id']}").status_code == 204
    assert client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY},
                       content=photo_with("x")).status_code == 201
    assert len([name for name in media_files() if not name.endswith(".p")]) == 2


def test_a_declared_body_that_cannot_fit_the_storage_is_refused_before_it_is_read(
        client: TestClient, account: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"storage_per_person_gb": 1 / 1024})
    refused = send(client, b"%PDF-" + b"z" * (2 * 1024 * 1024), "pdf")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "storage_full"
    assert media_files() == []


# --- Links -----------------------------------------------------------------------------------------------------------


def test_a_link_keeps_its_address_and_title_and_the_host_stands_in_for_a_missing_title(
        client: TestClient, account: Account) -> None:
    made = link(client, "https://tickets.example.com/fest?tag=1#oben", "  Das Fest\n am See ")
    assert made.status_code == 201, made.text
    item = made.json()
    assert item["kind"] == "link" and item["url"] == "https://tickets.example.com/fest?tag=1#oben"
    assert item["name"] == "Das Fest am See" and item["size"] == 0 and item["seconds"] is None
    plain = link(client, "http://example.com/x").json()
    assert plain["name"] == "example.com"
    assert link(client, "https://example.com/y", "").json()["name"] == "example.com"
    assert client.get(f"/api/attachments/{item['id']}").status_code == 404, "a link has no file"
    assert client.get(f"/api/attachments/{item['id']}/preview").status_code == 404
    assert media_files() == []


@pytest.mark.parametrize("url", [
    "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi", "https://user:secret@example.com/",
    "https://user@example.com/", "https://example.com/a b", "https://example.com/\tx", " https://example.com/",
    "https:///nohost", "example.com", "", "https://example.com:99999/", "https://example.com/" + "a" * 2030,
    "file:///etc/passwd", "https://exa\u0000mple.com/",
])
def test_a_link_that_is_no_web_address_is_refused(client: TestClient, account: Account, url: str) -> None:
    refused = link(client, url)
    assert refused.status_code == 422, url
    assert refused.json()["detail"]["code"] == "invalid_input" and refused.json()["detail"]["fields"] == ["url"]


def test_the_longest_address_and_title_are_taken_and_one_more_is_not(client: TestClient, account: Account) -> None:
    base = "https://example.com/"
    assert link(client, base + "a" * (2048 - len(base))).status_code == 201
    assert link(client, base + "a" * (2049 - len(base))).status_code == 422
    assert link(client, base, "t" * 200).status_code == 201
    long_title = link(client, base, "t" * 201)
    assert long_title.status_code == 422 and long_title.json()["detail"]["fields"] == ["title"]


def test_a_name_loses_line_breaks_control_characters_and_paths_and_is_cut_at_120(
        client: TestClient, account: Account) -> None:
    named = send(client, samples.pdf(), "pdf", name="../../etc/Prog\u0000ramm\r\n" + "x" * 300).json()
    assert named["name"] == "Programm " + "x" * 111 and len(named["name"]) == 120
    assert send(client, samples.pdf(), "pdf", name="").json()["name"] == "PDF"
    got = client.get(f"/api/attachments/{named['id']}", params={"download": 1})
    assert got.headers["content-disposition"].startswith("attachment; filename*=UTF-8''Programm%20xxx")
    assert got.headers["content-disposition"].endswith(".pdf")


# --- Days, lists, storage --------------------------------------------------------------------------------------------


def test_the_day_today_and_the_lists_carry_the_attachments_oldest_first(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime

    moments = iter(datetime(2026, 10, 22, 9, minute, tzinfo=UTC) for minute in range(60))
    monkeypatch.setattr(clock, "now", lambda: next(moments))
    first = link(client, "https://example.com/1", "eins", day=None).json()
    second = send(client, samples.pdf(), "pdf", day=None).json()
    assert first["date"] == second["date"] == "2026-10-22", "without a date: the day of the notes"
    listed = client.get("/api/attachments", params={"date": "2026-10-22"}).json()["attachments"]
    assert [item["id"] for item in listed] == [first["id"], second["id"]]
    today = client.get("/api/today").json()
    assert [item["id"] for item in today["attachments"]] == [first["id"], second["id"]]
    assert client.put("/api/days/2026-10-22", json={"title": "Heute", "text": "Text."}).status_code == 200
    day = client.get("/api/days/2026-10-22").json()
    assert [item["id"] for item in day["attachments"]] == [first["id"], second["id"]]
    library = client.get("/api/attachments/library").json()
    assert [item["id"] for item in library["attachments"]] == [second["id"], first["id"]]
    assert library["next"] is None
    only_links = client.get("/api/attachments/library", params={"kind": "link"}).json()["attachments"]
    assert [item["id"] for item in only_links] == [first["id"]]
    by_size = client.get("/api/attachments/library", params={"order": "size"}).json()["attachments"]
    assert by_size[0]["id"] == second["id"]
    page = client.get("/api/attachments/library", params={"limit": 1}).json()
    assert len(page["attachments"]) == 1 and page["next"]
    rest = client.get("/api/attachments/library", params={"limit": 1, "before": page["next"]}).json()
    assert [item["id"] for item in rest["attachments"]] == [first["id"]] and rest["next"] is None
    sized = client.get("/api/attachments/library", params={"limit": 1, "order": "size"}).json()
    after = client.get("/api/attachments/library", params={"limit": 1, "order": "size",
                                                           "before": sized["next"]}).json()
    assert [item["id"] for item in after["attachments"]] == [first["id"]]
    assert client.get("/api/attachments/library", params={"before": "nonsense"}).status_code == 422
    assert client.get("/api/attachments/library", params={"before": sized["next"]}).status_code == 422
    # Deleting the page leaves the attachments.
    assert client.delete("/api/days/2026-10-22").status_code == 204
    assert len(client.get("/api/attachments", params={"date": "2026-10-22"}).json()["attachments"]) == 2


def test_deleting_takes_the_row_and_its_files(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    item = send(client, samples.h264_mp4(), "video").json()
    assert len(media_files()) == 2, "the file and the still"
    assert client.delete(f"/api/attachments/{item['id']}").status_code == 204
    assert media_files() == []
    assert client.get(f"/api/attachments/{item['id']}").status_code == 404
    assert client.delete(f"/api/attachments/{item['id']}").status_code == 404


def test_the_search_finds_the_name_and_points_to_the_day(client: TestClient, account: Account) -> None:
    word = "Waldbuehne" + uuid.uuid4().hex[:4]
    link(client, "https://example.com/k", f"Karten {word}")
    send(client, samples.pdf(), "pdf", name=f"Programm {word}.pdf", day="2026-10-19")
    found = client.post("/api/search", json={"q": word.lower()}).json()["results"]
    assert [(hit["date"], hit["kind"]) for hit in found] == [(DAY, "attachment"), ("2026-10-19", "attachment")]
    assert found[0]["snippet"] == f"Karten {word}"


# --- The lock --------------------------------------------------------------------------------------------------------


def test_a_locked_day_takes_no_attachment_and_gives_none_away_on_any_way(client: TestClient, account: Account) -> None:
    kept = link(client, "https://example.com/bleibt").json()
    pdf = send(client, samples.pdf(), "pdf").json()
    lock(client)
    for answer in (send(client, samples.pdf(), "pdf"), link(client, "https://example.com/neu"),
                   client.delete(f"/api/attachments/{kept['id']}"), client.delete(f"/api/attachments/{pdf['id']}")):
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "day_locked", answer.text
    listed = client.get("/api/attachments", params={"date": DAY}).json()["attachments"]
    assert [item["id"] for item in listed] == [kept["id"], pdf["id"]]
    assert client.get(f"/api/attachments/{pdf['id']}").status_code == 200
    # Whatever code asks, the database says no too.
    me = client.get("/api/auth/me").json()["id"]
    insert = ("INSERT INTO attachments (uid, user_id, date, kind, status, size, preview_size, meta_enc, created_at) "
              "VALUES (:uid, :user, :day, 'link', 'ready', 0, 0, x'00', '2026-10-22 10:00:00')")
    other = link(client, "https://example.com/anders", day="2026-10-19").json()
    with SessionLocal() as db:
        for statement, values in (("DELETE FROM attachments WHERE date = :day", {"day": DAY}),
                                  ("UPDATE attachments SET date = '2026-10-19' WHERE date = :day", {"day": DAY}),
                                  (insert, {"uid": "0" * 32, "user": me, "day": DAY}),
                                  # Moving one in from another day is refused as well.
                                  ("UPDATE attachments SET date = :day WHERE uid = :uid",
                                   {"day": DAY, "uid": other["id"]})):
            with pytest.raises(Exception, match="day is locked"):
                db.execute(text(statement), values)
            db.rollback()


def test_a_locked_day_checked_before_the_body_is_read(client: TestClient, account: Account,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    lock(client)
    read: list[int] = []
    real = attachments.receive

    async def counted(*args: Any, **kwargs: Any) -> int:
        read.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(attachments, "receive", counted)

    def chunks() -> Iterator[bytes]:
        for _ in range(8):
            yield b"%PDF-" + b"x" * 1000

    answer = client.post("/api/attachments", params={"upload_id": str(uuid.uuid4()), "kind": "pdf", "date": DAY},
                         content=chunks())
    assert answer.status_code == 409
    assert read == [], "refused before a byte of the body was read"
    assert media_files() == []


# --- Who gets what ---------------------------------------------------------------------------------------------------


def routes_of(uid: str) -> list[tuple[str, str]]:
    return [("GET", f"/api/attachments/{uid}"), ("GET", f"/api/attachments/{uid}/preview"),
            ("DELETE", f"/api/attachments/{uid}"), ("POST", f"/api/attachments/{uid}/convert")]


def test_an_attachment_of_somebody_else_is_not_found_on_any_way(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    mine = send(client, samples.hevc_mp4(), "video").json()
    owner = client.get("/api/auth/me").json()["id"]
    with new_client(make_member("tom")) as tom:
        for method, path in routes_of(mine["id"]):
            answer = tom.request(method, path)
            assert answer.status_code == 404 and answer.json()["detail"]["code"] == "not_found", (method, path)
        assert tom.get("/api/attachments", params={"date": DAY}).json() == {"attachments": []}
        assert tom.get("/api/attachments/library").json()["attachments"] == []
        assert tom.get(f"/api/shared/{owner}/{DAY}/attachments/{mine['id']}").status_code == 404
        assert tom.get(f"/api/shared/{owner}/{DAY}/attachments/{mine['id']}/preview").status_code == 404
    assert client.get(f"/api/attachments/{mine['id']}").status_code == 200
    for path in ("/api/attachments/" + "z" * 32, "/api/attachments/../x", "/api/attachments/" + "a" * 31):
        assert client.get(path).status_code == 404


def make_member(name: str) -> Account:
    from .conftest import make_account

    return make_account(name)


def test_without_a_session_nothing(client: TestClient, account: Account) -> None:
    item = link(client, "https://example.com/x").json()
    with TestClient(client.app, headers={"X-Nexdiary-Client": "tab-tests000"}) as stranger:
        assert stranger.get(f"/api/attachments/{item['id']}").status_code == 401
        assert stranger.get("/api/attachments", params={"date": DAY}).status_code == 401
        assert stranger.post("/api/attachments/link", json={"url": "https://example.com", "upload_id":
                                                            str(uuid.uuid4())}).status_code == 401


def test_a_shared_day_shows_its_attachments_read_only_and_a_share_taken_back_shows_nothing(
        client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    video = send(client, samples.hevc_mp4(), "video").json()
    shared_pdf = samples.pdf("geteilt")
    pdf = send(client, shared_pdf, "pdf").json()
    other_day = send(client, samples.pdf("anders"), "pdf", day="2026-10-19").json()
    assert client.put(f"/api/days/{DAY}", json={"title": "Geteilt", "text": "Ein Tag."}).status_code == 200
    assert client.put("/api/days/2026-10-19", json={"title": "Nicht", "text": "Für mich."}).status_code == 200
    rike = make_member("rike")
    owner = client.get("/api/auth/me").json()["id"]
    with new_client(rike) as reader:
        assert reader.get(f"/api/shared/{owner}/{DAY}").status_code == 404
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{pdf['id']}").status_code == 404
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [rike.id], "with_values": False,
                                                          "with_notes": False}).status_code == 200
        shared = reader.get(f"/api/shared/{owner}/{DAY}").json()
        assert [item["id"] for item in shared["attachments"]] == [video["id"], pdf["id"]]
        assert all(item["can_convert"] is False for item in shared["attachments"])
        got = reader.get(f"/api/shared/{owner}/{DAY}/attachments/{pdf['id']}")
        assert got.status_code == 200 and got.content == shared_pdf
        assert got.headers["cache-control"] == "private, no-store"
        assert got.headers["content-disposition"].startswith("attachment;")
        part = reader.get(f"/api/shared/{owner}/{DAY}/attachments/{video['id']}", headers={"Range": "bytes=0-99"})
        assert part.status_code == 206 and len(part.content) == 100
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{video['id']}/preview").status_code == 200
        # Read only: none of the owner's own routes open for the reader.
        for method, path in routes_of(pdf["id"]):
            assert reader.request(method, path).status_code == 404, (method, path)
        # An attachment of another day of the owner does not come through this share.
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{other_day['id']}").status_code == 404
        assert reader.get(f"/api/shared/{owner}/2026-10-19/attachments/{other_day['id']}").status_code == 404
        # Taken back: nothing.
        assert client.delete(f"/api/days/{DAY}/shares").status_code == 204
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{pdf['id']}").status_code == 404
        assert reader.get(f"/api/shared/{owner}/{DAY}/attachments/{video['id']}/preview").status_code == 404


# --- The operator ----------------------------------------------------------------------------------------------------


def test_everybody_signed_in_learns_the_limits_and_whether_ffmpeg_is_there(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.put("/api/admin/attachments", json={"video_max_mb": 800, "other_max_mb": 50}).status_code == 200
    with new_client(make_member("tom")) as tom:
        seen = tom.get("/api/attachments/limits")
        assert seen.status_code == 200
        assert seen.json() == {"video_max_mb": 800, "other_max_mb": 50, "ffmpeg": media_tools.available()}
        monkeypatch.setattr(media_tools, "available", lambda: False)
        assert tom.get("/api/attachments/limits").json()["ffmpeg"] is False
    with TestClient(client.app, headers={"X-Nexdiary-Client": "tab-tests000"}) as stranger:
        assert stranger.get("/api/attachments/limits").status_code == 401


def test_the_operator_sets_the_limits_and_the_switch_and_nobody_else(client: TestClient, account: Account) -> None:
    seen = operator_view(client)
    assert seen["video_max_mb"] == 500 and seen["other_max_mb"] == 100 and seen["convert"] is True
    assert seen["queue"] == {"waiting": 0, "running": None, "last": None}
    assert isinstance(seen["ffmpeg"], bool)
    changed = client.put("/api/admin/attachments", json={"video_max_mb": 4000, "convert": False}).json()
    assert changed["video_max_mb"] == 4000 and changed["other_max_mb"] == 100 and changed["convert"] is False
    for wrong in ({"video_max_mb": 0}, {"video_max_mb": 4001}, {"other_max_mb": 1001}, {"convert": "ja"},
                  {"something": 1}):
        assert client.put("/api/admin/attachments", json=wrong).status_code == 422, wrong
    with new_client(make_member("tom")) as tom:
        assert tom.get("/api/admin/attachments").status_code == 403
        assert tom.put("/api/admin/attachments", json={"convert": True}).status_code == 403
    assert operator_view(client)["convert"] is False


def test_the_policy_lets_media_and_the_pdf_worker_play_and_the_microphone_record(client: TestClient) -> None:
    headers = client.get("/api/health").headers
    assert "media-src 'self' blob:" in headers["content-security-policy"]
    assert "worker-src 'self'" in headers["content-security-policy"]
    assert "microphone=(self)" in headers["permissions-policy"]


# --- The AI and the book ----------------------------------------------------------------------------------------------


def test_the_ai_never_gets_an_attachment(client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    from app.services import ai

    from .test_ai import HOME_IP, LOCAL, Model, set_up

    stand_in = Model()
    monkeypatch.setattr(ai, "transport", httpx.MockTransport(stand_in.handle))
    monkeypatch.setattr(ai, "resolver", lambda host, port: [HOME_IP])
    word = "Anhangwort" + uuid.uuid4().hex[:4]
    assert client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "eine Notiz", "date": DAY}
                       ).status_code == 201
    assert link(client, f"https://example.com/{word}", f"Titel {word}").status_code == 201
    assert send(client, samples.pdf(word), "pdf", name=f"Datei {word}.pdf").status_code == 201
    set_up(client, "local", LOCAL)
    assert client.post("/api/ai/formulate", json={"date": DAY, "length": "short"}).status_code == 200
    # Asking first: whatever the stand-in answers, what went out is what counts.
    client.post("/api/ai/followups", json={"date": DAY})
    asked = [request for request in stand_in.requests if not request.url.path.endswith("/models")]
    assert len(asked) == 2
    for request in asked:
        body = request.content.decode("utf-8")
        assert "eine Notiz" in body, "the notes went"
        assert word not in body and "example.com" not in body and "Datei" not in body


def test_the_book_lists_the_attachments_at_the_end_of_the_day_without_their_contents() -> None:
    from app.services import book

    book._fonts()
    styles = book.Styles(1.0)
    layout = book.layout_of("a5")
    words = book.TEXTS["de"]
    options = book.Options(year=2026, format="a5", photos=False, values=False, notes=False, language="de")
    from datetime import date

    flowables = book._day(None, date(2026, 10, 20), {"title": "T", "text": "Text.", "values": {}}, options,  # type: ignore[arg-type]
                          words, styles, layout, {}, [], lambda *_: None,  # type: ignore[arg-type, return-value]
                          [{"kind": "link", "name": "Karten", "url": "https://example.com/k"},
                           {"kind": "pdf", "name": "Programm.pdf", "url": ""},
                           {"kind": "audio", "name": "Ruf <b>", "url": ""}])
    texts = [getattr(item, "text", "") for item in flowables]
    assert texts[-4:] == ["Anhänge", "Link · Karten · https://example.com/k", "PDF · Programm.pdf",
                          "Ton · Ruf &lt;b&gt;"]


def test_nothing_of_an_attachment_but_its_sealed_bytes_lies_in_the_media_folder(
        client: TestClient, account: Account) -> None:
    word = "Klartext" + uuid.uuid4().hex[:6]
    data = samples.pdf(word)
    item = send(client, data, "pdf", name=f"Name {word}").json()
    stored = (MEDIA / next(name for name in media_files())).read_bytes()
    assert word.encode() not in stored and b"%PDF" not in stored
    assert stored.startswith(sealed_file.MAGIC)
    assert client.get(f"/api/attachments/{item['id']}").content == data
    with SessionLocal() as db:
        row = db.query(Attachment).one()
        assert word.encode() not in row.meta_enc and row.file_id != row.uid


def test_a_file_of_one_attachment_put_in_place_of_another_does_not_open(client: TestClient, account: Account) -> None:
    first = send(client, samples.pdf("erste"), "pdf").json()
    second = send(client, samples.pdf("zweite"), "pdf").json()
    with SessionLocal() as db:
        rows = {row.uid: row.file_id for row in db.query(Attachment)}
    a, b = MEDIA / rows[first["id"]], MEDIA / rows[second["id"]]
    a_bytes = a.read_bytes()
    a.write_bytes(b.read_bytes())
    b.write_bytes(a_bytes)
    assert client.get(f"/api/attachments/{first['id']}").status_code == 404
    assert client.get(f"/api/attachments/{second['id']}").status_code == 404


def test_ffmpeg_is_called_without_a_shell_with_only_files_and_a_named_demuxer(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    video = samples.h264_mp4()
    seen: list[dict[str, Any]] = []
    timed: list[Any] = []
    real_run, real_popen = subprocess.run, subprocess.Popen

    def watched_run(arguments: Any, *args: Any, **kwargs: Any) -> Any:
        timed.append(kwargs.get("timeout"))
        return real_run(arguments, *args, **kwargs)

    tools = {media_tools.ffmpeg_path(), media_tools.ffprobe_path()}

    def watched(arguments: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(arguments, list) and arguments and arguments[0] in tools:
            seen.append({"arguments": list(arguments), "shell": kwargs.get("shell", False),
                         "stdin": kwargs.get("stdin")})
        return real_popen(arguments, *args, **kwargs)

    # Every way a program is started goes through Popen; ``run`` must bring a time limit.
    monkeypatch.setattr(media_tools.subprocess, "run", watched_run)
    monkeypatch.setattr(media_tools.subprocess, "Popen", watched)
    assert send(client, video, "video", name="Mein Name; rm -rf").status_code == 201
    assert len(seen) >= 4 and timed and all(timed)
    for call in seen:
        arguments = call["arguments"]
        assert call["shell"] is False and call["stdin"] == subprocess.DEVNULL
        # ffmpeg reads nothing from a terminal; ffprobe never does (its stdin is closed too).
        assert "-nostdin" in arguments or "ffprobe" in Path(arguments[0]).name
        assert arguments[arguments.index("-protocol_whitelist") + 1] == "file"
        assert arguments[arguments.index("-f") + 1] in media_tools.DEMUXERS
        assert not any("Mein Name" in part for part in arguments), "no name of the person goes to ffmpeg"
        for part in arguments:
            if part.startswith("file:"):
                assert Path(part[5:]).resolve().is_relative_to(MEDIA.resolve())
                assert Path(part[5:]).parent.name.startswith(attachments.WORK_PREFIX)
