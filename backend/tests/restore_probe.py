"""A new nexdiary on an empty data folder, run as its own process by ``test_readiness.py``: the saved master key is put
in ``keys/`` before the first start, the backup of the old server is restored, and the day it holds is read back.

Arguments: the backup archive, the master key file, the account name and password, the date of the day. Prints the
day's title; exits with 3 when the backup is refused for another master key.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    archive, key_file, name, password, date = sys.argv[1:6]
    data = Path(os.environ["NEXDIARY_DATA_DIR"])
    (data / "keys").mkdir(parents=True)
    shutil.copyfile(key_file, data / "keys" / "master.key")
    (data / "backups").mkdir()
    shutil.copyfile(archive, data / "backups" / Path(archive).name)

    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import backups, vault

    backups.restart_soon = lambda *args, **kwargs: None  # type: ignore[assignment]
    with TestClient(app):
        try:
            backups.stage_restore(Path(archive).name)
        except backups.BackupError as exc:
            print(exc.code)
            return 3
    vault.forget()
    with TestClient(app, headers={"X-Nexdiary-Client": "tab-probe0000"}) as browser:
        signed = browser.post("/api/auth/login", json={"name": name, "password": password})
        if signed.status_code != 200:
            print("sign-in", signed.status_code)
            return 4
        print(browser.get(f"/api/days/{date}").json()["title"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
