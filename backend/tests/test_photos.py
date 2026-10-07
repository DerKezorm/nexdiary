"""Photos: drawn anew without anything but their pixels, sealed on disk, given back only to the person who took them,
and gone with their files when deleted. Hostile files stay small here (a bomb is a header, not a gigabyte)."""

from __future__ import annotations

import io
import secrets
import struct
import threading
import uuid
import zipfile
import zlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms
from sqlalchemy import func, select

from app import clock, middleware
from app.db import SessionLocal
from app.models import Account, Note, Photo
from app.services import backups, photos, pictures, vault

from .conftest import MEDIA, make_account, new_client, person

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"RIFF", b"WEBP", b"Exif", b"ftyp", b"<x:xmpmeta", b"http://ns.adobe.com")


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    yield


@pytest.fixture
def word() -> str:
    return "Qx" + secrets.token_hex(6) + "Zy"


def picture(word: str = "", width: int = 600, height: int = 300, kind: str = "JPEG", **extra: Any) -> bytes:
    """Left half red, right half blue; a camera, a place and the word in its Exif, turned by its orientation (6)."""
    image = Image.new("RGB", (width, height), (220, 30, 30))
    image.paste((30, 30, 220), (width // 2, 0, width, height))
    exif = Image.Exif()
    exif[0x0110] = "Pocket Camera 9"
    exif[0x0112] = 6
    exif[0x010E] = f"description {word}"
    exif[0x8825] = {1: "N", 2: (52.0, 31.0, 12.0), 3: "E", 4: (13.0, 24.0, 0.0)}
    out = io.BytesIO()
    if kind == "HEIF":
        import pillow_heif

        pillow_heif.register_heif_opener()
        image.save(out, "HEIF", exif=exif.tobytes())
    else:
        image.save(out, kind, exif=exif.tobytes(), **extra)
    return out.getvalue()


def upload(client: TestClient, data: bytes, *, date: str = "", upload_id: str | None = None) -> Any:
    params = {"upload_id": upload_id or str(uuid.uuid4())}
    if date:
        params["date"] = date
    return client.post("/api/photos", params=params, content=data)


def kept(client: TestClient, data: bytes, **extra: Any) -> dict[str, Any]:
    answer = upload(client, data, **extra)
    assert answer.status_code == 201, answer.text
    return answer.json()


def media_files() -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in MEDIA.iterdir() if path.is_file()}


def count_photos() -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(Photo)) or 0)


# --- What is kept ---------------------------------------------------------------------------------------------------


