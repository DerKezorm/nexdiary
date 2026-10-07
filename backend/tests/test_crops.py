"""How a photo is shown: the crop of a cover, and the turn and crop of a picture in the text.

* ``cover_crop`` is ``{x, y, zoom}`` (middle in per mille, zoom 100 to 400), checked strictly, kept only with a photo
  for the cover; a new cover without one starts without; it comes with the day, the lists, the draft and the shared day.
* A picture in the text may carry ``#crop=x,y,w,h&rot=r``. The server keeps only the canonical form and drops a fragment
  with anything else whole, the picture staying; ids, words, the search and the start of a page see through it.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.models import Account
from app.services import diary

from .conftest import make_account, new_client
from .test_lock import code
from .test_photos import picture

DAY = "2026-10-06"
CROP = {"x": 250, "y": 600, "zoom": 180}


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(clock, "now", lambda: datetime(2026, 10, 7, 12, 0, tzinfo=UTC))
    yield


def shot(client: TestClient, day: str = DAY) -> str:
    answer = client.post("/api/photos", params={"upload_id": str(uuid.uuid4()), "date": day}, content=picture())
    assert answer.status_code == 201, answer.text
    return answer.json()["id"]


def stored(account: Account) -> dict[str, Any]:
    """The page as it lies sealed in the database, opened."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Day
    from app.services import vault

    with SessionLocal() as db:
        sealed = db.scalar(select(Day.content_enc).where(Day.user_id == account.id, Day.date == DAY))
    return diary._content(account.id, vault.dek_for(account.id), DAY, sealed)


def put(client: TestClient, **body: Any) -> Any:
    return client.put(f"/api/days/{DAY}", json={"title": "Am See", "text": "Ein Tag.", **body})


# --- The crop of a cover --------------------------------------------------------------------------------------------


def test_a_cover_photo_keeps_its_crop_and_every_view_carries_it(client: TestClient, account: Account) -> None:
    photo = shot(client)
    saved = put(client, cover=f"photo:{photo}", cover_crop=CROP)
    assert saved.status_code == 200 and saved.json()["cover_crop"] == CROP
    assert client.get(f"/api/days/{DAY}").json()["cover_crop"] == CROP
    assert client.get("/api/days").json()[0]["cover_crop"] == CROP
    assert client.post("/api/journal", json={}).json()["days"][0]["cover_crop"] == CROP
    assert client.post("/api/search", json={"q": "Am See"}).json()["days"][DAY]["cover_crop"] == CROP
    # Other fields changing leave it; values too.
    assert client.put(f"/api/days/{DAY}", json={"text": "Anders."}).json()["cover_crop"] == CROP
    mood = client.get("/api/values").json()[0]["id"]
    assert client.put(f"/api/days/{DAY}/values", json={"values": {mood: 7}}).json()["cover_crop"] == CROP
    # The same cover sent again keeps it; null takes it back.
    assert client.put(f"/api/days/{DAY}", json={"cover": f"photo:{photo}"}).json()["cover_crop"] == CROP
    assert client.put(f"/api/days/{DAY}", json={"cover_crop": None}).json()["cover_crop"] is None


def test_a_new_cover_starts_without_the_crop_of_the_one_before(client: TestClient, account: Account) -> None:
    first, second = shot(client), shot(client)
    assert put(client, cover=f"photo:{first}", cover_crop=CROP).json()["cover_crop"] == CROP
    assert client.put(f"/api/days/{DAY}", json={"cover": f"photo:{second}"}).json()["cover_crop"] is None
    both = client.put(f"/api/days/{DAY}", json={"cover": f"photo:{first}", "cover_crop": CROP}).json()
    assert both["cover_crop"] == CROP
    # An illustration has no crop, sent or not; and back to the suggestion, none either.
    drawn = client.put(f"/api/days/{DAY}", json={"cover": "illu:baum.abend.herbst", "cover_crop": CROP}).json()
    assert drawn["cover"] == "illu:baum.abend.herbst" and drawn["cover_crop"] is None
    assert stored(account)["cover_crop"] is None, "not kept either"
    assert client.put(f"/api/days/{DAY}", json={"cover_crop": CROP}).json()["cover_crop"] is None
    assert client.put(f"/api/days/{DAY}", json={"cover": None, "cover_crop": CROP}).json()["cover_crop"] is None


