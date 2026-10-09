"""Time capsules: who sees what and from when, on every route, from every side.

Jule writes; Tom and Mia receive; Ben is a third person on the server, the operator a fourth. Before its day a
recipient sees who sent a capsule, its title and the day, never its text or its photo; a letter only to oneself is
sealed for its sender too. A capsule changes or goes back only until it opened for somebody. The clock is set by the
test, never read from the wall."""

from __future__ import annotations

import io
import secrets
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from app import clock
from app.db import SessionLocal
from app.models import Account, Capsule, CapsuleKey, CapsuleUpload
from app.services import capsules

from .conftest import MEDIA, PASSWORD, make_account, new_client, sign_in

#: Friday 9 October 2026, noon in Berlin.
NOON = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
OPENS = "2026-12-24"


@dataclass
class Family:
    operator: TestClient
    jule: TestClient
    tom: TestClient
    mia: TestClient
    ben: TestClient
    ids: dict[str, int] = field(default_factory=dict)
    moment: list[datetime] = field(default_factory=lambda: [NOON])
    accounts: dict[str, Account] = field(default_factory=dict)

    def at(self, when: datetime) -> None:
        """Sets the clock; everybody signs in anew then (a session of months ago would have run out)."""
        self.moment[0] = when
        with SessionLocal() as db:
            standing = set(db.scalars(select(Account.id)))
        for name, row in self.accounts.items():
            if row.id in standing:
                sign_in(getattr(self, name), row)


@pytest.fixture
def family(client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> Iterator[Family]:
    moment = [NOON]
    monkeypatch.setattr(clock, "now", lambda: moment[0])
    people = {name: make_account(name) for name in ("jule", "tom", "mia", "ben")}
    clients = {name: new_client(row) for name, row in people.items()}
    for browser in [client, *clients.values()]:
        assert browser.put("/api/me/preferences", json={"timezone": "Europe/Berlin"}).status_code == 200
    out = Family(operator=client, **clients, ids={name: row.id for name, row in people.items()}, moment=moment,
                 accounts={**people, "operator": operator})
    out.ids["operator"] = operator.id
    try:
        yield out
    finally:
        for browser in clients.values():
            browser.close()


def jpeg(word: str = "", colour: tuple[int, int, int] = (120, 160, 90)) -> bytes:
    image = Image.new("RGB", (64, 48), colour)
    out = io.BytesIO()
    if word:
        exif = Image.Exif()
        exif[0x010E] = f"Bild {word}"
        image.save(out, "JPEG", exif=exif.tobytes())
    else:
        image.save(out, "JPEG")
    return out.getvalue()


def photo(client: TestClient, word: str = "") -> str:
    answer = client.post("/api/capsules/photos", params={"upload_id": str(uuid.uuid4())}, content=jpeg(word))
    assert answer.status_code == 201, answer.text
    return str(answer.json()["id"])


def close(client: TestClient, to: list[int], opens: str = OPENS, title: str = "Für Heiligabend",
          text: str = "Wir backen Plätzchen.\n\nUnd dann?", with_photo: str | None = None,
          client_id: str | None = None, status: int = 201) -> dict[str, Any]:
    answer = client.post("/api/capsules", json={"id": client_id or str(uuid.uuid4()), "to": to, "opens_on": opens,
                                                "title": title, "text": text, "photo": with_photo})
    assert answer.status_code == status, answer.text
    return answer.json()


def count(model: Any) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)


def media_files() -> set[str]:
    return {path.name for path in MEDIA.iterdir() if path.is_file()}


def berlin_midnight(day: str) -> datetime:
    """00:00 of the day in Berlin (in winter UTC+1, in summer UTC+2), as UTC."""
    from zoneinfo import ZoneInfo

    return datetime.fromisoformat(f"{day}T00:00:00").replace(tzinfo=ZoneInfo("Europe/Berlin")).astimezone(UTC)


# --- Before the day: who, the title and the day, nothing else -------------------------------------------------------


def test_before_its_day_a_recipient_sees_who_the_title_and_the_day_on_every_way(family: Family) -> None:
    word = "Qx" + secrets.token_hex(5) + "Zy"
    upload = photo(family.jule)
    made = close(family.jule, [family.ids["tom"]], title="Für Heiligabend", text=f"Geheim {word}", with_photo=upload)
    uid = made["id"]
    listed = family.tom.get("/api/capsules")
    assert listed.status_code == 200
    item = listed.json()["for_me"][0]
    assert item["title"] == "Für Heiligabend" and item["opens_on"] == OPENS and item["from"]["name"] == "jule"
    assert item["open"] is False and "photo" not in item and word not in listed.text
    single = family.tom.get(f"/api/capsules/{uid}")
    assert single.status_code == 200 and "text" not in single.json() and "photo" not in single.json()
    assert word not in single.text and "to" not in single.json(), "a recipient does not see who else it is for"
    for path in (f"/api/capsules/{uid}/photo", f"/api/capsules/{uid}/photo/preview"):
        assert family.tom.get(path).status_code == 404, path
    assert family.tom.post(f"/api/capsules/{uid}/read").status_code == 409
    assert family.tom.get("/api/capsules/count").json() == {"new": 0}
    # The day before, one second before midnight in Berlin: still closed.
    family.at(berlin_midnight(OPENS) - timedelta(seconds=1))
    assert "text" not in family.tom.get(f"/api/capsules/{uid}").json()
    assert family.tom.get(f"/api/capsules/{uid}/photo").status_code == 404
    # Midnight: open, with its text and its photo, and new until read.
    family.at(berlin_midnight(OPENS))
    assert family.tom.get("/api/capsules/count").json() == {"new": 1}
    opened = family.tom.get(f"/api/capsules/{uid}").json()
    assert opened["text"] == f"Geheim {word}" and opened["photo"] is True and opened["open"] is True
    picture = family.tom.get(f"/api/capsules/{uid}/photo")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/webp"
    assert "no-store" in picture.headers["cache-control"]
    assert family.tom.get(f"/api/capsules/{uid}/photo/preview").status_code == 200
    assert family.tom.post(f"/api/capsules/{uid}/read").status_code == 204
    assert family.tom.get("/api/capsules/count").json() == {"new": 0}
    assert family.tom.get("/api/capsules").json()["for_me"][0]["new"] is False


