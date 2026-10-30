"""Files sealed in pieces: the attachments of a day (videos, sounds, PDFs) and their stills.

A photo is sealed as a whole (``services/photos.py``): it is small and always read whole. A video is not: a browser
asks for a part of it (Safari plays no video without ``206``, and every jump asks for another part), and nothing here
may hold a whole video in memory. So the file is cut into pieces of ``CHUNK`` bytes, each sealed on its own:

* **The head** says what the file is: ``MAGIC``, the format version, the size of a piece and the size of what is
  sealed in it. The size of the contents follows from the head alone, without opening anything.
* **Every piece** is AES-256-GCM with the person's data key and a nonce of its own, as ``nonce | ciphertext | tag``.
  Its associated data binds it to the person, the attachment, the part (the file or its still), the name of the file,
  its number, whether it is the last one, and the whole head. A piece moved to another place, another attachment or
  another person does not open; one left out, one too many, a file cut short or a head that claims another size is
  found before anything is given out (``Reader`` checks the length of the file against the head).
* **Reading a range** opens only the pieces it touches (``Reader.iter_range``), one at a time.

Writing reads the plain file from disk piece by piece and writes the sealed one under a temporary name next to its
place, then moves it there (``os.replace``): a reader never sees half a file, a backup never takes the temporary one,
and a crash leaves only a temporary file for the sweep of the media folder (``services/media_sweep.py``).
"""

from __future__ import annotations

import os
import secrets
import struct
import time
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO, Self

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .. import private

MAGIC = b"NXDA"
FORMAT = 1
#: The size of a piece: a range costs at most two pieces more than it asks for.
CHUNK = 1024 * 1024
NONCE_BYTES = 12
TAG_BYTES = 16
#: ``MAGIC | format (1) | piece size (4) | size of the contents (8)``.
_HEAD = struct.Struct(">4sBIQ")
HEAD_BYTES = _HEAD.size
#: The largest piece size a head may claim (a damaged head must not make a reader allocate gigabytes).
MAX_CHUNK = 16 * 1024 * 1024
#: A temporary file of a write ends like this (``media_sweep.PART_NAME``).
PART_SUFFIX = ".part"


class SealedFileError(Exception):
    """A sealed file that does not open: damaged, cut short, grown, or moved to a place it does not belong."""


def label(account_id: int, uid: str, part: str, name: str) -> bytes:
    """What every piece of a file is bound to: the person, the attachment, the part (``file`` or ``preview``) and the
    name the file has in the media folder."""
    return f"nexdiary|{int(account_id)}|attachments|{part}|{uid}|{name}".encode()


