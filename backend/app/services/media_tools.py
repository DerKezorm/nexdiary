"""ffprobe and ffmpeg, for the videos and sounds people attach to a day.

Whatever comes in is a file from somewhere: ffmpeg is the part of nexdiary that reads it most deeply, so it runs on a
short leash.

* **Never through a shell**: a list of arguments, ``-nostdin``, nothing of the person in it (no name, no file name; the
  paths are random ones of the server's own work folders).
* **Only files**: ``-protocol_whitelist file``; the demuxer is named (``-f``) from a fixed list, after the first bytes
  said which one it is (``demuxer_of``), so that no other demuxer of ffmpeg's hundreds ever looks at the file.
* **A time limit** on every run, and under Linux limits on CPU time, memory and the size of what it writes
  (``resource.setrlimit`` in the child, before ffmpeg starts). Windows, for development, runs without those.
* **Not there** is fine: without ffmpeg or ffprobe (``NEXDIARY_FFMPEG``, ``NEXDIARY_FFPROBE``, else the PATH) videos and
  sounds are not taken, everything else works (``available``).

What is kept is the stream as it came, packed anew without anything else (``remux``): no place, no device, no date, no
chapter, no subtitle or data stream. Only turning HEVC into H.264 (``convert_command``) encodes.
"""

from __future__ import annotations

import json
import logging
import math
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import get_settings

logger = logging.getLogger("nexdiary.media")

PROBE_SECONDS = 30
STILL_SECONDS = 60
#: A remux copies the file once: at least this many bytes a second, plus a minute.
REMUX_BYTES_PER_SECOND = 20 * 1024 * 1024
#: Memory ffmpeg may take under Linux (address space: decoders reserve far more than they touch).
MEMORY_BYTES = 3 * 1024**3
#: More streams than any phone or camera makes: such a file is refused before anything else.
MAX_STREAMS = 32
#: What ffprobe may print (JSON of a file with many streams and tags): more is refused.
MAX_PROBE_OUTPUT = 1024 * 1024

#: The demuxers nexdiary lets ffmpeg use, by what the first bytes say (``demuxer_of``).
DEMUXERS = ("mov", "matroska", "ogg", "wav", "mp3")

#: What may be kept, per kind and container: the video codecs, the sound codecs.
VIDEO_FORMATS: dict[str, tuple[set[str], set[str]]] = {
    "mp4": ({"h264", "hevc", "av1"}, {"aac", "opus"}),
    "webm": ({"vp9", "av1", "vp8"}, {"opus", "vorbis"}),
}
AUDIO_FORMATS: dict[str, set[str]] = {
    "mp4": {"aac"},
    "mp3": {"mp3"},
    "ogg": {"opus"},
    "webm": {"opus"},
    "wav": {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"},
}
#: How long a video and a sound may be.
VIDEO_MAX_SECONDS = 4 * 3600
AUDIO_MAX_SECONDS = 6 * 3600


class MediaError(Exception):
    """Not a video or sound nexdiary takes (``reason``: ``kind`` for another kind, ``format`` for anything else)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason


class ToolFailed(Exception):
    """ffmpeg or ffprobe failed, ran out of time or was stopped."""


# --- Finding the tools -----------------------------------------------------------------------------------------------


def _tool(configured: str, name: str) -> str | None:
    if configured:
        path = Path(configured)
        return str(path) if path.is_file() else None
    return shutil.which(name)


def ffmpeg_path() -> str | None:
    return _tool(get_settings().ffmpeg, "ffmpeg")


def ffprobe_path() -> str | None:
    return _tool(get_settings().ffprobe, "ffprobe")


def available() -> bool:
    """Whether both tools are there."""
    return ffmpeg_path() is not None and ffprobe_path() is not None


# --- Running them ----------------------------------------------------------------------------------------------------


def _limits(cpu_seconds: int, file_bytes: int) -> Any:
    """The function the child runs before ffmpeg starts, under Linux: it may not use more CPU time, memory or write a
    larger file than this. Built here, before the fork, so that the child only calls ``setrlimit``."""
    if not sys.platform.startswith("linux"):
        return None
    import resource

    cpu = max(int(cpu_seconds), 1)
    size = max(int(file_bytes), 1024 * 1024)

    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return apply


def _cpu_for(seconds: float) -> int:
    # Threads add up CPU time: a few cores' worth of the wall-clock limit.
    return int(seconds * 4) + 10


def run(arguments: list[str], seconds: float, file_bytes: int) -> subprocess.CompletedProcess[bytes]:
    """One run of ffmpeg or ffprobe, to its end; ``ToolFailed`` when it fails or takes longer than ``seconds``."""
    try:
        done = subprocess.run(arguments, stdin=subprocess.DEVNULL, capture_output=True, timeout=seconds, check=False,
                              preexec_fn=_limits(_cpu_for(seconds), file_bytes))
    except subprocess.TimeoutExpired as exc:
        raise ToolFailed("ran out of time") from exc
    except OSError as exc:
        raise ToolFailed(f"could not start: {exc.strerror}") from exc
    if done.returncode != 0:
        # The first line of what it said, never the arguments: they hold no names, but the log stays short.
        said = done.stderr.decode("utf-8", "replace").strip().splitlines()[:1]
        raise ToolFailed(f"exit {done.returncode}: {said[0][:200] if said else ''}")
    return done


def run_bounded(arguments: list[str], seconds: float, most: int) -> bytes:
    """ffprobe to its end, its output read while it comes: past ``most`` bytes it is stopped (``ToolFailed``), so that a
    file with a huge tag never fills the server's memory with what ffprobe says about it."""
    try:
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, preexec_fn=_limits(_cpu_for(seconds), 1024 * 1024))  # noqa: PLW1509
    except OSError as exc:
        raise ToolFailed(f"could not start: {exc.strerror}") from exc
    timer = threading.Timer(seconds, process.kill)
    timer.start()
    out = bytearray()
    try:
        assert process.stdout is not None
        while piece := process.stdout.read(64 * 1024):
            out.extend(piece)
            if len(out) > most:
                process.kill()
                raise ToolFailed("said too much")
        process.wait()
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        if process.stdout is not None:
            process.stdout.close()
    if process.returncode != 0:
        raise ToolFailed(f"exit {process.returncode}")
    return bytes(out)