def test_a_letter_only_to_oneself_is_sealed_for_its_sender_too(family: Family) -> None:
    upload = photo(family.jule)
    made = close(family.jule, [family.ids["jule"]], title="An mich, in einem Jahr", text="Wo stehe ich?",
                 with_photo=upload)
    uid = made["id"]
    assert made["sealed"] is True and "text" not in made
    lists = family.jule.get("/api/capsules").json()
    assert [item["title"] for item in lists["for_me"]] == ["An mich, in einem Jahr"]
    assert lists["from_me"][0]["sealed"] is True and lists["from_me"][0]["opened"] is False
    single = family.jule.get(f"/api/capsules/{uid}").json()
    assert "text" not in single and "photo" not in single
    assert family.jule.get(f"/api/capsules/{uid}/photo").status_code == 404
    change = family.jule.put(f"/api/capsules/{uid}", json={"revision": 0, "to": [family.ids["jule"]],
                                                           "opens_on": OPENS, "title": "Neu", "text": "Neu"})
    assert change.status_code == 409 and change.json()["detail"]["code"] == "capsule_sealed"
    # Changing the recipients does not open it either.
    change = family.jule.put(f"/api/capsules/{uid}", json={"revision": 0, "to": [family.ids["tom"]],
                                                           "opens_on": OPENS, "title": "Neu", "text": "Neu"})
    assert change.status_code == 409
    # On its day it opens for its writer, as for anybody it is for.
    family.at(berlin_midnight(OPENS))
    assert family.jule.get(f"/api/capsules/{uid}").json()["text"] == "Wo stehe ich?"
    assert family.jule.get(f"/api/capsules/{uid}/photo").status_code == 200


def test_a_sealed_letter_can_be_taken_back_and_is_gone_with_its_photo(family: Family) -> None:
    before = media_files()
    upload = photo(family.jule)
    uid = close(family.jule, [family.ids["jule"]], with_photo=upload)["id"]
    assert len(media_files() - before) == 2, "the photo and its smaller copy, the upload gone"
    assert family.jule.delete(f"/api/capsules/{uid}").status_code == 204
    assert family.jule.get(f"/api/capsules/{uid}").status_code == 404
    assert count(Capsule) == 0 and count(CapsuleKey) == 0
    assert media_files() == before


