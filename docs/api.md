# The nexdiary API

Programs such as a dashboard card read nexdiary over `/api/v1`. The API only reads; nothing under `/api/v1` changes
anything. What is under `/api/v1` stays as it is: new fields may come, nothing is renamed or taken away.

## Switching it on

API tokens are off until the operator switches them on, under **Settings → API**. Then every account makes
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

### `GET /api/v1/dashboard`

A few numbers for a dashboard card, all of them for the account of the token and nobody else:

```json
{
  "version": "0.7.0",
  "today_written": true,
  "streak": 12,
  "streak_unit": "days",
  "entries_month": 9,
  "notes_month": 31,
  "next_capsule": "2026-12-24",
  "next_capsule_days": 74
}
```

| Field | Meaning |
|---|---|
| `version` | The nexdiary version. |
| `today_written` | The page of today is written (it has text). "Today" is the date in the time zone the account uses. |
| `streak` | The streak the interface shows. |
| `streak_unit` | `days` at a weekly goal of 7 (every day), `weeks` at a lower goal. The streak counts in that unit. |
| `entries_month` | Pages with text in the current calendar month, up to today. |
| `notes_month` | Notes in the current calendar month, up to today. |
| `next_capsule` | The day (`YYYY-MM-DD`) the next time capsule *for this account* opens, or `null` while none is closed. Capsules the account wrote to itself count; capsules it wrote only to other people do not. |
| `next_capsule_days` | Whole days from today to `next_capsule`, or `null`. |

**What it deliberately does not give.** No text, title, tag, value (1 to 10) or mood, not even the names of the values;
no photo; nothing of any other account; for a capsule only the day it opens, never its title, text, sender or
recipients. The numbers are counts and days, so a card can show them and a leaked token shows no more than that.

Reading makes no change: asking never creates a data key for an account that has not written yet.