@pytest.mark.parametrize("crop", [
    {"x": -1, "y": 0, "zoom": 100}, {"x": 1001, "y": 0, "zoom": 100}, {"x": 0, "y": 1001, "zoom": 100},
    {"x": 0, "y": 0, "zoom": 99}, {"x": 0, "y": 0, "zoom": 401}, {"x": 1.5, "y": 0, "zoom": 100},
    {"x": "5", "y": 0, "zoom": 100}, {"x": True, "y": 0, "zoom": 100}, {"x": 0, "y": 0},
    {"x": 0, "y": 0, "zoom": 100, "rot": 90}, {"x": None, "y": 0, "zoom": 100}, [0, 0, 100], "0,0,100", 5,
])
def test_a_crop_of_the_wrong_form_is_refused(client: TestClient, account: Account, crop: Any) -> None:
    photo = shot(client)
    answer = put(client, cover=f"photo:{photo}", cover_crop=crop)
    assert answer.status_code == 422, crop
    draft = client.put(f"/api/days/{DAY}/draft", json={"cover": f"photo:{photo}", "cover_crop": crop,
                                                       "base_revision": -1})
    assert draft.status_code == 422, crop
    assert client.get(f"/api/days/{DAY}").status_code == 404


def test_the_ends_of_a_crop_are_taken(client: TestClient, account: Account) -> None:
    photo = shot(client)
    for crop in ({"x": 0, "y": 0, "zoom": 100}, {"x": 1000, "y": 1000, "zoom": 400}):
        assert put(client, cover=f"photo:{photo}", cover_crop=crop).json()["cover_crop"] == crop
    # The service checks as strictly as the route.
    for crop in ({"x": 0, "y": 0, "zoom": 100.0}, {"x": False, "y": 0, "zoom": 100}, {"x": 0, "y": 0, "zoom": 401}):
        with pytest.raises(Exception, match="422"):
            diary.check_cover_crop(crop)


def test_the_draft_keeps_the_crop_and_loses_it_with_its_photo(client: TestClient, account: Account) -> None:
    photo = shot(client)
    kept = client.put(f"/api/days/{DAY}/draft", json={"cover": f"photo:{photo}", "cover_crop": CROP,
                                                      "base_revision": -1})
    assert kept.status_code == 200 and kept.json()["cover_crop"] == CROP
    assert client.get(f"/api/days/{DAY}/draft").json()["cover_crop"] == CROP
    drawn = client.put(f"/api/days/{DAY}/draft", json={"cover": "illu:baum.abend.herbst", "cover_crop": CROP,
                                                       "base_revision": -1}).json()
    assert drawn["cover_crop"] is None
    client.put(f"/api/days/{DAY}/draft", json={"cover": f"photo:{photo}", "cover_crop": CROP, "base_revision": -1})
    assert client.delete(f"/api/photos/{photo}").status_code == 204
    back = client.get(f"/api/days/{DAY}/draft").json()
    assert back["cover"] is None and back["cover_crop"] is None


def test_the_person_a_day_is_shared_with_sees_the_crop(client: TestClient, account: Account) -> None:
    photo = shot(client)
    assert put(client, cover=f"photo:{photo}", cover_crop=CROP).status_code == 200
    ben = make_account("ben")
    assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben.id]}).status_code == 200
    with new_client(ben) as reader:
        assert reader.get(f"/api/shared/{account.id}/{DAY}").json()["cover_crop"] == CROP
        assert reader.get("/api/shared").json()[0]["cover_crop"] == CROP
    assert client.get("/api/shares").json()[0]["cover_crop"] == CROP