def test_to_others_the_sender_reads_changes_and_takes_back_until_it_opened(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"], family.ids["jule"]], text="Erster Text")
    uid = made["id"]
    assert made["sealed"] is False and made["text"] == "Erster Text"
    assert [person["name"] for person in made["to"]] == ["jule", "tom"]
    changed = family.jule.put(f"/api/capsules/{uid}", json={
        "revision": made["revision"], "to": [family.ids["tom"], family.ids["mia"]], "opens_on": "2026-12-31",
        "title": "Silvester", "text": "Zweiter Text"})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["revision"] == made["revision"] + 1 and body["opens_on"] == "2026-12-31"
    assert [person["name"] for person in body["to"]] == ["tom", "mia"] and body["text"] == "Zweiter Text"
    # Jule is no longer among the recipients, Mia is.
    assert family.jule.get("/api/capsules").json()["for_me"] == []
    assert family.mia.get("/api/capsules").json()["for_me"][0]["title"] == "Silvester"
    # Open for Tom and Mia: no change, no taking back, for the sender either.
    family.at(berlin_midnight("2026-12-31"))
    refused = family.jule.put(f"/api/capsules/{uid}", json={
        "revision": body["revision"], "to": [family.ids["tom"]], "opens_on": "2027-01-01", "title": "x", "text": "y"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "capsule_open"
    gone = family.jule.delete(f"/api/capsules/{uid}")
    assert gone.status_code == 409 and gone.json()["detail"]["code"] == "capsule_open"
    assert family.jule.get("/api/capsules").json()["from_me"][0]["opened"] is True
    assert family.tom.get(f"/api/capsules/{uid}").json()["text"] == "Zweiter Text"


def test_taking_back_a_capsule_to_others_leaves_nothing_for_them(family: Family) -> None:
    uid = close(family.jule, [family.ids["tom"], family.ids["mia"]])["id"]
    assert family.jule.delete(f"/api/capsules/{uid}").status_code == 204
    for browser in (family.tom, family.mia):
        assert browser.get("/api/capsules").json()["for_me"] == []
        assert browser.get(f"/api/capsules/{uid}").status_code == 404
    assert family.jule.delete(f"/api/capsules/{uid}").status_code == 404


def test_strangers_and_the_operator_find_nothing_as_if_it_did_not_exist(family: Family) -> None:
    uid = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule))["id"]
    family.at(berlin_midnight(OPENS) + timedelta(days=1))
    missing = secrets.token_hex(16)
    body = {"revision": 0, "to": [family.ids["ben"]], "opens_on": "2027-01-01", "title": "x", "text": "y"}
    for stranger in (family.ben, family.operator, family.mia):
        for target in (uid, missing):
            assert stranger.get(f"/api/capsules/{target}").status_code == 404
            assert stranger.get(f"/api/capsules/{target}/photo").status_code == 404
            assert stranger.post(f"/api/capsules/{target}/read").status_code == 404
            assert stranger.put(f"/api/capsules/{target}", json=body).status_code == 404
            assert stranger.delete(f"/api/capsules/{target}").status_code == 404
        listed = stranger.get("/api/capsules").json()
        assert (listed["for_me"], listed["from_me"], listed["new"]) == ([], [], 0)
    # A recipient cannot change or take back what is not theirs.
    assert family.tom.put(f"/api/capsules/{uid}", json=body).status_code == 404
    assert family.tom.delete(f"/api/capsules/{uid}").status_code == 404
    for odd in ("x", "1" * 33, "../" + uid, uid.upper() + "g"):
        assert family.tom.get(f"/api/capsules/{odd}").status_code == 404


def test_blocked_people_cannot_be_chosen_and_a_blocked_sender_s_capsules_vanish(family: Family) -> None:
    uid = close(family.jule, [family.ids["tom"]])["id"]
    blocked = family.operator.post(f"/api/accounts/{family.ids['mia']}/block", json={"current_password": PASSWORD})
    assert blocked.status_code == 204
    refused = family.jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [family.ids["mia"]],
                                                      "opens_on": OPENS, "title": "x", "text": "y"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "person_unknown"
    assert family.operator.post(f"/api/accounts/{family.ids['jule']}/block",
                                json={"current_password": PASSWORD}).status_code == 204
    family.at(berlin_midnight(OPENS))
    assert family.tom.get("/api/capsules").json()["for_me"] == []
    assert family.tom.get("/api/capsules/count").json() == {"new": 0}
    assert family.tom.get(f"/api/capsules/{uid}").status_code == 404
    assert family.operator.post(f"/api/accounts/{family.ids['jule']}/unblock",
                                json={"current_password": PASSWORD}).status_code == 204
    assert family.tom.get(f"/api/capsules/{uid}").status_code == 200, "unblocked, it is there again"


def test_a_block_that_comes_in_between_is_caught_by_the_statement_that_writes(
    family: Family, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mia is blocked after the look at who may be chosen and before the capsule is written: the statement that
    writes her copy of the key checks again, and nothing is kept."""
    real = capsules._chosen

    def looked_before_the_block(db: Any, sender: Account, ids: list[int], keep: set[int] | None = None) -> list[Account]:
        chosen = real(db, sender, ids, keep)
        assert family.operator.post(f"/api/accounts/{family.ids['mia']}/block",
                                    json={"current_password": PASSWORD}).status_code == 204
        return chosen

    monkeypatch.setattr(capsules, "_chosen", looked_before_the_block)
    refused = family.jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [family.ids["mia"]],
                                                      "opens_on": OPENS, "title": "x", "text": "y"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "person_unknown"
    assert count(Capsule) == 0 and count(CapsuleKey) == 0


def test_taking_back_is_refused_once_it_opened_also_when_nobody_looked(family: Family) -> None:
    uid = close(family.jule, [family.ids["tom"]])["id"]
    family.at(berlin_midnight(OPENS))
    gone = family.jule.delete(f"/api/capsules/{uid}")
    assert gone.status_code == 409 and gone.json()["detail"]["code"] == "capsule_open"
    assert family.tom.get(f"/api/capsules/{uid}").status_code == 200


def test_a_change_keeps_a_blocked_recipient_the_sender_no_longer_sees(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"], family.ids["mia"]])
    assert family.operator.post(f"/api/accounts/{family.ids['mia']}/block",
                                json={"current_password": PASSWORD}).status_code == 204
    shown = family.jule.get(f"/api/capsules/{made['id']}").json()
    assert [person["name"] for person in shown["to"]] == ["tom"]
    changed = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": shown["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "Neu", "text": "Neu"})
    assert changed.status_code == 200
    with SessionLocal() as db:
        holders = set(db.scalars(select(CapsuleKey.user_id).where(CapsuleKey.recipient.is_(True))))
    assert holders == {family.ids["tom"], family.ids["mia"]}


# --- Days and time zones --------------------------------------------------------------------------------------------


def test_it_opens_at_midnight_in_each_recipient_s_own_zone(family: Family) -> None:
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Auckland"}).status_code == 200
    assert family.mia.put("/api/me/preferences", json={"timezone": "America/Los_Angeles"}).status_code == 200
    uid = close(family.jule, [family.ids["tom"], family.ids["mia"]], opens="2026-11-01")["id"]
    # Auckland is UTC+13 on 1 November (summer time), Los Angeles UTC-7 (until the clocks go back that night).
    auckland = datetime(2026, 10, 31, 11, 0, tzinfo=UTC)
    los_angeles = datetime(2026, 11, 1, 7, 0, tzinfo=UTC)

    def opened(browser: TestClient) -> bool:
        return "text" in browser.get(f"/api/capsules/{uid}").json()

    family.at(auckland - timedelta(seconds=1))
    assert (opened(family.tom), opened(family.mia)) == (False, False)
    # Still changeable: it opened nowhere yet.
    revision = family.jule.get(f"/api/capsules/{uid}").json()["revision"]
    family.at(auckland)
    assert (opened(family.tom), opened(family.mia)) == (True, False)
    refused = family.jule.put(f"/api/capsules/{uid}", json={
        "revision": revision, "to": [family.ids["mia"]], "opens_on": "2026-11-02", "title": "x", "text": "y"})
    assert refused.json()["detail"]["code"] == "capsule_open"
    family.at(los_angeles - timedelta(seconds=1))
    assert opened(family.mia) is False
    family.at(los_angeles)
    assert opened(family.mia) is True


def test_the_day_must_be_to_come_for_everybody_and_within_fifty_years(family: Family) -> None:
    def refused(opens: str, to: list[int]) -> str:
        answer = family.jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": to, "opens_on": opens,
                                                         "title": "x", "text": "y"})
        assert answer.status_code == 422, (opens, answer.text)
        return str(answer.json()["detail"]["code"])

    me, tom = family.ids["jule"], family.ids["tom"]
    assert refused("2026-10-09", [me]) == "capsule_date_past"
    assert refused("2026-10-01", [me]) == "capsule_date_past"
    assert refused("2076-10-10", [me]) == "capsule_date_far"
    assert refused("2026-02-30", [me]) == "date_invalid"
    assert refused("morgen", [me]) in ("date_invalid", "invalid_input")
    close(family.jule, [me], opens="2026-10-10")
    close(family.jule, [me], opens="2076-10-09")
    # Late at night in Berlin it is tomorrow already in Auckland: a capsule for tomorrow would open there at once.
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Auckland"}).status_code == 200
    family.at(datetime(2026, 10, 9, 20, 0, tzinfo=UTC))
    assert refused("2026-10-10", [tom]) == "capsule_date_past"
    close(family.jule, [tom], opens="2026-10-11")


def test_limits_of_title_text_people_and_capsules(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    me = family.ids["jule"]

    def answer(**fields: Any) -> Any:
        body = {"id": str(uuid.uuid4()), "to": [me], "opens_on": OPENS, "title": "x", "text": "y", **fields}
        return family.jule.post("/api/capsules", json=body)

    assert answer(title="t" * 200).status_code == 201
    assert answer(title="t" * 201).json()["detail"]["code"] == "capsule_title_too_long"
    assert answer(text="t" * 50_000).status_code == 201
    assert answer(text="t" * 50_001).json()["detail"]["code"] == "capsule_text_too_long"
    assert answer(title="   ").json()["detail"]["code"] == "capsule_empty"
    assert answer(text="\n\n").json()["detail"]["code"] == "capsule_empty"
    assert answer(to=[]).json()["detail"]["code"] == "capsule_nobody"
    assert answer(to=[999_999]).json()["detail"]["code"] == "person_unknown"
    assert answer(to=list(range(1, 52))).status_code == 422
    assert answer(to=["2"]).status_code == 422
    assert answer(photo="0" * 32).json()["detail"]["code"] == "capsule_photo_missing"
    assert answer(to=[me, family.ids["tom"]]).json()["to"][1]["name"] == "tom"
    monkeypatch.setattr(capsules, "CAPSULES_MAX", count(Capsule) + 1)
    assert answer().status_code == 201
    full = answer()
    assert full.status_code == 409 and full.json()["detail"]["code"] == "too_many_capsules"


def test_the_brake_holds_a_flood_of_capsules(family: Family, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import brakes

    monkeypatch.setitem(brakes.LIMITS, "capsule", 3)
    for _ in range(3):
        close(family.jule, [family.ids["jule"]])
    flood = family.jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [family.ids["jule"]],
                                                    "opens_on": OPENS, "title": "x", "text": "y"})
    assert flood.status_code == 429


# --- Races ----------------------------------------------------------------------------------------------------------


def test_closing_twice_with_the_same_id_keeps_one_capsule(family: Family) -> None:
    client_id = str(uuid.uuid4())
    upload = photo(family.jule)
    first = close(family.jule, [family.ids["tom"]], client_id=client_id, with_photo=upload)
    again = close(family.jule, [family.ids["tom"]], client_id=client_id, with_photo=upload, status=200)
    assert first == again and count(Capsule) == 1
    other = family.jule.post("/api/capsules", json={"id": client_id, "to": [family.ids["tom"]], "opens_on": OPENS,
                                                    "title": "Anders", "text": "Anders"})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "capsule_id_taken"
    assert count(Capsule) == 1


def test_a_double_click_at_the_same_moment_closes_one_capsule(family: Family) -> None:
    client_id = str(uuid.uuid4())
    upload = photo(family.jule)
    before = media_files()
    start = threading.Barrier(4, timeout=10)
    answers: list[int] = []

    def tap() -> None:
        with new_client(make_account_client(family, "jule")) as browser:
            start.wait()
            answer = browser.post("/api/capsules", json={"id": client_id, "to": [family.ids["tom"]], "opens_on": OPENS,
                                                         "title": "Einmal", "text": "Nur einmal", "photo": upload})
            answers.append(answer.status_code)

    threads = [threading.Thread(target=tap) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers) == [200, 200, 200, 201], answers
    assert count(Capsule) == 1 and count(CapsuleUpload) == 0
    # One photo in the capsule (two files), the upload's two files gone, nothing of the losers left.
    assert len(media_files()) == len(before)


def make_account_client(family: Family, name: str) -> Account:
    with SessionLocal() as db:
        row = db.get(Account, family.ids[name])
        assert row is not None
        db.expunge(row)
    return row


def test_two_changes_from_the_same_revision_keep_the_first(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"]])
    body = {"revision": made["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "Erste",
            "text": "Erste"}
    assert family.jule.put(f"/api/capsules/{made['id']}", json=body).status_code == 200
    second = family.jule.put(f"/api/capsules/{made['id']}", json={**body, "title": "Zweite"})
    assert second.status_code == 409 and second.json()["detail"]["code"] == "capsule_changed"
    assert family.jule.get(f"/api/capsules/{made['id']}").json()["title"] == "Erste"


def test_a_change_that_meets_another_change_is_refused_in_the_statement_that_writes(
    family: Family, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two tabs change the same capsule at once, both from revision 0: the second was read before the first was
    written, and it is written only onto the revision it was read from, so it is refused."""
    made = close(family.jule, [family.ids["tom"]])
    real = capsules._refuse_when_open
    jule = family.accounts["jule"]

    def other_tab_first(db: Any, capsule: Any) -> None:
        real(db, capsule)
        monkeypatch.setattr(capsules, "_refuse_when_open", real)
        with SessionLocal() as other:
            capsules.change(other, jule, made["id"], made["revision"], [family.ids["tom"]], OPENS, "Erster Tab",
                            "Erster Tab")

    monkeypatch.setattr(capsules, "_refuse_when_open", other_tab_first)
    second = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "Zweiter Tab",
        "text": "Zweiter Tab"})
    assert second.status_code == 409 and second.json()["detail"]["code"] == "capsule_changed"
    assert family.jule.get(f"/api/capsules/{made['id']}").json()["text"] == "Erster Tab"