def _pieces(size: int, chunk: int) -> int:
    """How many pieces a file of ``size`` bytes has: an empty file is one empty last piece."""
    return max(1, -(-size // chunk))


def _aad(bound: bytes, head: bytes, index: int, last: bool) -> bytes:
    return bound + f"|{index}|{1 if last else 0}|".encode() + head


def sealed_size(size: int, chunk: int = CHUNK) -> int:
    """The bytes on disk of a file whose contents are ``size`` bytes."""
    return HEAD_BYTES + size + _pieces(size, chunk) * (NONCE_BYTES + TAG_BYTES)


def _temporary(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}-{time.time_ns()}{PART_SUFFIX}")


def write(source: Path, target: Path, dek: bytes, bound: bytes, *, chunk: int = CHUNK) -> int:
    """Seals the plain file ``source`` into ``target``, piece by piece; the bytes written. ``target`` appears whole or
    not at all."""
    size = source.stat().st_size
    head = _HEAD.pack(MAGIC, FORMAT, chunk, size)
    count = _pieces(size, chunk)
    aead = AESGCM(dek)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary(target)
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
    try:
        written = 0
        with os.fdopen(descriptor, "wb") as out, source.open("rb") as plain:
            out.write(head)
            written += len(head)
            for index in range(count):
                piece = plain.read(chunk)
                last = index == count - 1
                expected = chunk if not last else size - index * chunk
                if len(piece) != expected:
                    raise SealedFileError("the file changed while it was sealed")
                nonce = secrets.token_bytes(NONCE_BYTES)
                sealed = aead.encrypt(nonce, piece, _aad(bound, head, index, last))
                out.write(nonce)
                out.write(sealed)
                written += NONCE_BYTES + len(sealed)
            if plain.read(1):
                raise SealedFileError("the file changed while it was sealed")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
        return written
    finally:
        temporary.unlink(missing_ok=True)


def write_bytes(data: bytes, target: Path, dek: bytes, bound: bytes, *, chunk: int = CHUNK) -> int:
    """Seals bytes held in memory (a small still) the same way; the bytes written."""
    head = _HEAD.pack(MAGIC, FORMAT, chunk, len(data))
    count = _pieces(len(data), chunk)
    aead = AESGCM(dek)
    parts = [head]
    for index in range(count):
        nonce = secrets.token_bytes(NONCE_BYTES)
        piece = data[index * chunk:(index + 1) * chunk]
        parts.append(nonce + aead.encrypt(nonce, piece, _aad(bound, head, index, index == count - 1)))
    whole = b"".join(parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary(target)
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
    try:
        with os.fdopen(descriptor, "wb") as out:
            out.write(whole)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return len(whole)


class Reader:
    """An open sealed file: its size from the head, and any range of it opened piece by piece. The file stays open
    until ``close`` (a stream that is still being sent keeps reading the file it began with, even when a conversion
    puts a new one in its place)."""

    def __init__(self, path: Path, dek: bytes, bound: bytes) -> None:
        self._handle: BinaryIO = path.open("rb")
        try:
            head = self._handle.read(HEAD_BYTES)
            if len(head) != HEAD_BYTES:
                raise SealedFileError("no head")
            magic, version, chunk, size = _HEAD.unpack(head)
            if magic != MAGIC or version != FORMAT or not 0 < chunk <= MAX_CHUNK:
                raise SealedFileError("not a sealed file of a known format")
            length = os.fstat(self._handle.fileno()).st_size
            if length != sealed_size(size, chunk):
                # Cut short, or something added: the head is bound into every piece, so it cannot lie about this.
                raise SealedFileError("the file is not as long as its head says")
        except BaseException:
            self._handle.close()
            raise
        self._head = head
        self._chunk = chunk
        self._count = _pieces(size, chunk)
        self._aead = AESGCM(dek)
        self._bound = bound
        self.size = size

    def piece(self, index: int) -> bytes:
        """The contents of piece ``index``, opened; ``SealedFileError`` when it does not open here."""
        if not 0 <= index < self._count:
            raise SealedFileError("no such piece")
        last = index == self._count - 1
        plain = self._chunk if not last else self.size - index * self._chunk
        self._handle.seek(HEAD_BYTES + index * (self._chunk + NONCE_BYTES + TAG_BYTES))
        raw = self._handle.read(NONCE_BYTES + plain + TAG_BYTES)
        if len(raw) != NONCE_BYTES + plain + TAG_BYTES:
            raise SealedFileError("cut short")
        try:
            return self._aead.decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], _aad(self._bound, self._head, index, last))
        except InvalidTag as exc:
            raise SealedFileError("a piece does not open here") from exc

    def iter_range(self, start: int, end: int) -> Iterator[bytes]:
        """The bytes from ``start`` up to and including ``end``, a piece at a time."""
        if self.size == 0 or start > end:
            return
        if not 0 <= start <= end < self.size:
            raise SealedFileError("outside the file")
        first, last = start // self._chunk, end // self._chunk
        for index in range(first, last + 1):
            data = self.piece(index)
            offset = index * self._chunk
            yield data[max(start - offset, 0):min(end - offset + 1, len(data))]

    def read_all(self) -> bytes:
        """The whole contents (for a small file such as a still)."""
        return b"".join(self.iter_range(0, self.size - 1)) if self.size else b""

    def close(self) -> None:
        self._handle.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def open_to(path: Path, target: Path, dek: bytes, bound: bytes) -> None:
    """Opens a sealed file into a plain one (the input of a conversion), piece by piece, only the owner's."""
    with Reader(path, dek, bound) as reader:
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, private.FILE_MODE)
        with os.fdopen(descriptor, "wb") as out:
            for piece in reader.iter_range(0, reader.size - 1) if reader.size else ():
                out.write(piece)
