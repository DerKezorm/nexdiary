"""Sharing a day: who sees what, on every route, from every side.

Jule shares one day with Ben. Mia is a third person on the server, the operator a fourth. A word made for this run
stands in the ratings' names and in the notes, and every answer anybody but Jule gets is searched for it: what a share
does not allow is in no answer, not in a list, not in a count, not in a heart. A day of somebody else that is not
shared answers 404 exactly like one that does not exist. The clock stands still."""

from __future__ import annotations

import io
import json
import secrets
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from app import clock
from app.db import SessionLocal
from app.models import Account, Heart, Share, ShareSeen
from app.services import diary, sharing

from .conftest import PASSWORD, make_account, new_client

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
DAY = "2026-10-05"
OTHER_DAY = "2026-10-04"


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: NOON)
    yield


def png(*colour: Any) -> bytes:
    if len(colour) == 1:
        colour = colour[0]
    out = io.BytesIO()
    Image.new("RGB", (64, 48), tuple(colour)).save(out, "PNG")
    return out.getvalue()


def upload(client: TestClient, date: str, colour: tuple[int, int, int]) -> str:
    answer = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": date}, content=png(colour))
    assert answer.status_code == 201, answer.text
    return str(answer.json()["id"])


def count(model: Any) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)


@dataclass
class Family:
    jule: TestClient
    ben: TestClient
    mia: TestClient
    operator: TestClient
    jule_id: int
    ben_id: int
    mia_id: int
    operator_id: int
    #: In the names of Jule's values and in her notes: never in an answer that does not allow them.
    secret: str
    #: In the title and the text: what every share shows.
    word: str
    cover: str
    day_photo: str
    note_photo: str
    other_day_photo: str
    value_id: str

    @property
    def path(self) -> str:
        return f"/api/shared/{self.jule_id}/{DAY}"


@pytest.fixture
def family(client: TestClient, account: Account) -> Iterator[Family]:
    jule_row, ben_row, mia_row = make_account("jule"), make_account("ben"), make_account("mia")
    secret = "Sv" + secrets.token_hex(5) + "Qz"
    word = "Wt" + secrets.token_hex(5) + "Kp"
    with new_client(jule_row) as jule, new_client(ben_row) as ben, new_client(mia_row) as mia:
        for person in (jule, ben, mia, client):
            assert person.put("/api/me/preferences", json={"timezone": "UTC"}).status_code == 200
        value = jule.post("/api/values", json={"name": f"Wert {secret}", "low": f"tief {secret}",
                                                "high": f"hoch {secret}"}).json()
        cover = upload(jule, DAY, (200, 30, 30))
        day_photo = upload(jule, DAY, (30, 200, 30))
        note_photo = upload(jule, DAY, (30, 30, 200))
        other = upload(jule, OTHER_DAY, (90, 90, 90))
        for text, photo in ((f"rohe notiz {secret}", None), ("", note_photo)):
            answer = jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": text, "date": DAY,
                                                    **({"photo_id": photo} if photo else {})})
            assert answer.status_code == 201
        made = jule.put(f"/api/days/{DAY}", json={"title": f"Am See {word}", "text": f"Ein **langer** Tag {word}.",
                                                   "tags": ["familie"], "values": {value["id"]: 8},
                                                   "cover": f"photo:{cover}"})
        assert made.status_code == 200
        jule.put(f"/api/days/{OTHER_DAY}", json={"title": "Vortag", "cover": f"photo:{other}"})
        yield Family(jule, ben, mia, client, jule_row.id, ben_row.id, mia_row.id, account.id, secret, word, cover,
                     day_photo, note_photo, other, value["id"])


def share(family: Family, *, to: list[int] | None = None, values: bool = False, notes: bool = False,
          date: str = DAY) -> Any:
    answer = family.jule.put(f"/api/days/{date}/shares", json={
        "to": [family.ben_id] if to is None else to, "with_values": values, "with_notes": notes})
    assert answer.status_code == 200, answer.text
    return answer.json()


def everything_ben_gets(family: Family) -> list[Any]:
    """Every answer of every route the person a day is shared with can ask, apart from the pictures."""
    ben = family.ben
    out = [ben.get("/api/shared"), ben.get("/api/shared/count"), ben.get(family.path),
           ben.post(f"{family.path}/seen"), ben.put(f"{family.path}/heart"), ben.get("/api/shared"),
           ben.post("/api/search", json={"q": family.secret}), ben.post("/api/search", json={"q": family.word}),
           ben.post("/api/journal", json={}), ben.get("/api/journal/overview"), ben.get("/api/days"), ben.get("/api/shares"),
           ben.get("/api/people"), ben.get("/api/today")]
    return out


