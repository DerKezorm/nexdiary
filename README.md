# nexdiary

A diary for the family, on your own server. Jot things down during the day, write the page in the evening. Every
person sees only their own diary; the operator manages the accounts and never sees what is written in them.

This is an early version: accounts, sign-in with a second factor, OpenID Connect (with a one-step setup for
authentik), invitations, backups, languages and the log are in place. The diary itself follows.

## Running it

```sh
docker compose up -d --build
```

Then open `http://127.0.0.1:8550` on that machine (the port listens only there; the comment in
[docker-compose.yml](docker-compose.yml) says how to change that). The first account becomes the operator; it needs the
setup code from the log (`docker logs nexdiary`), or the one set in `NEXDIARY_SETUP_TOKEN`. The settings that must be
known before the first start are in [docker-compose.yml](docker-compose.yml).

## Updating

```sh
docker compose pull && docker compose up -d
```

A change to the database makes a backup first; the way back is under Settings, Server, Backup.

## nexdiary on the internet

- Put it behind a reverse proxy with https, and set `NEXDIARY_TRUSTED_PROXIES` to the proxy's address so the brake
  against password guessing sees the real sender.
- Set the public address (Settings, Server, Sign-in, or `NEXDIARY_PUBLIC_URL`).
- A second factor is required from the start: right after the password, every account sets one up (a code from an
  app, or a passkey). Settings, Server, Sign-in shows "Ready for the internet?", which checks the rest itself.
- Keep the backups somewhere else as well; a backup holds every account. A backup also holds the server's secrets
  (`secret.key`), so keep it like a password. Save the master key (Settings, Server, Backups) and keep it apart from
  the backups: without it a backup cannot be read.
- Nobody, the operator included, sets a password for somebody else. Whoever forgot theirs gets a link to set a new one:
  the operator sends it (Settings, Server, Accounts), or, where a mail server and the public address are set, the
  person asks for it on the sign-in page. The link works once and for 24 hours.
- Passkeys work under the public https address, or on localhost.

## Programs

Programs read nexdiary over `/api/v1` with a token; see [docs/api.md](docs/api.md).

## Developing

- Backend: `cd backend`, `python -m venv .venv`, `.venv/Scripts/python -m pip install -r requirements-dev.txt`, then
  `python -m pytest` and `python -m ruff check app tests`. The server: `uvicorn app.main:app --port 8550 --no-proxy-headers --no-server-header`.
- Frontend: `cd frontend`, `npm ci`, `npm run dev` (port 5550, the API proxied to 8550), `npm test`, `npm run lint`,
  `npm run build`.

## Licence

[AGPL-3.0](LICENSE). What nexdiary ships or depends on is listed in [THIRD-PARTY.md](THIRD-PARTY.md).