def start(arguments: list[str], seconds: float, file_bytes: int) -> subprocess.Popen[bytes]:
    """ffmpeg running in the background (a conversion, read line by line); the caller waits and stops it."""
    try:
        return subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, preexec_fn=_limits(_cpu_for(seconds), file_bytes))  # noqa: PLW1509
    except OSError as exc:
        raise ToolFailed(f"could not start: {exc.strerror}") from exc


def _file(path: Path) -> str:
    """A path for ffmpeg that can only be a file: never read as another protocol, whatever it looks like."""
    return "file:" + str(path)


# --- Knowing the file -----------------------------------------------------------------------------------------------


def demuxer_of(head: bytes) -> str | None:
    """Which of ``DEMUXERS`` may read a file, by its first bytes (at least 16); None for anything else."""
    if len(head) >= 12 and head[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"):
        return "mov"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "matroska"
    if head.startswith(b"OggS"):
        return "ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "mp3"
    return None


def looks_like_media(head: bytes) -> bool:
    return demuxer_of(head) is not None


@dataclass
class Stream:
    index: int
    codec: str
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    #: How the picture is coded: ``color_transfer`` (``arib-std-b67`` is HLG, ``smpte2084`` PQ), the primaries, the
    #: pixel format. Empty when ffprobe does not say.
    transfer: str = ""
    primaries: str = ""
    matrix: str = ""
    pixels: str = ""

    @property
    def hdr(self) -> bool:
        return self.transfer in HDR_TRANSFERS


#: The transfer functions of HDR video: HLG (what an iPhone records) and PQ (HDR10, Dolby Vision's base).
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}


@dataclass
class Probe:
    """What ffprobe said about a file: its container, the first video and sound stream, its length and whether
    anything in it still names a place."""

    format_name: str
    brand: str
    duration: float | None
    video: Stream | None
    audio: Stream | None
    #: Any sound stream at all (one of a codec that is not taken counts too).
    has_audio: bool
    streams: int
    tags: set[str] = field(default_factory=set)

    @property
    def places(self) -> bool:
        """Whether a tag of the file or a stream names a place (``location``, Apple's ``ISO6709``)."""
        return any("location" in tag or "iso6709" in tag or tag.startswith("com.apple.quicktime")
                   for tag in self.tags)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _rotated(stream: dict[str, Any]) -> bool:
    """Whether the picture is shown turned by a quarter (a phone held upright): width and height swap then."""
    turns = []
    for side in stream.get("side_data_list") or []:
        if isinstance(side, dict) and "rotation" in side:
            turns.append(side["rotation"])
    tags = stream.get("tags") or {}
    if isinstance(tags, dict) and "rotate" in tags:
        turns.append(tags["rotate"])
    for turn in turns:
        try:
            number = abs(float(turn))
        except (TypeError, ValueError):
            continue
        if math.isfinite(number) and round(number) % 180 == 90:
            return True
    return False