def leaks(answers: list[Any], word: str) -> list[str]:
    return [answer.request.url.path for answer in answers if word in answer.text]


# --- What the person a day is shared with sees ---------------------------------------------------------------------


def test_a_shared_day_shows_text_tags_cover_and_photos_and_nothing_else(family: Family) -> None:
    share(family)
    day = family.ben.get(family.path)
    assert day.status_code == 200
    body = day.json()
    assert body["title"] == f"Am See {family.word}" and body["text"] == f"Ein **langer** Tag {family.word}."
    assert body["tags"] == ["familie"] and body["cover"] == f"photo:{family.cover}"
    assert body["from"] == {"id": family.jule_id, "name": "jule", "display_name": "", "avatar": None}
    assert [photo["id"] for photo in body["photos"]] == [family.day_photo], "the day's photos, the cover apart"
    assert "values" not in body and "notes" not in body
    assert set(body) == {"from", "date", "title", "text", "tags", "cover", "cover_crop", "photos", "with_values",
                         "with_notes", "heart", "shared_at"}
    # Not in any answer Ben can get: neither the names of Jule's values nor her notes. And none is kept by a browser
    # or a proxy.
    answers = everything_ben_gets(family)
    assert leaks(answers, family.secret) == []
    assert [answer.request.url.path for answer in answers if answer.headers.get("cache-control") != "no-store"] == []
    # Floor: the secret is really there, for Jule.
    assert family.secret in family.jule.get(f"/api/notes?date={DAY}").text


def test_values_and_notes_come_only_when_shared_with_them(family: Family) -> None:
    share(family, values=True)
    body = family.ben.get(family.path).json()
    assert body["values"] == [{"name": f"Wert {family.secret}", "low": f"tief {family.secret}",
                               "high": f"hoch {family.secret}", "value": 8}]
    assert "notes" not in body
    assert family.ben.get(f"{family.path}/photos/{family.note_photo}").status_code == 404
    # Lists never carry the ratings, even when the day itself does.
    assert family.secret not in family.ben.get("/api/shared").text
    share(family, notes=True)
    body = family.ben.get(family.path).json()
    assert "values" not in body, "taken back: no more ratings"
    assert [(note["text"], note["photo_id"]) for note in body["notes"]] == [
        (f"rohe notiz {family.secret}", None), ("", family.note_photo)]
    assert set(body["notes"][0]) == {"text", "prompt", "photo_id", "created_at"}
    assert family.ben.get(f"{family.path}/photos/{family.note_photo}").status_code == 200
    assert family.secret not in family.ben.get("/api/shared").text


def test_photos_come_only_through_the_share_and_only_those_of_the_day(family: Family) -> None:
    share(family)
    ben = family.ben
    for photo in (family.cover, family.day_photo):
        for suffix in ("", "/preview"):
            answer = ben.get(f"{family.path}/photos/{photo}{suffix}")
            assert answer.status_code == 200 and answer.headers["content-type"] == "image/webp"
            assert answer.headers["cache-control"] == "private, no-store"
    # Not the photo of a note (without notes), not one of another day, never through the owner's route.
    for photo in (family.note_photo, family.other_day_photo, secrets.token_hex(16)):
        assert ben.get(f"{family.path}/photos/{photo}").status_code == 404, photo
    for photo in (family.cover, family.day_photo):
        assert ben.get(f"/api/photos/{photo}").status_code == 404
        assert ben.get(f"/api/photos/{photo}/preview").status_code == 404
    # The other day is not shared, not even its cover.
    assert ben.get(f"/api/shared/{family.jule_id}/{OTHER_DAY}/photos/{family.other_day_photo}").status_code == 404
    for wrong in ("../photos", "x" * 32, family.cover.upper() + "0"):
        assert ben.get(f"{family.path}/photos/{wrong}").status_code == 404


def note_with_photo(family: Family) -> dict[str, Any]:
    return next(note for note in family.jule.get(f"/api/notes?date={DAY}").json() if note["photo_id"])


def seen_photos(family: Family) -> list[str]:
    return [photo["id"] for photo in family.ben.get(family.path).json()["photos"]]