def test_a_photo_is_drawn_anew_upright_and_without_anything_but_its_pixels(client: TestClient, account: Account,
                                                                          word: str) -> None:
    xmp = f'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description about="{word}"/></x:xmpmeta>'.encode()
    photo = kept(client, picture(word, xmp=xmp))
    assert photo["date"] == "2026-10-06" and photo["source"] == "upload"
    # Orientation 6 applied: the 600 x 300 picture stands upright as 300 x 600.
    assert (photo["width"], photo["height"]) == (300, 600)
    for path in ("", "/preview"):
        served = client.get(f"/api/photos/{photo['id']}{path}")
        assert served.status_code == 200
        assert served.headers["content-type"] == "image/webp"
        assert served.headers["x-content-type-options"] == "nosniff"
        assert served.headers["cache-control"].startswith("private")
        image = Image.open(io.BytesIO(served.content))
        assert image.format == "WEBP"
        assert not image.getexif() and not {"exif", "xmp", "icc_profile"} & set(image.info)
        for needle in (word.encode(), b"Pocket Camera", b"Exif", b"xmpmeta"):
            assert needle not in served.content
        top = image.convert("RGB").getpixel((image.width // 2, 5))
        low = image.convert("RGB").getpixel((image.width // 2, image.height - 5))
        # The red left half is on top now.
        assert top[0] > 150 > top[2] and low[2] > 150 > low[0], (top, low)
    small = Image.open(io.BytesIO(client.get(f"/api/photos/{photo['id']}/preview").content))
    assert max(small.size) <= photos.PREVIEW_EDGE


def test_on_disk_a_photo_is_sealed_under_a_random_name(client: TestClient, account: Account, word: str) -> None:
    photo = kept(client, picture(word))
    files = media_files()
    assert set(files) == {photo["id"], photo["id"] + ".p"}
    for name, data in files.items():
        assert word.encode() not in data and b"Pocket Camera" not in data, name
        for magic in MAGIC:
            assert magic not in data[:64], (name, magic)
        assert data[0] == vault.FORMAT
    # Sealed for this person and this photo: the original does not open as the preview, nor for another person.
    dek = vault.dek_for(account.id)
    original = files[photo["id"]]
    assert vault.open_sealed(dek, original, vault.aad(account.id, "photos", "original", photo["id"]))
    with pytest.raises(vault.SealError):
        vault.open_sealed(dek, original, vault.aad(account.id, "photos", "preview", photo["id"]))


def test_a_large_photo_is_kept_at_most_edge_pixels_and_a_png_keeps_its_transparency(client: TestClient,
                                                                                     account: Account) -> None:
    wide = Image.new("RGB", (3000, 200), (10, 120, 10))
    out = io.BytesIO()
    wide.save(out, "PNG")
    photo = kept(client, out.getvalue())
    assert (photo["width"], photo["height"]) == (photos.EDGE, 171)
    clear = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    out = io.BytesIO()
    clear.save(out, "PNG")
    served = client.get(f"/api/photos/{kept(client, out.getvalue())['id']}")
    assert Image.open(io.BytesIO(served.content)).mode == "RGBA"


def test_heic_from_a_phone_is_taken_and_turned(client: TestClient, account: Account, word: str) -> None:
    photo = kept(client, picture(word, kind="HEIF"))
    assert (photo["width"], photo["height"]) == (300, 600)
    served = client.get(f"/api/photos/{photo['id']}")
    assert word.encode() not in served.content and b"Pocket Camera" not in served.content


def test_a_colour_profile_is_turned_into_srgb_and_not_kept(client: TestClient, account: Account) -> None:
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    image = Image.new("RGB", (50, 50), (200, 100, 50))
    out = io.BytesIO()
    image.save(out, "JPEG", icc_profile=profile)
    assert "icc_profile" in Image.open(io.BytesIO(out.getvalue())).info
    served = client.get(f"/api/photos/{kept(client, out.getvalue())['id']}")
    back = Image.open(io.BytesIO(served.content))
    assert "icc_profile" not in back.info
    red, green, blue = back.convert("RGB").getpixel((25, 25))
    assert abs(red - 200) < 12 and abs(green - 100) < 12 and abs(blue - 50) < 12


def test_the_same_upload_twice_keeps_one_photo_and_no_files_behind(client: TestClient, account: Account) -> None:
    upload_id = str(uuid.uuid4())
    first = upload(client, picture(), upload_id=upload_id)
    second = upload(client, picture(), upload_id=upload_id)
    assert (first.status_code, second.status_code) == (201, 200)
    assert first.json() == second.json()
    assert count_photos() == 1 and len(media_files()) == 2


def test_the_same_upload_at_the_same_moment_keeps_one_photo(account: Account) -> None:
    upload_id = str(uuid.uuid4())
    data = picture()
    start = threading.Barrier(2, timeout=10)
    codes: list[int] = []

    def send() -> None:
        with new_client(account) as browser:
            start.wait()
            codes.append(upload(browser, data, upload_id=upload_id).status_code)

    threads = [threading.Thread(target=send) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(codes) == [200, 201]
    assert count_photos() == 1 and len(media_files()) == 2


def test_a_day_holds_a_limited_number_of_photos(client: TestClient, account: Account,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(photos, "PHOTOS_PER_DAY", 2)
    kept(client, picture())
    kept(client, picture())
    third = upload(client, picture())
    assert third.status_code == 409 and third.json()["detail"]["code"] == "too_many_photos"
    assert count_photos() == 2 and len(media_files()) == 4
    assert kept(client, picture(), date="2026-10-05")["date"] == "2026-10-05"


def test_a_photo_is_listed_with_its_day_and_on_today(client: TestClient, account: Account) -> None:
    yesterday = kept(client, picture(), date="2026-10-05")
    today = kept(client, picture())
    assert [item["id"] for item in client.get("/api/photos", params={"date": "2026-10-05"}).json()] == [yesterday["id"]]
    assert [item["id"] for item in client.get("/api/today").json()["photos"]] == [today["id"]]
    assert upload(client, picture(), date="2026-10-09").json()["detail"]["code"] == "date_in_future"
    assert client.post("/api/photos", params={"upload_id": "nope"}, content=picture()).status_code == 422
    assert client.post("/api/photos", content=picture()).status_code == 422


# --- What is refused ------------------------------------------------------------------------------------------------


def png_claiming(width: int, height: int) -> bytes:
    """A PNG whose header claims a huge picture, with almost nothing behind it."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\0" * 64)) + chunk(b"IEND", b"")


@pytest.mark.parametrize(
    ("name", "data", "code"),
    [
        ("empty", b"", "photo_not_a_picture"),
        ("svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "photo_not_a_picture"),
        ("html named jpg", b"<!doctype html><img src=x onerror=alert(1)>" + b" " * 64, "photo_not_a_picture"),
        ("jpeg magic, then html", b"\xff\xd8\xff\xe0<html><script>alert(1)</script></html>" + b" " * 64,
         "photo_not_a_picture"),
        ("bomb", png_claiming(30_000, 30_000), "photo_too_large"),
        ("gif", b"GIF89a" + b"\0" * 64, "photo_not_a_picture"),
        ("tiff", b"II*\x00" + b"\0" * 64, "photo_not_a_picture"),
        ("pdf", b"%PDF-1.7\n" + b"\0" * 64, "photo_not_a_picture"),
    ],
)
def test_what_is_not_a_photo_is_refused_and_leaves_nothing(client: TestClient, account: Account, name: str,
                                                           data: bytes, code: str) -> None:
    answer = upload(client, data)
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == code, name
    assert count_photos() == 0 and media_files() == {}


def test_a_photo_cut_off_halfway_is_refused(client: TestClient, account: Account) -> None:
    whole = picture(width=400, height=400)
    answer = upload(client, whole[: len(whole) // 2])
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "photo_not_a_picture"
    assert media_files() == {}


def test_a_polyglot_keeps_only_its_pixels(client: TestClient, account: Account) -> None:
    payload = b"<script>alert('polyglot')</script>"
    hidden = io.BytesIO()
    with zipfile.ZipFile(hidden, "w") as archive:
        archive.writestr("evil.html", payload)
    image = Image.new("RGB", (32, 32), (90, 90, 90))
    out = io.BytesIO()
    image.save(out, "PNG")
    photo = kept(client, out.getvalue() + payload + hidden.getvalue())
    served = client.get(f"/api/photos/{photo['id']}").content
    assert payload not in served and b"PK\x03\x04" not in served and b"evil.html" not in served


def test_too_large_a_photo_is_refused_before_it_is_read(client: TestClient, account: Account) -> None:
    assert middleware.LARGE_BODIES["/api/photos"] == pictures.MAX_BYTES
    assert middleware.LARGE_BODIES["/api/auth/avatar"] == pictures.MAX_BYTES
    answer = upload(client, b"\xff\xd8\xff" + b"\0" * pictures.MAX_BYTES)
    assert answer.status_code == 413 and answer.json()["detail"]["max_mb"] == pictures.MAX_BYTES // (1024 * 1024)
    assert media_files() == {}


def test_too_many_pixels_are_refused_before_they_are_unpacked(client: TestClient, account: Account,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pictures, "MAX_PIXELS", 100 * 100)
    answer = upload(client, picture(width=101, height=100))
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "photo_too_large"


# --- Whose it is ----------------------------------------------------------------------------------------------------


def test_a_photo_of_somebody_else_answers_like_one_that_is_not_there(client: TestClient, account: Account) -> None:
    mine = kept(client, picture())
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "meins"}).json()
    with person("bert") as bert:
        theirs = kept(bert, picture())
        their_note = bert.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "seins"}).json()
        for path in (f"/api/photos/{mine['id']}", f"/api/photos/{mine['id']}/preview"):
            assert bert.get(path).status_code == 404
        assert bert.delete(f"/api/photos/{mine['id']}").status_code == 404
        assert bert.put("/api/days/2026-10-06", json={"cover": f"photo:{mine['id']}"}).status_code == 404
        assert bert.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "x",
                                             "photo_id": mine["id"]}).status_code == 404
        assert bert.put(f"/api/notes/{their_note['id']}", json={"text": "seins",
                                                                "photo_id": mine["id"]}).status_code == 404
        # And my own photo on their note: their note is not there for me.
        assert client.put(f"/api/notes/{their_note['id']}", json={"text": "x",
                                                                  "photo_id": mine["id"]}).status_code == 404
        assert bert.get("/api/photos", params={"date": "2026-10-06"}).json() == [theirs]
        assert bert.post("/api/search", json={"q": "meins"}).json()["results"] == []
    assert client.get(f"/api/photos/{theirs['id']}").status_code == 404
    assert client.put(f"/api/notes/{note['id']}", json={"text": "meins", "photo_id": theirs["id"]}).status_code == 404
    assert client.get(f"/api/photos/{mine['id']}").status_code == 200
    # Ids that cannot exist are not found either.
    for bad in ("x", "../nexdiary.db", "A" * 32, "0" * 33):
        assert client.get(f"/api/photos/{bad}").status_code == 404


def test_the_media_folder_is_never_served_as_files(client: TestClient, account: Account) -> None:
    photo = kept(client, picture())
    for path in (f"/media/{photo['id']}", f"/api/media/{photo['id']}", f"/{photo['id']}"):
        assert client.get(path).content != (MEDIA / photo["id"]).read_bytes()


# --- Notes and covers -----------------------------------------------------------------------------------------------


def test_a_note_carries_a_photo_and_may_be_without_words(client: TestClient, account: Account) -> None:
    photo = kept(client, picture())
    note_id = str(uuid.uuid4())
    made = client.post("/api/notes", json={"id": note_id, "text": "", "photo_id": photo["id"]})
    assert made.status_code == 201 and made.json()["photo_id"] == photo["id"] and made.json()["text"] == ""
    again = client.post("/api/notes", json={"id": note_id, "text": "", "photo_id": photo["id"]})
    assert again.status_code == 200
    other = client.post("/api/notes", json={"id": note_id, "text": "", "photo_id": None})
    assert other.status_code == 422 and other.json()["detail"]["code"] == "note_empty"
    assert client.put(f"/api/notes/{note_id}", json={"text": "mit Bild"}).json()["photo_id"] == photo["id"]
    assert client.put(f"/api/notes/{note_id}", json={"text": "", "photo_id": None}).json()["detail"]["code"] == \
        "note_empty"
    assert client.put(f"/api/notes/{note_id}", json={"text": "ohne", "photo_id": None}).json()["photo_id"] is None


def test_deleting_a_photo_deletes_its_files_and_its_place_on_notes_and_covers(client: TestClient,
                                                                              account: Account) -> None:
    photo = kept(client, picture())
    note = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "x", "photo_id": photo["id"]}).json()
    day = client.put("/api/days/2026-10-06", json={"text": "Ein Tag.", "cover": f"photo:{photo['id']}",
                                                   "tags": ["urlaub"]}).json()
    assert day["cover"] == f"photo:{photo['id']}" and day["cover_chosen"] is True
    assert client.delete(f"/api/photos/{photo['id']}").status_code == 204
    assert media_files() == {} and count_photos() == 0
    assert client.get("/api/notes", params={"date": "2026-10-06"}).json()[0]["photo_id"] is None
    assert note["photo_id"] == photo["id"]
    # The day falls back to its suggestion, never to nothing.
    fallen = client.get("/api/days/2026-10-06").json()
    assert fallen["cover"] == "illu:strand.abend.herbst" and fallen["cover_chosen"] is False
    assert client.delete(f"/api/photos/{photo['id']}").status_code == 404


def test_deleting_an_account_deletes_its_photo_files(client: TestClient, account: Account) -> None:
    kept(client, picture())
    bert = make_account("bert")
    with new_client(bert) as browser:
        kept(browser, picture())
        kept(browser, picture(), date="2026-10-01")
    assert len(media_files()) == 6
    from .conftest import PASSWORD

    answer = client.request("DELETE", f"/api/accounts/{bert.id}", json={"current_password": PASSWORD})
    assert answer.status_code == 204, answer.text
    assert len(media_files()) == 2 and count_photos() == 1


def test_a_backup_carries_the_sealed_photo_files_and_no_master_key(client: TestClient, account: Account,
                                                                   word: str) -> None:
    photo = kept(client, picture(word))
    path = backups.create(note="photos")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert backups.MEDIA_PREFIX + photo["id"] in names and backups.MEDIA_PREFIX + photo["id"] + ".p" in names
        assert not any(name.endswith("master.key") for name in names)
        everything = b"".join(archive.read(name) for name in names)
    master = Path(vault.master_key_path()).read_bytes()
    assert master.splitlines()[1] not in everything
    assert word.encode() not in everything and b"Pocket Camera" not in everything


def test_two_photos_at_once_both_decode_within_the_ration(client: TestClient, account: Account) -> None:
    """The decoder ration is a semaphore, not a lock that would refuse the second."""
    data = picture()
    results: list[int] = []

    def send() -> None:
        with new_client(account) as browser:
            results.append(upload(browser, data).status_code)

    threads = [threading.Thread(target=send) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [201, 201, 201]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Note)) == 0


def test_when_every_decoder_is_taken_the_server_says_busy(client: TestClient, account: Account,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pictures, "_decoders", threading.BoundedSemaphore(1))
    monkeypatch.setattr(pictures, "DECODER_WAIT_SECONDS", 0.05)
    assert pictures._decoders.acquire()
    answer = upload(client, picture())
    assert answer.status_code == 503 and answer.json()["detail"]["code"] == "busy"
    assert answer.headers["retry-after"] == "5"
    assert media_files() == {} and count_photos() == 0
    pictures._decoders.release()
    assert upload(client, picture()).status_code == 201


@pytest.mark.parametrize("kind", ["GIF", "BMP", "TIFF", "ICO", "PPM"])
def test_a_whole_picture_of_a_kind_that_is_no_photo_is_refused(client: TestClient, account: Account, kind: str) -> None:
    """Whole, readable pictures, which the decoder would open: refused by their first bytes alone."""
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 200)).save(out, kind)
    answer = upload(client, out.getvalue())
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "photo_not_a_picture", kind
    assert media_files() == {}


def test_a_photo_of_somebody_else_is_not_even_opened(client: TestClient, account: Account,
                                                    caplog: pytest.LogCaptureFixture) -> None:
    """The owner is checked before the file is touched: the sealing would refuse it too, but nobody's file is read
    on somebody else's behalf."""
    mine = kept(client, picture())
    opened: list[str] = []
    original = Path.read_bytes

    def watched(path: Path) -> bytes:
        if path.parent == MEDIA:
            opened.append(path.name)
        return original(path)

    with person("bert") as bert, pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "read_bytes", watched)
        assert bert.get(f"/api/photos/{mine['id']}").status_code == 404
        assert bert.get(f"/api/photos/{mine['id']}/preview").status_code == 404
    assert opened == []
    assert "did not open" not in caplog.text


def test_the_original_and_its_smaller_copy_are_sealed_apart(client: TestClient, account: Account) -> None:
    """Each file is bound to its part: swapped on disk, neither opens as the other."""
    photo = kept(client, picture())
    original, small = MEDIA / photo["id"], MEDIA / (photo["id"] + ".p")
    a, b = original.read_bytes(), small.read_bytes()
    original.write_bytes(b)
    small.write_bytes(a)
    assert client.get(f"/api/photos/{photo['id']}").status_code == 404
    assert client.get(f"/api/photos/{photo['id']}/preview").status_code == 404


def test_a_draft_does_not_keep_a_deleted_photo_as_its_cover(client: TestClient, account: Account) -> None:
    photo = kept(client, picture())
    assert client.put("/api/days/2026-10-06/draft", json={"text": "x", "cover": f"photo:{photo['id']}",
                                                          "base_revision": -1}).status_code == 200
    assert client.get("/api/days/2026-10-06/draft").json()["cover"] == f"photo:{photo['id']}"
    assert client.delete(f"/api/photos/{photo['id']}").status_code == 204
    draft = client.get("/api/days/2026-10-06/draft").json()
    assert draft["cover"] is None and draft["text"] == "x"
    # Saved as it comes back, it goes through.
    saved = client.put("/api/days/2026-10-06", json={"text": draft["text"], "cover": draft["cover"],
                                                     "base_revision": draft["base_revision"]})
    assert saved.status_code == 200 and saved.json()["cover_chosen"] is False