def probe(path: Path, demuxer: str) -> Probe:
    """What the file is, from ffprobe with the demuxer named; ``MediaError("format")`` when ffprobe cannot read it."""
    tool = ffprobe_path()
    if tool is None or demuxer not in DEMUXERS:
        raise MediaError("format", "no ffprobe")
    arguments = [tool, "-v", "error", "-protocol_whitelist", "file", "-f", demuxer,
                 "-print_format", "json", "-show_format", "-show_streams", "-i", _file(path)]
    try:
        output = run_bounded(arguments, PROBE_SECONDS, MAX_PROBE_OUTPUT)
    except ToolFailed as exc:
        raise MediaError("format", str(exc)) from exc
    try:
        said = json.loads(output.decode("utf-8", "replace"))
    except ValueError as exc:
        raise MediaError("format", "no answer") from exc
    if not isinstance(said, dict):
        raise MediaError("format", "no answer")
    container = said.get("format") if isinstance(said.get("format"), dict) else {}
    streams = [stream for stream in said.get("streams") or [] if isinstance(stream, dict)]
    if not streams or len(streams) > MAX_STREAMS:
        raise MediaError("format", "no streams or too many")
    tags: set[str] = set()
    for holder in [container, *streams]:
        found = holder.get("tags")
        if isinstance(found, dict):
            tags.update(str(key).lower() for key in found)
    container_tags = container.get("tags") if isinstance(container.get("tags"), dict) else {}
    video = audio = None
    has_audio = False
    for stream in streams:
        kind = stream.get("codec_type")
        codec = str(stream.get("codec_name") or "")
        disposition = stream.get("disposition") if isinstance(stream.get("disposition"), dict) else {}
        index = stream.get("index")
        if not isinstance(index, int):
            continue
        if kind == "video" and not disposition.get("attached_pic") and video is None:
            width, height = stream.get("width"), stream.get("height")
            width = width if isinstance(width, int) and 0 < width <= 16384 else None
            height = height if isinstance(height, int) and 0 < height <= 16384 else None
            if width and height and _rotated(stream):
                width, height = height, width
            video = Stream(index, codec, width, height, _number(stream.get("duration")),
                           transfer=str(stream.get("color_transfer") or ""),
                           primaries=str(stream.get("color_primaries") or ""),
                           matrix=str(stream.get("color_space") or ""),
                           pixels=str(stream.get("pix_fmt") or ""))
        elif kind == "audio":
            has_audio = True
            if audio is None:
                audio = Stream(index, codec, duration=_number(stream.get("duration")))
    duration = _number(container.get("duration"))
    if duration is None:
        lengths = [stream.duration for stream in (video, audio) if stream is not None and stream.duration]
        duration = max(lengths) if lengths else None
    return Probe(format_name=str(container.get("format_name") or ""),
                 brand=str(container_tags.get("major_brand") or "").strip().lower(),
                 duration=duration, video=video, audio=audio, has_audio=has_audio, streams=len(streams), tags=tags)


def first_allowed_audio(path: Path, demuxer: str, allowed: set[str]) -> Stream | None:
    """The first sound stream of a codec that is taken (a phone may put another one first)."""
    tool = ffprobe_path()
    if tool is None:
        return None
    arguments = [tool, "-v", "error", "-protocol_whitelist", "file", "-f", demuxer,
                 "-print_format", "json", "-show_streams", "-select_streams", "a", "-i", _file(path)]
    try:
        said = json.loads(run_bounded(arguments, PROBE_SECONDS, MAX_PROBE_OUTPUT).decode("utf-8", "replace"))
    except (ToolFailed, ValueError):
        return None
    for stream in (said.get("streams") or []) if isinstance(said, dict) else []:
        if isinstance(stream, dict) and stream.get("codec_name") in allowed and isinstance(stream.get("index"), int):
            return Stream(stream["index"], str(stream["codec_name"]), duration=_number(stream.get("duration")))
    return None


