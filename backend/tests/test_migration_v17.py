"""A real nexdiary 0.6.0 (schema 16, its one sign-in provider in the settings) comes to version 17: the data folders in
``fixtures/v16`` were made by the code of that state (``fixtures/v16/make.py``), one with the switch "the provider
checks the second factor" off (as from the start), one with it on. Started on a copy in a process of its own
(``migration_probe_v17.py``), the provider becomes the entry ``oidc`` with a link per stored subject; it keeps how 0.6
treated the second factor; the people sign in at the address the provider knew and read their own diary and nothing
else; nobody's data key changes; the way back to 0.6 shows the provider in full only where 0.6 trusted it, with the
issuer written as 0.6 wrote it; a second start changes nothing."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from app.db import SCHEMA_VERSION
from app.services import vault

from .fixtures.v16.make import CLIENT_ID, ISSUER, PAGES, fixture_client_secret, fixture_key, fixture_secret

FIXTURE = Path(__file__).parent / "fixtures" / "v16"


def probe(tmp: Path, database: str) -> dict[str, Any]:
    folder = tmp / "data"
    folder.mkdir()
    shutil.copyfile(FIXTURE / database, folder / "nexdiary.db")
    (folder / "keys").mkdir()
    (folder / "keys" / "master.key").write_bytes(vault._encode(fixture_key()))
    env = {**os.environ, "NEXDIARY_DATA_DIR": str(folder), "NEXDIARY_MEDIA_DIR": str(folder / "media"),
           "NEXDIARY_LOCALES_DIR": str(folder / "locales"), "NEXDIARY_SECRET_KEY": fixture_secret()}
    env.pop("NEXDIARY_MASTER_KEY_FILE", None)
    env.pop("NEXDIARY_PUBLIC_URL", None)
    run = subprocess.run([sys.executable, "-m", "tests.migration_probe_v17"], cwd=Path(__file__).parent.parent,
                         env=env, capture_output=True, text=True, timeout=300, check=False)
    assert run.returncode == 0, run.stderr[-4000:]
    return dict(json.loads(run.stdout.strip().splitlines()[-1]))


@pytest.fixture(scope="module")
def asked(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    return probe(tmp_path_factory.mktemp("v16-asked"), "nexdiary-v16.sqlite")


@pytest.fixture(scope="module")
def trusted(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    return probe(tmp_path_factory.mktemp("v16-trusted"), "nexdiary-v16-trusted.sqlite")


@pytest.mark.parametrize("which", ["asked", "trusted"])
def test_the_provider_of_0_6_becomes_the_entry_oidc_with_its_links(which: str, request: pytest.FixtureRequest) -> None:
    seen = request.getfixturevalue(which)
    assert seen["version"] == SCHEMA_VERSION and seen["schema_as_new"] is True
    assert seen["backups"] == 2, "one before schema 17, one before the provider list"
    slug, label, issuer, client_id, enabled, auto_create, trusts, managed, redirect_path = seen["entries"][0]
    assert len(seen["entries"]) == 1
    assert (slug, label, issuer, client_id) == ("oidc", "authentik", ISSUER.rstrip("/"), CLIENT_ID)
    assert enabled == 1 and auto_create == 0 and managed == "authentik" and redirect_path == ""
    assert trusts == (1 if which == "trusted" else 0), "the entry asks the code after the provider as 0.6 did"
    stored = ISSUER.rstrip("/")
    assert seen["links"] == [["alex", "person-alex", stored], ["olga", "person-olga", stored]]
    assert seen["secret_with_context"] is True and seen["secret_without_context"] == ""


@pytest.mark.parametrize("which", ["asked", "trusted"])
def test_people_sign_in_at_the_old_address_and_read_their_own_diary_only(
    which: str, request: pytest.FixtureRequest
) -> None:
    seen = request.getfixturevalue(which)
    for name in ("olga", "alex"):
        person = seen[name]
        assert person["callback"] == "/api/oidc/callback", "the address the provider knew"
        assert person["name"] == name and person["stage"] == "full"
        assert person["page"] == PAGES[name] and person["days"] == ["2026-10-08"]
    # tom never linked: the provider's identity named "someone" with an address finds nobody.
    assert "oidc_no_account" in seen["stranger"]["location"] and "name" not in seen["stranger"]
    assert seen["keys_kept"] is True and seen["keys_kept_after_sign_ins"] is True


def test_the_way_back_shows_0_6_its_provider_in_full_only_where_it_trusted_it(
    asked: dict[str, Any], trusted: dict[str, Any]
) -> None:
    # Trusted: everything as 0.6 wrote it, the issuer letter for letter (its button's slash), the subjects.
    assert trusted["way_back"] == {
        "oidc_issuer": ISSUER, "oidc_client_id": CLIENT_ID, "oidc_provider_name": "authentik",
        "oidc_auto_create": False, "oidc_second_factor_by_provider": True, "oidc_legacy_anchor": ISSUER}
    assert trusted["way_back_secret"] == fixture_client_secret()
    # Asked (an entry that does not trust the provider is off for 0.6): issuer and name stay, the
    # client goes, so that 0.6 lets nobody in without the code it would not ask.
    assert asked["way_back"] == {
        "oidc_issuer": ISSUER, "oidc_client_id": "", "oidc_provider_name": "authentik",
        "oidc_auto_create": False, "oidc_second_factor_by_provider": False, "oidc_legacy_anchor": ISSUER}
    assert asked["way_back_secret"] == ""
    for seen in (asked, trusted):
        assert seen["subjects"] == {"jule": "", "alex": "person-alex", "olga": "person-olga", "tom": ""}


@pytest.mark.parametrize("which", ["asked", "trusted"])
def test_a_second_start_changes_nothing(which: str, request: pytest.FixtureRequest) -> None:
    seen = request.getfixturevalue(which)
    assert seen["backups_after_second_start"] == seen["backups"]
    assert seen["fingerprint_after_second_start"] == seen["fingerprint"] and seen["fingerprint"]
