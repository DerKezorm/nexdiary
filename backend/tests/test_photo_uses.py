"""Photos taken for the text, what uses a photo, and deleting it.

* A photo taken with the picture button of the text (upload or Immich, ``text``) is marked ``for_text``; chosen again
  on purpose without it (a photo of the day, a cover) it stays for good.
* Saving the page and throwing the draft away tidy those photos of the day that nothing holds any more (not the text or
  the cover of the page, not a note, not the draft), rows and files; never while the draft is only kept, never on a
  locked day, never a photo just taken.
* Deleting a photo takes it out of every place it shows (text of page and draft, cover with its crop, notes), in one
  transaction; a locked day refuses. Several at once: each on its own.
* What uses a photo, the library of all photos a page at a time, and the storage: each person their own only, the
  operator included.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import SessionLocal
from app.models import Account, Photo
from app.services import diary, photos

from .conftest import MEDIA, make_account, new_client, person
from .test_immich import Lookups, address, connect, made_key, open_immich
from .test_lock import code
from .test_photos import picture

DAY = "2026-10-06"
OTHER = "2026-10-05"
START = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = START

    def later(self, minutes: float = 5) -> None:
        self.now += timedelta(minutes=minutes)


@pytest.fixture(autouse=True)
def moment(monkeypatch: pytest.MonkeyPatch) -> Iterator[Clock]:
    found = Clock()
    monkeypatch.setattr(clock, "now", lambda: found.now)
    yield found


def shot(client: TestClient, day: str = DAY, **flags: bool) -> dict[str, Any]:
    params: dict[str, str] = {"upload_id": str(uuid.uuid4()), "date": day}
    params.update({name: str(value).lower() for name, value in flags.items()})
    answer = client.post("/api/photos", params=params, content=picture())
    assert answer.status_code == 201, answer.text
    return answer.json()


def image(photo: str, caption: str = "") -> str:
    return f"![{caption}](photo:{photo})"


def exists(photo: str) -> bool:
    with SessionLocal() as db:
        return db.scalar(select(Photo.id).where(Photo.uid == photo)) is not None


def files_of(photo: str) -> list[Path]:
    return [path for path in (MEDIA / photo, MEDIA / f"{photo}.p") if path.exists()]


def gone(photo: str) -> bool:
    return not exists(photo) and files_of(photo) == []


def note_with(client: TestClient, photo: str, day: str = DAY, words: str = "notiz") -> dict[str, Any]:
    answer = client.post("/api/notes", json={"id": str(uuid.uuid4()), "text": words, "date": day, "photo_id": photo})
    assert answer.status_code == 201, answer.text
    return answer.json()


# --- Where a photo comes from ---------------------------------------------------------------------------------------


def test_a_photo_for_the_text_is_marked_and_no_other(client: TestClient, account: Account) -> None:
    for_text = shot(client, text=True)
    plain = shot(client)
    for_note = shot(client, note=True)
    assert (for_text["for_text"], plain["for_text"], for_note["for_text"]) == (True, False, False)
    listed = {photo["id"]: photo["for_text"] for photo in client.get(f"/api/photos?date={DAY}").json()}
    assert listed == {for_text["id"]: True, plain["id"]: False, for_note["id"]: False}
    # For a note and for the text at once is no photo anybody takes.
    answer = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY, "note": "true",
                                                "text": "true"}, content=picture())
    assert code(answer) == (422, "invalid_input")
    # The same upload sent again is the same photo, marked as it was.
    upload_id = str(uuid.uuid4())
    first = client.post("/api/photos", params={"upload_id": upload_id, "date": DAY, "text": "true"},
                        content=picture())
    again = client.post("/api/photos", params={"upload_id": upload_id, "date": DAY}, content=picture())
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"] and again.json()["for_text"] is True


@pytest.fixture
def immich_ready(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch,
                 moment: Clock) -> Iterator[list[Any]]:
    from app.services import immich

    from .fake_immich import Asset, FakeImmich

    found = Lookups()
    monkeypatch.setattr(immich, "resolver", found)
    moment.now = datetime(2026, 10, 6, 18, 0, tzinfo=UTC)
    fake = FakeImmich()
    try:
        key = made_key()
        assets = [Asset(taken="2026-10-06T05:20:00+00:00"), Asset(taken="2026-10-06T10:18:00+00:00")]
        fake.library(key, *assets)
        open_immich(client)
        connect(client, fake, key, address(fake))
        yield assets
    finally:
        fake.close()


def test_a_photo_of_immich_for_the_text_is_marked_until_it_is_chosen_on_purpose(
    client: TestClient, immich_ready: list[Any]
) -> None:
    first, second = immich_ready
    taken = client.post(f"/api/immich/photos/{first.id}", json={"date": DAY, "text": True})
    assert taken.status_code == 201 and taken.json()["for_text"] is True
    # Taken for the text again: the same photo, still for the text.
    again = client.post(f"/api/immich/photos/{first.id}", json={"date": DAY, "text": True})
    assert again.status_code == 200 and again.json() == taken.json()
    # Chosen as a photo of the day: the same photo, now for good, and it stays so when taken for the text once more.
    chosen = client.post(f"/api/immich/photos/{first.id}", json={"date": DAY})
    assert chosen.status_code == 200 and chosen.json()["id"] == taken.json()["id"]
    assert chosen.json()["for_text"] is False
    assert client.post(f"/api/immich/photos/{first.id}", json={"date": DAY, "text": True}).json()["for_text"] is False
    # Chosen first, then for the text: never marked.
    plain = client.post(f"/api/immich/photos/{second.id}", json={"date": DAY})
    assert plain.status_code == 201 and plain.json()["for_text"] is False
    assert client.post(f"/api/immich/photos/{second.id}", json={"date": DAY, "text": True}).json()["for_text"] is False
    assert code(client.post(f"/api/immich/photos/{first.id}", json={"date": DAY, "text": True, "note": True})) == (
        422, "invalid_input")


# --- Tidying when the page is saved -----------------------------------------------------------------------------------


def test_saving_the_page_tidies_the_photos_for_the_text_nothing_holds(
    client: TestClient, account: Account, moment: Clock
) -> None:
    in_text = shot(client, text=True)["id"]
    taken_out = shot(client, text=True)["id"]
    as_cover = shot(client, text=True)["id"]
    on_a_note = shot(client, text=True)["id"]
    in_draft = shot(client, text=True)["id"]
    of_the_day = shot(client)["id"]
    other_day = shot(client, OTHER, text=True)["id"]
    note_with(client, on_a_note)
    assert files_of(taken_out), "its files are there"
    page = f"Anfang\n\n{image(in_text)}\n\n{image(taken_out)}"
    assert client.put(f"/api/days/{DAY}", json={"title": "T", "text": page, "base_revision": -1}).status_code == 200
    # The draft of a second device holds one; the cover holds another.
    draft = client.put(f"/api/days/{DAY}/draft", json={"text": f"Neu {image(in_draft)}", "base_revision": 0})
    assert draft.status_code == 200
    moment.later()
    saved = client.put(f"/api/days/{DAY}", json={"text": f"Anfang\n\n{image(in_text)}", "cover": f"photo:{as_cover}"})
    assert saved.status_code == 200
    assert gone(taken_out), "taken out of the text: row and files gone"
    for kept in (in_text, as_cover, on_a_note, in_draft, of_the_day, other_day):
        assert exists(kept) and files_of(kept), kept
    # Saved with its draft (the writing view): the draft is over, and what only it held goes too.
    moment.later()
    final = client.put(f"/api/days/{DAY}", json={"text": "Ohne Bilder", "base_revision": 1})
    assert final.status_code == 200
    assert gone(in_draft) and gone(in_text)
    for kept in (as_cover, on_a_note, of_the_day, other_day):
        assert exists(kept), kept


def test_a_photo_just_taken_for_the_text_is_not_tidied(client: TestClient, account: Account, moment: Clock) -> None:
    """It may be on its way into the text of another device."""
    young = shot(client, text=True)["id"]
    moment.later(3 / 60)
    assert client.put(f"/api/days/{DAY}", json={"text": "Ohne"}).status_code == 200
    assert exists(young)
    moment.later(1)
    assert client.put(f"/api/days/{DAY}", json={"text": "Ohne, noch einmal"}).status_code == 200
    assert gone(young)


def test_keeping_the_draft_tidies_nothing(client: TestClient, account: Account, moment: Clock) -> None:
    photo = shot(client, text=True)["id"]
    assert client.put(f"/api/days/{DAY}/draft", json={"text": image(photo), "base_revision": -1}).status_code == 200
    moment.later()
    assert client.put(f"/api/days/{DAY}/draft", json={"text": "ohne bild", "base_revision": -1}).status_code == 200
    assert exists(photo) and files_of(photo)


def test_throwing_the_draft_away_tidies_what_only_it_held(client: TestClient, account: Account,
                                                          moment: Clock) -> None:
    on_page = shot(client, text=True)["id"]
    only_draft = shot(client, text=True)["id"]
    draft_cover = shot(client, text=True)["id"]
    assert client.put(f"/api/days/{DAY}", json={"text": image(on_page)}).status_code == 200
    body = {"text": f"{image(on_page)} {image(only_draft)}", "cover": f"photo:{draft_cover}", "base_revision": 0}
    assert client.put(f"/api/days/{DAY}/draft", json=body).status_code == 200
    moment.later()
    assert client.delete(f"/api/days/{DAY}/draft").status_code == 204
    assert client.get(f"/api/days/{DAY}/draft").json() is None
    assert gone(only_draft) and gone(draft_cover)
    assert exists(on_page)
    # Thrown away on a day without a page: everything for the text goes.
    lonely = shot(client, OTHER, text=True)["id"]
    assert client.put(f"/api/days/{OTHER}/draft", json={"text": image(lonely), "base_revision": -1}).status_code == 200
    moment.later()
    assert client.delete(f"/api/days/{OTHER}/draft").status_code == 204
    assert gone(lonely)


def test_a_locked_day_is_never_tidied(client: TestClient, account: Account, moment: Clock) -> None:
    loose = shot(client, text=True)["id"]
    assert client.put(f"/api/days/{DAY}", json={"title": "T", "text": "Geschrieben"}).status_code == 200
    assert client.post(f"/api/days/{DAY}/lock").status_code == 200
    moment.later()
    assert code(client.delete(f"/api/days/{DAY}/draft")) == (409, "day_locked")
    with SessionLocal() as db:
        assert diary.tidy_text_photos(db, account.id, _dek(account), DAY) == []
        with pytest.raises(Exception, match="409"):
            diary.tidy_text_photos(db, account.id, _dek(account), DAY, drop_draft=True)
    assert exists(loose) and files_of(loose)


def test_tidying_keeps_everything_when_the_page_changed_in_between(client: TestClient, account: Account,
                                                                    moment: Clock,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    """Another device saves the page with the photo in it between the reading and the deleting: the photo stays."""
    photo = shot(client, text=True)["id"]
    assert client.put(f"/api/days/{DAY}", json={"text": "Ohne"}).status_code == 200
    moment.later()
    real = diary._readable_content
    other = new_client(account)

    def read_then_meet_a_save(*args: Any) -> Any:
        found = real(*args)
        monkeypatch.setattr(diary, "_readable_content", real)
        # The other device puts the photo into the page now.
        assert other.put(f"/api/days/{DAY}", json={"text": f"Mit {image(photo)}"}).status_code == 200
        return found

    monkeypatch.setattr(diary, "_readable_content", read_then_meet_a_save)
    with SessionLocal() as db:
        assert diary.tidy_text_photos(db, account.id, _dek(account), DAY) == []
    other.close()
    assert exists(photo)
    assert photo in client.get(f"/api/days/{DAY}").json()["text"]


def _dek(account: Account) -> bytes:
    from app.services import vault

    return vault.dek_for(account.id)


# --- Deleting a photo -------------------------------------------------------------------------------------------------


def test_deleting_a_photo_takes_it_out_of_every_place(client: TestClient, account: Account) -> None:
    photo = shot(client)["id"]
    other = shot(client)["id"]
    text = f"Vorher\n\n{image(photo, 'weg')}\n\n{image(other, 'bleibt')}\n\nNachher {image(photo)}"
    saved = client.put(f"/api/days/{DAY}", json={"title": "T", "text": text, "cover": f"photo:{photo}",
                                                 "cover_crop": {"x": 300, "y": 400, "zoom": 150}}).json()
    held = note_with(client, photo)
    assert client.put(f"/api/days/{DAY}/draft", json={"text": f"Entwurf {image(photo)} {image(other)}",
                                                      "cover": f"photo:{photo}",
                                                      "base_revision": saved["revision"]}).status_code == 200
    assert client.get(f"/api/photos/{photo}/uses").json() == {
        "cover": True, "text": True, "notes": [{"id": held["id"], "date": DAY}], "date": DAY, "locked": False}
    assert client.delete(f"/api/photos/{photo}").status_code == 204
    assert gone(photo)
    day = client.get(f"/api/days/{DAY}").json()
    assert day["text"] == f"Vorher\n\n{image(other, 'bleibt')}\n\nNachher"
    assert day["revision"] == saved["revision"] + 1
    assert day["cover_chosen"] is False and day["cover_crop"] is None and day["cover"].startswith("illu:")
    draft = client.get(f"/api/days/{DAY}/draft").json()
    assert draft["text"] == f"Entwurf  {image(other)}"
    assert draft["cover"] is None and draft["cover_crop"] is None
    # The draft began on the page as it stood: it follows the page, saving it meets no "changed meanwhile".
    assert draft["base_revision"] == day["revision"]
    [kept_note] = client.get(f"/api/notes?date={DAY}").json()
    assert kept_note["photo_id"] is None and kept_note["text"] == "notiz"
    assert code(client.get(f"/api/photos/{photo}/uses")) == (404, "not_found")
    assert code(client.delete(f"/api/photos/{photo}")) == (404, "not_found")


def test_deleting_a_photo_nothing_shows_leaves_the_page_as_it_is(client: TestClient, account: Account) -> None:
    photo = shot(client)["id"]
    saved = client.put(f"/api/days/{DAY}", json={"title": "T", "text": "Kein Bild"}).json()
    assert client.delete(f"/api/photos/{photo}").status_code == 204
    assert client.get(f"/api/days/{DAY}").json()["revision"] == saved["revision"]


def test_a_locked_day_keeps_its_photos_and_a_locked_note_too(client: TestClient, account: Account) -> None:
    photo = shot(client)["id"]
    # A photo of an open day held by a note of the day that is locked next.
    elsewhere = shot(client, OTHER)["id"]
    note_with(client, elsewhere, DAY)
    assert client.put(f"/api/days/{DAY}", json={"title": "T", "text": f"Mit {image(photo)}"}).status_code == 200
    assert client.post(f"/api/days/{DAY}/lock").status_code == 200
    before = client.get(f"/api/days/{DAY}").json()
    assert client.get(f"/api/photos/{photo}/uses").json()["locked"] is True
    assert code(client.delete(f"/api/photos/{photo}")) == (409, "day_locked")
    assert client.get(f"/api/days/{DAY}").json() == before
    assert exists(photo) and files_of(photo)
    # The note of the locked day may not lose its photo of the open day.
    assert client.get(f"/api/photos/{elsewhere}/uses").json()["locked"] is True
    assert code(client.delete(f"/api/photos/{elsewhere}")) == (409, "day_locked")
    assert exists(elsewhere)


def test_deleting_meets_a_save_in_between_and_loses_nothing(client: TestClient, account: Account,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    """The page is saved on another device between the reading and the writing of the delete, now with the photo in
    it: the delete reads again, and the page holds the other device's words without the photo."""
    photo = shot(client)["id"]
    assert client.put(f"/api/days/{DAY}", json={"text": "Alt, ohne Bild"}).status_code == 200
    other = new_client(account)
    real = diary.without_photo
    calls = []

    def meet_a_save(content: dict[str, Any], uid: str) -> Any:
        calls.append(1)
        if len(calls) == 1:
            assert other.put(f"/api/days/{DAY}", json={"text": f"Neu vom Handy {image(photo)}"}).status_code == 200
        return real(content, uid)

    monkeypatch.setattr(diary, "without_photo", meet_a_save)
    assert client.delete(f"/api/photos/{photo}").status_code == 204
    other.close()
    assert len(calls) >= 2, "read again"
    assert client.get(f"/api/days/{DAY}").json()["text"] == "Neu vom Handy"
    assert gone(photo)


