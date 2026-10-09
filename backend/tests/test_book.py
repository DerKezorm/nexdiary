"""A year as a book: the PDF opens and holds the year's own pages and nothing of anybody else, it never lies on the
disk in the clear (while it is set nor after), only its person fetches it, once, it goes after the download and after
its time, a second book waits while one is set, and a book that takes too long is stopped."""

from __future__ import annotations

import io
import threading
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader

from app import clock
from app.services import book, book_art, book_text

from .conftest import DATA_DIR, person

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fixed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOW)
    book.forget()
    yield
    book.checkpoint = None
    book.forget()


def picture(colour: tuple[int, int, int] = (90, 122, 82)) -> bytes:
    image = Image.new("RGB", (800, 500), colour)
    out = io.BytesIO()
    image.save(out, "JPEG")
    return out.getvalue()


def write(client: TestClient, day: str, title: str, text: str = "", **extra: Any) -> dict[str, Any]:
    answer = client.put(f"/api/days/{day}", json={"title": title, "text": text, **extra})
    assert answer.status_code == 200, answer.text
    return answer.json()


def photo(client: TestClient, day: str) -> str:
    answer = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": day}, content=picture())
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def wait(client: TestClient, job: str, seconds: float = 60) -> dict[str, Any]:
    deadline = time.monotonic() + seconds
    while True:
        found = client.get(f"/api/book/{job}").json()
        if found["state"] != "working":
            return found
        assert time.monotonic() < deadline, "the book took too long in the test"
        time.sleep(0.05)


def made(client: TestClient, year: int = 2026, **options: Any) -> tuple[dict[str, Any], bytes]:
    answer = client.post("/api/book", json={"year": year, **options})
    assert answer.status_code == 202, answer.text
    done = wait(client, answer.json()["id"])
    assert done["state"] == "done", done
    pdf = client.get(f"/api/book/{done['id']}/pdf")
    assert pdf.status_code == 200
    return done, pdf.content


def text_of(pdf: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def files_under(root: Path) -> Iterator[Path]:
    for path in root.rglob("*"):
        if path.is_file():
            yield path


def nowhere_on_disk(word: bytes) -> None:
    for path in files_under(Path(DATA_DIR)):
        try:
            data = path.read_bytes()
        except OSError:
            continue
        assert word not in data, f"{word!r} in the clear in {path.name}"


# --- The PDF --------------------------------------------------------------------------------------------------------


def test_the_book_opens_with_its_pages_and_holds_the_titles_of_the_year() -> None:
    with person("jule") as jule:
        jule.put("/api/me/preferences", json={"timezone": "Europe/Berlin"})
        jule.put("/api/me/language", json={"language": "de"})
        write(jule, "2026-01-03", "Schnee im Garten", "Wir haben **gebaut**, und *viel* gelacht.\n\n> Ein Satz.")
        write(jule, "2026-03-14", "Am See", "## Mittag\n\n- Brot\n- Käse\n\n1. eins\n2. zwei")
        write(jule, "2026-03-15", "Regen", "Nur Regen.")
        write(jule, "2025-12-31", "Silvester", "Das alte Jahr.")
        done, pdf = made(jule)
    reader = PdfReader(io.BytesIO(pdf))
    # Title, contents, two chapters (January, March), three days.
    assert len(reader.pages) == done["pages"] == 2 + 2 + 3
    text = text_of(pdf)
    for title in ("Schnee im Garten", "Am See", "Regen", "Januar", "März", "Inhalt", "Das Tagebuch von jule"):
        assert title in text
    assert "Silvester" not in text


def test_the_contents_name_the_page_each_month_begins_on() -> None:
    with person("jule") as jule:
        jule.put("/api/me/language", json={"language": "de"})
        write(jule, "2026-01-03", "Eins")
        write(jule, "2026-02-03", "Zwei")
        _done, pdf = made(jule)
    contents = PdfReader(io.BytesIO(pdf)).pages[1].extract_text()
    words = " ".join(contents.replace(".", " ").split())
    assert "Januar 3 Februar 5" in words


def test_options_values_and_notes_appear_only_when_asked_for() -> None:
    with person("jule") as jule:
        jule.put("/api/me/language", json={"language": "de"})
        values = {item["name"]: item["id"] for item in jule.get("/api/values").json()}
        write(jule, "2026-05-01", "Maifeiertag", "Text.", values={values["Stimmung"]: 8})
        jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "rohe notiz zum mai", "date": "2026-05-01"})
        _done, plain = made(jule)
        _done, full = made(jule, values=True, notes=True, format="a4")
    assert "Stimmung 8/10" not in text_of(plain) and "rohe notiz zum mai" not in text_of(plain)
    assert "Stimmung 8/10" in text_of(full) and "rohe notiz zum mai" in text_of(full)
    assert "Rohnotizen" in text_of(full)
    width = float(PdfReader(io.BytesIO(full)).pages[0].mediabox.width)
    assert round(width) == 595  # A4