def test_a_change_that_meets_the_opening_is_refused_in_the_statement_that_writes(
    family: Family, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tom reads the capsule at its first moment while Jule's change is on its way, past its own look at the clock:
    the change is written only where nobody opened it, and so it is refused, the text Tom read stays."""
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Auckland"}).status_code == 200
    made = close(family.jule, [family.ids["tom"]], opens="2026-11-01", text="Was Tom liest")
    family.at(datetime(2026, 10, 31, 11, 0, tzinfo=UTC))
    assert family.tom.get(f"/api/capsules/{made['id']}").json()["text"] == "Was Tom liest"
    # The change looked at the clock a moment before Tom's midnight and found it closed.
    monkeypatch.setattr(capsules, "_refuse_when_open", lambda _db, _capsule: None)
    refused = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": "2026-11-05", "title": "x",
        "text": "Später geändert"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "capsule_open"
    assert family.tom.get(f"/api/capsules/{made['id']}").json()["text"] == "Was Tom liest"
    gone = family.jule.delete(f"/api/capsules/{made['id']}")
    assert gone.status_code == 409


def race_once(family: Family) -> tuple[dict[str, Any], str]:
    """One round: a capsule for Tom opening at his midnight, then Jule's change and Tom's first look at once, the
    change past its own look at the clock. What each got, and the capsule's id."""
    family.at(NOON)
    made = close(family.jule, [family.ids["tom"]], opens="2026-11-01", text="alt")
    family.at(datetime(2026, 10, 31, 11, 0, tzinfo=UTC))
    results: dict[str, Any] = {}
    start = threading.Barrier(2, timeout=10)

    def change() -> None:
        start.wait()
        answer = family.jule.put(f"/api/capsules/{made['id']}", json={
            "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": "2026-11-05", "title": "x",
            "text": "neu"})
        results["change"] = answer.status_code

    def look() -> None:
        start.wait()
        results["read"] = family.tom.get(f"/api/capsules/{made['id']}").json().get("text")

    original = capsules._refuse_when_open
    capsules._refuse_when_open = lambda _db, _capsule: None  # type: ignore[assignment]
    try:
        threads = [threading.Thread(target=change), threading.Thread(target=look)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        capsules._refuse_when_open = original  # type: ignore[assignment]
    return results, str(made["id"])


def test_a_change_and_an_opening_at_the_same_moment_end_in_one_order(family: Family) -> None:
    """At Tom's midnight, Jule's change (moving the day) and Tom's first look race each other many times: either the
    change came first (Tom reads nothing, the day moved) or the opening did (the change is refused and Tom read the old
    text); never a change accepted after Tom read the old one, never the new text on the old day."""
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Auckland"}).status_code == 200
    for round_ in range(6):
        results, uid = race_once(family)
        if results["change"] == 200:
            assert results["read"] is None, results
            assert "text" not in family.tom.get(f"/api/capsules/{uid}").json(), round_
        else:
            assert results["change"] == 409 and results["read"] == "alt", results


# --- Accounts that go -----------------------------------------------------------------------------------------------


def delete_account(family: Family, name: str) -> None:
    gone = family.operator.request("DELETE", f"/api/accounts/{family.ids[name]}", json={"current_password": PASSWORD})
    assert gone.status_code == 204


def test_the_capsule_outlives_its_sender(family: Family) -> None:
    for_mia = close(family.jule, [family.ids["mia"]], title="Zu deinem 18. Geburtstag", text="Liebe Mia",
                    with_photo=photo(family.jule))["id"]
    own = close(family.jule, [family.ids["jule"]], with_photo=photo(family.jule))["id"]
    with_self = close(family.jule, [family.ids["jule"], family.ids["tom"]], title="Vorsätze")["id"]
    photo(family.jule)  # chosen, never closed
    delete_account(family, "jule")
    assert count(CapsuleUpload) == 0
    listed = family.mia.get("/api/capsules").json()["for_me"]
    assert [(item["title"], item["from"]) for item in listed] == [("Zu deinem 18. Geburtstag", None)]
    assert family.tom.get(f"/api/capsules/{with_self}").json()["from"] is None
    with SessionLocal() as db:
        assert db.scalar(select(Capsule.id).where(Capsule.uid == own)) is None, "nobody left to receive it"
    assert len(media_files()) == 2, "only the photo of the capsule for Mia, both its files"
    family.at(berlin_midnight(OPENS))
    opened = family.mia.get(f"/api/capsules/{for_mia}")
    assert opened.status_code == 200 and opened.json()["text"] == "Liebe Mia"
    assert family.mia.get(f"/api/capsules/{for_mia}/photo").status_code == 200


def test_a_recipient_who_goes_takes_only_their_own_copy(family: Family) -> None:
    both = close(family.jule, [family.ids["tom"], family.ids["mia"]], with_photo=photo(family.jule))["id"]
    only_tom = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule))["id"]
    files = media_files()
    delete_account(family, "tom")
    shown = family.jule.get(f"/api/capsules/{both}").json()
    assert [person["name"] for person in shown["to"]] == ["mia"]
    assert family.mia.get(f"/api/capsules/{both}").status_code == 200
    # The capsule only for Tom has nobody left: it goes, with its photo.
    assert family.jule.get(f"/api/capsules/{only_tom}").status_code == 404
    assert len(files - media_files()) == 2
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CapsuleKey)
                         .where(CapsuleKey.user_id == family.ids["tom"])) == 0


