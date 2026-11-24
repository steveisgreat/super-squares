# 012 — Host accounts: emailed sign-in, one owner per board

**Date:** 2026-11-23 · **Status:** accepted (approved by Steve 2026-11-23) · **Roadmap:** R1 (design),
R2 (build) · **Replaces:** 009 when R2 ships. 009's rule that a game id is a read
capability stays.

## Context
One site-wide `HOST_PASSWORD` means every host sees and edits every board. Selling the
app needs one account per host, boards scoped to their owner, and the LAN build still
working with no sign-in. Email needs a verified sending domain (R16) before R2 can ship.

## Decision

### 1. Sign-in: one email, a link and an 8-digit code
- The host types an email. We send one message with a link and a code. Either one signs
  them in. The first successful sign-in creates the account. There are no passwords.
- **Why the code too:** the app is an installable PWA. On an iPhone a link opens in
  Safari, whose cookies the home-screen app may not share, so a link alone can leave
  the installed app signed out. The code also covers "email on the phone, board on the
  laptop" and signing in on a scorekeeper's phone.
- The link is `<APP_ORIGIN>/#login-<token>`. The fragment never reaches server logs or
  referrers. The page shows a **Sign in** button that POSTs the token, so mail scanners
  that open links cannot use it up.
- Links are built from the `APP_ORIGIN` variable, never from the `Host` header (a forged
  header would send the token to an attacker's site).
- Token: 32 random bytes, stored as SHA-256. Code: 8 random digits, stored as
  HMAC(`SESSION_SECRET`, request id + code). Both expire in 15 minutes and work once.
- The code works only with the request id held by the browser that asked, and only for
  5 tries. Each try is counted and checked in one atomic `UPDATE`.
- At most 5 requests per email per hour, checked in the insert, plus a site-wide hourly
  cap from `LOGIN_EMAILS_PER_HOUR`. The answer is the same for known and unknown emails.
- Accepted: someone can use up another person's 5 requests an hour and delay their next
  sign-in. The long session and R10's per-IP firewall rule limit this, so **R10's rule
  ships with R2**, not after it.

### 2. Session: the signed cookie we have, plus a version number
- Cookie `sbs_session` = `v1.<hostId>.<sessionVersion>.<expiry>.<HMAC-SHA256>`, 90 days,
  HttpOnly, SameSite=Lax, Secure on HTTPS, no Domain attribute (so the marketing site on
  the apex never receives it).
- `hosts.session_version` is compared on every guarded request, in the same query that
  reads the board's owner. "Sign out everywhere" adds 1 to it. That gives real
  revocation without a session table, and anonymous readers still cost no extra query.
- `SESSION_SECRET` is required in accounts mode, with no fallback.
- Every POST, PUT, PATCH and DELETE with an `Origin` header that doesn't match the
  request host gets 403. SameSite treats `app.` and the apex as one site, so the cookie
  setting alone is not enough.

### 3. Library or our own code: our own
About 250 lines in `lib/auth.js` and a new `lib/mailer.js` (one `fetch` to Resend's API).
**No new dependency.**

| Option | Why not |
|---|---|
| Better Auth (self-hosted) | Brings its own schema, database driver and client; large for two endpoints; awkward with no build step and an fs target |
| Neon Auth (managed) | Ties sign-in to one vendor, and its browser client expects a bundler |
| Clerk, Auth0 | Monthly cost, third-party script, a second place holding user data |

The cost is that we own the security. `/code-review high` and the tests below are the
control.

### 4. Modes, and failing closed

| Mode | Selected by | Behavior |
|---|---|---|
| accounts | `AUTH_MODE=accounts` (needs `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_ORIGIN`) | this decision |
| password | `HOST_PASSWORD` set | 009, kept for one release as the rollback path, then removed |
| off | neither | LAN: no sign-in; every request is the host |

A missing variable in accounts mode returns 503 on guarded routes. When `VERCEL` is set,
**off is never allowed**: today, deleting one variable would open every board.
Without `RESEND_API_KEY` off Vercel, the link and code print to the server console.

### 5. Schema (adds only; next free migration number)

```sql
create table if not exists hosts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,              -- trimmed, lowercased
  session_version int not null default 1,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists login_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash bytea not null unique,
  code_hash bytea not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists login_requests_email_idx on login_requests (email, created_at);
create index if not exists login_requests_created_idx on login_requests (created_at);

alter table games add column if not exists owner_id uuid references hosts(id);
create index if not exists games_owner_idx on games (owner_id, updated_at desc);
```

- **`owner_id` is a column, never in `doc`.** Every guest reads `doc`, and hosts PUT
  the whole `doc`, so an owner stored there would leak and could be overwritten.
- It stays nullable: boards made with auth off have no owner. In accounts mode a board
  with no owner cannot be written by anyone.
- Old `login_requests` rows (over 24 h) are deleted by the next sign-in request. No cron.
- **Existing games:** `scripts/assign-owner.js <email>`, run once by hand, creates
  Steve's host row and sets `owner_id` where it is null. It prints the counts first and
  writes only with `--apply`. Run it after the migration and again after the deploy.

### 6. Endpoint access

| Endpoint | Anonymous | Signed in, not owner | Owner |
|---|---|---|---|
| `GET /api/session` | 200 | 200 | 200 (adds the email; `no-store`) |
| `POST /api/login` `{email}` | 200 `{requestId}` | same | same |
| `POST /api/login/verify` `{token}` or `{requestId, code}` | sets cookie, or 401 | same | same |
| `DELETE /api/session` | 200 | 200 | 200 |
| `POST /api/session/revoke-all` | 401 | 200 (own account) | 200 (own account) |
| `GET /api/game/:id`, `GET /api/hosts` | 200 | 200 | 200 |
| `GET /api/games` | 401 | own boards only | own boards only |
| `GET /api/todays-games` | 401 | 200 | 200 |
| `POST /api/game` | 401 | 201, becomes owner | n/a |
| `PUT`, `DELETE /api/game/:id` | 401 | **403** | 200 |
| `PATCH /api/game/:id/score` | 401 | **403** | 200 |

Unknown id on a write: 404. The board is publicly readable by id, so 403 reveals nothing
new. A 403 never opens the sign-in prompt. `POST /api/session` (password) answers only in
password mode.

### 7. Store contract
- `listGames(scope)`, `createGame(game, ownerId)`, new `getGameAccess(id, hostId)`
  returning the owner and that host's session version in one query.
- `scope` is `{ all: true }` or `{ ownerId }`. **Anything else throws**, so forgetting it
  cannot list everyone's boards.
- Authorization stays in `lib/api.js`: `denyUnlessHost` becomes `denyUnlessSignedIn` and
  `denyUnlessOwner`. Ownership never changes after creation and deleted ids are never
  reused, so the owner check can't go stale. `PUT` on an unknown id now returns 404 at the
  route. A delete racing a save could still re-create the row through the store's
  upsert, so in accounts mode the Postgres write is update-only.
- Server-owned writes caused by anonymous reads (auto-cutoff, live score) are unchanged.
- The fs backend accepts only `{ all: true }`. Accounts mode without `DATABASE_URL` is refused.

### 8. New risk that comes with strangers as hosts
Until now the only host was Steve. After R2, a stranger's board text renders in other
people's browsers, including signed-in hosts. R2 therefore also includes:
- an output-escaping audit of every `innerHTML` in `public/` (53 template assignments),
  and stricter `validateGame` types for fields that reach markup (dates, colors, scores,
  draw cells);
- a Content-Security-Policy header (`vercel.json` and `server.js`), after moving the
  inline script in `index.html` to a file;
- a smaller body limit on game writes (5 MB today; R2 measures a full simulated board
  and sets about twice that).

## Tests R2 must add
Host A cannot list, PUT, PATCH or DELETE host B's board, or claim it by putting `owner_id`
in the body; unowned boards are write-locked; `listGames` without a scope throws; a
used, expired or wrong token fails; the sixth code try fails even if right, including
when tries run in parallel; the code fails under another request id; revoke-all ends other
sessions; a foreign `Origin` is refused; missing config on Vercel returns 503 and never
opens; with auth off, every LAN route works as today. Route tests use a stub store and
always run. The SQL tests run in `test-store-pg.js` against a Neon branch. The repo has
no CI yet, so R2 adds a GitHub Actions workflow (the branch's connection string is a
repository secret).

## Order of work in R2
Migration → store and scope → auth, mailer and routes with tests → client sign-in (email
form, code entry, `#login-` page) → escaping and CSP → assign-owner script → docs. Deploy
with `AUTH_MODE` unset (password mode keeps working), run the migration and the script,
then set `AUTH_MODE=accounts`. Roll back by unsetting it.

## Consequences
- Resend's free plan sends 100 emails a day, too few for game week. R7 adds the paid plan
  (about $20 a month; confirm the price when buying).
- A scorekeeper's phone must be signed in to the owner's account (the code makes that
  possible). Per-board scorekeeper links are not in R2.
- Not in R2: teams or co-hosts, changing an email, self-service account deletion (by hand
  from the runbook until built), social sign-in.

## Build notes
R2 part 1 (2026-11-23: migration 002, store, `lib/auth.js`, `lib/mailer.js`, routes, tests):
- §7's 404 for `PUT` on an unknown id, and update-only writes, apply in accounts mode
  only. Password and off modes keep the old upsert, so the LAN build is unchanged.
- Accounts mode requires a `SESSION_SECRET` of 32+ characters and an `https` `APP_ORIGIN`
  on Vercel. An unrecognized `AUTH_MODE` fails closed (503). `api/[...path].js` sets
  `VERCEL` itself, because Vercel sets it only when system variables are exposed.
- Over either email limit the answer is 429, the same for known and unknown addresses.
- "Sign out everywhere" includes the device that asked. `GET /api/session` also returns
  `mode`. The cross-site check applies in every mode.
- `LOGIN_EMAILS_PER_HOUR` defaults to 200. Password mode runs without migration 002.

R2 part 2 (2026-11-23: client sign-in in `public/`):
- A 401 asks `GET /api/session` for `mode`, then opens the password or the email prompt.
  A device already signed in from another tab gets no prompt.
- While a code is pending, `{requestId, email, expiry}` sits in `localStorage` for up to 15
  minutes (never the code or a token), so an iPhone home-screen app killed while the host
  reads mail reopens at the code step. Returning to the tab checks the session once; no timer.
- The `#login-` page takes the token out of the address bar at once and posts it only on
  the click. A link pasted into an open tab closes any email prompt and opens the page.
- A 403 sets `err.forbidden`, never prompts, and `SBS.handleForbidden` shows the message
  once and returns the server's copy. A 401 or 403 stops the auto-cutoff timer's retries.
- Home makes one session call and does not wait for it.

R2 part 3 (2026-11-23: escaping audit, Content-Security-Policy, body limit, script, CI):
- The audit read every `innerHTML` and `el(…, html)` in `public/`. Script injection was
  possible through winner names, live clock, period and score (player view), live score and
  player colors (grid), game dates, setup-form values and league, the score panel's period,
  and one error. All are fixed. A hostile `simPlan` could also write a bad live score,
  because the server adds its points up without validating again.
- `showAlert`, `showConfirm` and `showChoice` now take **text**, never HTML, so a missed
  escape in a message can't matter.
- `validateGame` holds each of those fields to an exact type. Numbers must be numbers, not
  numeric strings (no stored board had any). Player names that every object already has as
  a key (`__proto__`, `toString`) are refused. Live-feed fields are coerced at the source,
  so an odd value from the feed can't block a host's save.
- The policy is in `vercel.json` only, and `server.js` reads it from there. `style-src`
  keeps `'unsafe-inline'` for `style=""` attributes; `style-src-elem` does not, so
  current browsers refuse injected `<style>` blocks.
- A full simulated board measures 9.6 KB (12.8 KB with names in a three-byte script). The
  limit is 40 KB (28 KB before decision 019), and 4 KB for a score operation. Over it is 413.
- The Postgres tests in CI read the secret `TEST_DATABASE_URL` and are skipped without it.
