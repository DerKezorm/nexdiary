"""Headings and names that are only marks of Markdown or nothing to see are refused; the same heading in another writing
(``C#`` and ``C\\#``, with the stars of bold or italic, with a backslash before a mark) is the same heading, in a
template and in what the AI's answer is made to follow; the headings go into the text as words, with their marks
escaped, so that the editor shows them as typed."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.models import Account
from app.services import templates

from .test_templates import code, put, saved

BS = "\\"
MARKED = ["C#", "Plan [A]", "Dank_ und _mehr", "a * b", "Was *wichtig* war", "Tag & <b>"]
ESCAPED = [f"C{BS}#", f"Plan {BS}[A{BS}]", f"Dank{BS}_ und {BS}_mehr", f"a {BS}* b", f"Was {BS}*wichtig{BS}* war",
           f"Tag {BS}& {BS}<b{BS}>"]


def template(heading: str, name: str = "x") -> list[dict[str, Any]]:
    return [{"name": name, "sections": [{"heading": heading, "question": ""}]}]


def test_a_name_or_heading_of_nothing_visible_is_refused(client: TestClient, account: Account) -> None:
    # Direction marks, zero width spaces, joiners and a byte order mark: format characters, nothing to see.
    rlo, zwsp, bom, wj, zwj = (chr(code) for code in (0x202E, 0x200B, 0xFEFF, 0x2060, 0x200D))
    for invisible in (rlo + zwsp, zwsp, bom, wj + " " + zwj, " " + rlo + " "):
        assert code(put(client, template(invisible))) == (422, "template_heading_empty"), repr(invisible)
        assert code(put(client, template("Dank", name=invisible))) == (422, "template_name_empty"), repr(invisible)
    assert client.get("/api/templates").json()["revision"] == -1, "nothing was written"
    # A text with a format character in it is a text: the joiners of an emoji sequence stay.
    family = "Familie " + chr(0x1F468) + zwj + chr(0x1F469) + zwj + chr(0x1F467)
    assert saved(client, template("Dank", name=family))["templates"][0]["name"] == family


def test_a_heading_of_only_marks_of_markdown_is_refused(client: TestClient, account: Account) -> None:
    for marks in ("***", "___", "`", "* _ *"):
        assert code(put(client, template(marks))) == (422, "template_heading_empty"), marks
    assert client.get("/api/templates").json()["revision"] == -1


def test_the_same_heading_in_another_writing_is_the_same_heading(client: TestClient, account: Account) -> None:
    for first, second in (("C#", "c#"), ("Dank_ und _mehr", "Dank und mehr"), ("Was *wichtig* war", "was wichtig war"),
                          ("Plan [A]", " Plan  [A] ")):
        answer = put(client, [{"name": "x", "sections": [{"heading": first, "question": ""},
                                                          {"heading": second, "question": ""}]}])
        assert code(answer) == (422, "template_heading_twice"), (first, second)
    # A backslash the person typed is a word of the heading: with it and without it are two headings.
    both = [{"heading": f"C{BS}#", "question": ""}, {"heading": "C#", "question": ""}]
    assert put(client, [{"name": "x", "sections": both}]).status_code == 200


def test_headings_go_into_the_text_as_words_with_their_marks_escaped() -> None:
    assert templates.shape("", MARKED) == "\n\n".join(f"## {heading}" for heading in ESCAPED)
    assert not templates.has_words(templates.shape("", MARKED), MARKED)


def test_the_answer_of_the_model_is_taken_whether_it_wrote_the_marks_raw_escaped_or_as_bold() -> None:
    shown = ["C#", "Plan [A]", "Dank_ und _mehr", "a * b", "Was wichtig war", "Tag & <b>"]

    def written(headings: list[str], wrap: str = "") -> str:
        return "\n\n".join(f"## {wrap}{heading}{wrap}\n\nText {at}" for at, heading in enumerate(headings))

    wanted = "\n\n".join(f"## {ESCAPED[at]}\n\nText {at}" for at in range(len(MARKED)))
    for text in (written(MARKED), written(ESCAPED), written(shown, "**"), written([line.upper() for line in MARKED])):
        shaped = templates.shape(text, MARKED)
        assert shaped == wanted, text[:60]
        # No heading became bold text of a foreign one, nothing is lost, and shaping again changes nothing.
        assert "**" not in shaped
        assert templates.shape(shaped, MARKED) == shaped
        assert templates.has_words(shaped, MARKED)
    assert templates.is_heading_of(f"## C{BS}#", MARKED) and templates.is_heading_of("### Was *wichtig* war", MARKED)