# --- What is kept ----------------------------------------------------------------------------------------------------


@dataclass
class Checked:
    """A file that may be kept: its kind, the container it is packed into, the streams to keep and its length."""

    kind: str
    container: str
    demuxer: str
    video: Stream | None
    audio: Stream | None
    seconds: float | None


def check(path: Path, head: bytes, wanted: str) -> Checked:
    """Whether the file is a video or sound nexdiary takes, of the kind the person meant (``wanted``).
    ``MediaError("kind")`` for a file of the other kind, ``MediaError("format")`` for anything not taken."""
    demuxer = demuxer_of(head)
    if demuxer is None:
        raise MediaError("format", "not a known container")
    found = probe(path, demuxer)
    kind = "video" if found.video is not None else "audio" if found.audio is not None else None
    if kind is None:
        raise MediaError("format", "no video and no sound")
    if kind != wanted:
        raise MediaError("kind", f"this is {kind}")
    names = set(found.format_name.split(","))
    if demuxer == "mov":
        container = "mp4"
    elif demuxer == "matroska":
        container = "webm"
    else:
        container = demuxer
    if demuxer == "mov" and not names & {"mov", "mp4", "m4a"}:
        raise MediaError("format", "not mp4")
    audio = found.audio
    if kind == "video":
        assert found.video is not None
        video_codecs, audio_codecs = VIDEO_FORMATS.get(container, (set(), set()))
        if found.video.codec not in video_codecs:
            raise MediaError("format", f"video codec {found.video.codec}")
        if found.has_audio and (audio is None or audio.codec not in audio_codecs):
            audio = first_allowed_audio(path, demuxer, audio_codecs)
            if audio is None:
                raise MediaError("format", "sound codec")
        limit = VIDEO_MAX_SECONDS
    else:
        allowed = AUDIO_FORMATS.get(container, set())
        if audio is None or audio.codec not in allowed:
            audio = first_allowed_audio(path, demuxer, allowed)
            if audio is None:
                raise MediaError("format", "sound codec")
        limit = AUDIO_MAX_SECONDS
    if found.duration is not None and found.duration > limit:
        raise MediaError("format", "too long")
    return Checked(kind, container, demuxer, found.video if kind == "video" else None, audio, found.duration)


#: The muxer and what goes with it for every container kept.
_MUXERS: dict[tuple[str, str], list[str]] = {
    ("video", "mp4"): ["-movflags", "+faststart", "-f", "mp4"],
    ("audio", "mp4"): ["-movflags", "+faststart", "-f", "mp4"],
    ("video", "webm"): ["-f", "webm"],
    ("audio", "webm"): ["-f", "webm"],
    ("audio", "ogg"): ["-f", "ogg"],
    ("audio", "mp3"): ["-id3v2_version", "0", "-write_id3v1", "0", "-f", "mp3"],
    ("audio", "wav"): ["-f", "wav"],
}

#: Nothing of the source rides along: no tags of the file or of a stream, no chapters, and ffmpeg names neither itself
#: nor the time.
_CLEAN = ["-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1", "-fflags", "+bitexact",
          "-flags:v", "+bitexact", "-flags:a", "+bitexact"]


def _input(demuxer: str, path: Path) -> list[str]:
    return ["-protocol_whitelist", "file", "-f", demuxer, "-i", _file(path)]


def remux(checked: Checked, source: Path, target: Path) -> None:
    """The first video and the first sound stream, packed anew without anything else: no tags, chapters, subtitles
    or data streams (a phone keeps the place in those), nothing encoded again. MP4 with its index in front."""
    tool = ffmpeg_path()
    if tool is None:
        raise ToolFailed("no ffmpeg")
    maps: list[str] = []
    if checked.video is not None:
        maps += ["-map", f"0:{checked.video.index}"]
    if checked.audio is not None:
        maps += ["-map", f"0:{checked.audio.index}"]
    extra: list[str] = []
    if checked.video is not None and checked.video.codec == "hevc" and checked.container == "mp4":
        # The tag Apple's players need to play HEVC from an MP4.
        extra = ["-tag:v", "hvc1"]
    size = source.stat().st_size
    arguments = [tool, "-nostdin", "-v", "error", "-y", *_input(checked.demuxer, source), *maps, "-c", "copy",
                 "-sn", "-dn", *extra, *_CLEAN, *_MUXERS[(checked.kind, checked.container)], _file(target)]
    run(arguments, 60 + size / REMUX_BYTES_PER_SECOND, size * 2 + 64 * 1024 * 1024)