def test_a_save_that_meets_a_delete_in_between_keeps_no_picture_of_the_gone_photo(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The save checked the photo, then another device deletes it, then the save writes: the page ends without it."""
    photo = shot(client)
    stays = shot(client)["id"]
    photo = photo["id"]
    assert client.put(f"/api/days/{DAY}", json={"text": "Vorher"}).status_code == 200
    other = new_client(account)
    real = diary.merge

    def delete_in_between(content: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
        monkeypatch.setattr(diary, "merge", real)
        assert other.delete(f"/api/photos/{photo}").status_code == 204
        return real(content, patch)

    monkeypatch.setattr(diary, "merge", delete_in_between)
    saved = client.put(f"/api/days/{DAY}", json={"text": f"Mit {image(photo)} und {image(stays)}",
                                                 "cover": f"photo:{photo}"})
    other.close()
    assert saved.status_code == 200
    assert saved.json()["text"] == f"Mit  und {image(stays)}" and saved.json()["cover_chosen"] is False
    assert client.get(f"/api/days/{DAY}").json()["text"] == saved.json()["text"]
    assert gone(photo)


def test_several_photos_are_deleted_each_on_its_own(client: TestClient, account: Account) -> None:
    mine = shot(client)["id"]
    also = shot(client, OTHER)["id"]
    locked = shot(client, "2026-10-04")["id"]
    assert client.put("/api/days/2026-10-04", json={"title": "T", "text": "x"}).status_code == 200
    assert client.post("/api/days/2026-10-04/lock").status_code == 200
    with person("ben") as ben:
        theirs = shot(ben)["id"]
        ghost = uuid.uuid4().hex
        answer = client.post("/api/photos/delete", json={"ids": [mine, locked, theirs, ghost, mine.upper(), also,
                                                                 "nicht-eine-id"]})
        assert answer.status_code == 200
        assert answer.json() == {"deleted": [mine, also], "locked": [locked], "missing": [theirs, ghost,
                                                                                          "nicht-eine-id"]}
        assert exists(theirs) and exists(locked) and gone(mine) and gone(also)
    assert client.post("/api/photos/delete", json={"ids": []}).json() == {"deleted": [], "locked": [], "missing": []}
    too_many = client.post("/api/photos/delete", json={"ids": [uuid.uuid4().hex for _ in range(101)]})
    assert too_many.status_code == 422
    assert client.post("/api/photos/delete", json={"ids": ["a" * 33]}).status_code == 422
    assert client.post("/api/photos/delete", json={"ids": [mine], "more": 1}).status_code == 422


# --- Only the own photos --------------------------------------------------------------------------------------------


def test_a_photo_for_the_text_the_text_no_longer_shows_is_not_shared(client: TestClient, account: Account) -> None:
    """Taken out of the text and not tidied yet (just taken): the person a day is shared with sees nothing of it."""
    shown = shot(client, text=True)["id"]
    taken_out = shot(client, text=True)["id"]
    of_the_day = shot(client)["id"]
    assert client.put(f"/api/days/{DAY}", json={"title": "T", "text": f"Mit {image(shown)}"}).status_code == 200
    ben_account = make_account("ben")
    with new_client(ben_account) as ben:
        assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben_account.id]}).status_code == 200
        path = f"/api/shared/{account.id}/{DAY}"
        assert [photo["id"] for photo in ben.get(path).json()["photos"]] == [of_the_day]
        assert ben.get(f"{path}/photos/{shown}").status_code == 200
        assert ben.get(f"{path}/photos/{of_the_day}").status_code == 200
        assert ben.get(f"{path}/photos/{taken_out}").status_code == 404
    assert exists(taken_out)


def test_another_persons_photo_answers_like_none_and_the_operator_sees_nothing(client: TestClient,
                                                                              operator: Account) -> None:
    own = shot(client)["id"]
    with person("ben") as ben:
        theirs = shot(ben, text=True)["id"]
        assert client.put(f"/api/days/{DAY}", json={"text": "x"}).status_code == 200
        # The operator asks for a member's photo: as if it were not there.
        assert code(client.get(f"/api/photos/{theirs}/uses")) == (404, "not_found")
        assert code(client.delete(f"/api/photos/{theirs}")) == (404, "not_found")
        assert [photo["id"] for photo in client.get("/api/photos/library").json()["photos"]] == [own]
        assert client.get("/api/photos/storage").json()["count"] == 1
        # And the member for the operator's.
        assert code(ben.get(f"/api/photos/{own}/uses")) == (404, "not_found")
        assert [photo["id"] for photo in ben.get("/api/photos/library").json()["photos"]] == [theirs]
        assert exists(own) and exists(theirs)
    with new_client() as nobody:
        for path in ("/api/photos/library", "/api/photos/storage", f"/api/photos/{own}/uses"):
            assert nobody.get(path).status_code == 401
        assert nobody.post("/api/photos/delete", json={"ids": [own]}).status_code == 401


def test_the_storage_counts_the_own_photos_and_texts(client: TestClient, account: Account) -> None:
    empty = client.get("/api/photos/storage").json()
    assert empty["count"] == 0 and empty["limit"] == 5 * 1024**3
    shot(client)
    shot(client, OTHER)
    found = client.get("/api/photos/storage").json()
    with SessionLocal() as db:
        sizes = sum(row.size + row.preview_size for row in db.execute(select(Photo.size, Photo.preview_size)))
    assert found["count"] == 2 and found["used"] - empty["used"] == sizes and found["limit"] == empty["limit"]
    assert client.put("/api/settings", json={"storage_per_person_gb": 0}).status_code == 200
    assert client.get("/api/photos/storage").json()["limit"] is None


# --- The library ------------------------------------------------------------------------------------------------------


def test_the_library_pages_through_all_own_photos_newest_first(client: TestClient, account: Account,
                                                               moment: Clock) -> None:
    made: list[tuple[str, str]] = []
    for day in ("2026-10-04", "2026-10-06", "2026-10-05", "2026-10-06"):
        made.append((day, shot(client, day)["id"]))
        moment.later(1)
    wanted = [uid for _day, uid in sorted(made, key=lambda pair: pair[0], reverse=True)]
    # Of the two of the 6th the newer first.
    wanted[0], wanted[1] = made[3][1], made[1][1]
    first = client.get("/api/photos/library", params={"limit": 3}).json()
    assert [photo["id"] for photo in first["photos"]] == wanted[:3] and first["next"]
    second = client.get("/api/photos/library", params={"limit": 3, "before": first["next"]}).json()
    assert [photo["id"] for photo in second["photos"]] == wanted[3:] and second["next"] is None
    whole = client.get("/api/photos/library").json()
    assert [photo["id"] for photo in whole["photos"]] == wanted and whole["next"] is None
    assert set(whole["photos"][0]) >= {"id", "date", "width", "height", "for_text", "on_note", "uses"}
    for bad in ({"limit": 0}, {"limit": 101}, {"before": "nonsense"}, {"before": "2026-10-06.1.zz"},
                {"before": f"2026-10-06.{'9' * 17}.{'a' * 32}"}):
        assert client.get("/api/photos/library", params=bad).status_code == 422, bad


def test_the_library_says_what_uses_each_photo_and_finds_the_unused(client: TestClient, account: Account,
                                                                    moment: Clock,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    cover = shot(client)["id"]
    in_text = shot(client)["id"]
    on_note = shot(client, note=True)["id"]
    only_of_the_day = shot(client)["id"]
    other_day = shot(client, OTHER)["id"]
    held = note_with(client, on_note)
    assert client.put(f"/api/days/{DAY}", json={"text": image(in_text), "cover": f"photo:{cover}"}).status_code == 200
    uses = {photo["id"]: photo["uses"] for photo in client.get("/api/photos/library").json()["photos"]}
    assert uses[cover] == {"cover": True, "text": False, "notes": []}
    assert uses[in_text] == {"cover": False, "text": True, "notes": []}
    assert uses[on_note] == {"cover": False, "text": False, "notes": [{"id": held["id"], "date": DAY}]}
    assert uses[only_of_the_day] == uses[other_day] == {"cover": False, "text": False, "notes": []}
    unused = client.get("/api/photos/library", params={"unused": 1}).json()
    assert {photo["id"] for photo in unused["photos"]} == {only_of_the_day, other_day} and unused["next"] is None
    # Only so many are looked at per request: a shorter page, and a cursor to go on until all are found.
    monkeypatch.setattr(photos, "LIBRARY_SCAN", 2)
    found: list[str] = []
    cursor = ""
    pages = 0
    for _ in range(10):
        pages += 1
        page = client.get("/api/photos/library", params={"unused": 1, "before": cursor}).json()
        assert len(page["photos"]) <= 2
        found += [photo["id"] for photo in page["photos"]]
        if page["next"] is None:
            break
        cursor = page["next"]
    assert sorted(found) == sorted([only_of_the_day, other_day])
    assert pages == 3, "five photos, two looked at per request"


def test_taking_the_same_photo_of_immich_on_purpose_in_a_race_keeps_it(client: TestClient, account: Account) -> None:
    """Two requests at once: the second finds the photo the first kept only when it writes. Taken without ``for_text``,
    the photo stays for good all the same."""
    from app.services import vault

    drawn = photos.draw(picture())
    key = uuid.uuid4().hex * 2
    with SessionLocal() as db:
        dek = vault.dek_for(account.id)
        first, new = photos.add(db, account.id, dek, DAY, None, drawn, START, source="immich", asset_key=key,
                                for_text=True)
        assert new and first["for_text"] is True
        # The check before the write did not see it (the race): the write meets it.
        real = photos._by_upload
        seen = []

        def not_yet(*args: Any) -> Any:
            seen.append(1)
            return None if len(seen) == 1 else real(*args)

        photos._by_upload = not_yet  # type: ignore[assignment]
        try:
            again, new = photos.add(db, account.id, dek, DAY, None, drawn, START, source="immich", asset_key=key)
        finally:
            photos._by_upload = real  # type: ignore[assignment]
        assert not new and again["id"] == first["id"] and again["for_text"] is False
    assert files_of(first["id"]), "the files of the first stay"


def test_a_page_without_the_photo_keeps_no_crop_of_it() -> None:
    page = {"title": "", "text": "x ![a](photo:" + "a" * 32 + ")", "cover": "photo:" + "a" * 32,
            "cover_crop": {"x": 1, "y": 2, "zoom": 150}}
    assert diary.without_photo(page, "a" * 32) == {"title": "", "text": "x", "cover": None, "cover_crop": None}
    assert diary.without_photo(page, "b" * 32) is None