def test_a_photo_taken_for_a_note_never_becomes_a_photo_of_the_day(family: Family) -> None:
    """Loosened from its note, it stays a note's: the person a day is shared with without notes never sees it."""
    share(family)
    note = note_with_photo(family)
    assert family.jule.put(f"/api/notes/{note['id']}", json={"text": "ohne bild", "photo_id": None}).status_code == 200
    assert family.note_photo not in seen_photos(family)
    assert family.ben.get(f"{family.path}/photos/{family.note_photo}").status_code == 404
    # The owner keeps it, marked as a note's.
    own = {photo["id"]: photo["on_note"] for photo in family.jule.get(f"/api/photos?date={DAY}").json()}
    assert own[family.note_photo] is True and own[family.day_photo] is False
    assert family.day_photo in seen_photos(family)
    # A photo of the day put on a note later is a note's from then on, even when it comes off again.
    text_note = next(item for item in family.jule.get(f"/api/notes?date={DAY}").json() if item["text"])
    assert family.jule.put(f"/api/notes/{text_note['id']}", json={"text": text_note["text"],
                                                                  "photo_id": family.day_photo}).status_code == 200
    family.jule.put(f"/api/notes/{text_note['id']}", json={"text": text_note["text"], "photo_id": None})
    assert family.day_photo not in seen_photos(family)
    assert family.ben.get(f"{family.path}/photos/{family.day_photo}").status_code == 404
    # Uploaded for a note, it is a note's before any note holds it.
    early = family.jule.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": DAY, "note": "true"},
                             content=png(9, 9, 9))
    assert early.status_code == 201 and early.json()["on_note"] is True
    assert early.json()["id"] not in seen_photos(family)
    assert family.ben.get(f"{family.path}/photos/{early.json()['id']}").status_code == 404


def test_deleting_a_note_takes_its_photo_unless_it_is_the_cover(family: Family) -> None:
    from .conftest import MEDIA

    note = note_with_photo(family)
    assert family.jule.delete(f"/api/notes/{note['id']}").status_code == 204
    assert family.jule.get(f"/api/photos/{family.note_photo}").status_code == 404
    assert not (MEDIA / family.note_photo).exists() and not (MEDIA / f"{family.note_photo}.p").exists()
    made = family.jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "", "date": DAY,
                                                "photo_id": family.day_photo}).json()
    # Put on a note it is a note's from now on, and as the cover it stays when the note goes.
    family.jule.put(f"/api/days/{DAY}", json={"cover": f"photo:{family.day_photo}"})
    assert family.jule.delete(f"/api/notes/{made['id']}").status_code == 204
    assert family.jule.get(f"/api/photos/{family.day_photo}").status_code == 200
    share(family)
    assert family.ben.get(family.path).json()["cover"] == f"photo:{family.day_photo}"
    assert family.ben.get(f"{family.path}/photos/{family.day_photo}").status_code == 200


def test_the_cover_is_a_photo_of_that_very_day(family: Family) -> None:
    for path, body in ((f"/api/days/{DAY}", {"cover": f"photo:{family.other_day_photo}"}),
                       (f"/api/days/{DAY}/draft", {"cover": f"photo:{family.other_day_photo}", "base_revision": 0})):
        answer = family.jule.put(path, json=body)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "cover_other_day", path
    # A photo of a note of the same day may be the cover; the person it is shared with then sees it, and only it.
    other = family.jule.post("/api/notes", json={"id": str(uuid.uuid4()), "text": "", "date": DAY,
                                                 "photo_id": upload(family.jule, DAY, (1, 2, 3))}).json()
    assert family.jule.put(f"/api/days/{DAY}", json={"cover": f"photo:{other['photo_id']}"}).status_code == 200
    share(family)
    assert family.ben.get(family.path).json()["cover"] == f"photo:{other['photo_id']}"
    assert family.ben.get(f"{family.path}/photos/{other['photo_id']}").status_code == 200
    assert family.ben.get(f"{family.path}/photos/{family.note_photo}").status_code == 404


def test_the_reader_sees_the_page_as_it_stands_now(family: Family) -> None:
    share(family)
    family.jule.put(f"/api/days/{DAY}", json={"title": "Neuer Titel", "cover": "illu:wald.tag.herbst"})
    body = family.ben.get(family.path).json()
    assert body["title"] == "Neuer Titel" and body["cover"] == "illu:wald.tag.herbst"
    # The old cover is now just a photo of the day: listed, still reachable.
    assert family.cover in [photo["id"] for photo in body["photos"]]