# --- Pushes ---------------------------------------------------------------------------------------------------------


def device(browser: TestClient, fake: Any) -> str:
    made = fake.device()
    assert browser.post("/api/push/devices", json=made.subscription()).status_code == 201
    return str(made.endpoint).rsplit("/", 1)[-1]


def bodies(fake: Any, endpoint: str) -> list[str]:
    return [came.message["body"] for came in fake.received if came.device == endpoint]


def test_arrival_is_pushed_to_the_others_never_to_the_sender_and_not_again_on_a_change(
    family: Family, push_service: Any
) -> None:
    from app.services import notices

    jule = device(family.jule, push_service)
    tom = device(family.tom, push_service)
    mia = device(family.mia, push_service)
    assert family.tom.put("/api/me/language", json={"language": "en"}).status_code in (200, 204)
    made = close(family.jule, [family.ids["jule"], family.ids["tom"]], title="Geheimer Titel", text="Geheimer Text")
    notices.settle()
    assert bodies(push_service, jule) == []
    assert len(bodies(push_service, tom)) == 1
    assert bodies(push_service, tom)[0] in (
        "jule hat dir eine Zeitkapsel geschickt. Sie öffnet sich am 24. Dezember 2026.",
        "jule sent you a time capsule. It opens on 24 December 2026.")
    changed = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"], family.ids["mia"]], "opens_on": OPENS,
        "title": "Anders", "text": "Anders"})
    assert changed.status_code == 200
    notices.settle()
    assert len(bodies(push_service, tom)) == 1, "no second push for a change"
    assert len(bodies(push_service, mia)) == 1, "the one added hears that it came"
    for came in push_service.received:
        assert "Geheim" not in came.message["body"] and "Anders" not in came.message["body"]
        assert (came.message["url"], came.message["desk"]) == ("/zeitkapseln", "/zeitkapseln")


def test_a_letter_to_oneself_brings_no_arrival_push(family: Family, push_service: Any) -> None:
    from app.services import notices

    jule = device(family.jule, push_service)
    close(family.jule, [family.ids["jule"]])
    notices.settle()
    assert bodies(push_service, jule) == []


