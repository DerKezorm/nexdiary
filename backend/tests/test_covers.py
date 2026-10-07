"""The illustrations the server knows are the ones the interface draws, there are 16 for every motif, and every day of
every season gets a suggestion. ``frontend/src/covers`` holds the same lists; the cases here are run there too."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest

from app.services import covers

COVERS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "covers"


def catalog() -> dict:
    return json.loads((COVERS / "catalog.json").read_text(encoding="utf-8"))


def test_the_server_knows_exactly_the_illustrations_the_interface_draws() -> None:
    shown = catalog()
    assert tuple(motif["id"] for motif in shown["motifs"]) == covers.MOTIFS
    assert tuple(shown["times"]) == covers.TIMES
    assert tuple(shown["seasons"]) == covers.SEASONS
    assert tuple(shown["defaults"]) == covers.DEFAULTS
    assert tuple(tuple(pair) for pair in shown["tagMotifs"]) == covers.TAG_MOTIFS


def test_every_motif_comes_at_four_times_and_in_four_seasons_once() -> None:
    assert len(covers.MOTIFS) == len(set(covers.MOTIFS)) >= 16
    assert len(covers.ILLUSTRATIONS) == len(covers.MOTIFS) * len(covers.TIMES) * len(covers.SEASONS) == len(covers.MOTIFS) * 16
    assert {motif for _tag, motif in covers.TAG_MOTIFS} <= set(covers.MOTIFS)
    assert set(covers.DEFAULTS) <= set(covers.MOTIFS) and len(covers.DEFAULTS) >= covers.SUGGESTIONS


@pytest.mark.parametrize("case", json.loads((COVERS / "suggest.cases.json").read_text(encoding="utf-8")),
                         ids=lambda case: f"{case['date']}-{case['time']}")
def test_a_suggestion_follows_season_time_and_tags(case: dict) -> None:
    got = covers.suggest(case["date"], case["tags"], case["time"])
    assert got == [f"{motif}.{case['time']}.{case['season']}" for motif in case["expect"]]


def test_every_day_of_a_leap_year_at_every_time_gets_six_known_suggestions() -> None:
    day = date(2028, 1, 1)
    while day.year == 2028:
        for time in covers.TIMES:
            got = covers.suggest(day.isoformat(), ["urlaub", "familie"], time)
            assert len(got) == covers.SUGGESTIONS == len(set(got))
            assert all(name in covers.ILLUSTRATIONS for name in got)
        assert covers.is_illustration(covers.suggested_cover(day.isoformat(), []))
        day += timedelta(days=1)


def test_an_unknown_time_of_day_is_the_evening() -> None:
    assert covers.suggest("2026-10-06", [], "mittag")[0] == "baum.abend.herbst"


def test_only_known_names_are_illustrations_and_only_photo_ids_are_photos() -> None:
    assert covers.is_illustration("illu:baum.abend.herbst")
    for wrong in ("baum.abend.herbst", "illu:baum.abend", "illu:mond.abend.herbst", "illu:", None, 3,
                  "illu:baum.abend.herbst "):
        assert not covers.is_illustration(wrong)  # type: ignore[arg-type]
    assert covers.photo_of("photo:" + "a" * 32) == "a" * 32
    for wrong in ("photo:" + "A" * 32, "photo:../x", "photo:", "illu:baum.abend.herbst", None):
        assert covers.photo_of(wrong) is None
