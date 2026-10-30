"""What the review of the attachments found, held by tests: a stalled upload gives its place up, one person holds one
place, ffprobe may not say more than a megabyte, HDR becomes proper SDR, leftovers go at the start, a backup never
holds a row without its file, the queue is shared fairly, ranges as RFC 9110 has them, and nothing of somebody else
leaks through the library or a race with the lock."""

from __future__ import annotations

import asyncio
import threading
import zipfile
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import clock
from app.db import SessionLocal
from app.models import Account, Attachment
from app.services import attachments, backups, conversions, media_sweep, media_tools, photos

from . import media_samples as samples
from .conftest import MEDIA, make_account, new_client
from .test_attachments import DAY, link, media_files, probe_bytes, send, work_folders


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 22, 10, 0, tzinfo=UTC))
    conversions.forget()


# --- M1: stalled bodies, one place a person -------------------------------------------------------------------------


def test_a_body_that_stops_coming_is_given_up(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No wall clock: a gap of no time at all, and a body whose second piece never comes."""
    monkeypatch.setattr(attachments, "BODY_GAP_SECONDS", 0)
    never = asyncio.Event()

    async def stalling() -> AsyncIterator[bytes]:
        yield b"%PDF-1.4\n"
        await never.wait()
        yield b"never"

    async def run() -> None:
        # The outer limit only guards the test itself against a receive that would wait for ever.
        await asyncio.wait_for(attachments.receive(stalling(), tmp_path / "in", 10_000), 10)

    with pytest.raises(attachments.Stalled):
        asyncio.run(run())


def test_a_body_that_keeps_coming_is_taken(tmp_path: Path) -> None:
    async def steady() -> AsyncIterator[bytes]:
        for _ in range(5):
            yield b"x" * 100

    assert asyncio.run(attachments.receive(steady(), tmp_path / "in", 10_000)) == 500


def test_a_stalled_upload_answers_408_and_frees_its_place(client: TestClient, account: Account,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    async def stalls(pieces: Any, seconds: float) -> bytes | None:
        raise attachments.Stalled

    monkeypatch.setattr(attachments, "next_piece", stalls)
    answer = send(client, samples.pdf(), "pdf")
    assert answer.status_code == 408 and answer.json()["detail"]["code"] == "upload_stalled"
    assert attachments._admitted == 0 and attachments._uploading == set()
    assert media_files() == [] and work_folders() == []
    monkeypatch.undo()
    assert send(client, samples.pdf(), "pdf").status_code == 201


def test_one_person_holds_one_place_and_leaves_the_others_for_everybody_else(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    me = client.get("/api/auth/me").json()["id"]
    monkeypatch.setattr(attachments, "_uploading", {me})
    monkeypatch.setattr(attachments, "_admitted", 1)
    refused = send(client, samples.pdf(), "pdf")
    assert refused.status_code == 503 and refused.headers["retry-after"] == "5"
    with new_client(make_account("tom")) as tom:
        assert send(tom, samples.pdf(), "pdf").status_code == 201
    assert attachments._uploading == {me} and attachments._admitted == 1


# --- M2: what ffprobe says -------------------------------------------------------------------------------------------


def test_a_file_whose_tags_would_make_ffprobe_say_megabytes_is_refused_early(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    data = samples.huge_title(2)
    read: list[int] = []
    real = media_tools.run_bounded

    def counted(arguments: list[str], seconds: float, most: int) -> bytes:
        try:
            out = real(arguments, seconds, most)
        except media_tools.ToolFailed:
            read.append(-1)
            raise
        read.append(len(out))
        return out

    monkeypatch.setattr(media_tools, "run_bounded", counted)
    refused = send(client, data, "video")
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "attachment_not_supported"
    assert read and read[0] == -1, "stopped while it was still speaking"
    assert media_files() == [] and work_folders() == []


def test_the_output_of_ffprobe_is_cut_off_past_the_limit(tmp_path: Path) -> None:
    """The reading itself, with a stand-in that prints without end."""
    import sys

    talker = [sys.executable, "-c", "import sys\nwhile True:\n    sys.stdout.write('x' * 65536)"]
    with pytest.raises(media_tools.ToolFailed, match="said too much"):
        media_tools.run_bounded(talker, 30, 1024 * 1024)
    assert media_tools.run_bounded([sys.executable, "-c", "print('ok')"], 30, 1024).strip() == b"ok"


# --- M4: HDR ---------------------------------------------------------------------------------------------------------


def test_an_hdr_video_becomes_sdr_bt709_in_8_bit(client: TestClient, account: Account) -> None:
    data = samples.hlg_hevc()
    source = probe_bytes(data, "mov")
    assert source.video is not None and source.video.hdr and source.video.pixels == "yuv420p10le"
    if not media_tools.can_tonemap():
        pytest.skip("this ffmpeg has no zscale")
    item = send(client, data, "video").json()
    assert item["codec"] == "hevc"
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    done = client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]
    assert done["status"] == "ready" and done["codec"] == "h264"
    result = probe_bytes(client.get(f"/api/attachments/{item['id']}").content, "mov")
    assert result.video is not None
    assert (result.video.transfer, result.video.primaries, result.video.matrix, result.video.pixels) == (
        "bt709", "bt709", "bt709", "yuv420p")
    assert not result.video.hdr


def test_an_sdr_video_is_not_tone_mapped(client: TestClient, account: Account,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []
    real = media_tools.convert_command

    def watched(*args: Any, **kwargs: Any) -> list[str]:
        command = real(*args, **kwargs)
        seen.append(command)
        return command

    monkeypatch.setattr(media_tools, "convert_command", watched)
    item = send(client, samples.hevc_mp4(), "video").json()
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    picture = seen[0][seen[0].index("-vf") + 1]
    assert "zscale" not in picture and "tonemap" not in picture and "-color_trc" not in seen[0]


def test_without_the_filters_for_it_an_hdr_video_fails_honestly(client: TestClient, account: Account,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    samples.need_ffmpeg()
    monkeypatch.setattr(media_tools, "can_tonemap", lambda: False)
    item = send(client, samples.hlg_hevc(), "video").json()
    before = client.get(f"/api/attachments/{item['id']}").content
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    failed = client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]
    assert failed["status"] == "failed" and failed["codec"] == "hevc"
    assert client.get(f"/api/attachments/{item['id']}").content == before


# --- N1: leftovers at the start --------------------------------------------------------------------------------------


def test_at_the_start_work_folders_and_temporary_files_go_whatever_their_age(client: TestClient,
                                                                             account: Account) -> None:
    import secrets
    import time

    kept = link(client, "https://example.com/x").json()
    young_work = MEDIA / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
    young_work.mkdir()
    (young_work / "in").write_bytes(b"a video in the clear")
    young_part = MEDIA / f".{secrets.token_hex(16)}.1-2.part"
    young_part.write_bytes(b"half a file")
    young_orphan = MEDIA / secrets.token_hex(16)
    young_orphan.write_bytes(b"maybe still waiting for its row")
    now = time.time()
    assert media_sweep.sweep(now) == 0, "while running: they wait their hour"
    assert media_sweep.sweep(now, at_start=True) == 2
    assert not young_work.exists() and not young_part.exists()
    assert young_orphan.exists(), "a media file without a row still waits its hour"
    assert client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]["id"] == kept["id"]
    # Something that writes right now is never taken, not even at the start.
    with photos.writing():
        busy = MEDIA / f"{attachments.WORK_PREFIX}{secrets.token_hex(16)}"
        busy.mkdir()
        (busy / "in").write_bytes(b"x")
        assert media_sweep.sweep(time.time() + 5, at_start=True) == 0
        assert busy.exists()


# --- N2: a backup never holds a row without its file -----------------------------------------------------------------


def test_a_file_deleted_while_a_backup_runs_is_still_in_it(client: TestClient, account: Account,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    data = samples.pdf("mitten")
    item = send(client, data, "pdf").json()
    with SessionLocal() as db:
        file_id = db.query(Attachment).filter_by(uid=item["id"]).one().file_id
    real_copy = backups._database_copy
    during: list[list[str]] = []

    def copy_then_delete(target: Path) -> int:
        accounts = real_copy(target)
        # Right after the copy of the database, before the media files: the attachment goes.
        with new_client(account) as other:
            assert other.delete(f"/api/attachments/{item['id']}").status_code == 204
        during.append(media_files())
        return accounts

    monkeypatch.setattr(backups, "_database_copy", copy_then_delete)
    made = backups.create(kind=backups.MANUAL)
    assert during == [[file_id]], "kept on disk while the backup ran"
    with zipfile.ZipFile(made) as unpacked:
        assert backups.MEDIA_PREFIX + file_id in unpacked.namelist()
    assert media_files() == [], "and gone once it was done"


# --- N3: the queue is shared ------------------------------------------------------------------------------------------


def test_one_person_has_at_most_three_conversions_waiting(client: TestClient, account: Account) -> None:
    samples.need_ffmpeg()
    videos = [send(client, samples.hevc_mp4(), "video", day=f"2026-10-{day:02d}").json() for day in (10, 11, 12, 13)]
    for item in videos[:3]:
        assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    refused = client.post(f"/api/attachments/{videos[3]['id']}/convert")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "attachment_cannot_convert"
    # Somebody else still gets a place in the queue.
    with new_client(make_account("tom")) as tom:
        theirs = send(tom, samples.hevc_mp4(), "video").json()
        assert tom.post(f"/api/attachments/{theirs['id']}/convert").status_code == 202


def test_no_conversion_may_take_longer_than_six_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess
    import sys

    asked: list[float] = []

    def quick(command: list[str], seconds: float, *_args: Any) -> subprocess.Popen[bytes]:
        asked.append(seconds)
        return subprocess.Popen([sys.executable, "-c", "print('progress=end')"], stdout=subprocess.PIPE,
                                stdin=subprocess.DEVNULL)

    monkeypatch.setattr(media_tools, "start", quick)
    conversions._encode(["x"], 4 * 3600, 1000, threading.Event())
    conversions._encode(["x"], 10, 1000, threading.Event())
    assert asked == [6 * 3600, 600]


# --- N7: ranges --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("asked", ["", "   ", "items=0-5", "lines=1-2", "bytes"])
def test_an_empty_range_or_another_unit_is_ignored_and_the_whole_file_comes(client: TestClient, account: Account,
                                                                             asked: str) -> None:
    data = samples.pdf("ganz")
    item = send(client, data, "pdf").json()
    got = client.get(f"/api/attachments/{item['id']}", headers={"Range": asked})
    assert got.status_code == 200 and got.content == data
    assert attachments.parse_range(asked, 10) is None


def test_the_unit_of_a_range_is_read_in_any_case(client: TestClient, account: Account) -> None:
    data = samples.pdf("gross")
    item = send(client, data, "pdf").json()
    for asked in ("Bytes=0-4", "BYTES=0-4"):
        got = client.get(f"/api/attachments/{item['id']}", headers={"Range": asked})
        assert got.status_code == 206 and got.content == data[:5]


# --- Gaps the mutations found -----------------------------------------------------------------------------------------


def test_the_library_pages_through_the_own_attachments_only(client: TestClient, account: Account) -> None:
    mine = [link(client, f"https://example.com/mine/{index}").json()["id"] for index in range(3)]
    with new_client(make_account("tom")) as tom:
        theirs = [link(tom, f"https://example.com/theirs/{index}").json()["id"] for index in range(3)]
        seen: list[str] = []
        cursors: list[str] = []
        for order in ("new", "size"):
            following: str | None = ""
            while following is not None:
                params: dict[str, Any] = {"limit": 2, "order": order}
                if following:
                    params["before"] = following
                page = tom.get("/api/attachments/library", params=params).json()
                seen += [item["id"] for item in page["attachments"]]
                following = page["next"]
                if following:
                    cursors.append(following)
        assert set(seen) == set(theirs) and len(seen) == 6
        assert not any(uid in cursor for cursor in cursors for uid in mine), "no cursor out of somebody else's rows"
    assert {item["id"] for item in client.get("/api/attachments/library").json()["attachments"]} == set(mine)


def test_a_day_locked_between_the_check_and_the_request_takes_no_conversion(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    item = send(client, samples.hevc_mp4(), "video").json()
    me = client.get("/api/auth/me").json()["id"]
    real = attachments.one

    def then_locked(db: Any, account_id: int, dek: bytes, uid: str) -> dict[str, Any]:
        found = real(db, account_id, dek, uid)
        with SessionLocal() as other:
            other.execute(text("INSERT INTO days (user_id, date, content_enc, revision, created_at, updated_at, "
                               "locked_at) VALUES (:user, :day, x'00', 0, '2026-10-22 10:00:00', '2026-10-22 10:00:00', "
                               "'2026-10-22 10:00:00')"), {"user": me, "day": DAY})
            other.commit()
        return found

    monkeypatch.setattr(attachments, "one", then_locked)
    refused = client.post(f"/api/attachments/{item['id']}/convert")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "attachment_cannot_convert"
    with SessionLocal() as db:
        assert db.query(Attachment).filter_by(uid=item["id"]).one().status == "ready"