def test_on_its_day_each_recipient_hears_once_at_eight_of_their_own_clock(family: Family, push_service: Any) -> None:
    jule = device(family.jule, push_service)
    tom = device(family.tom, push_service)
    mia = device(family.mia, push_service)
    assert family.mia.put("/api/me/preferences", json={"timezone": "America/New_York"}).status_code == 200
    close(family.jule, [family.ids["jule"], family.ids["tom"], family.ids["mia"]], title="Geheim", text="Geheim")
    close(family.jule, [family.ids["jule"]], title="Geheim", text="Geheim")
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    # Berlin in December is UTC+1 (08:00 is 07:00 UTC), New York UTC-5 (08:00 is 13:00 UTC).
    sent: dict[str, list[datetime]] = {}
    moment = datetime(2026, 12, 23, 22, 0, tzinfo=UTC)
    while moment < datetime(2026, 12, 25, 6, 0, tzinfo=UTC):
        before = len(push_service.received)
        capsules.run_once(moment)
        for came in push_service.received[before:]:
            sent.setdefault(came.device, []).append(moment)
        moment += timedelta(minutes=1)
    assert sent[tom] == [datetime(2026, 12, 24, 7, 0, tzinfo=UTC)]
    assert sent[mia] == [datetime(2026, 12, 24, 13, 0, tzinfo=UTC)]
    assert sent[jule] == [datetime(2026, 12, 24, 7, 0, tzinfo=UTC)] * 2, "two capsules for Jule"
    texts = {body for endpoint in (tom, mia, jule) for body in bodies(push_service, endpoint)}
    assert texts <= {"Eine Zeitkapsel von jule hat sich geöffnet.", "A time capsule from jule has opened.",
                     "Dein Brief an dich selbst hat sich geöffnet.", "Your letter to yourself has opened."}
    assert any("dich selbst" in body or "yourself" in body for body in bodies(push_service, jule))
    # A restart (a new round on the same database) sends nothing again.
    assert capsules.run_once(datetime(2026, 12, 24, 9, 0, tzinfo=UTC)) == 0
    assert capsules.run_once(datetime(2026, 12, 26, 9, 0, tzinfo=UTC)) == 0


def test_a_server_that_was_down_at_eight_sends_at_its_first_round_after(family: Family, push_service: Any) -> None:
    tom = device(family.tom, push_service)
    close(family.jule, [family.ids["tom"]])
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    assert capsules.run_once(datetime(2026, 12, 24, 6, 59, tzinfo=UTC)) == 0
    assert capsules.run_once(datetime(2026, 12, 25, 18, 0, tzinfo=UTC)) == 1
    assert bodies(push_service, tom) in (["Eine Zeitkapsel von jule hat sich geöffnet."],
                                         ["A time capsule from jule has opened."])


def test_two_rounds_at_once_push_once(family: Family, push_service: Any) -> None:
    tom = device(family.tom, push_service)
    close(family.jule, [family.ids["tom"]])
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    start = threading.Barrier(3, timeout=10)
    counts: list[int] = []

    def round_() -> None:
        start.wait()
        counts.append(capsules.run_once(datetime(2026, 12, 24, 7, 0, tzinfo=UTC)))

    threads = [threading.Thread(target=round_) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(counts) == 1 and len(bodies(push_service, tom)) == 1


def test_no_push_from_a_blocked_sender(family: Family, push_service: Any) -> None:
    tom = device(family.tom, push_service)
    close(family.jule, [family.ids["tom"]])
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    assert family.operator.post(f"/api/accounts/{family.ids['jule']}/block",
                                json={"current_password": PASSWORD}).status_code == 204
    assert capsules.run_once(datetime(2026, 12, 24, 7, 0, tzinfo=UTC)) == 0
    assert bodies(push_service, tom) == []


# --- Photos, storage ------------------------------------------------------------------------------------------------


def test_a_chosen_photo_never_closed_goes_after_a_day(family: Family) -> None:
    before = media_files()
    photo(family.jule)
    assert count(CapsuleUpload) == 1 and len(media_files() - before) == 2
    capsules.run_once(NOON + timedelta(hours=23))
    assert count(CapsuleUpload) == 1
    capsules.run_once(NOON + timedelta(hours=24, seconds=1))
    assert count(CapsuleUpload) == 0 and media_files() == before


def test_another_person_cannot_use_my_chosen_photo(family: Family) -> None:
    mine = photo(family.jule)
    refused = family.tom.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [family.ids["tom"]],
                                                     "opens_on": OPENS, "title": "x", "text": "y", "photo": mine})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "capsule_photo_missing"


def test_a_change_swaps_and_removes_the_photo(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule))
    files = media_files()
    swapped = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "x", "text": "y",
        "photo": photo(family.jule)})
    assert swapped.status_code == 200 and swapped.json()["photo"] is True
    assert len(media_files()) == len(files) and media_files() != files
    kept = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": swapped.json()["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "x",
        "text": "z"})
    assert kept.json()["photo"] is True
    removed = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": kept.json()["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "x", "text": "z",
        "photo": None})
    assert removed.json()["photo"] is False and len(media_files()) == len(files) - 2
    assert family.jule.get(f"/api/capsules/{made['id']}/photo").status_code == 404


def test_capsules_count_in_the_sender_s_storage(family: Family) -> None:
    before = family.jule.get("/api/photos/storage").json()["used"]
    close(family.jule, [family.ids["tom"]], text="x" * 5000, with_photo=photo(family.jule))
    after = family.jule.get("/api/photos/storage").json()["used"]
    assert after - before > 5000
    assert family.tom.get("/api/photos/storage").json()["used"] == 0
    with SessionLocal() as db:
        from app.services import settings_service

        settings_service.save(db, {"storage_per_person_gb": 0.000001})
    full = family.jule.post("/api/capsules", json={"id": str(uuid.uuid4()), "to": [family.ids["tom"]],
                                                   "opens_on": OPENS, "title": "x", "text": "y" * 4000})
    assert full.status_code == 409 and full.json()["detail"]["code"] == "storage_full"


