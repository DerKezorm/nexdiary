"""The whole collection of the own Immich: a timeline newest first in pages, a day or a month to jump to, the albums
(left out with a word when the key may not read them), a search (smart, else by description, place and file name), and
what was uploaded lately. Every road is the person's own link through the same bolt and host list as the photos of a
day; a search word is in no address and no log; a photo taken from the collection belongs to the day it is taken for,
once. Always against the stand-in (``fake_immich``); every key is made for the run."""

# ruff: noqa: F811 - the fixtures are imported from another test module and used by name

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.services import brakes, immich_browse

from .conftest import person
from .fake_immich import ALL, Asset, FakeImmich, made_key
from .test_immich import (  # noqa: F401 - the fixtures are used by name
    DAY,
    HOST,
    NOW,
    Lookups,
    address,
    code,
    connect,
    fake,
    lookups,
    open_immich,
    ready,
)


def stamp(moment: datetime) -> str:
    return moment.isoformat()


@pytest.fixture
def library(client: TestClient, operator: Account, fake: FakeImmich, monkeypatch: pytest.MonkeyPatch
            ) -> tuple[str, list[Asset]]:
    """Seven photos over four months, oldest first in the list; a video and one in the bin; two albums."""
    monkeypatch.setattr(immich_browse, "PAGE", 3)
    key = made_key()
    shots = [Asset(taken=f"2026-{month:02d}-{day:02d}T10:00:00+00:00") for month, day in
             ((7, 3), (7, 20), (8, 9), (8, 10), (9, 1), (9, 30), (10, 6))]
    video = Asset(taken="2026-10-01T10:00:00+00:00", type="VIDEO")
    trashed = Asset(taken="2026-10-02T10:00:00+00:00", trashed=True)
    fake.library(key, *shots, video, trashed)
    fake.albums[key] = [(str(uuid.uuid4()), "Sommer", [shots[0].id, shots[1].id, shots[2].id]),
                        (str(uuid.uuid4()), "Leer", [])]
    open_immich(client)
    connect(client, fake, key)
    return key, shots


def ids(answer: object) -> list[str]:
    assert answer.status_code == 200, answer.text  # type: ignore[attr-defined]
    return [photo["id"] for photo in answer.json()["photos"]]  # type: ignore[attr-defined]


# --- The timeline -------------------------------------------------------------------------------------------------------