# --- Who else -------------------------------------------------------------------------------------------------------


def test_nobody_but_the_person_it_is_shared_with_reaches_the_day(family: Family) -> None:
    share(family, values=True, notes=True)
    routes = [("GET", family.path), ("POST", f"{family.path}/seen"), ("PUT", f"{family.path}/heart"),
              ("DELETE", f"{family.path}/heart"), ("GET", f"{family.path}/photos/{family.cover}"),
              ("GET", f"{family.path}/photos/{family.cover}/preview"),
              ("GET", f"{family.path}/photos/{family.note_photo}")]
    # Mia, the operator, and Jule herself (her own day is hers through /api/days, not through a share).
    for who in (family.mia, family.operator, family.jule):
        for method, path in routes:
            answer = who.request(method, path)
            assert answer.status_code == 404, (method, path)
            assert answer.json()["detail"]["code"] == "not_found"
        assert who.get("/api/shared").json() == []
        assert who.get("/api/shared/count").json() == {"new": 0}
    # And the same 404 as a day that does not exist at all, or a person that does not exist.
    for path in (f"/api/shared/{family.jule_id}/2026-01-01", f"/api/shared/99999/{DAY}", f"/api/shared/x/{DAY}",
                 f"/api/shared/0{family.jule_id}/{DAY}", f"/api/shared/+{family.jule_id}/{DAY}",
                 f"/api/shared/{family.jule_id}/2026-13-45", f"/api/shared/{family.jule_id}/x"):
        assert family.ben.get(path).status_code == 404, path
    # No account list of the operator shows anything of it.
    listed = family.operator.get("/api/accounts").text
    assert family.word not in listed and family.secret not in listed
    for who in (family.mia, family.operator):
        assert leaks([who.get("/api/shared"), who.post("/api/search", json={"q": family.word}),
                      who.post("/api/journal", json={}), who.get("/api/journal/overview")], family.word) == []
    # Without a session nothing answers.
    with new_client() as stranger:
        for method, path in [*routes, ("GET", "/api/shared"), ("GET", "/api/shared/count"), ("GET", "/api/people"),
                             ("GET", "/api/shares"), ("GET", f"/api/days/{DAY}/shares"),
                             ("PUT", f"/api/days/{DAY}/shares"), ("POST", "/api/journal")]:
            assert stranger.request(method, path, json={}).status_code == 401, (method, path)


def test_the_person_it_is_shared_with_cannot_pass_it_on(family: Family) -> None:
    share(family)
    ben = family.ben
    # Ben has no page of that day: there is nothing of his to share, and Jule's is not his.
    tried = ben.put(f"/api/days/{DAY}/shares", json={"to": [family.mia_id], "with_values": True, "with_notes": True})
    assert tried.status_code == 404
    assert ben.get(f"/api/days/{DAY}/shares").status_code == 404
    assert ben.delete(f"/api/days/{DAY}/shares").status_code == 204
    assert family.ben.get(family.path).status_code == 200, "nothing of Jule's changed"
    assert family.mia.get("/api/shared").json() == []
    # With a page of his own on the same date, Ben shares his own page, never Jule's.
    ben.put(f"/api/days/{DAY}", json={"title": "Bens Tag"})
    assert ben.put(f"/api/days/{DAY}/shares", json={"to": [family.mia_id]}).status_code == 200
    assert family.mia.get(f"/api/shared/{family.jule_id}/{DAY}").status_code == 404
    seen = family.mia.get(f"/api/shared/{family.ben_id}/{DAY}").json()
    assert seen["title"] == "Bens Tag" and family.word not in json.dumps(seen)
    assert family.mia.get(f"/api/shared/{family.ben_id}/{DAY}/photos/{family.cover}").status_code == 404


