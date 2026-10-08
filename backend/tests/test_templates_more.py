"""Headings with a backslash of their own, the search over escaped Markdown, and the characters that print as nothing."""

# ruff: noqa: F811 - the fixtures are imported from other test modules and used by name

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models import Account
from app.services import templates

from .test_ai import DAY, Model, model, note, set_up  # noqa: F401
from .test_templates import code, put, saved
from .test_templates_ai import ask, made, written
from .test_templates_marks import template

BS = chr(92)
#: Headings as typed: a path, a backslash before an underscore, two backslashes, a backslash before a hash.
OWN = [f"C:{BS}Users{BS}*", f"a{BS}_b", f"{BS}{BS}", f"a {BS}#"]


def test_a_backslash_of_the_persons_own_is_kept_on_every_way(client: TestClient, account: Account) -> None:
    kept = saved(client, [{"name": "x", "sections": [{"heading": heading, "question": ""} for heading in OWN]}])
    assert [section["heading"] for section in kept["templates"][0]["sections"]] == OWN
    # The same heading twice, once with its backslash and once without, is not the same heading.
    twice = [{"heading": f"a{BS}_b", "question": ""}, {"heading": "ab", "question": ""}]
    assert put(client, [{"name": "y", "sections": twice}], revision=0).status_code == 200


def test_shaping_headings_with_a_backslash_changes_nothing_a_second_time_and_is_not_a_page() -> None:
    empty = templates.shape("", OWN)
    # Every backslash of the heading is written twice, and the marks after it as marks of their own.
    assert empty.split("\n\n")[1] == f"## a{BS}{BS}{BS}_b"
    assert templates.shape(empty, OWN) == empty
    assert not templates.has_words(empty, OWN)
    for heading in OWN:
        assert not templates.has_words(templates.shape("", [heading]), [heading]), heading
    # What the model wrote under them is kept, whatever way it wrote the headings: escaped as here, or as the words are.
    written_out = [part[3:] for part in empty.split("\n\n")]
    for lines in ("\n\n".join(f"## {line}\n\nText {at}" for at, line in enumerate(written_out)),
                  "\n\n".join(f"## {heading}\n\nText {at}" for at, heading in enumerate(OWN))):
        shaped = templates.shape(lines, OWN)
        assert [line for line in shaped.split("\n\n") if line.startswith("Text")] == [f"Text {at}" for at in range(4)]
        assert "**" not in shaped and templates.shape(shaped, OWN) == shaped


def test_an_answer_of_nothing_but_such_headings_is_no_page(client: TestClient, account: Account, model: Model) -> None:
    set_up(client)
    note(client, "kastanien gesammelt")
    [mine] = made(client, {"name": "Eigene", "sections": [{"heading": heading, "question": ""} for heading in OWN]})
    written(model, templates.shape("", OWN))
    answer = ask(client, template=mine)
    assert (answer.status_code, answer.json()["detail"]["code"]) == (502, "ai_empty")
    written(model, "Ein Satz.")
    assert ask(client, template=mine).status_code == 200


def test_the_search_reads_the_words_not_the_markdown(client: TestClient, account: Account) -> None:
    headings = [f"C{BS}#", f"a {BS}* b", f"Was {BS}*wichtig{BS}* war", f"Tag & {BS}<b{BS}>", f"Plan {BS}[A{BS}]"]
    text = "\n\n".join(f"## {heading}\n\nGeschrieben {at}." for at, heading in enumerate(headings))
    assert client.put("/api/days/2026-10-05", json={"text": text}).status_code == 200
    for needle in ("C#", "a * b", "Was *wichtig* war", "Tag & <b>", "Plan [A]"):
        found = client.post("/api/search", json={"q": needle}).json()["results"]
        assert [hit["kind"] for hit in found] == ["text"], needle
        snippet = found[0]["snippet"]
        assert needle in snippet and "##" not in snippet and BS not in snippet, (needle, snippet)
    # The words around it are searched as before.
    assert client.post("/api/search", json={"q": "Geschrieben 3"}).json()["results"][0]["snippet"].count("Geschrieben") >= 1


def test_what_prints_as_nothing_is_no_name_and_no_heading(client: TestClient, account: Account) -> None:
    invisible = [chr(code_) for code_ in (0x3164, 0x115F, 0x1160, 0xFFA0, 0x2800, 0x034F, 0xFE00, 0xFE0F, 0xE0100, 0xE01EF)]
    invisible.append("".join(invisible))
    invisible.append(" " + chr(0x2800) + " " + chr(0xFE0F))
    for blank in invisible:
        assert code(put(client, template(blank))) == (422, "template_heading_empty"), repr(blank)
        assert code(put(client, template("Dank", name=blank))) == (422, "template_name_empty"), repr(blank)
    assert client.get("/api/templates").json()["revision"] == -1
    # An emoji keeps its selector, and a word with a joiner inside is a word.
    heart = chr(0x2764) + chr(0xFE0F)
    kept = saved(client, template("Dank " + heart, name=heart))
    assert kept["templates"][0]["name"] == heart
    assert kept["templates"][0]["sections"][0]["heading"] == "Dank " + heart
