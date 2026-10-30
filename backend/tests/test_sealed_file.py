"""Files sealed in pieces (``services/sealed_file.py``): what comes back is what went in, a range opens only the pieces
it touches, and a file that was cut, grown, reordered, given another head or moved to another attachment or person
does not open."""

from __future__ import annotations

import secrets
from pathlib import Path

import pytest

from app.services import sealed_file

CHUNK = 64


def sealed(tmp_path: Path, data: bytes, bound: bytes, key: bytes, name: str = "file") -> Path:
    source = tmp_path / f"{name}.plain"
    source.write_bytes(data)
    target = tmp_path / name
    written = sealed_file.write(source, target, key, bound, chunk=CHUNK)
    assert written == target.stat().st_size == sealed_file.sealed_size(len(data), CHUNK)
    return target


@pytest.fixture
def key() -> bytes:
    return secrets.token_bytes(32)


BOUND = sealed_file.label(7, "a" * 32, "file", "b" * 32)


@pytest.mark.parametrize("size", [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 5 * CHUNK, 5 * CHUNK + 17])
def test_what_comes_back_is_what_went_in(tmp_path: Path, key: bytes, size: int) -> None:
    data = secrets.token_bytes(size)
    path = sealed(tmp_path, data, BOUND, key)
    with sealed_file.Reader(path, key, BOUND) as reader:
        assert reader.size == size
        assert reader.read_all() == data
        if size:
            for start, end in ((0, 0), (size - 1, size - 1), (0, size - 1), (CHUNK - 1, min(CHUNK, size - 1)),
                               (size // 3, size // 2)):
                assert b"".join(reader.iter_range(start, end)) == data[start:end + 1], (start, end)
    # (A byte or two can stand in the ciphertext by chance; a whole piece of the contents cannot.)
    assert size < 16 or data not in path.read_bytes()
    assert path.read_bytes().startswith(sealed_file.MAGIC)
    # No temporary file stays next to it.
    assert sorted(item.name for item in tmp_path.iterdir()) == ["file", "file.plain"]


def test_a_range_opens_only_the_pieces_it_needs(tmp_path: Path, key: bytes, monkeypatch: pytest.MonkeyPatch) -> None:
    data = secrets.token_bytes(10 * CHUNK)
    path = sealed(tmp_path, data, BOUND, key)
    with sealed_file.Reader(path, key, BOUND) as reader:
        opened: list[int] = []
        real = reader.piece

        def counted(index: int) -> bytes:
            opened.append(index)
            return real(index)

        monkeypatch.setattr(reader, "piece", counted)
        assert b"".join(reader.iter_range(3 * CHUNK + 5, 4 * CHUNK + 1)) == data[3 * CHUNK + 5:4 * CHUNK + 2]
        assert opened == [3, 4]


def piece_at(index: int) -> slice:
    size = sealed_file.NONCE_BYTES + CHUNK + sealed_file.TAG_BYTES
    start = sealed_file.HEAD_BYTES + index * size
    return slice(start, start + size)


def refused(path: Path, key: bytes, bound: bytes = BOUND) -> bool:
    try:
        with sealed_file.Reader(path, key, bound) as reader:
            reader.read_all()
    except sealed_file.SealedFileError:
        return True
    return False


def test_two_pieces_swapped_do_not_open(tmp_path: Path, key: bytes) -> None:
    path = sealed(tmp_path, secrets.token_bytes(4 * CHUNK), BOUND, key)
    raw = bytearray(path.read_bytes())
    first, second = raw[piece_at(1)], raw[piece_at(2)]
    raw[piece_at(1)], raw[piece_at(2)] = second, first
    path.write_bytes(bytes(raw))
    assert refused(path, key)


def test_a_file_cut_short_or_grown_does_not_open(tmp_path: Path, key: bytes) -> None:
    data = secrets.token_bytes(4 * CHUNK)
    path = sealed(tmp_path, data, BOUND, key)
    whole = path.read_bytes()
    for changed in (whole[:-1], whole[:piece_at(3).start], whole + b"\x00", whole + whole[piece_at(3)]):
        path.write_bytes(changed)
        assert refused(path, key)


def test_the_last_piece_cut_away_with_a_head_that_claims_less_does_not_open(tmp_path: Path, key: bytes) -> None:
    """Cutting off whole pieces and writing a smaller size into the head: the head is bound into every piece, and the
    piece that is the last now was not sealed as the last."""
    data = secrets.token_bytes(4 * CHUNK)
    path = sealed(tmp_path, data, BOUND, key)
    whole = bytearray(path.read_bytes())
    head = bytearray(whole[:sealed_file.HEAD_BYTES])
    head[-8:] = (3 * CHUNK).to_bytes(8, "big")
    path.write_bytes(bytes(head) + bytes(whole[sealed_file.HEAD_BYTES:piece_at(3).start]))
    assert refused(path, key)


def test_a_changed_byte_does_not_open(tmp_path: Path, key: bytes) -> None:
    path = sealed(tmp_path, secrets.token_bytes(3 * CHUNK), BOUND, key)
    raw = bytearray(path.read_bytes())
    raw[piece_at(1).start + 20] ^= 0x01
    path.write_bytes(bytes(raw))
    with sealed_file.Reader(path, key, BOUND) as reader:
        assert reader.piece(0)
        with pytest.raises(sealed_file.SealedFileError):
            reader.piece(1)


def test_a_file_of_another_attachment_part_or_person_does_not_open(tmp_path: Path, key: bytes) -> None:
    path = sealed(tmp_path, secrets.token_bytes(2 * CHUNK), BOUND, key)
    for other in (sealed_file.label(7, "c" * 32, "file", "b" * 32), sealed_file.label(8, "a" * 32, "file", "b" * 32),
                  sealed_file.label(7, "a" * 32, "preview", "b" * 32),
                  sealed_file.label(7, "a" * 32, "file", "d" * 32)):
        assert refused(path, key, other)
    assert refused(path, secrets.token_bytes(32))
    assert not refused(path, key)


def test_a_piece_moved_from_another_file_of_the_same_size_does_not_open(tmp_path: Path, key: bytes) -> None:
    other_bound = sealed_file.label(7, "e" * 32, "file", "f" * 32)
    mine = sealed(tmp_path, secrets.token_bytes(3 * CHUNK), BOUND, key, "mine")
    theirs = sealed(tmp_path, secrets.token_bytes(3 * CHUNK), other_bound, key, "theirs")
    raw = bytearray(mine.read_bytes())
    raw[piece_at(1)] = theirs.read_bytes()[piece_at(1)]
    mine.write_bytes(bytes(raw))
    assert refused(mine, key)


def test_a_head_of_another_format_or_a_huge_piece_size_is_refused(tmp_path: Path, key: bytes) -> None:
    path = sealed(tmp_path, b"abc", BOUND, key)
    whole = path.read_bytes()
    for head in (b"XXXX" + whole[4:], whole[:4] + b"\x02" + whole[5:],
                 whole[:5] + (64 * 1024 * 1024).to_bytes(4, "big") + whole[9:], b""):
        path.write_bytes(head)
        assert refused(path, key)


def test_a_range_outside_the_file_is_refused(tmp_path: Path, key: bytes) -> None:
    path = sealed(tmp_path, b"0123456789", BOUND, key)
    with sealed_file.Reader(path, key, BOUND) as reader:
        with pytest.raises(sealed_file.SealedFileError):
            list(reader.iter_range(5, 10))
        assert list(reader.iter_range(5, 4)) == []


def test_sealing_from_memory_is_the_same_format(tmp_path: Path, key: bytes) -> None:
    data = secrets.token_bytes(3 * CHUNK + 1)
    target = tmp_path / "still"
    sealed_file.write_bytes(data, target, key, BOUND, chunk=CHUNK)
    with sealed_file.Reader(target, key, BOUND) as reader:
        assert reader.read_all() == data


def test_a_source_that_changes_while_it_is_sealed_leaves_nothing(tmp_path: Path, key: bytes,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "plain"
    source.write_bytes(b"x" * (3 * CHUNK))
    real_stat = Path.stat

    def larger(self: Path, *args: object, **kwargs: object) -> object:
        found = real_stat(self, *args, **kwargs)  # type: ignore[arg-type]
        if self == source:
            class Claimed:
                st_size = found.st_size + 10
            return Claimed()
        return found

    monkeypatch.setattr(Path, "stat", larger)
    with pytest.raises(sealed_file.SealedFileError):
        sealed_file.write(source, tmp_path / "target", key, BOUND, chunk=CHUNK)
    monkeypatch.undo()
    assert sorted(item.name for item in tmp_path.iterdir()) == ["plain"]