# --- Pictures in the text ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("raw", "kept"), [
    ("crop=100,200,300,400", "#crop=100,200,300,400"),
    ("rot=90", "#rot=90"),
    ("crop=0,0,500,500&rot=270", "#crop=0,0,500,500&rot=270"),
    ("rot=180&crop=10,10,10,10", "#crop=10,10,10,10&rot=180"),
    ("crop=0100,0,0900,1000", "#crop=100,0,900,1000"),
    ("crop=0,0,1000,1000", ""),
    ("rot=0", ""),
    ("crop=0,0,1000,1000&rot=0", ""),
    ("crop=0,0,1000,1000&rot=90", "#rot=90"),
    ("crop=990,990,10,10", "#crop=990,990,10,10"),
    ("", ""),
    ("crop=1,2,3", ""),
    ("crop=0,0,9,500", ""),
    ("crop=0,0,500,9", ""),
    ("crop=1,0,1000,500", ""),
    ("crop=0,1,500,1000", ""),
    ("crop=-1,0,500,500", ""),
    ("crop=+1,0,500,500", ""),
    ("crop=1.5,0,500,500", ""),
    ("crop=1, 0,500,500", ""),
    ("crop=10000,0,10,10", ""),
    ("crop=١,0,500,500", ""),
    ("rot=45", ""),
    ("rot=360", ""),
    ("rot=-90", ""),
    ("rot=90&rot=90", ""),
    ("crop=0,0,10,10&crop=0,0,10,10", ""),
    ("zoom=2", ""),
    ("rot=90&x=1", ""),
    ("rot=90&", ""),
    ("&rot=90", ""),
    ("rot", ""),
    ("rot=90;crop=0,0,10,10", ""),
    ("ROT=90", ""),
    ("rot=90" + "&rot=90" * 20, ""),
    ("crop=" + "0" * 70 + ",0,10,10", ""),
    ('"><img src=x onerror=alert`1`>', ""),
    ("javascript:alert`1`", ""),
    ("rot=90%26crop=0,0,10,10", ""),
])
def test_a_fragment_is_kept_only_in_its_canonical_form(raw: str, kept: str) -> None:
    assert diary.canonical_fragment(raw) == kept


def test_saving_writes_the_canonical_form_and_keeps_the_picture(client: TestClient, account: Account) -> None:
    photo = shot(client)
    sent = "\n\n".join([
        f"![Erste](photo:{photo}#rot=90&crop=0100,0,0900,1000)",
        f"![Zweite](photo:{photo}#crop=0,0,1000,1000&rot=0)",
        f"![Dritte](photo:{photo}#zoom=3&rot=90)",
        f"![Vierte](photo:{photo}#crop=1, 2,30,40)",
        f'![Fünfte](photo:{photo}#"><img src=x onerror=alert`1`>)',
        f"![Sechste](photo:{photo}#{'rot=90&' * 30}rot=90)",
        f"![Siebte](photo:{photo}#)",
    ])
    saved = put(client, text=sent)
    assert saved.status_code == 200
    assert saved.json()["text"] == "\n\n".join([
        f"![Erste](photo:{photo}#crop=100,0,900,1000&rot=90)",
        f"![Zweite](photo:{photo})",
        f"![Dritte](photo:{photo})",
        f"![Vierte](photo:{photo})",
        f"![Fünfte](photo:{photo})",
        f"![Sechste](photo:{photo})",
        f"![Siebte](photo:{photo})",
    ])
    assert diary.text_photo_ids(saved.json()["text"]) == [photo]
    # The draft keeps the canonical form too.
    draft = client.put(f"/api/days/{DAY}/draft", json={"text": f"![x](photo:{photo}#rot=180&crop=0,0,10,10)",
                                                       "base_revision": saved.json()["revision"]})
    assert draft.json()["text"] == f"![x](photo:{photo}#crop=0,0,10,10&rot=180)"


def test_brackets_or_parentheses_in_a_fragment_make_no_picture(client: TestClient, account: Account) -> None:
    """The fragment ends at a bracket or parenthesis: what follows is text, never a picture the server would not see."""
    photo = shot(client)
    for odd in (f"![x](photo:{photo}#rot=90(1))", f"![x](photo:{photo}#[rot=90])", f"![x](photo:{photo}#rot=90\n)"):
        assert diary.text_photo_ids(odd) == [], odd


