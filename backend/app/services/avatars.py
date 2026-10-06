"""Profile pictures: what comes in is a picture of any kind a phone or camera makes; what is kept is a square WebP of
``SIZE`` pixels, drawn anew. Nothing of the file that came survives but its pixels: no place, no device, no hidden
second picture, no script in an SVG (an SVG is not taken at all).

Kept in the database next to the account (a few kilobytes), so every backup carries it and nothing lies beside.
Seen by everybody on the server: the family knows each other, and a shared day shows who shared it.
"""

from __future__ import annotations

import io
import logging
import struct

from sqlalchemy.orm import Session

from ..models import Account

logger = logging.getLogger("nexdiary.accounts")

SIZE = 256
#: Larger than any photo a phone takes; above it the file is not even opened. The request guard holds the body of
#: ``/api/auth/avatar`` to the same number (``middleware.LARGE_BODIES``), so both say the same.
MAX_BYTES = 20 * 1024 * 1024
#: Pixels of the picture that came (a 1-bit PNG can be tiny on disk and huge in memory).
MAX_PIXELS = 50_000_000
#: What phones and cameras make. The decoder opens more (TIFF, PSD, EPS, which would start Ghostscript): not here.
KINDS = {"jpeg", "png", "webp", "gif", "bmp", "heic", "avif"}
HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1", b"mif2"}
AVIF_BRANDS = {b"avif", b"avis"}


def sniff(head: bytes) -> str | None:
    """The kind of a picture by its first bytes (at least 64 of them), never by its name."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM") and len(head) > 14:
        return "bmp"
    if head[4:8] == b"ftyp" and len(head) >= 12:
        size = struct.unpack(">I", head[:4])[0]
        brands = {head[8:12]} | {head[at : at + 4] for at in range(16, min(size, len(head)) - 3, 4)}
        if brands & AVIF_BRANDS:
            return "avif"
        if brands & HEIF_BRANDS:
            return "heic"
    return None


class AvatarError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def make(data: bytes) -> bytes:
    """The square WebP of a picture, upright and cut to its middle. ``AvatarError`` for anything else."""
    if len(data) > MAX_BYTES:
        raise AvatarError("avatar_too_large")
    if sniff(data[:64]) not in KINDS:
        raise AvatarError("avatar_not_a_picture")
    import pillow_heif
    from PIL import Image, ImageOps

    pillow_heif.register_heif_opener()
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise AvatarError("avatar_too_large")
            upright = ImageOps.exif_transpose(image)
            square = ImageOps.fit(upright.convert("RGBA"), (SIZE, SIZE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            square.save(out, "WEBP", quality=85, method=4, exif=b"", xmp=b"")
            return out.getvalue()
    except AvatarError:
        raise
    except Image.DecompressionBombError as exc:
        # A small file that claims a huge picture: Pillow refuses it while opening. Too large, not "no picture".
        raise AvatarError("avatar_too_large") from exc
    except Exception as exc:
        # A broken or hostile picture fails in the decoder's own way.
        logger.info("A profile picture could not be read: %s", type(exc).__name__)
        raise AvatarError("avatar_not_a_picture") from exc


def may_see(db: Session, viewer: Account, owner_id: int) -> bool:
    """Everybody on the server sees everybody's name and picture: a family knows each other's faces, and a shared day
    shows who it comes from."""
    return True