def demuxer_of_container(container: str) -> str:
    return {"mp4": "mov", "webm": "matroska"}.get(container, container)


def still_at(seconds: float | None) -> float:
    """Where the still of a video is taken: a tenth into it, at most a second into a very short one."""
    if not seconds:
        return 0.0
    return seconds * 0.1 if seconds >= 10 else min(1.0, seconds * 0.5)


def still(source: Path, container: str, seconds: float | None, target: Path) -> bool:
    """One picture of the video as PNG (made small already), upright as the video is shown; False when there is
    none."""
    tool = ffmpeg_path()
    if tool is None:
        return False
    for moment in dict.fromkeys((still_at(seconds), 0.0)):
        target.unlink(missing_ok=True)
        arguments = [tool, "-nostdin", "-v", "error", "-y", "-ss", f"{moment:.3f}",
                     *_input(demuxer_of_container(container), source), "-map", "0:v:0", "-frames:v", "1", "-an",
                     "-sn", "-dn", "-vf", "scale=w=1280:h=1280:force_original_aspect_ratio=decrease",
                     "-pix_fmt", "rgb24", "-c:v", "png", "-f", "image2", *_CLEAN, _file(target)]
        try:
            run(arguments, STILL_SECONDS, 64 * 1024 * 1024)
        except ToolFailed as exc:
            logger.info("No still of a video: %s", exc)
            continue
        if target.is_file() and target.stat().st_size > 0:
            return True
    return False


#: HDR (HLG or PQ, BT.2020, 10 bit) to SDR (BT.709, 8 bit): into linear light, to the BT.709 primaries, tone mapped
#: (hable, no desaturation), then the BT.709 transfer and matrix in TV range. Needs zscale (ffmpeg built with zimg).
TONEMAP = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
           "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
#: What the result of a tone mapping is said to be.
BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]

_filters: dict[str, bool] = {}


def can_tonemap() -> bool:
    """Whether this ffmpeg has the filters to turn HDR into SDR (``zscale`` and ``tonemap``); asked once."""
    tool = ffmpeg_path()
    if tool is None:
        return False
    if tool not in _filters:
        try:
            listed = run([tool, "-hide_banner", "-nostdin", "-filters"], PROBE_SECONDS, 1024 * 1024).stdout
        except ToolFailed:
            listed = b""
        names = {line.split()[1] for line in listed.decode("ascii", "replace").splitlines() if len(line.split()) > 2}
        _filters[tool] = {"zscale", "tonemap"} <= names
    return _filters[tool]


def convert_command(source: Path, target: Path, audio_codec: str | None, hdr: bool = False) -> list[str]:
    """ffmpeg turning a video into H.264 (``libx264 -preset veryfast -crf 23``, 4:2:0, 8 bit), its sound into AAC (or
    kept when it is AAC already), the index in front, nothing else of the source; telling how far it is on stdout. A
    video in HDR (``hdr``) is tone mapped to BT.709 and said to be that (``TONEMAP``): an 8-bit stream still marked as
    HLG shows washed-out colours. ``ToolFailed`` when this ffmpeg cannot tone map."""
    tool = ffmpeg_path()
    if tool is None:
        raise ToolFailed("no ffmpeg")
    if hdr and not can_tonemap():
        raise ToolFailed("this ffmpeg cannot turn HDR into SDR (no zscale)")
    picture = f"{TONEMAP},scale=trunc(iw/2)*2:trunc(ih/2)*2" if hdr else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    sound: list[str] = []
    if audio_codec is not None:
        sound = ["-map", "0:a:0", "-c:a", "copy"] if audio_codec == "aac" else ["-map", "0:a:0", "-c:a", "aac",
                                                                              "-b:a", "160k"]
    return [tool, "-nostdin", "-v", "error", "-y", *_input("mov", source), "-map", "0:v:0", *sound,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-vf", picture, *(BT709 if hdr else []), "-sn", "-dn", *_CLEAN, "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats", "-f", "mp4", _file(target)]
