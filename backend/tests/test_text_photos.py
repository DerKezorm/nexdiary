"""Pictures in the text of a page: only the own scheme ``![caption](photo:<id>)`` and only the person's own photos of
that very day. A stranger's photo, one of another day, one that is gone and one that never was are all removed when
the page is saved and answer alike; any other picture stays what it is (text, never fetched). The pictures are part of
the page: counted in no word, absent from the start of a page in a list, found in the search by their caption only, seen
by the person a day is shared with (and only with the share), and a photo of a note put into the text stays when the
note goes. A locked day changes none of it."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import SessionLocal
from app.models import Account, Photo
from app.services import diary

from .conftest import make_account, new_client
from .test_lock import code, note, shot

DAY = "2026-10-06"
OTHER = "2026-10-05"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 12, 0, tzinfo=UTC))
    yield


def picture(photo: str, caption: str = "") -> str:
    return f"![{caption}](photo:{photo})"


def save(client: TestClient, text: str, day: str = DAY, **extra: Any) -> Any:
    return client.put(f"/api/days/{day}", json={"title": "Kastanien", "text": text, **extra})


def on_note(photo: str) -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(select(Photo.on_note).where(Photo.uid == photo)))


# --- What may stand in a page ------------------------------------------------------------------------------------------


def test_an_own_photo_of_the_day_stays_in_the_text(client: TestClient, account: Account) -> None:
    first = shot(client)["id"]
    text = f"Vorher.\n\n{picture(first, 'Mia am Baum')}\n\nNachher."
    saved = save(client, text)
    assert saved.status_code == 200 and saved.json()["text"] == text
    assert client.get(f"/api/days/{DAY}").json()["text"] == text
    assert diary.text_photo_ids(text) == [first]


def test_a_photo_that_is_not_the_persons_or_not_of_this_day_is_removed(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    other_day = shot(client, OTHER)["id"]
    with new_client(make_account("ben")) as ben:
        theirs = shot(ben)["id"]
    ghost = uuid.uuid4().hex
    text = "\n\n".join(["Anfang.", picture(mine, "meins"), picture(theirs, "fremd"), picture(other_day, "gestern"),
                        picture(ghost, "nie da"), "Ende."])
    saved = save(client, text)
    assert saved.status_code == 200
    kept = saved.json()["text"]
    assert kept == f"Anfang.\n\n{picture(mine, 'meins')}\n\nEnde."
    assert theirs not in kept and other_day not in kept and ghost not in kept
    # A stranger's photo and one that never was answer alike: the same text comes back, nothing says which it was.
    only_theirs = save(client, f"Text.\n\n{picture(theirs)}").json()["text"]
    only_ghost = save(client, f"Text.\n\n{picture(ghost)}").json()["text"]
    assert only_theirs == only_ghost == "Text."


def test_other_pictures_are_not_photos_and_are_kept_as_written(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    odd = ["![x](https://evil.example.com/a.png)", "![x](data:image/png;base64,AAAA)", "![x](javascript:alert(1))",
           f"![x](photo:{mine.upper()})", f"![x](photo:{mine[:-1]})", f"![x](/api/photos/{mine})",
           f"![x](photo:{mine}?a=b)", f"![x]( photo:{mine})"]
    saved = save(client, "\n\n".join(odd))
    assert saved.status_code == 200
    # Nothing but the exact scheme is a photo: the rest is text the editor shows as words and never loads.
    assert diary.text_photo_ids(saved.json()["text"]) == []
    assert on_note(mine) is False


def test_a_photo_in_the_text_of_a_deleted_day_or_a_gone_photo_is_no_trouble_for_saving(
    client: TestClient, account: Account
) -> None:
    gone = shot(client)["id"]
    kept = shot(client)["id"]
    assert save(client, f"{picture(gone)}\n\nUnd {picture(kept)}").status_code == 200
    assert client.delete(f"/api/photos/{gone}").status_code == 204
    # The page still reads; the next save drops the picture that is gone and keeps the other.
    assert gone in client.get(f"/api/days/{DAY}").json()["text"]
    saved = save(client, client.get(f"/api/days/{DAY}").json()["text"] + " Mehr.")
    assert saved.status_code == 200 and gone not in saved.json()["text"] and kept in saved.json()["text"]


def test_a_photo_that_came_with_a_note_and_is_put_in_the_text_is_a_photo_of_the_day(
    client: TestClient, account: Account
) -> None:
    with_note = shot(client, on_note=True)["id"]
    note(client, "am baum", photo_id=with_note)
    assert on_note(with_note) is True
    assert save(client, f"Text {picture(with_note)}").status_code == 200
    assert on_note(with_note) is False
    # Deleting the note leaves it: it is in the page now.
    note_id = client.get(f"/api/notes?date={DAY}").json()[0]["id"]
    assert client.delete(f"/api/notes/{note_id}").status_code == 204
    assert client.get(f"/api/photos/{with_note}/preview").status_code == 200
    assert [photo["id"] for photo in client.get(f"/api/photos?date={DAY}").json()] == [with_note]


def test_a_locked_day_takes_no_picture_and_loses_none(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    free = shot(client, on_note=True)["id"]
    text = f"Ein Tag {picture(mine)}"
    assert save(client, text).status_code == 200
    assert client.post(f"/api/days/{DAY}/lock").status_code == 200
    assert code(save(client, f"{text} {picture(free)}")) == (409, "day_locked")
    assert client.get(f"/api/days/{DAY}").json()["text"] == text
    # Not by the way of the helper either.
    with SessionLocal() as db:
        owner = db.scalar(select(Account.id).where(Account.name == "tester"))
        diary.adopt_text_photos(db, owner, DAY, picture(free))
    assert on_note(free) is True
    # Nor can the photo be deleted from under it.
    assert code(client.delete(f"/api/photos/{mine}")) == (409, "day_locked")


# --- Reading, lists, counts ---------------------------------------------------------------------------------------------


def test_words_the_start_of_a_page_and_the_search_do_not_see_the_syntax(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    text = f"Drei einfache Worte.\n\n{picture(mine, 'Unterschrift Eichel')}\n\nUnd noch zwei."
    saved = save(client, text).json()
    assert saved["words"] == 6, "three, and two, and the one of the caption is not counted"
    [entry] = client.post("/api/journal", json={}).json()["days"]
    assert entry["excerpt"] == "Drei einfache Worte. Und noch zwei."
    assert "photo" not in entry["excerpt"] and mine not in entry["excerpt"]
    # The search finds what a caption says, never the scheme or the id.
    found = client.post("/api/search", json={"q": "Eichel"}).json()["results"]
    assert [(hit["date"], hit["kind"]) for hit in found] == [(DAY, "text")]
    assert "photo:" not in found[0]["snippet"] and mine not in found[0]["snippet"]
    assert client.post("/api/search", json={"q": mine}).json()["results"] == []
    assert client.post("/api/search", json={"q": "photo:"}).json()["results"] == []
    stats = client.get("/api/stats").json()
    assert stats["tiles"]["words"] == 6


def test_a_long_page_cut_inside_a_picture_leaves_no_half_scheme(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    text = ("Wort " * (diary.EXCERPT_SOURCE // 5 + 20))[: diary.EXCERPT_SOURCE - 10] + picture(mine, "ein langes bild")
    assert len(text) > diary.EXCERPT_SOURCE
    shown = diary.excerpt(text)
    assert "photo" not in shown and "![" not in shown


# --- The person a day is shared with ------------------------------------------------------------------------------------


def test_the_person_a_day_is_shared_with_sees_the_pictures_of_the_text_and_nothing_else(
    client: TestClient, account: Account
) -> None:
    in_text = shot(client)["id"]
    on_page = shot(client)["id"]
    secret = shot(client, on_note=True)["id"]
    note(client, "heimliche notiz", photo_id=secret)
    other_day = shot(client, OTHER)["id"]
    assert save(client, f"Ein Tag\n\n{picture(in_text, 'sichtbar')}").status_code == 200
    ben_account = make_account("ben")
    mia_account = make_account("mia")
    path = f"/api/shared/{account.id}/{DAY}"
    with new_client(ben_account) as ben, new_client(mia_account) as mia:
        # Before the share: nothing, for anyone.
        for found in (in_text, on_page, secret):
            assert ben.get(f"{path}/photos/{found}").status_code == 404
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_account.id]}).status_code == 200
        view = ben.get(path).json()
        assert view["text"].count(f"photo:{in_text}") == 1
        # The picture of the text is not listed a second time; the other photo of the day is.
        assert [photo["id"] for photo in view["photos"]] == [on_page]
        assert ben.get(f"{path}/photos/{in_text}").status_code == 200
        assert ben.get(f"{path}/photos/{in_text}/preview").status_code == 200
        assert ben.get(f"{path}/photos/{on_page}").status_code == 200
        # A note's photo not in the text stays hidden without "share the notes"; one of another day always.
        assert ben.get(f"{path}/photos/{secret}").status_code == 404
        assert ben.get(f"{path}/photos/{other_day}").status_code == 404
        # A third person sees none of it.
        for found in (in_text, on_page):
            assert mia.get(f"{path}/photos/{found}").status_code == 404
        # Taking the share back takes the pictures away at once.
        assert client.delete(f"/api/days/{DAY}/shares").status_code == 204
        assert ben.get(f"{path}/photos/{in_text}").status_code == 404


def test_a_note_photo_in_the_text_is_seen_with_the_text_even_without_the_notes(
    client: TestClient, account: Account
) -> None:
    secret = shot(client, on_note=True)["id"]
    stays = shot(client, on_note=True)["id"]
    note(client, "erste notiz", photo_id=secret)
    note(client, "zweite notiz", photo_id=stays)
    assert save(client, f"Text {picture(secret)}").status_code == 200
    ben_account = make_account("ben")
    path = f"/api/shared/{account.id}/{DAY}"
    with new_client(ben_account) as ben:
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_account.id], "with_notes": False}).status_code == 200
        assert ben.get(f"{path}/photos/{secret}").status_code == 200, "put into the text on purpose"
        assert ben.get(f"{path}/photos/{stays}").status_code == 404, "the other note's photo stays with its note"
        assert "notes" not in ben.get(path).json()


def test_the_pictures_of_a_day_are_not_a_way_to_another_day(client: TestClient, account: Account) -> None:
    """A photo of another day cannot be smuggled into a shared day by putting it into the text."""
    other_day = shot(client, OTHER)["id"]
    saved = save(client, f"Text {picture(other_day)}").json()
    assert other_day not in saved["text"]
    ben_account = make_account("ben")
    with new_client(ben_account) as ben:
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_account.id]}).status_code == 200
        assert ben.get(f"/api/shared/{account.id}/{DAY}/photos/{other_day}").status_code == 404


# --- A photo the page holds stays with the page --------------------------------------------------------------------------


def test_a_photo_in_the_text_goes_neither_with_its_note_nor_with_its_move(client: TestClient, account: Account) -> None:
    held = shot(client, on_note=True)["id"]
    first = note(client, "mit foto", photo_id=held)
    assert save(client, f"Text {picture(held)}").status_code == 200
    # Put on a note again (the photo is marked as a note's once more): the page still holds it.
    second = note(client, "noch eine notiz", photo_id=held)
    assert on_note(held) is True
    # Moving a note to the day before leaves the photo where the page holds it.
    moved = client.post(f"/api/notes/{first['id']}/move", json={"direction": "previous"})
    assert moved.status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(Photo.date).where(Photo.uid == held)) == DAY
    # Deleting the notes leaves it too: it is in the text.
    assert client.delete(f"/api/notes/{second['id']}").status_code == 204
    assert client.delete(f"/api/notes/{moved.json()['id']}").status_code == 204
    assert client.get(f"/api/photos/{held}/preview").status_code == 200
    assert client.get(f"/api/days/{DAY}").json()["text"] == f"Text {picture(held)}"


def test_a_photo_that_is_only_a_notes_goes_with_its_note_as_before(client: TestClient, account: Account) -> None:
    loose = shot(client, on_note=True)["id"]
    gone = note(client, "mit foto", photo_id=loose)
    assert client.delete(f"/api/notes/{gone['id']}").status_code == 204
    assert client.get(f"/api/photos/{loose}/preview").status_code == 404


def test_a_note_photo_in_the_text_is_seen_by_the_receiver_even_where_a_note_holds_it_again(
    client: TestClient, account: Account
) -> None:
    held = shot(client, on_note=True)["id"]
    note(client, "erste notiz", photo_id=held)
    assert save(client, f"Text {picture(held)}").status_code == 200
    note(client, "zweite notiz", photo_id=held)
    assert on_note(held) is True
    ben_account = make_account("ben")
    with new_client(ben_account) as ben:
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_account.id], "with_notes": False}).status_code == 200
        assert ben.get(f"/api/shared/{account.id}/{DAY}/photos/{held}").status_code == 200