def test_only_other_active_people_can_be_chosen(family: Family) -> None:
    people = family.jule.get("/api/people").json()
    assert [person["name"] for person in people] == ["tester", "ben", "mia"], "in the order they came"
    assert all(set(person) == {"id", "name", "display_name", "avatar"} for person in people)
    for wrong in ([family.jule_id], [99999], [family.ben_id, 99999]):
        answer = family.jule.put(f"/api/days/{DAY}/shares", json={"to": wrong})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "person_unknown", wrong
    assert count(Share) == 0, "a refused list shares with nobody, not with the valid part"
    # A day without a page cannot be shared.
    assert family.jule.put("/api/days/2026-09-01/shares", json={"to": [family.ben_id]}).status_code == 404
    assert family.jule.get("/api/days/2026-09-01/shares").status_code == 404
    # Only whole numbers name a person: true would be account 1, "3" and 3.0 only look like ids.
    for wrong in ([True], [str(family.ben_id)], [float(family.ben_id)], [None]):
        answer = family.jule.put(f"/api/days/{DAY}/shares", json={"to": wrong})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "invalid_input", wrong
    assert count(Share) == 0
    # Too many at once, unknown fields, a date to come: refused.
    assert family.jule.put(f"/api/days/{DAY}/shares", json={"to": list(range(1, 60))}).status_code == 422
    assert family.jule.put(f"/api/days/{DAY}/shares", json={"to": [], "extra": 1}).status_code == 422
    assert family.jule.put("/api/days/2026-12-24/shares", json={"to": [family.ben_id]}).status_code == 422


def test_the_owner_sees_who_sees_what_and_who_sent_a_heart(family: Family) -> None:
    shared = share(family, to=[family.ben_id, family.mia_id], values=True)
    assert [(person["id"], person["name"], person["with_values"], person["with_notes"], person["heart"]) for person in
            shared["people"]] == [(family.ben_id, "ben", True, False, None), (family.mia_id, "mia", True, False, None)]
    assert (shared["with_values"], shared["with_notes"]) == (True, False)
    assert family.ben.put(f"{family.path}/heart").json()["heart"] == NOON.isoformat()
    seen = family.jule.get(f"/api/days/{DAY}/shares").json()
    assert [(person["name"], person["heart"]) for person in seen["people"]] == [("ben", NOON.isoformat()),
                                                                               ("mia", None)]
    mine = family.jule.get("/api/shares").json()
    assert [(item["date"], item["title"], [(p["id"], p["name"]) for p in item["people"]]) for item in mine] == [
        (DAY, f"Am See {family.word}", [(family.ben_id, "ben"), (family.mia_id, "mia")])]
    assert mine[0]["people"][0]["heart"] == NOON.isoformat()
    journal = family.jule.post("/api/journal", json={}).json()["days"]
    assert [(person["id"], person["name"]) for person in journal[0]["shared_with"]] == [(family.ben_id, "ben"),
                                                                                      (family.mia_id, "mia")]
    assert journal[1]["shared_with"] == []
    # Fewer people: Mia no longer sees it, Ben's heart stays.
    share(family, to=[family.ben_id], values=True)
    assert family.mia.get(f"/api/shared/{family.jule_id}/{DAY}").status_code == 404
    assert family.ben.get(family.path).json()["heart"] == NOON.isoformat()


def test_a_heart_is_one_and_comes_back_off(family: Family) -> None:
    share(family)
    ben = family.ben
    assert ben.put(f"{family.path}/heart").status_code == 200
    assert ben.put(f"{family.path}/heart").json()["heart"] == NOON.isoformat()
    assert count(Heart) == 1
    assert ben.get("/api/shared").json()[0]["heart"] == NOON.isoformat()
    assert ben.delete(f"{family.path}/heart").json() == {"heart": None}
    assert ben.delete(f"{family.path}/heart").json() == {"heart": None}
    assert count(Heart) == 0
    assert family.mia.put(f"{family.path}/heart").status_code == 404
    assert count(Heart) == 0


def test_a_day_is_new_until_it_was_opened(family: Family) -> None:
    share(family)
    family.jule.put(f"/api/days/{OTHER_DAY}/shares", json={"to": [family.ben_id]})
    ben = family.ben
    assert ben.get("/api/shared/count").json() == {"new": 2}
    assert [(item["date"], item["new"]) for item in ben.get("/api/shared").json()] == [(DAY, True), (OTHER_DAY, True)]
    assert ben.post(f"{family.path}/seen").status_code == 204
    assert ben.post(f"{family.path}/seen").status_code == 204
    assert count(ShareSeen) == 1
    assert ben.get("/api/shared/count").json() == {"new": 1}
    listed = ben.get("/api/shared").json()
    assert [(item["date"], item["new"]) for item in listed] == [(DAY, False), (OTHER_DAY, True)]
    assert set(listed[0]) == {"from", "date", "title", "excerpt", "cover", "cover_crop", "new", "heart"}
    # The person it comes from is named by their own id (the one the address of the day takes), never the share's.
    assert {item["from"]["id"] for item in listed} == {family.jule_id}
    assert listed[0]["from"] == {"id": family.jule_id, "name": "jule", "display_name": "", "avatar": None}
    assert listed[0]["excerpt"] == f"Ein langer Tag {family.word}."
    # Reading alone does not mark it: only the page that shows it says so.
    ben.get(f"/api/shared/{family.jule_id}/{OTHER_DAY}")
    assert ben.get("/api/shared/count").json() == {"new": 1}
    assert family.mia.post(f"{family.path}/seen").status_code == 404