def test_the_timeline_is_the_whole_collection_newest_first_in_pages(client: TestClient,
                                                                    library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    newest_first = [asset.id for asset in reversed(shots)]
    first = client.get("/api/immich/timeline")
    assert ids(first) == newest_first[:3] and first.json()["next"] == 2
    second = client.get("/api/immich/timeline", params={"page": 2})
    assert ids(second) == newest_first[3:6] and second.json()["next"] == 3
    last = client.get("/api/immich/timeline", params={"page": 3})
    assert ids(last) == newest_first[6:] and last.json()["next"] is None
    # Not one of the photos is from "the day": the collection is not limited to it.
    assert shots[0].taken[:10] < DAY
    assert all(entry["taken_at"] for entry in first.json()["photos"])


def test_videos_the_bin_and_what_is_hidden_are_never_offered(client: TestClient, library: tuple[str, list[Asset]],
                                                             fake: FakeImmich) -> None:
    key, shots = library
    odd = [Asset(taken="2026-10-05T10:00:00+00:00", visibility="hidden"),
           Asset(taken="2026-10-05T11:00:00+00:00", visibility="locked"),
           Asset(taken="2026-10-05T12:00:00+00:00", type="VIDEO"),
           Asset(taken="2026-10-05T13:00:00+00:00", trashed=True)]
    fake.libraries[key].extend(odd)
    everything: list[str] = []
    page: int | None = 1
    while page:
        found = client.get("/api/immich/timeline", params={"page": page})
        everything += ids(found)
        page = found.json()["next"]
    assert sorted(everything) == sorted(asset.id for asset in shots)
    assert not {asset.id for asset in odd} & set(everything)


def test_a_day_or_a_month_to_jump_to(client: TestClient, library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    # Up to the end of the 10th of August: that day's photo comes first.
    assert ids(client.get("/api/immich/timeline", params={"until": "2026-08-10"})) == [
        shots[3].id, shots[2].id, shots[1].id]
    # The 9th ends before the 10th begins.
    assert ids(client.get("/api/immich/timeline", params={"until": "2026-08-09"}))[0] == shots[2].id
    # A month: up to its last day.
    assert ids(client.get("/api/immich/timeline", params={"until": "2026-07"})) == [shots[1].id, shots[0].id]
    assert ids(client.get("/api/immich/timeline", params={"until": "2026-09"}))[0] == shots[5].id
    assert ids(client.get("/api/immich/timeline", params={"until": "2025-01-01"})) == []
    for bad in ("2026", "08-10", "2026-13", "2026-02-30", "tomorrow", "2026-8-10", "0000-01"):
        assert code(client.get("/api/immich/timeline", params={"until": bad})) == (422, "immich_until_invalid"), bad
    assert client.get("/api/immich/timeline", params={"page": 0}).status_code == 422
    assert client.get("/api/immich/timeline", params={"page": "x"}).status_code == 422


def test_the_zone_of_the_person_decides_where_a_day_ends(client: TestClient, library: tuple[str, list[Asset]],
                                                         fake: FakeImmich) -> None:
    key, _shots = library
    late = Asset(taken="2026-08-10T22:30:00+00:00")  # 00:30 on the 11th in Berlin
    fake.libraries[key].append(late)
    assert late.id not in ids(client.get("/api/immich/timeline", params={"until": "2026-08-10"}))
    assert late.id in ids(client.get("/api/immich/timeline", params={"until": "2026-08-11"}))


# --- The bolts hold on every road ---------------------------------------------------------------------------------------

ROADS = [("get", "/api/immich/timeline", None), ("get", "/api/immich/recent", None), ("get", "/api/immich/albums", None),
         ("get", "/api/immich/albums/{album}/photos", None), ("post", "/api/immich/search", {"q": "baum"})]


def call(client: TestClient, road: tuple[str, str, object], album: str = "") -> object:
    method, path, body = road
    return getattr(client, method)(path.format(album=album or "6f9619ff-8b86-d011-b42d-00c04fc964ff"),
                                   **({"json": body} if body else {}))


@pytest.mark.parametrize("road", ROADS, ids=[road[1] for road in ROADS])
def test_closed_not_connected_not_allowed_and_not_listed_stop_every_road(
    road: tuple[str, str, object], client: TestClient, operator: Account, fake: FakeImmich
) -> None:
    assert code(call(client, road)) == (403, "immich_closed")
    open_immich(client)
    assert code(call(client, road)) == (409, "immich_not_connected")
    key = made_key()
    fake.library(key, Asset(taken="2026-08-10T10:00:00+00:00"))
    connect(client, fake, key)
    assert call(client, road).status_code in (200, 404)
    before = len(fake.requests)
    # Taken off the list of hosts: from the next request on.
    open_immich(client, "elsewhere.example.com")
    assert code(call(client, road)) == (403, "immich_host_not_allowed")
    open_immich(client)
    assert len(fake.requests) == before
    # The operator took Immich from this account.
    with person("ben") as ben:
        other = made_key()
        fake.library(other, Asset(taken="2026-08-10T10:00:00+00:00"))
        connect(ben, fake, other)
        ben_id = next(row["id"] for row in client.get("/api/accounts").json() if row["name"] == "ben")
        assert client.put(f"/api/accounts/{ben_id}/permissions", json={"immich_allowed": False}).status_code == 200
        before = len(fake.requests)
        assert code(call(ben, road)) == (403, "immich_not_allowed")
        assert len(fake.requests) == before


def test_nobody_reaches_the_collection_of_somebody_else(client: TestClient, library: tuple[str, list[Asset]],
                                                        fake: FakeImmich) -> None:
    _key, shots = library
    with person("ben") as ben:
        other = made_key()
        mine = Asset(taken="2026-08-10T10:00:00+00:00")
        fake.library(other, mine)
        connect(ben, fake, other)
        seen = ids(ben.get("/api/immich/timeline"))
        assert seen == [mine.id]
        assert not set(seen) & {asset.id for asset in shots}
        # The album of Jule is not Ben's: his Immich knows nothing of it, and nothing of Jule's comes back.
        album = fake.albums[library[0]][0][0]
        assert ids(ben.get(f"/api/immich/albums/{album}/photos")) == []
        assert ben.get("/api/immich/albums").json()["albums"] == []


# --- Albums --------------------------------------------------------------------------------------------------------------


def test_the_albums_and_their_photos(client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich) -> None:
    _key, shots = library
    listed = client.get("/api/immich/albums").json()
    assert listed["available"] is True
    assert [(album["name"], album["count"]) for album in listed["albums"]] == [("Sommer", 3), ("Leer", 0)]
    assert listed["albums"][0]["cover"] == shots[0].id and listed["albums"][1]["cover"] is None
    summer = listed["albums"][0]["id"]
    first = client.get(f"/api/immich/albums/{summer}/photos")
    assert ids(first) == [shots[2].id, shots[1].id, shots[0].id] and first.json()["next"] is None
    assert ids(client.get(f"/api/immich/albums/{listed['albums'][1]['id']}/photos")) == []
    assert code(client.get("/api/immich/albums/not-an-album/photos")) == (404, "not_found")


def test_without_the_permission_for_albums_everything_else_still_works(client: TestClient,
                                                                       library: tuple[str, list[Asset]],
                                                                       fake: FakeImmich) -> None:
    key, shots = library
    fake.permissions[key] = tuple(name for name in ALL if name != "album.read")
    listed = client.get("/api/immich/albums")
    assert listed.status_code == 200
    assert listed.json() == {"available": False, "needed": "album.read", "albums": []}
    assert ids(client.get("/api/immich/timeline"))[0] == shots[-1].id
    # Another permission missing is still the plain refusal.
    fake.permissions[key] = tuple(name for name in ALL if name != "asset.read")
    assert code(client.get("/api/immich/timeline")) == (502, "immich_permission")


def test_a_service_that_answers_with_something_else_is_unreadable_not_a_crash(
    client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich
) -> None:
    def odd(handler: object, op: str) -> bool:
        if op == "/api/albums":
            handler.send_json(200, {"albums": "none"})  # type: ignore[attr-defined]
            return True
        if op == "/api/search/metadata":
            handler.send_json(200, {"assets": {"items": "no"}})  # type: ignore[attr-defined]
            return True
        return False

    fake.misbehave = odd
    assert code(client.get("/api/immich/albums")) == (502, "immich_unreadable")
    assert code(client.get("/api/immich/timeline")) == (502, "immich_unreadable")


# --- The search ------------------------------------------------------------------------------------------------------------


def test_the_search_uses_the_smart_search_and_the_word_stays_out_of_addresses_and_logs(
    client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich, caplog: pytest.LogCaptureFixture
) -> None:
    _key, shots = library
    shots[2].about = "Kinder am Strand mit Eimer"
    shots[5].about = "Strand bei Nacht"
    word = "Strandmuschel Ostsee"
    with caplog.at_level("DEBUG"):
        found = client.post("/api/immich/search", json={"q": "strand"})
        assert found.status_code == 200 and found.json()["mode"] == "smart"
        assert set(ids(found)) == {shots[5].id, shots[2].id}
        client.post("/api/immich/search", json={"q": word})
    assert word not in caplog.text and "strand" not in caplog.text.lower()
    assert not [seen for seen in fake.requests if "strand" in seen.path.lower()], "never in an address"
    sent = [seen for seen in fake.requests if seen.path == "/api/search/smart"]
    assert sent and sent[0].body["query"] == "strand" and sent[0].body["type"] == "IMAGE"


def test_where_the_smart_search_is_not_there_the_metadata_search_stands_in(
    client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich
) -> None:
    _key, shots = library
    shots[1].about = "Hafen von Kiel"
    fake.smart = False
    found = client.post("/api/immich/search", json={"q": "kiel"})
    assert found.status_code == 200 and found.json()["mode"] == "metadata"
    assert ids(found) == [shots[1].id] and found.json()["next"] is None
    assert client.post("/api/immich/search", json={"q": "kiel", "page": 2}).json()["photos"] == []


def test_a_search_word_is_checked(client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich) -> None:
    for empty in ("", "   ", "\x00\x01\n\t"):
        assert code(client.post("/api/immich/search", json={"q": empty})) == (422, "immich_search_empty")
    assert code(client.post("/api/immich/search", json={"q": "a" * 101}))[1] in ("search_too_long", "invalid_input")
    assert client.post("/api/immich/search", json={"q": "baum", "page": 0}).status_code == 422
    assert client.post("/api/immich/search", json={"q": "baum", "extra": 1}).status_code == 422
    assert not [seen for seen in fake.requests if seen.path.startswith("/api/search")], "nothing went out"


# --- Lately uploaded ------------------------------------------------------------------------------------------------------


def test_new_in_immich_is_by_the_time_of_upload_not_the_time_of_the_shot(
    client: TestClient, operator: Account, fake: FakeImmich, lookups: Lookups
) -> None:
    key = made_key()
    # A phone photo from last week, uploaded an hour ago; a photo of today uploaded three days ago; an old one.
    late = Asset(taken="2026-09-28T09:00:00+00:00", uploaded=stamp(NOW - timedelta(hours=1)))
    newer = Asset(taken="2026-10-06T07:00:00+00:00", uploaded=stamp(NOW - timedelta(hours=30)))
    stale = Asset(taken="2026-10-06T08:00:00+00:00", uploaded=stamp(NOW - timedelta(days=3)))
    fake.library(key, stale, newer, late)
    open_immich(client)
    connect(client, fake, key)
    found = client.get("/api/immich/recent").json()
    assert [entry["id"] for entry in found["photos"]] == [late.id, newer.id], "newest upload first, old ones left out"
    assert found["photos"][0]["taken_at"] == "2026-09-28T09:00:00+00:00"
    assert found["photos"][0]["uploaded_at"] == stamp(NOW - timedelta(hours=1))
    assert found["date"] == DAY and found["more"] is False
    # The photos of the day still list what was taken that day.
    assert {entry["id"] for entry in client.get("/api/immich/photos").json()["photos"]} == {stale.id, newer.id}


def test_at_most_thirty_and_each_knows_whether_it_was_taken(client: TestClient, operator: Account, fake: FakeImmich,
                                                            lookups: Lookups) -> None:
    key = made_key()
    many = [Asset(taken=f"2026-10-0{1 + index % 5}T0{index % 9}:00:00+00:00",
                  uploaded=stamp(NOW - timedelta(minutes=index))) for index in range(40)]
    fake.library(key, *many)
    open_immich(client)
    connect(client, fake, key)
    found = client.get("/api/immich/recent").json()
    assert len(found["photos"]) == immich_browse.RECENT_MAX == 30
    assert found["more"] is True
    assert [entry["id"] for entry in found["photos"]] == [asset.id for asset in many[:30]]
    first = found["photos"][0]["id"]
    taken = client.post(f"/api/immich/photos/{first}", json={"date": DAY, "anywhen": True})
    assert taken.status_code == 201, taken.text
    again = client.get("/api/immich/recent").json()["photos"][0]
    assert again["photo_id"] == taken.json()["id"]
    assert all(entry["photo_id"] is None for entry in client.get("/api/immich/recent").json()["photos"][1:])


# --- Taking a photo from the collection ----------------------------------------------------------------------------------


def test_a_photo_of_any_day_is_taken_for_the_day_it_is_taken_for_once(client: TestClient,
                                                                       library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    old = shots[0]
    assert old.taken[:10] == "2026-07-03"
    # Without the wish for any day, the old rule stands.
    assert code(client.post(f"/api/immich/photos/{old.id}", json={"date": DAY})) == (422, "immich_other_day")
    taken = client.post(f"/api/immich/photos/{old.id}", json={"date": DAY, "anywhen": True})
    assert taken.status_code == 201, taken.text
    photo = taken.json()
    assert photo["date"] == DAY and photo["source"] == "immich"
    # Twice is once.
    again = client.post(f"/api/immich/photos/{old.id}", json={"date": DAY, "anywhen": True})
    assert again.status_code == 200 and again.json()["id"] == photo["id"]
    assert [item["id"] for item in client.get(f"/api/photos?date={DAY}").json()] == [photo["id"]]
    # It can be the cover of the day it was taken for, not of another.
    assert client.put(f"/api/days/{DAY}", json={"cover": f"photo:{photo['id']}"}).status_code == 200
    assert code(client.put("/api/days/2026-10-05", json={"cover": f"photo:{photo['id']}"})) == (422, "cover_other_day")
    # The same photo for another day is a photo of that day too.
    other = client.post(f"/api/immich/photos/{old.id}", json={"date": "2026-10-05", "anywhen": True})
    assert other.status_code == 201 and other.json()["id"] != photo["id"] and other.json()["date"] == "2026-10-05"


def test_a_photo_of_the_collection_can_go_with_a_note(client: TestClient, library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    taken = client.post(f"/api/immich/photos/{shots[1].id}", json={"date": DAY, "anywhen": True, "note": True})
    assert taken.status_code == 201 and taken.json()["on_note"] is True
    day_one = client.post(f"/api/immich/photos/{shots[1].id}", json={"date": DAY, "anywhen": True})
    assert day_one.status_code == 201 and day_one.json()["id"] != taken.json()["id"], "for the note and for the day"


@pytest.mark.parametrize("what", ["video", "trashed", "hidden"])
def test_only_still_pictures_that_are_visible_are_taken(client: TestClient, library: tuple[str, list[Asset]],
                                                        fake: FakeImmich, what: str) -> None:
    key, _shots = library
    fake.libraries[key].append(Asset(taken="2026-10-03T10:00:00+00:00", visibility="hidden"))
    unwanted = next(asset for asset in fake.libraries[key] if (what == "video" and asset.type == "VIDEO")
                    or (what == "trashed" and asset.trashed) or (what == "hidden" and asset.visibility == "hidden"))
    assert code(client.post(f"/api/immich/photos/{unwanted.id}", json={"date": DAY, "anywhen": True})) == (
        422, "immich_not_a_picture")


def test_a_locked_day_takes_no_photo_from_the_collection(client: TestClient, library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    client.put(f"/api/days/{DAY}", json={"title": "Zu", "text": "Zu."})
    assert client.post(f"/api/days/{DAY}/lock").status_code == 200
    assert code(client.post(f"/api/immich/photos/{shots[0].id}", json={"date": DAY, "anywhen": True})) == (
        409, "day_locked")


def test_paging_has_a_brake_of_its_own(client: TestClient, library: tuple[str, list[Asset]],
                                       monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(brakes.LIMITS, "immich_browse", 3)
    for _ in range(3):
        assert client.get("/api/immich/timeline").status_code == 200
    slow = client.get("/api/immich/timeline")
    assert code(slow) == (429, "immich_too_often") and slow.headers["retry-after"] == "60"
    # The photos of a day have their own brake and the small pictures too.
    assert client.get("/api/immich/photos").status_code == 200


def test_the_small_pictures_of_any_photo_come_through_the_proxy(client: TestClient,
                                                                library: tuple[str, list[Asset]]) -> None:
    _key, shots = library
    answer = client.get(f"/api/immich/photos/{shots[0].id}/thumbnail")
    assert answer.status_code == 200 and answer.headers["content-type"] == "image/jpeg"


def test_a_search_that_fails_for_another_reason_is_not_answered_with_the_other_search(
    client: TestClient, library: tuple[str, list[Asset]], fake: FakeImmich
) -> None:
    """Only a smart search that is not there falls back; a key it refused, or an Immich that cannot be reached, is said."""
    _key, shots = library
    shots[1].about = "Hafen von Kiel"

    def refuse_smart(handler: object, op: str) -> bool:
        if op == "/api/search/smart":
            handler.send_json(401, {"message": "Invalid API key"})  # type: ignore[attr-defined]
            return True
        return False

    fake.misbehave = refuse_smart
    assert code(client.post("/api/immich/search", json={"q": "kiel"})) == (502, "immich_key_refused")
    assert not [seen for seen in fake.requests if seen.path == "/api/search/metadata" and seen.body.get("description")]