def test_covers_and_photos_go_in_and_stay_out_when_switched_off() -> None:
    with person("jule") as jule:
        uid = photo(jule, "2026-06-01")
        write(jule, "2026-06-01", "Mit Foto", f"Davor.\n\n![](photo:{uid})\n\nDanach.", cover=f"photo:{uid}")
        write(jule, "2026-06-02", "Mit Bild", "Text.", cover="illu:berge.abend.sommer")
        _done, with_photos = made(jule)
        _done, without = made(jule, photos=False)
    images = sum(len(page.images) for page in PdfReader(io.BytesIO(with_photos)).pages)
    assert images >= 2
    assert sum(len(page.images) for page in PdfReader(io.BytesIO(without)).pages) == 0
    assert len(with_photos) > len(without)


def test_nothing_of_another_account_goes_into_the_book() -> None:
    with person("jule") as jule, person("ben") as ben:
        write(jule, "2026-04-01", "Jules Tag")
        write(ben, "2026-04-01", "Bens Geheimnis", "nur für ben")
        uid = photo(ben, "2026-04-02")
        # A photo of somebody else in the own text is never fetched (the server drops it when the page is saved).
        write(jule, "2026-04-02", "Versuch", f"![](photo:{uid})")
        _done, pdf = made(jule)
    text = text_of(pdf)
    assert "Jules Tag" in text and "Bens Geheimnis" not in text and "nur für ben" not in text
    assert sum(len(page.images) for page in PdfReader(io.BytesIO(pdf)).pages) == 0


def test_a_locked_day_belongs_in_the_book() -> None:
    with person("jule") as jule:
        write(jule, "2026-02-02", "Verschlossen")
        assert jule.post("/api/days/2026-02-02/lock").status_code == 200
        _done, pdf = made(jule)
    assert "Verschlossen" in text_of(pdf)


def test_a_year_without_a_page_is_refused() -> None:
    with person("jule") as jule:
        write(jule, "2025-02-02", "Letztes Jahr")
        answer = jule.post("/api/book", json={"year": 2026})
    assert answer.status_code == 409 and answer.json()["detail"]["code"] == "book_empty"


# --- The disk, the download -----------------------------------------------------------------------------------------


def test_the_book_is_never_on_the_disk_in_the_clear_while_it_is_set_nor_after() -> None:
    seen: list[str] = []

    def look(step: str) -> None:
        seen.append(step)
        if step in ("day", "sealed"):
            # The PDF says "%PDF" first and names its producer; neither may lie anywhere in the data folder.
            nowhere_on_disk(b"%PDF")
            nowhere_on_disk(b"Kohlrabiwunder")

    with person("jule") as jule:
        write(jule, "2026-07-07", "Kohlrabiwunder", "Kohlrabiwunder im Garten.")
        book.checkpoint = look
        answer = jule.post("/api/book", json={"year": 2026})
        done = wait(jule, answer.json()["id"])
        assert done["state"] == "done"
        assert "sealed" in seen and "day" in seen
        sealed = list((Path(DATA_DIR) / "books").iterdir())
        assert len(sealed) == 1 and b"%PDF" not in sealed[0].read_bytes()
        pdf = jule.get(f"/api/book/{done['id']}/pdf")
        assert pdf.content.startswith(b"%PDF")
    nowhere_on_disk(b"%PDF")
    assert list((Path(DATA_DIR) / "books").iterdir()) == []


