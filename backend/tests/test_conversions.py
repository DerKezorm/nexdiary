"""Turning a video in HEVC into H.264 (``services/conversions.py``): on request only, one at a time, taken up again
after a restart, stopped when the attachment goes, and whatever goes wrong the original stays."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.db import SessionLocal
from app.models import Account, Attachment
from app.services import conversions, media_tools, settings_service

from . import media_samples as samples
from .conftest import MEDIA, new_client
from .test_attachments import DAY, lock, media_files, probe_bytes, send, work_folders


@pytest.fixture(autouse=True)
def ready(monkeypatch: pytest.MonkeyPatch) -> None:
    samples.need_ffmpeg()
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 22, 10, 0, tzinfo=UTC))
    conversions.forget()


def hevc(client: TestClient, seconds: float = 2) -> dict[str, Any]:
    answer = send(client, samples.hevc_mp4(seconds), "video")
    assert answer.status_code == 201, answer.text
    item = answer.json()
    assert item["codec"] == "hevc" and item["playable"] is False and item["can_convert"] is True
    return dict(item)


def row_of(uid: str) -> Any:
    with SessionLocal() as db:
        return db.query(Attachment).filter_by(uid=uid).one_or_none()


def test_a_video_in_hevc_becomes_h264_and_keeps_its_still(client: TestClient, account: Account) -> None:
    item = hevc(client)
    still = client.get(f"/api/attachments/{item['id']}/preview").content
    before = row_of(item["id"]).file_id
    asked = client.post(f"/api/attachments/{item['id']}/convert")
    assert asked.status_code == 202, asked.text
    assert asked.json()["status"] == "queued" and asked.json()["can_convert"] is False
    again = client.post(f"/api/attachments/{item['id']}/convert")
    assert again.status_code == 409 and again.json()["detail"]["code"] == "attachment_cannot_convert"
    assert client.get("/api/admin/attachments").json()["queue"]["waiting"] == 1
    assert conversions.run_pending() == 1
    done = client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]
    assert done["status"] == "ready" and done["codec"] == "h264" and done["playable"] is True
    assert done["can_convert"] is False and done["has_preview"] is True and done["progress"] is None
    assert done["width"] == 160 and done["height"] == 120 and 1.5 < done["seconds"] < 2.5
    after = row_of(item["id"])
    assert after.file_id != before and after.status == "ready" and after.queued_at is None
    assert sorted(media_files()) == sorted([after.file_id, item["id"] + ".p"]), "the old file is gone"
    assert work_folders() == []
    got = client.get(f"/api/attachments/{item['id']}")
    assert got.status_code == 200 and int(got.headers["content-length"]) == done["size"]
    probe = probe_bytes(got.content, "mov")
    assert probe.video is not None and probe.video.codec == "h264" and probe.audio is not None
    assert probe.audio.codec == "aac" and not probe.places
    assert client.get(f"/api/attachments/{item['id']}/preview").content == still
    queue = client.get("/api/admin/attachments").json()["queue"]
    assert queue["waiting"] == 0 and queue["running"] is None
    assert queue["last"]["seconds_video"] > 1 and queue["last"]["seconds_took"] >= 0
    held = client.get("/api/photos/storage").json()
    assert held["by_kind"]["video"] == after.size + after.preview_size


def test_only_a_video_in_hevc_may_be_converted(client: TestClient, account: Account) -> None:
    h264 = send(client, samples.h264_mp4(), "video").json()
    pdf = send(client, samples.pdf(), "pdf").json()
    sound = send(client, samples.m4a(), "audio").json()
    for item in (h264, pdf, sound):
        assert item["can_convert"] is False
        answer = client.post(f"/api/attachments/{item['id']}/convert")
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "attachment_cannot_convert"


def test_after_a_restart_the_conversion_that_ran_is_taken_up_again(client: TestClient, account: Account) -> None:
    item = hevc(client)
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    # The process died while it ran: the row says converting, nothing runs.
    with SessionLocal() as db:
        db.query(Attachment).filter_by(uid=item["id"]).update({"status": "converting"})
        db.commit()
    assert conversions.run_pending() == 0, "nothing waits while it seems to run"
    # A new start (the lifespan of the app) puts it back in the queue.
    with TestClient(client.app):
        pass
    assert row_of(item["id"]).status == "queued"
    assert conversions.run_pending() == 1
    assert row_of(item["id"]).status == "ready"


def slow(monkeypatch: pytest.MonkeyPatch) -> None:
    """ffmpeg reads its input as fast as the video plays: a conversion that is still running a moment later."""
    real = media_tools.convert_command

    def at_play_speed(*args: Any, **kwargs: Any) -> list[str]:
        command = real(*args, **kwargs)
        place = command.index("-protocol_whitelist")
        return [*command[:place], "-re", *command[place:]]

    monkeypatch.setattr(media_tools, "convert_command", at_play_speed)


def wait_for(condition: Any, seconds: float = 20) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "waited too long"
        time.sleep(0.05)


def test_deleting_the_attachment_stops_its_conversion_and_leaves_nothing(
        client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    item = hevc(client, seconds=8)
    slow(monkeypatch)
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    worker = threading.Thread(target=conversions.run_pending)
    worker.start()
    wait_for(lambda: conversions.running() is not None and work_folders())
    seen = client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]
    assert seen["status"] == "converting" and isinstance(seen["progress"], int)
    assert client.get("/api/admin/attachments").json()["queue"]["running"]["id"] == item["id"]
    started = time.monotonic()
    assert client.delete(f"/api/attachments/{item['id']}").status_code == 204
    worker.join(timeout=30)
    assert not worker.is_alive() and time.monotonic() - started < 6, "stopped, not run to its end"
    assert row_of(item["id"]) is None
    assert media_files() == [] and work_folders() == []
    assert conversions.running() is None


def test_a_conversion_that_fails_keeps_the_original(client: TestClient, account: Account,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    item = hevc(client)
    original = client.get(f"/api/attachments/{item['id']}").content
    before = row_of(item["id"]).file_id
    real = media_tools.convert_command
    monkeypatch.setattr(media_tools, "convert_command",
                        lambda *args, **kwargs: [part if part != "libx264" else "no-such-codec"
                                                 for part in real(*args, **kwargs)])
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    failed = client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]
    assert failed["status"] == "failed" and failed["codec"] == "hevc" and failed["can_convert"] is True
    assert row_of(item["id"]).file_id == before
    assert client.get(f"/api/attachments/{item['id']}").content == original
    assert sorted(media_files()) == sorted([before, item["id"] + ".p"]) and work_folders() == []
    # Asked again, it works.
    monkeypatch.setattr(media_tools, "convert_command", real)
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    assert row_of(item["id"]).status == "ready"


def test_running_out_of_time_fails_and_keeps_the_original(client: TestClient, account: Account,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    item = hevc(client, seconds=8)
    slow(monkeypatch)
    monkeypatch.setattr(conversions, "MIN_SECONDS", 1)
    monkeypatch.setattr(conversions, "PER_SECOND_OF_VIDEO", 0)
    before = row_of(item["id"]).file_id
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    started = time.monotonic()
    assert conversions.run_pending() == 1
    assert time.monotonic() - started < 6
    assert row_of(item["id"]).status == "failed" and row_of(item["id"]).file_id == before
    assert work_folders() == []


def test_a_full_storage_fails_the_conversion_and_keeps_the_original(client: TestClient, account: Account,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    item = hevc(client)
    real = media_tools.convert_command
    # Lossless: the new file is surely larger than the original.
    monkeypatch.setattr(media_tools, "convert_command",
                        lambda *args, **kwargs: [part if part != "23" else "0" for part in real(*args, **kwargs)])
    used = client.get("/api/photos/storage").json()["used"]
    before = row_of(item["id"]).file_id
    with SessionLocal() as db:
        # Exactly what is held now: any growth is too much.
        settings_service.save(db, {"storage_per_person_gb": used / (1024**3)})
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    assert conversions.run_pending() == 1
    row = row_of(item["id"])
    assert row.status == "failed" and row.file_id == before
    assert sorted(media_files()) == sorted([before, item["id"] + ".p"])


def test_a_locked_day_takes_no_request_and_a_running_conversion_ends(client: TestClient, account: Account) -> None:
    item = hevc(client)
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    lock(client)
    assert client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]["can_convert"] is False
    assert conversions.run_pending() == 1
    assert row_of(item["id"]).status == "ready", "asked while the day was open: it runs to its end"
    second = hevc_on(client, "2026-10-19")
    lock(client, "2026-10-19")
    assert client.get("/api/attachments", params={"date": "2026-10-19"}).json()["attachments"][0][
        "can_convert"] is False
    refused = client.post(f"/api/attachments/{second['id']}/convert")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "attachment_cannot_convert"


def hevc_on(client: TestClient, day: str) -> dict[str, Any]:
    return dict(send(client, samples.hevc_mp4(), "video", day=day).json())


def test_with_the_switch_off_nothing_new_starts_and_what_waits_keeps_waiting(client: TestClient,
                                                                             account: Account) -> None:
    item = hevc(client)
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    other = hevc_on(client, "2026-10-19")
    assert client.put("/api/admin/attachments", json={"convert": False}).status_code == 200
    assert client.get("/api/attachments", params={"date": "2026-10-19"}).json()["attachments"][0][
        "can_convert"] is False
    assert client.post(f"/api/attachments/{other['id']}/convert").status_code == 409
    assert conversions.run_pending() == 0
    assert row_of(item["id"]).status == "queued"
    assert client.put("/api/admin/attachments", json={"convert": True}).status_code == 200
    assert conversions.run_pending() == 1
    assert row_of(item["id"]).status == "ready"


def test_without_ffmpeg_nothing_can_be_converted(client: TestClient, account: Account,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    item = hevc(client)
    monkeypatch.setattr(media_tools, "available", lambda: False)
    assert client.get("/api/attachments", params={"date": DAY}).json()["attachments"][0]["can_convert"] is False
    assert client.post(f"/api/attachments/{item['id']}/convert").status_code == 409


def test_somebody_else_cannot_ask_for_a_conversion(client: TestClient, account: Account) -> None:
    from .conftest import make_account

    item = hevc(client)
    with new_client(make_account("tom")) as tom:
        assert tom.post(f"/api/attachments/{item['id']}/convert").status_code == 404
    assert row_of(item["id"]).status == "ready"


def test_the_queue_goes_oldest_first_one_at_a_time(client: TestClient, account: Account,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = hevc(client), hevc_on(client, "2026-10-19")
    moment = [datetime(2026, 10, 22, 10, 0, tzinfo=UTC)]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    assert client.post(f"/api/attachments/{first['id']}/convert").status_code == 202
    moment[0] = datetime(2026, 10, 22, 9, 0, tzinfo=UTC)
    assert client.post(f"/api/attachments/{second['id']}/convert").status_code == 202
    order: list[str] = []
    real = conversions._convert

    def watched(row: Any) -> None:
        assert conversions.running() is None, "one at a time"
        order.append(row.uid)
        real(row)

    monkeypatch.setattr(conversions, "_convert", watched)
    assert conversions.run_pending() == 2
    assert order == [second["id"], first["id"]], "asked earlier, converted first"


def test_deleting_the_account_stops_its_conversion(client: TestClient, account: Account,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    from .conftest import PASSWORD, make_account

    jule = make_account("jule")
    with new_client(jule) as browser:
        item = hevc(browser, seconds=8)
        slow(monkeypatch)
        assert browser.post(f"/api/attachments/{item['id']}/convert").status_code == 202
    worker = threading.Thread(target=conversions.run_pending)
    worker.start()
    wait_for(lambda: conversions.running() is not None)
    started = time.monotonic()
    gone = client.request("DELETE", f"/api/accounts/{jule.id}", json={"current_password": PASSWORD})
    assert gone.status_code == 204, gone.text
    worker.join(timeout=30)
    assert not worker.is_alive() and time.monotonic() - started < 6, "stopped, not run to its end"
    assert media_files() == [] and work_folders() == []
    assert not list(MEDIA.iterdir())


def test_the_progress_is_read_from_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a real run: what ffmpeg prints on ``-progress`` becomes the share done."""
    import subprocess
    import sys

    seen: list[int] = []
    monkeypatch.setattr(conversions, "_set_progress", lambda value: seen.append(value))
    script = ("import sys\nfor t in (0, 2500000, 5000000, 7500000):\n"
              "    print('out_time_us=%d' % t); print('progress=continue')\nprint('progress=end')\n")
    monkeypatch.setattr(media_tools, "start", lambda command, *_args: subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, stdin=subprocess.DEVNULL))
    assert conversions._encode(["x"], 10.0, 1000, threading.Event()) is True
    assert seen == [0, 25, 50, 75]