# --- Taking back, deleting, blocking --------------------------------------------------------------------------------


def gone_for_ben(family: Family) -> None:
    ben = family.ben
    assert ben.get(family.path).status_code == 404
    assert ben.get(f"{family.path}/photos/{family.cover}").status_code == 404
    assert ben.put(f"{family.path}/heart").status_code == 404
    assert ben.post(f"{family.path}/seen").status_code == 404
    assert ben.get("/api/shared").json() == []
    assert ben.get("/api/shared/count").json() == {"new": 0}


def test_taking_a_share_back_leaves_nothing(family: Family) -> None:
    share(family, values=True, notes=True)
    family.ben.put(f"{family.path}/heart")
    family.ben.post(f"{family.path}/seen")
    assert family.jule.delete(f"/api/days/{DAY}/shares").status_code == 204
    gone_for_ben(family)
    assert (count(Share), count(Heart), count(ShareSeen)) == (0, 0, 0)
    assert family.jule.get("/api/shares").json() == []
    # Sharing with nobody is the same.
    share(family)
    share(family, to=[])
    gone_for_ben(family)


def test_deleting_the_page_takes_its_shares(family: Family) -> None:
    share(family)
    family.ben.put(f"{family.path}/heart")
    assert family.jule.delete(f"/api/days/{DAY}").status_code == 204
    gone_for_ben(family)
    assert (count(Share), count(Heart)) == (0, 0)
    # A new page on the date is not shared again by itself.
    family.jule.put(f"/api/days/{DAY}", json={"title": "neu"})
    gone_for_ben(family)


def test_a_blocked_owner_s_days_vanish_and_a_blocked_reader_is_not_listed(family: Family) -> None:
    share(family)
    block = family.operator.post(f"/api/accounts/{family.jule_id}/block", json={"current_password": PASSWORD})
    assert block.status_code == 204
    gone_for_ben(family)
    assert "jule" not in [person["name"] for person in family.ben.get("/api/people").json()]
    family.operator.post(f"/api/accounts/{family.jule_id}/unblock", json={"current_password": PASSWORD})
    with new_client(_row("jule")) as jule:
        assert family.ben.get(family.path).status_code == 200, "unblocked, the share stands again"
        assert family.operator.post(f"/api/accounts/{family.ben_id}/block",
                                    json={"current_password": PASSWORD}).status_code == 204
        assert jule.get(f"/api/days/{DAY}/shares").json()["people"] == []
        assert jule.get("/api/shares").json() == []
        assert jule.post("/api/journal", json={}).json()["days"][0]["shared_with"] == []
        assert "ben" not in [person["name"] for person in jule.get("/api/people").json()]
        answer = jule.put(f"/api/days/{DAY}/shares", json={"to": [family.ben_id]})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "person_unknown"


def _row(name: str) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=name).one()
        db.expunge(row)
    return row


def test_deleting_either_account_deletes_the_shares(family: Family) -> None:
    share(family)
    family.jule.put(f"/api/days/{OTHER_DAY}/shares", json={"to": [family.mia_id]})
    family.ben.put(f"{family.path}/heart")
    deleted = family.operator.request("DELETE", f"/api/accounts/{family.ben_id}", json={"current_password": PASSWORD})
    assert deleted.status_code == 204
    assert (count(Share), count(Heart)) == (1, 0)
    deleted = family.operator.request("DELETE", f"/api/accounts/{family.jule_id}", json={"current_password": PASSWORD})
    assert deleted.status_code == 204
    assert count(Share) == 0
    assert family.mia.get("/api/shared").json() == []


# --- At the same moment ---------------------------------------------------------------------------------------------