def test_only_the_person_fetches_the_book_and_only_once() -> None:
    with person("jule") as jule, person("ben") as ben:
        write(jule, "2026-03-03", "Drei")
        answer = jule.post("/api/book", json={"year": 2026})
        job = answer.json()["id"]
        wait(jule, job)
        assert ben.get(f"/api/book/{job}").status_code == 404
        assert ben.get(f"/api/book/{job}/pdf").status_code == 404
        assert ben.delete(f"/api/book/{job}").status_code == 404
        first = jule.get(f"/api/book/{job}/pdf")
        assert first.status_code == 200
        assert first.headers["content-disposition"] == 'attachment; filename="nexdiary-2026.pdf"'
        assert "no-store" in first.headers["cache-control"]
        assert jule.get(f"/api/book/{job}/pdf").status_code == 404
        assert jule.get(f"/api/book/{job}").status_code == 404
        assert jule.get("/api/book/not-a-job").status_code == 404


def test_a_book_nobody_fetched_is_gone_after_its_time(monkeypatch: pytest.MonkeyPatch) -> None:
    moment = [1000.0]
    monkeypatch.setattr(book, "ticks", lambda: moment[0])
    with person("jule") as jule:
        write(jule, "2026-03-03", "Drei")
        job = jule.post("/api/book", json={"year": 2026}).json()["id"]
        assert wait(jule, job)["state"] == "done"
        assert len(list((Path(DATA_DIR) / "books").iterdir())) == 1
        moment[0] += book.KEEP_SECONDS - 1
        assert jule.get(f"/api/book/{job}").status_code == 200
        moment[0] += 2
        assert jule.get(f"/api/book/{job}").status_code == 404
    assert list((Path(DATA_DIR) / "books").iterdir()) == []


def test_a_second_book_waits_while_one_is_set_and_one_person_sets_one_at_a_time() -> None:
    gate = threading.Event()
    inside = threading.Event()

    def hold(step: str) -> None:
        if step == "day":
            inside.set()
            gate.wait(10)

    with person("jule") as jule, person("ben") as ben:
        write(jule, "2026-03-03", "Drei")
        write(ben, "2026-03-03", "Bens")
        book.checkpoint = hold
        job = jule.post("/api/book", json={"year": 2026}).json()["id"]
        assert inside.wait(10)
        busy = ben.post("/api/book", json={"year": 2026})
        assert busy.status_code == 503 and busy.json()["detail"]["code"] == "book_busy"
        again = jule.post("/api/book", json={"year": 2026})
        assert again.status_code == 409 and again.json()["detail"]["code"] == "book_running"
        gate.set()
        assert wait(jule, job)["state"] == "done"
        book.checkpoint = None
        assert ben.post("/api/book", json={"year": 2026}).status_code == 202


def test_books_per_hour_are_braked(monkeypatch: pytest.MonkeyPatch) -> None:
    with person("jule") as jule:
        write(jule, "2026-03-03", "Drei")
        for _ in range(book.PER_HOUR):
            job = jule.post("/api/book", json={"year": 2026})
            assert job.status_code == 202
            wait(jule, job.json()["id"])
        refused = jule.post("/api/book", json={"year": 2026})
    assert refused.status_code == 429 and refused.json()["detail"]["code"] == "book_too_often"
    assert int(refused.headers["retry-after"]) > 0


def test_a_book_that_takes_too_long_is_stopped_and_leaves_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    moment = [0.0]
    monkeypatch.setattr(book, "ticks", lambda: moment[0])

    def late(step: str) -> None:
        if step == "day":
            moment[0] += book.JOB_SECONDS + 1

    with person("jule") as jule:
        write(jule, "2026-03-03", "Drei")
        book.checkpoint = late
        job = jule.post("/api/book", json={"year": 2026}).json()["id"]
        done = wait(jule, job)
        assert done["state"] == "failed" and done["error"] == "book_too_long"
        assert jule.get(f"/api/book/{job}/pdf").status_code == 404
    assert list((Path(DATA_DIR) / "books").iterdir()) == []