def test_a_stranger_or_another_day_with_a_fragment_is_still_removed(client: TestClient, account: Account) -> None:
    mine = shot(client)
    other_day = shot(client, "2026-10-05")
    with new_client(make_account("ben")) as ben:
        theirs = shot(ben)
    sent = (f"A ![m](photo:{mine}#rot=90)\n\n![t](photo:{theirs}#rot=90)\n\n![o](photo:{other_day}#crop=0,0,10,10)"
            "\n\nB")
    kept = put(client, text=sent).json()["text"]
    assert kept == f"A ![m](photo:{mine}#rot=90)\n\nB"


def test_words_search_and_the_start_of_a_page_see_through_the_fragment(client: TestClient, account: Account) -> None:
    photo = shot(client)
    text = f"Drei einfache Worte.\n\n![Eichel am Weg](photo:{photo}#crop=100,100,500,500&rot=90)\n\nUnd zwei."
    saved = put(client, text=text).json()
    assert saved["words"] == 5
    [entry] = client.post("/api/journal", json={}).json()["days"]
    assert entry["excerpt"] == "Drei einfache Worte. Und zwei."
    hits = client.post("/api/search", json={"q": "Eichel"}).json()["results"]
    assert [hit["kind"] for hit in hits] == ["text"] and "crop" not in hits[0]["snippet"]
    for needle in ("crop", "rot=90", photo):
        assert client.post("/api/search", json={"q": needle}).json()["results"] == [], needle
    long = "Wort " * (diary.EXCERPT_SOURCE // 5) + f"![lang](photo:{photo}#crop=100,100,500,500&rot=90)"
    cut = diary.excerpt(long[: diary.EXCERPT_SOURCE - 20] + long[-60:])
    assert "crop" not in cut and "![" not in cut and "rot=" not in cut


def test_the_person_a_day_is_shared_with_gets_the_picture_with_its_fragment(client: TestClient,
                                                                           account: Account) -> None:
    photo = shot(client)
    assert put(client, text=f"Text ![x](photo:{photo}#rot=270)").status_code == 200
    ben = make_account("ben")
    assert client.put(f"/api/days/{DAY}/shares", json={"to": [ben.id]}).status_code == 200
    with new_client(ben) as reader:
        assert reader.get(f"/api/shared/{account.id}/{DAY}").json()["text"] == f"Text ![x](photo:{photo}#rot=270)"
        assert reader.get(f"/api/shared/{account.id}/{DAY}/photos/{photo}").status_code == 200


def test_a_page_of_half_pictures_is_read_in_one_pass(client: TestClient, account: Account) -> None:
    """Many starts of a picture with a fragment that never closes: no start reads past the next one."""
    photo = shot(client)
    half = f"![](photo:{photo}#crop=0,0,10,10"
    text = (half * (diary.TEXT_MAX // len(half)))[: diary.TEXT_MAX]
    started = time.perf_counter()
    for _ in range(3):
        assert diary.text_photo_ids(text) == []
        diary.canonical_photos(text)
        diary.strip_images(text)
    assert time.perf_counter() - started < 1.0
    assert put(client, text=text).status_code == 200


def test_deleting_a_photo_takes_its_pictures_with_their_fragments(client: TestClient, account: Account) -> None:
    photo = shot(client)
    stays = shot(client)
    text = f"A\n\n![x](photo:{photo}#rot=90)\n\n![y](photo:{stays}#crop=0,0,10,10)\n\nB"
    assert put(client, text=text).status_code == 200
    assert client.get(f"/api/photos/{photo}/uses").json()["text"] is True
    assert client.delete(f"/api/photos/{photo}").status_code == 204
    assert client.get(f"/api/days/{DAY}").json()["text"] == f"A\n\n![y](photo:{stays}#crop=0,0,10,10)\n\nB"
    assert code(client.get(f"/api/photos/{photo}/uses")) == (404, "not_found")