def _at_once(*calls: Any) -> list[Any]:
    out: list[Any] = [None] * len(calls)

    def run(index: int) -> None:
        try:
            out[index] = calls[index]()
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever went wrong
            out[index] = exc

    threads = [threading.Thread(target=run, args=(index,)) for index in range(len(calls))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    return out


def test_sharing_twice_at_once_leaves_one_share(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    """Both have looked at the day before either writes."""
    both = threading.Barrier(2, timeout=10)
    original = diary.day_exists
    first = [0]

    def day_exists_then_wait(db: Any, account_id: int, day: str) -> bool:
        found = original(db, account_id, day)
        first[0] += 1
        if first[0] <= 2:
            both.wait()
        return found

    monkeypatch.setattr(diary, "day_exists", day_exists_then_wait)
    body = {"to": [family.ben_id], "with_values": False, "with_notes": False}
    answers = _at_once(lambda: family.jule.put(f"/api/days/{DAY}/shares", json=body),
                       lambda: family.jule.put(f"/api/days/{DAY}/shares", json={**body, "with_notes": True}))
    assert [answer.status_code for answer in answers] == [200, 200]
    assert count(Share) == 1


def test_two_hearts_at_once_are_one(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    share(family)
    both = threading.Barrier(2, timeout=10)
    original = sharing._share_for

    def found_then_wait(*args: Any) -> Any:
        row = original(*args)
        both.wait()
        return row

    monkeypatch.setattr(sharing, "_share_for", found_then_wait)
    answers = _at_once(lambda: family.ben.put(f"{family.path}/heart"), lambda: family.ben.put(f"{family.path}/heart"))
    assert [answer.status_code for answer in answers] == [200, 200]
    assert count(Heart) == 1


def test_a_heart_sent_while_the_share_is_taken_back_leaves_nothing(family: Family,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """The heart found the share, then the share went, then the heart is written: nothing, and a 404."""
    share(family)
    original = sharing._share_for

    def found_then_taken_back(*args: Any) -> Any:
        row = original(*args)
        with SessionLocal() as db:
            sharing.stop_sharing(db, family.jule_id, DAY)
        return row

    monkeypatch.setattr(sharing, "_share_for", found_then_taken_back)
    assert family.ben.put(f"{family.path}/heart").status_code == 404
    assert (count(Share), count(Heart)) == (0, 0)
    share(family)
    assert family.ben.post(f"{family.path}/seen").status_code == 204
    assert (count(Share), count(ShareSeen)) == (0, 0)


def test_a_heart_taken_back_in_the_same_moment_is_no_404(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    """Sent in one tab, taken back in another at once: the share stands, so there is no heart and no 404."""
    share(family)
    original = sharing._mark

    def mark_then_taken_back(db: Any, table: str, share_id: int) -> None:
        original(db, table, share_id)
        db.commit()
        with SessionLocal() as other:
            other.execute(Heart.__table__.delete())
            other.commit()

    monkeypatch.setattr(sharing, "_mark", mark_then_taken_back)
    answer = family.ben.put(f"{family.path}/heart")
    assert answer.status_code == 200 and answer.json() == {"heart": None}


def test_sharing_while_the_page_is_deleted_shares_nothing(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    """The share found the page, then the page went, then the share is written: nothing, and a 404."""
    original = diary.day_exists
    calls = [0]

    def found_then_deleted(db: Any, account_id: int, day: str) -> bool:
        found = original(db, account_id, day)
        calls[0] += 1
        if calls[0] == 1:
            with SessionLocal() as other:
                diary.delete_day(other, account_id, day)
        return found

    monkeypatch.setattr(diary, "day_exists", found_then_deleted)
    answer = family.jule.put(f"/api/days/{DAY}/shares", json={"to": [family.ben_id]})
    assert answer.status_code == 404
    assert count(Share) == 0


def test_sharing_and_taking_back_at_once_end_in_one_of_the_two(family: Family) -> None:
    for _ in range(4):
        answers = _at_once(lambda: family.jule.put(f"/api/days/{DAY}/shares", json={"to": [family.ben_id]}),
                           lambda: family.jule.delete(f"/api/days/{DAY}/shares"))
        assert sorted(answer.status_code for answer in answers) == [200, 204]
        assert count(Share) in (0, 1)
        status = family.ben.get(family.path).status_code
        assert status == (200 if count(Share) else 404)