def test_a_book_given_up_while_it_is_set_stops() -> None:
    gate = threading.Event()
    inside = threading.Event()

    def hold(step: str) -> None:
        if step == "day":
            inside.set()
            gate.wait(10)

    with person("jule") as jule:
        write(jule, "2026-03-03", "Drei")
        book.checkpoint = hold
        job = jule.post("/api/book", json={"year": 2026}).json()["id"]
        assert inside.wait(10)
        assert jule.delete(f"/api/book/{job}").status_code == 204
        gate.set()
        deadline = time.monotonic() + 10
        while jule.get(f"/api/book/{job}").status_code == 200:
            assert time.monotonic() < deadline
            time.sleep(0.05)
    assert list((Path(DATA_DIR) / "books").iterdir()) == []


def test_leftovers_of_a_last_run_go_at_the_start() -> None:
    folder = Path(DATA_DIR) / "books"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "old.sealed").write_bytes(b"x")
    book.startup()
    assert not folder.exists() or list(folder.iterdir()) == []


def test_a_sealed_file_cut_short_or_changed_does_not_open(tmp_path: Path) -> None:
    key = bytes(range(32))
    path = tmp_path / "x.sealed"
    writer = book.SealedWriter(path, key, b"label")
    writer.write(b"a" * (book.CHUNK * 2 + 10))
    writer.close()
    assert b"".join(book.unsealed(path, key, b"label")) == b"a" * (book.CHUNK * 2 + 10)
    whole = path.read_bytes()
    first = int.from_bytes(whole[:4], "big") + 4
    path.write_bytes(whole[:first])
    with pytest.raises(ValueError):
        b"".join(book.unsealed(path, key, b"label"))
    path.write_bytes(whole)
    with pytest.raises(Exception):  # noqa: B017 - the tag does not fit under another label
        b"".join(book.unsealed(path, key, b"other"))


# --- Text and pictures ----------------------------------------------------------------------------------------------


def test_markdown_becomes_well_formed_markup_whatever_the_marks() -> None:
    assert book_text.inline("a **b** *c* _d_ snake_case \\*e\\* <x> & y") == (
        "a <b>b</b> <i>c</i> <i>d</i> snake_case *e* &lt;x&gt; &amp; y")
    # Marks that are never closed still give markup that opens and closes.
    for odd in ("**a", "*a **b", "***", "_a*b**c_", "a_" * 50):
        markup = book_text.inline(odd)
        assert markup.count("<b>") == markup.count("</b>") and markup.count("<i>") == markup.count("</i>")
    kinds = [block.kind for block in book_text.blocks("# H\n\ntext\nmore\n\n> q\n- a\n1. b\n\n![x](photo:" + "a" * 32 +
                                                       "#rot=90)")]
    assert kinds == ["heading", "paragraph", "quote", "bullet", "number", "photo"]
    assert book_text.cut_of("crop=0,0,500,500&rot=90") == ((0, 0, 500, 500), 90)
    assert book_text.cut_of("crop=1,2") == (None, 0)


def test_a_strange_text_is_read_in_good_time() -> None:
    started = time.perf_counter()
    for text in ("*" * 100_000, "_a" * 50_000, "![" * 50_000, "\\" * 100_000, "# " * 50_000, "> " * 50_000):
        book_text.blocks(text)
    assert time.perf_counter() - started < 5


def test_every_illustration_is_known_and_draws() -> None:
    from reportlab.pdfgen.canvas import Canvas

    from app.services import covers

    out = io.BytesIO()
    canvas = Canvas(out)
    for name in sorted(covers.ILLUSTRATIONS):
        assert book_art.known(name)
        book_art.place(canvas, name, 0, 0, 160, 90)
    canvas.showPage()
    canvas.save()
    assert out.getvalue().startswith(b"%PDF")
