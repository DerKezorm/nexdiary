# The nexdiary API

Programs such as a dashboard card read nexdiary over `/api/v1`. The API only reads; nothing under `/api/v1` changes
anything. What is under `/api/v1` stays as it is: new fields may come, nothing is renamed or taken away.

## Switching it on

API tokens are off until the operator switches them on, under **Settings → Server → API**. Then every account makes
its own tokens under **My account → Connections**:

- A token reads as its account, never more.
- It runs out after 30, 90 or 365 days, or never. The list marks a token a week before it runs out.
- It is shown once, right after it was made. nexdiary keeps only a checksum.
- The operator sees every token (never the token itself) and can block one for good.

## Asking

Every request carries the token in a header:

```
Authorization: Bearer nxa_…
```

A request that carries an `Origin` header is refused (403): the API is for programs, not web pages. The answers are
JSON.

| Answer | Code | Meaning |
|---|---|---|
| 401 | `api_off` | The operator has not switched API tokens on. |
| 401 | `token_invalid` | No such token, or it ran out, was blocked or deleted. |
| 403 | `origin_refused` | The request came from a web page. |
| 429 | `slow_down` | More than 600 requests in a minute with this token; `Retry-After` says when to go on. |

Errors look like `{"detail": {"code": "token_invalid", "message": "No valid API token."}}`.

## Routes

### `GET /api/v1/me`

Who the token speaks for: `name`, `display_name`, `level` (always `read`) and the nexdiary `version`.
