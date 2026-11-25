# 018 — Scorer-phone hand-off: a one-time QR gives one phone score entry on one board

**Date:** 2026-11-24 · **Status:** accepted (approved by Steve 2026-11-24); **replaced** by [025](025-helpers-and-score-pad.md) (R37, built 2026-11-25) · **Roadmap:** R24 · **Related:** 008, 009, 011, 012, 015, 017

## Context
Decision 012 left one way to score from a second phone: sign that phone in to the host's
account with an emailed code. At a party that is slow, and it hands over every board the
host owns for 90 days. The host is already signed in on an iPad or laptop, so that device
can vouch for the phone.

## Decision

### 1. What the phone gets: score entry on one board, nothing else
The phone gets a **scorer grant**, not a host session. The grant allows
`PATCH /api/game/:id/score` on that board (points, set, end quarter, final, undo, edit a
quarter, take over from the live feed and resume it). It never allows `PUT` or `DELETE` of
the board, squares, players, payouts, the drawn winner, TV pairing, another hand-off, or any
other board. Reading the board is already public.

| Option | Why not |
|---|---|
| Full host sign-in on the phone | One photographed QR would hand over every board and the account for 90 days |
| Host rights limited to this board | Whole-document `PUT` could wipe the grid or delete the board; a helper does not need it |
| A reusable link per board | Can be forwarded; nobody knows who holds it |

### 2. Flow
1. On Game Day, **Score from another phone** (in "What's in the room?") and **Score on
   phone** open one dialog. It calls `POST /api/game/:id/handoff` and shows a QR of
   `<origin>/#handoff-<token>`. `<origin>` is the host page's own address.
2. The phone opens the link. The page takes the token out of the address bar and shows a
   **Start scoring** button. Only the tap redeems it, so link previews can't use it up.
3. `POST /api/handoff { token }` uses the token once, sets the cookie and returns the
   board id. The phone opens score entry for that board.
4. The host's dialog checks for the scan every 4 s while the QR is showing, then says
   "Phone connected". It stops on use, expiry or close (5 minutes at most).

### 3. Token and cookie
- **Token:** 32 random bytes, in the URL fragment (never in server logs or referrers), stored
  as SHA-256. **Single use, 5 minutes.** Using it is one conditional `UPDATE`, so two phones
  that scan together can't both get in. A new QR cancels the board's earlier unused one.
- **Cookie `sbs_scorer`:** another 32 random bytes, made at redemption, stored as SHA-256.
  HttpOnly, SameSite=Lax, Secure on HTTPS, **`Path=/api/game/<id>`**, so the browser sends it
  for that board only and one phone can score two boards. **24 hours**, checked against the
  row, not just the cookie.
- The grant is a database row, not a signed cookie, so the host can end it. The row is read
  only when a score write (or `GET …/role`) carries the cookie, so hosts cost no extra query.

### 4. How a grant ends
- 24 hours pass, or the board is deleted (foreign key, `on delete cascade`).
- **Remove scorer phones** in the dialog ends all of that board's grants at once. The dialog
  shows how many phones can score now. At most 5 at a time.
- **Sign out everywhere** ends them too: the grant stores the host's `session_version` and
  the check compares it with the current one, in the same query that reads the board's owner.
  Plain sign-out on the host's device does not (the party goes on).
- A grant made in one auth mode is refused in another: accounts mode requires the stored
  version and a board owner; password and off modes require that there is none.

### 5. Schema (migration 006, adds only)
```sql
create table if not exists scorer_grants (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  host_version int,                      -- null in password and off modes
  token_hash   text not null unique,     -- sha256 of the QR token
  session_hash text unique,              -- sha256 of the phone's cookie, set on use
  created_at   timestamptz not null default now(),
  used_at      timestamptz
);
create index if not exists scorer_grants_game_idx on scorer_grants (game_id);
```
The fs store keeps the same shape in `data/scorer-grants.json`. Expiry is judged at read time
(decision 007). Expired rows are deleted when a new one is created.

### 6. Endpoint access

| Endpoint | Anonymous | Scorer of this board | Owner |
|---|---|---|---|
| `POST /api/game/:id/handoff` → `{ token, scorers, expiresInSeconds }` | 401 | 401 | 201; 409 before lock or at 5 phones |
| `GET /api/game/:id/handoff` → `{ waiting, scorers }` | 401 | 401 | 200 |
| `DELETE /api/game/:id/handoff` (remove all, and any waiting QR) | 401 | 401 | 200 |
| `POST /api/handoff { token }` | 200 + cookie, or 401 | same | same |
| `GET /api/game/:id/role` → `{ role }` | `none` | `scorer` | `host` |
| `PATCH /api/game/:id/score` | 401 | **200** | 200 |
| every other write | 401 | 401 | as today |

A signed-in host who is not the owner keeps getting 403 unless that phone also holds a grant.
Wrong, used, expired and cancelled tokens get one answer. The `Origin` check and the
fail-closed 503 (decision 012) apply to all of it. Authorization stays in `lib/api.js`: a new
`denyUnlessOwnerOrScorer`, used by the score route only.

### 7. What the scorer sees
The phone score screen with the current-score panel, quarter results and winners. No Manage
Players and no draw button ("The host draws the winner"). Simulation boards are read-only. On
a Live board with the feed up, **Enter the score** takes over (the existing `override`
operation). When the grant ends the page says so and asks for a new QR. It never opens the
sign-in prompt.

## Accepted risks
- **Someone else scans first.** Anyone who can see the host's screen can scan within 5
  minutes. They get score entry on one board, the real scorer sees "already used", and the
  host's dialog shows the phone count and can remove it. Scores can be corrected, and a
  changed quarter already marked paid shows "Needs settling" (decision 015).
- **iPhone home-screen app.** The camera opens Safari, so scoring runs in Safari, not in an
  installed app. That is fine: it needs no account.
- **Password mode.** Changing `HOST_PASSWORD` does not end a grant; Remove or 24 hours does.
  The mode goes away a release after R2 (decision 012).

## Tests (the security ones are required)
A scorer can PATCH score on its own board and gets 401 on every other write and on another
board; a token works once, including two parallel redemptions; expired and cancelled tokens
fail; remove-all, sign out everywhere, expiry and board deletion each end a grant; a grant
from another auth mode is refused; a non-owner can't create, list or remove; foreign `Origin`
is refused; misconfigured returns 503. Store contract tests run on both backends.

## Consequences
- **Deploy order:** apply migration 006 before the push that ships R24. Only the hand-off
  routes and devices holding the scorer cookie touch the table, so without it boards load,
  hosts can score, and only the hand-off fails.
- The privacy page says that scorer phones get a cookie that lasts 24 hours.
- Replaces "per-board scorekeeper links" in Later.