def test_the_photo_keeps_nothing_but_its_pixels(family: Family) -> None:
    word = "Qx" + secrets.token_hex(5) + "Zy"
    uid = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule, word))["id"]
    picture = family.jule.get(f"/api/capsules/{uid}/photo").content
    assert word.encode() not in picture
    for path in MEDIA.iterdir():
        assert word.encode() not in path.read_bytes()


# --- Second round: the kept zone, retries, races with the photo, hidden people, chosen photos, the seal ------------


def test_a_recipient_who_moves_their_clock_east_opens_nothing_earlier(family: Family, push_service: Any) -> None:
    """Tom was in Berlin when the capsule came. Setting his zone to Kiritimati (UTC+14) afterwards changes nothing: it
    opens at Berlin's midnight, the push comes at Berlin's eight, and until then Jule can still take it back."""
    tom = device(family.tom, push_service)
    first = close(family.jule, [family.ids["tom"]], text="Bis Heiligabend")["id"]
    second = close(family.jule, [family.ids["tom"]], text="Auch das")["id"]
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Kiritimati"}).status_code == 200
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    # Kiritimati has the 24th from 10:00 UTC on the 23rd; Berlin only from 23:00 UTC.
    family.at(datetime(2026, 12, 23, 12, 0, tzinfo=UTC))
    assert "text" not in family.tom.get(f"/api/capsules/{first}").json()
    assert family.tom.get(f"/api/capsules/{first}/photo").status_code == 404
    assert family.tom.get("/api/capsules/count").json() == {"new": 0}
    assert family.tom.get("/api/capsules").json()["for_me"][0]["open"] is False
    assert family.tom.post(f"/api/capsules/{first}/read").status_code == 409
    assert capsules.run_once(datetime(2026, 12, 23, 18, 0, tzinfo=UTC)) == 0, "08:00 in Kiritimati is not the hour"
    assert family.jule.delete(f"/api/capsules/{second}").status_code == 204, "it opened nowhere yet"
    family.at(berlin_midnight(OPENS))
    assert family.tom.get(f"/api/capsules/{first}").json()["text"] == "Bis Heiligabend"
    assert capsules.run_once(datetime(2026, 12, 24, 6, 59, tzinfo=UTC)) == 0
    assert capsules.run_once(datetime(2026, 12, 24, 7, 0, tzinfo=UTC)) == 1
    assert len(bodies(push_service, tom)) == 1


def test_a_sealed_letter_answers_a_retry_only_right_after_closing(family: Family) -> None:
    """The same request again (a double click, a lost answer) gets the letter back for a few minutes; later the same
    id answers 409 whatever it carries, so that its sender cannot test guesses of the sealed words."""
    client_id = str(uuid.uuid4())
    me = [family.ids["jule"]]
    close(family.jule, me, title="An mich", text="Geheim", client_id=client_id)
    close(family.jule, me, title="An mich", text="Geheim", client_id=client_id, status=200)
    guess = family.jule.post("/api/capsules", json={"id": client_id, "to": me, "opens_on": OPENS, "title": "An mich",
                                                    "text": "Geraten"})
    assert guess.status_code == 409
    family.at(NOON + capsules.RETRY_WINDOW + timedelta(seconds=1))
    for words in ("Geheim", "Geraten"):
        late = family.jule.post("/api/capsules", json={"id": client_id, "to": me, "opens_on": OPENS,
                                                       "title": "An mich", "text": words})
        assert late.status_code == 409 and late.json()["detail"]["code"] == "capsule_id_taken", words
    with SessionLocal() as db:
        mac = db.scalar(select(Capsule.request_mac))
    assert mac and len(mac) == 64 and "Geheim" not in mac


def test_taking_back_while_a_change_swaps_the_photo_leaves_no_file(family: Family,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    before = media_files()
    made = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule))
    swap = photo(family.jule)
    real = capsules._refuse_when_open
    jule = family.accounts["jule"]

    def change_in_between(db: Any, capsule: Any) -> None:
        real(db, capsule)
        monkeypatch.setattr(capsules, "_refuse_when_open", real)
        with SessionLocal() as other:
            capsules.change(other, jule, made["id"], made["revision"], [family.ids["tom"]], OPENS, "x", "y", swap)

    monkeypatch.setattr(capsules, "_refuse_when_open", change_in_between)
    assert family.jule.delete(f"/api/capsules/{made['id']}").status_code == 204
    assert count(Capsule) == 0 and count(CapsuleUpload) == 0
    assert media_files() == before, "neither the first photo nor the one the change brought is left"


