"""A nexdiary started on the data folder of 0.6.0 (schema 16, its one sign-in provider in the settings, made by the
code of that state, see ``fixtures/v16/make.py``), run as its own process by ``test_migration_v17.py``: the start
brings the database up and the provider becomes the entry ``oidc`` of the list; then people sign in through the fake
provider at the address it knew, and the start runs once more. Prints what it saw as JSON.

The data folder, the master key and the server secret are put in place by the test; the environment names them.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit


def main() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent / "nexoidc"))
    import oidc_fakes as fakes
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.db import SessionLocal
    from app.main import app
    from app.security import decrypt_secret
    from app.services import oidc_store, settings_service
    from app.vendor import nexoidc
    from app.vendor.nexoidc import secret_context

    from .fixtures.v16.make import CLIENT_ID, DAY, ISSUER, fixture_client_secret
    from .test_schema import fresh_schema_sql, schema_of

    path = get_settings().database_path
    seen: dict[str, Any] = {}

    def keys() -> dict[int, str]:
        with closing(sqlite3.connect(path)) as connection:
            return {row[0]: bytes(row[1]).hex() for row in connection.execute("SELECT user_id, wrapped_dek FROM user_keys")}

    def backups() -> int:
        return len(list((get_settings().data_dir / "backups").glob("*.zip")))

    keys_before = keys()
    network = fakes.Network()
    fake = network.add(fakes.FakeProvider(ISSUER, client_id=CLIENT_ID, client_secret=fixture_client_secret()))
    tab = {"X-Nexdiary-Client": "tab-probe0000"}
    with TestClient(app, base_url="http://testserver", headers=tab) as client:
        nexoidc.use_transport(network.transport())
        with closing(sqlite3.connect(path)) as connection:
            seen["version"] = connection.execute("PRAGMA user_version").fetchone()[0]
            with closing(sqlite3.connect(":memory:")) as fresh:
                fresh.executescript(fresh_schema_sql())
                seen["schema_as_new"] = schema_of(connection) == schema_of(fresh)
            seen["links"] = sorted(list(row) for row in connection.execute(
                "SELECT users.name, oidc_links.subject, oidc_links.issuer FROM oidc_links "
                "JOIN users ON users.id = oidc_links.account_id"))
            seen["entries"] = [list(row) for row in connection.execute(
                "SELECT slug, label, issuer, client_id, enabled, auto_create, trusts_second_factor, managed, "
                "redirect_path FROM oidc_providers")]
        seen["backups"] = backups()
        seen["keys_kept"] = keys() == keys_before and len(keys_before) == 3
        with SessionLocal() as db:
            entry = oidc_store.SqlStore(db).provider_by_slug("oidc")
            assert entry is not None
            from app.models import OidcProvider

            sealed = db.get(OidcProvider, entry.id).client_secret_enc  # type: ignore[union-attr]
            seen["secret_with_context"] = decrypt_secret(sealed, secret_context(entry.id)) == fixture_client_secret()
            seen["secret_without_context"] = decrypt_secret(sealed)
            values = settings_service.get_all(db)
            seen["way_back"] = {key: values[key] for key in (
                "oidc_issuer", "oidc_client_id", "oidc_provider_name", "oidc_auto_create",
                "oidc_second_factor_by_provider", "oidc_legacy_anchor")}
            seen["way_back_secret"] = decrypt_secret(str(values["oidc_client_secret_enc"] or ""))
            seen["fingerprint"] = values["oidc_legacy_fingerprint"]
        seen["subjects"] = {name: subject for name, subject in sqlite3.connect(path).execute(
            "SELECT name, oidc_subject FROM users")}

        def through_the_provider(subject: str) -> tuple[str, dict[str, Any]]:
            browser = TestClient(app, base_url="http://testserver", follow_redirects=False, headers=tab)
            target = browser.get("/api/oidc/oidc/start").headers["location"]
            fake.person = {"sub": subject, "preferred_username": "someone", "email": "someone@example.com"}
            params = fake.authorize(target)
            back = urlsplit(fakes.query_of(target)["redirect_uri"]).path
            answer = browser.get(f"{back}?{urlencode(params)}")
            out: dict[str, Any] = {"callback": back, "location": answer.headers.get("location", "")}
            me = browser.get("/api/auth/me")
            if me.status_code == 200:
                out["name"] = me.json()["name"]
                out["stage"] = me.json()["session_stage"]
                day = browser.get(f"/api/days/{DAY}")
                out["page"] = day.json().get("text") if day.status_code == 200 else day.status_code
                out["days"] = [item["date"] for item in browser.get("/api/days").json()]
            return out["location"], out

        seen["olga"] = through_the_provider("person-olga")[1]
        seen["alex"] = through_the_provider("person-alex")[1]
        seen["stranger"] = through_the_provider("person-tom")[1]
        # The start once more: nothing to take over, no backup, the same fingerprint.
        oidc_store.migrate_settings()
        seen["backups_after_second_start"] = backups()
        with SessionLocal() as db:
            seen["fingerprint_after_second_start"] = settings_service.get(db, "oidc_legacy_fingerprint")
        seen["keys_kept_after_sign_ins"] = keys() == keys_before
        client.get("/api/health")
    print(json.dumps(seen, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
