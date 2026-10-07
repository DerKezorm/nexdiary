"""Every test run gets its own empty data directory; nothing touches ``data/`` of the project."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

_DATA = tempfile.mkdtemp(prefix="nexdiary-tests-")
os.environ["NEXDIARY_DATA_DIR"] = _DATA
os.environ["NEXDIARY_DISABLE_BACKGROUND"] = "1"
os.environ["NEXDIARY_FRONTEND_DIST"] = os.path.join(_DATA, "no-frontend")
# Set, not removed: a value in the environment wins over a .env file in the project, a removed one does not.
os.environ["NEXDIARY_MEDIA_DIR"] = os.path.join(_DATA, "media")
os.environ["NEXDIARY_LOCALES_DIR"] = os.path.join(_DATA, "locales")
os.environ["NEXDIARY_LOG_LEVEL"] = ""
os.environ["NEXDIARY_API_DOCS"] = "false"
# Argon2 as cheap as it goes: the tests make many accounts. The strength itself is Argon2's business.
os.environ["NEXDIARY_ARGON2_TIME"] = "1"
os.environ["NEXDIARY_ARGON2_MEMORY_KIB"] = "1024"
os.environ["NEXDIARY_ARGON2_PARALLELISM"] = "1"
# Never GitHub from a test: port 9 refuses at once.
os.environ["NEXDIARY_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
os.environ["NEXDIARY_SECRET_KEY"] = "test-secret-key-for-the-test-run-only"
SETUP_CODE = "test-setup-code"
os.environ["NEXDIARY_SETUP_TOKEN"] = SETUP_CODE

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import MEMBER, OPERATOR, Account, Base, Setting  # noqa: E402
from app.security import SESSION_COOKIE, brake, hash_password, start_session  # noqa: E402
from app.services import ai, backups, brakes, diary, immich, totp, updates  # noqa: E402

DATA_DIR = _DATA
MEDIA = Path(_DATA) / "media"
TAB = {"X-Nexdiary-Client": "tab-tests000"}


@pytest.fixture(scope="session", autouse=True)
def schema() -> None:
    init_db()


@pytest.fixture(autouse=True)
def clean_db(schema: None) -> Iterator[None]:
    with SessionLocal() as db:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(delete(table))
        db.execute(delete(Setting))
        db.commit()
    assert MEDIA.resolve().is_relative_to(Path(_DATA).resolve())
    shutil.rmtree(MEDIA, ignore_errors=True)
    MEDIA.mkdir(parents=True)
    # Backups of a test before (an automatic one of the same second) must not decide what another test prunes.
    shutil.rmtree(backups.folder(), ignore_errors=True)
    brake.forget()
    brakes.forget()
    totp.forget()
    updates.forget()
    diary.forget_searches()
    ai.forget()
    immich.forget()
    yield
    app.dependency_overrides.clear()


PASSWORD = "correct horse battery"


def make_account(name: str, role: str = MEMBER, password: str = PASSWORD) -> Account:
    """An account with a password, straight into the database."""
    with SessionLocal() as db:
        row = Account(name=name, role=role, password_hash=hash_password(password))
        db.add(row)
        db.commit()
        db.expunge(row)
    return row


def sign_in(client: TestClient, account: Account) -> None:
    """The client carries a session of ``account`` from now on (a real one, as after signing in)."""
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        token = start_session(db, row, "127.0.0.1", "tests")
    client.cookies.set(SESSION_COOKIE, token)


def new_client(account: Account | None = None) -> TestClient:
    """Another browser, signed in as ``account`` when one is given. Close it (``with``) when done."""
    client = TestClient(app, base_url="http://testserver", headers=TAB)
    if account is not None:
        sign_in(client, account)
    return client


def person(name: str) -> TestClient:
    """A browser signed in as a new member ``name``."""
    return new_client(make_account(name))


def _operator(client: TestClient) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="tester").one_or_none()
        if row is not None:
            db.expunge(row)
    if row is None:
        row = make_account("tester", OPERATOR)
    sign_in(client, row)
    return row


@pytest.fixture
def client() -> Iterator[TestClient]:
    # As the interface does: every request names its tab (changes are refused without it).
    with TestClient(app, base_url="http://testserver", headers=TAB) as test_client:
        yield test_client


@pytest.fixture
def operator(client: TestClient) -> Account:
    """The signed-in operator ``tester``."""
    return _operator(client)


@pytest.fixture
def account(client: TestClient) -> Account:
    """The same as ``operator``, under the name the tests from nexlore use."""
    return _operator(client)


def pytest_unconfigure(config: pytest.Config) -> None:
    """The data folder of this run goes when the run ends: the log file is closed first (Windows keeps open files),
    then the folder with everything in it."""
    import logging

    for logger in (logging.getLogger(), logging.getLogger("uvicorn.error")):
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)
    from app.db import engine

    engine.dispose()
    shutil.rmtree(_DATA, ignore_errors=True)
