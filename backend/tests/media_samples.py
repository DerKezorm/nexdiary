"""Videos, sounds and PDFs for the tests of attachments, made at run time (no media file lies in the repository): a few
seconds of ffmpeg's test picture and a sine tone, small. ffmpeg is needed for the videos and sounds; without it those
tests are skipped, except where ``NEXDIARY_REQUIRE_FFMPEG=1`` says it must be there (CI), and then they fail."""

from __future__ import annotations

import functools
import io
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.services import media_tools

#: Where a place is written into a video: Apple's key and the plain one.
PLACE = "+01.2345-023.4567+000.000/"


def need_ffmpeg() -> None:
    """Skips the test without ffmpeg and ffprobe, or fails it where they are required."""
    if media_tools.available():
        return
    if os.environ.get("NEXDIARY_REQUIRE_FFMPEG") == "1":
        pytest.fail("ffmpeg and ffprobe are required here (NEXDIARY_REQUIRE_FFMPEG=1) and were not found")
    pytest.skip("ffmpeg and ffprobe are not installed")


@pytest.fixture
def ffmpeg() -> None:
    need_ffmpeg()


@functools.lru_cache(maxsize=1)
def _folder() -> Path:
    return Path(tempfile.mkdtemp(prefix="nexdiary-media-samples-"))


def _make(name: str, arguments: list[str]) -> bytes:
    """A file made once per run with ffmpeg (``arguments`` between the tool and the output)."""
    need_ffmpeg()
    target = _folder() / name
    if not target.is_file():
        tool = media_tools.ffmpeg_path()
        assert tool is not None
        done = subprocess.run([tool, "-nostdin", "-v", "error", "-y", *arguments, str(target)], capture_output=True,
                              timeout=120, check=False)
        assert done.returncode == 0, done.stderr.decode("utf-8", "replace")[-2000:]
    return target.read_bytes()


def _picture(seconds: float, size: str = "160x120") -> list[str]:
    return ["-f", "lavfi", "-i", f"testsrc=size={size}:rate=10:duration={seconds}"]


def _tone(seconds: float) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]


def h264_mp4(seconds: float = 2) -> bytes:
    return _make(f"h264-{seconds}.mp4", [*_picture(seconds), *_tone(seconds), "-c:v", "libx264", "-preset",
                                         "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4"])


def hevc_mp4(seconds: float = 2) -> bytes:
    return _make(f"hevc-{seconds}.mp4", [*_picture(seconds), *_tone(seconds), "-c:v", "libx265", "-preset",
                                         "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p",
                                         "-tag:v", "hvc1", "-c:a", "aac", "-shortest", "-f", "mp4"])


def mov_with_place(word: str = "Ortsname") -> bytes:
    """A MOV as a phone makes it: HEVC, sound, the place in Apple's key and the plain one, a creation date, a title, and
    a subtitle stream that carries words of its own."""
    subtitles = _folder() / f"words-{word}.srt"
    subtitles.write_text(f"1\n00:00:00,000 --> 00:00:01,500\nUntertitel {word}\n", encoding="utf-8")
    return _make(f"place-{word}.mov", [
        *_picture(2), *_tone(2), "-i", str(subtitles), "-map", "0:v", "-map", "1:a", "-map", "2:s",
        "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1",
        "-c:a", "aac", "-c:s", "mov_text", "-shortest",
        "-metadata", f"location={PLACE}", "-metadata", f"com.apple.quicktime.location.ISO6709={PLACE}",
        "-metadata", "com.apple.quicktime.make=Phone", "-metadata", f"title=Titel {word}",
        "-metadata", "creation_time=2026-10-30T10:00:00Z", "-movflags", "use_metadata_tags", "-f", "mov"])


def hlg_hevc(seconds: float = 2) -> bytes:
    """HEVC in 10 bit with HLG and BT.2020, as an iPhone records from the start."""
    return _make(f"hlg-{seconds}.mp4", [
        *_picture(seconds), *_tone(seconds), "-c:v", "libx265", "-preset", "ultrafast",
        "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
        "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
        "-colorspace", "bt2020nc", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", "-f", "mp4"])


def huge_title(megabytes: int = 2) -> bytes:
    """An MP4 whose title tag alone is ``megabytes`` large: ffprobe would say all of it."""
    meta = _folder() / f"title-{megabytes}.txt"
    meta.write_text(";FFMETADATA1\ntitle=" + "A" * (megabytes * 1024 * 1024) + "\n", encoding="ascii")
    return _make(f"title-{megabytes}.mp4", [*_picture(1), "-f", "ffmetadata", "-i", str(meta), "-map", "0",
                                            "-map_metadata", "1", "-c:v", "libx264", "-preset", "ultrafast",
                                            "-f", "mp4"])


def webm_vp9(seconds: float = 2) -> bytes:
    return _make(f"vp9-{seconds}.webm", [*_picture(seconds), *_tone(seconds), "-c:v", "libvpx-vp9", "-deadline",
                                         "realtime", "-cpu-used", "8", "-b:v", "200k", "-c:a", "libopus", "-shortest",
                                         "-f", "webm"])


def webm_opus(seconds: float = 2) -> bytes:
    """Sound as a browser records it (Chrome: WebM with Opus)."""
    return _make(f"opus-{seconds}.webm", [*_tone(seconds), "-c:a", "libopus", "-f", "webm"])


def ogg_opus(seconds: float = 2) -> bytes:
    return _make(f"opus-{seconds}.ogg", [*_tone(seconds), "-c:a", "libopus", "-f", "ogg"])


def wav(seconds: float = 1) -> bytes:
    return _make(f"tone-{seconds}.wav", [*_tone(seconds), "-c:a", "pcm_s16le", "-f", "wav"])


def mp3(seconds: float = 2, title: str = "") -> bytes:
    tags = ["-metadata", f"title={title}", "-id3v2_version", "3"] if title else []
    return _make(f"tone-{seconds}-{title}.mp3", [*_tone(seconds), "-c:a", "libmp3lame", "-b:a", "64k", *tags,
                                                 "-f", "mp3"])


def m4a(seconds: float = 2) -> bytes:
    return _make(f"tone-{seconds}.m4a", [*_tone(seconds), "-c:a", "aac", "-f", "mp4"])


def mkv_h264(seconds: float = 1) -> bytes:
    """Matroska with H.264: a container nexdiary reads, a codec it does not keep there."""
    return _make(f"h264-{seconds}.mkv", [*_picture(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-f",
                                         "matroska"])


def mp4_mpeg4(seconds: float = 1) -> bytes:
    """MP4 with MPEG-4 Part 2: a container nexdiary keeps, a codec it does not."""
    return _make(f"mpeg4-{seconds}.mp4", [*_picture(seconds), "-c:v", "mpeg4", "-f", "mp4"])


def avi(seconds: float = 1) -> bytes:
    return _make(f"picture-{seconds}.avi", [*_picture(seconds), "-c:v", "mjpeg", "-f", "avi"])


def pdf(text: str = "Hallo") -> bytes:
    """A small valid PDF with ``text`` on its page, in the clear in the file (no compression)."""
    from reportlab.pdfgen.canvas import Canvas

    out = io.BytesIO()
    canvas = Canvas(out, pageCompression=0)
    canvas.drawString(72, 720, text)
    canvas.showPage()
    canvas.save()
    data = out.getvalue()
    assert data.startswith(b"%PDF-") and text.encode() in data
    return data
