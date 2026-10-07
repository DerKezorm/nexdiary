"""Settings from the environment, prefix ``NEXDIARY_``.

What the operator changes at runtime (log level and, later, sign-in rules and backups) lives in the database, see
``services/settings_service.py``. Only what must be known before the first start is here.
"""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import PrivateAttr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEXDIARY_",
        env_file=(PROJECT_DIR / ".env", BACKEND_DIR / ".env"),
        extra="ignore",
    )

    #: Database, logs, backups and the operator's own language files.
    data_dir: Path = PROJECT_DIR / "data"
    #: Files that belong to the diary (photos, later). Empty: ``<data_dir>/media``.
    media_dir: Path | None = None
    #: Extra languages as JSON files, one per language (``es.json``). Empty: ``<data_dir>/locales``.
    locales_dir: Path | None = None
    disable_background: bool = False
    #: Where the update check asks for the newest release. Empty: GitHub's API. The tests point it elsewhere.
    update_url: str = ""
    frontend_dist: Path = PROJECT_DIR / "frontend" / "dist"
    #: Overrides the stored log level; the emergency exit when the app does not even start.
    log_level: str = ""
    #: Serves /api/docs and /api/openapi.json. Off by default.
    api_docs: bool = False
    #: Signs the sign-in attempt cookie of OIDC and encrypts what the server must read on its own (the OIDC client
    #: secret, the mail password). Empty: a random key in ``<data_dir>/secret.key``, made at the first start.
    secret_key: str = ""
    #: A session with "stay signed in on this device" ends after this many days without use (each use moves the end).
    session_days: int = 30
    #: Argon2id for passwords. The tests lower the cost.
    argon2_time: int = 3
    argon2_memory_kib: int = 65536
    argon2_parallelism: int = 2
    #: ``auto``: the session cookie is ``Secure`` when the request came over HTTPS (or a proxy says so).
    cookie_secure: str = "auto"
    #: The address people reach nexdiary under, for links in invitations and the OIDC return. Empty: the address of
    #: the request. The setting in the interface wins over this.
    public_url: str = ""
    #: Appended to every cookie name. Two instances on one host under different ports share their cookies (a browser
    #: does not tell ports apart); a suffix keeps their sign-ins apart. Letters, digits and "_" only.
    cookie_suffix: str = ""
    #: Addresses or networks of reverse proxies whose ``X-Forwarded-For`` may be believed, comma separated. Empty:
    #: the header is ignored, so that nobody dodges the sign-in brake with made-up addresses.
    trusted_proxies: str = ""
    #: The code the first account must bring. Empty: nexdiary makes one at every start until set up and writes it to
    #: the log, so that whoever reaches a fresh instance first does not become its operator.
    setup_token: str = ""
    #: Addresses or networks the operator's settings may be changed from, comma separated (e.g. 192.168.0.0/16).
    #: Empty: from anywhere. Behind a reverse proxy only with ``trusted_proxies`` set.
    operator_networks: str = ""
    #: The master key that wraps every person's data key (``services/vault.py``). Empty: ``<data_dir>/keys/master.key``,
    #: made at the first start. It is never in the database, never in the log and never in a backup.
    master_key_file: Path | None = None
    #: How many pictures are unpacked at the same moment (photos, profile pictures). Each one may take some 150 MB
    #: while it is open; one is enough for a family, a larger server may give more.
    decode_slots: int = 1

    @field_validator("data_dir", "frontend_dist", "media_dir", "locales_dir", "master_key_file")
    @classmethod
    def _relative_to_project(cls, value: Path | None) -> Path | None:
        # A relative path means the project, not whatever directory the process was started from.
        if value is None or value == Path(""):
            return None
        return value if value.is_absolute() else PROJECT_DIR / value

    @model_validator(mode="after")
    def _defaults_inside_data(self) -> Settings:
        if self.media_dir is None:
            self.media_dir = self.data_dir / "media"
        if self.locales_dir is None:
            self.locales_dir = self.data_dir / "locales"
        return self

    _remembered_key: str = PrivateAttr(default="")

    @property
    def database_path(self) -> Path:
        return self.data_dir / "nexdiary.db"

    def cookie_name_suffix(self) -> str:
        """The suffix, with anything but letters, digits and "_" taken out (a cookie name allows little)."""
        return "".join(ch for ch in self.cookie_suffix if ch.isascii() and (ch.isalnum() or ch == "_"))

    def resolved_secret_key(self) -> str:
        """``NEXDIARY_SECRET_KEY``, else ``secret.key`` in the data folder, made once with a random value."""
        if self.secret_key:
            return self.secret_key
        if self._remembered_key:
            return self._remembered_key
        self.data_dir.mkdir(parents=True, exist_ok=True)
        key_file = self.data_dir / "secret.key"
        if key_file.exists():
            self._remembered_key = key_file.read_text(encoding="utf-8").strip()
        else:
            self._remembered_key = secrets.token_urlsafe(48)
            # Made only the owner's from the first byte: written first and narrowed after, it stood open a moment.
            descriptor = os.open(key_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(self._remembered_key)
        try:
            os.chmod(key_file, 0o600)
        except OSError:
            pass
        return self._remembered_key


@lru_cache
def get_settings() -> Settings:
    return Settings()