def test_the_sender_learns_how_many_recipients_are_hidden(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"], family.ids["mia"]])
    only_mia = close(family.jule, [family.ids["mia"]])
    assert family.operator.post(f"/api/accounts/{family.ids['mia']}/block",
                                json={"current_password": PASSWORD}).status_code == 204
    sent = {item["id"]: item for item in family.jule.get("/api/capsules").json()["from_me"]}
    assert ([person["name"] for person in sent[made["id"]]["to"]], sent[made["id"]]["hidden"]) == (["tom"], 1)
    assert (sent[only_mia["id"]]["to"], sent[only_mia["id"]]["hidden"]) == ([], 1)
    assert sent[only_mia["id"]]["sealed"] is False
    assert family.jule.get(f"/api/capsules/{made['id']}").json()["hidden"] == 1


def test_a_chosen_photo_left_behind_goes_at_once_and_the_waiting_ones_have_a_limit(
    family: Family, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = media_files()
    chosen = photo(family.jule)
    assert family.tom.delete(f"/api/capsules/photos/{chosen}").status_code == 404, "only the own"
    assert family.jule.delete(f"/api/capsules/photos/{chosen}").status_code == 204
    assert family.jule.delete(f"/api/capsules/photos/{chosen}").status_code == 404
    assert count(CapsuleUpload) == 0 and media_files() == before
    monkeypatch.setattr(capsules, "UPLOADS_MAX", 1)
    photo(family.jule)
    full = family.jule.post("/api/capsules/photos", params={"upload_id": str(uuid.uuid4())}, content=jpeg())
    assert full.status_code == 409 and full.json()["detail"] == {
        "code": "capsule_photos_waiting", "message": "Too many photos are waiting for a time capsule.", "max": 1}


def test_the_day_and_the_seal_are_bound_into_the_sealed_words_and_photo(family: Family) -> None:
    import sqlite3
    from contextlib import closing

    from app.config import get_settings

    made = close(family.jule, [family.ids["tom"]], title="Gebunden", with_photo=photo(family.jule))
    # Changed in the database alone: nothing opens any more.
    with closing(sqlite3.connect(get_settings().database_path)) as connection:
        connection.execute("UPDATE capsules SET opens_on = ?", ("2026-10-10",))
        connection.commit()
    family.at(berlin_midnight("2026-10-10"))
    assert family.tom.get("/api/capsules").json()["for_me"] == []
    assert family.tom.get(f"/api/capsules/{made['id']}").status_code == 404
    assert family.tom.get(f"/api/capsules/{made['id']}/photo").status_code == 404


def test_a_change_of_the_day_seals_the_kept_photo_anew(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"]], with_photo=photo(family.jule))
    files = media_files()
    moved = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": "2026-12-31", "title": "x", "text": "y"})
    assert moved.status_code == 200 and moved.json()["photo"] is True
    assert len(media_files()) == len(files) and media_files() != files, "the same photo, sealed anew"
    assert family.jule.get(f"/api/capsules/{made['id']}/photo").status_code == 200
    family.at(berlin_midnight("2026-12-31"))
    assert family.tom.get(f"/api/capsules/{made['id']}/photo").status_code == 200


def test_a_change_to_only_oneself_seals_the_letter(family: Family) -> None:
    made = close(family.jule, [family.ids["tom"], family.ids["jule"]], text="Erst für zwei")
    changed = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["jule"]], "opens_on": OPENS, "title": "Nur für mich",
        "text": "Jetzt versiegelt"})
    assert changed.status_code == 200
    body = changed.json()
    assert body["sealed"] is True and "text" not in body and "photo" not in body
    again = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": body["revision"], "to": [family.ids["jule"]], "opens_on": OPENS, "title": "x", "text": "y"})
    assert again.json()["detail"]["code"] == "capsule_sealed"
    assert family.jule.get("/api/capsules").json()["from_me"][0]["sealed"] is True
    family.at(berlin_midnight(OPENS))
    assert family.jule.get(f"/api/capsules/{made['id']}").json()["text"] == "Jetzt versiegelt"


def test_a_sealed_letter_that_opened_says_it_opened(family: Family) -> None:
    made = close(family.jule, [family.ids["jule"]])
    family.at(berlin_midnight(OPENS))
    refused = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": 0, "to": [family.ids["jule"]], "opens_on": "2027-01-01", "title": "x", "text": "y"})
    assert refused.json()["detail"]["code"] == "capsule_open"


def move_the_day_first(family: Family, monkeypatch: pytest.MonkeyPatch, uid: str, revision: int) -> None:
    """Just before the opening is marked, Jule's change moves the day (her own look at the clock came a moment
    earlier and found it closed)."""
    real_mark = capsules._mark_opened
    real_refuse = capsules._refuse_when_open
    jule = family.accounts["jule"]

    def changed_first(db: Any, capsule_id: int, today: str | None = None) -> bool:
        capsules._mark_opened = real_mark  # type: ignore[assignment]
        capsules._refuse_when_open = lambda _db, _capsule: None  # type: ignore[assignment]
        try:
            with SessionLocal() as other:
                capsules.change(other, jule, uid, revision, [family.ids["tom"]], "2026-12-31", "x", "verschoben")
        finally:
            capsules._refuse_when_open = real_refuse  # type: ignore[assignment]
        return real_mark(db, capsule_id, today)

    monkeypatch.setattr(capsules, "_mark_opened", changed_first)


def test_a_change_moving_the_day_just_before_the_first_look_leaves_it_closed(
    family: Family, monkeypatch: pytest.MonkeyPatch
) -> None:
    made = close(family.jule, [family.ids["tom"]], text="alt")
    family.at(berlin_midnight(OPENS))
    move_the_day_first(family, monkeypatch, made["id"], made["revision"])
    seen = family.tom.get(f"/api/capsules/{made['id']}").json()
    assert "text" not in seen and seen["opens_on"] == "2026-12-31"
    # Not marked opened: its sender can still take it back.
    assert family.jule.delete(f"/api/capsules/{made['id']}").status_code == 204


def test_a_change_moving_the_day_just_before_the_push_stops_it(family: Family, monkeypatch: pytest.MonkeyPatch,
                                                                 push_service: Any) -> None:
    tom = device(family.tom, push_service)
    made = close(family.jule, [family.ids["tom"]])
    from app.services import notices

    notices.settle()
    push_service.received.clear()
    family.at(datetime(2026, 12, 24, 7, 0, tzinfo=UTC))
    move_the_day_first(family, monkeypatch, made["id"], made["revision"])
    assert capsules.run_once(datetime(2026, 12, 24, 7, 0, tzinfo=UTC)) == 0
    assert bodies(push_service, tom) == []
    assert family.jule.delete(f"/api/capsules/{made['id']}").status_code == 204


def test_a_change_of_the_day_measures_a_recipient_by_the_zone_kept_not_the_one_set_since(family: Family) -> None:
    """Tom was in Berlin when the capsule came, then set his clock to Kiritimati (UTC+14). On the 23rd at noon UTC it is
    the 24th there, in Berlin not yet: Jule may still move the day to the 24th, and Tom still reads nothing."""
    made = close(family.jule, [family.ids["tom"]], opens="2026-12-31", text="Erst später")
    assert family.tom.put("/api/me/preferences", json={"timezone": "Pacific/Kiritimati"}).status_code == 200
    family.at(datetime(2026, 12, 23, 12, 0, tzinfo=UTC))
    moved = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": made["revision"], "to": [family.ids["tom"]], "opens_on": OPENS, "title": "Für Heiligabend",
        "text": "Erst später"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["opens_on"] == OPENS
    assert "text" not in family.tom.get(f"/api/capsules/{made['id']}").json()
    # The 23rd itself has come in Berlin: refused, for the sender and for the zone kept.
    refused = family.jule.put(f"/api/capsules/{made['id']}", json={
        "revision": moved.json()["revision"], "to": [family.ids["tom"]], "opens_on": "2026-12-23",
        "title": "Für Heiligabend", "text": "Erst später"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "capsule_date_past"
