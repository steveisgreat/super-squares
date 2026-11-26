# 027 — Admin usage page: who may see it, and the daily counters

**Date:** 2026-11-26 · **Status:** accepted (Steve approved the page design 2026-11-25 and the split
into R45a/b/c 2026-11-26); the server side (R45a) built 2026-11-26 ·
**Roadmap:** R45 · **Related:** 001 (feed failover, ≤4 calls a minute), 007 (no timers), 009 and 012
(auth modes), 023 (cached reads), 024 (consent columns)

## Context
Steve needs one page that shows how the whole site is used ahead of the launch on 2027-02-14: hosts,
boards, guests, which games, and whether the score feeds and Resend are holding up. Nothing records
outside calls today, and every existing route is scoped to one host or one board. The privacy page
says there is no analytics, and that must stay true.

## Decision

### 1. Access
- `#admin` and one route, `GET /api/admin/stats`, answered `no-store`.
- An admin is a host signed in **in accounts mode** with a current session whose email is in
  `ADMIN_EMAILS` (comma-separated, compared normalized). Unset means nobody.
- Password and off modes have no email to check, so nobody is an admin there, not even the "every
  request is the host" of off mode. Local checks of the page need accounts mode against a database.
- Every refusal is the same `403 Admins only.`, signed in or not, in every mode (misconfigured
  included), so the route does not say who is an admin. The check is route-level in `lib/api.js`
  (`isAdmin`), like every other rule (009, 012).

### 2. What it answers
- **Counts only**, worked out in `lib/admin-stats.js` (pure, shared by both stores and the tests) from
  the store's `adminFacts`: per board made in the range, its stage, league, date, teams, scoring,
  player picks, squares sold, distinct player names and distinct pick-device tags. Never a document,
  a square's owner or a payment mark.
- Host emails are masked (`j•••@gmail.com`). `?reveal=<host id>` answers one full email, so the page
  shows one at a time on a tap.
- Ranges: `7d`, `30d`, `season` (from September 1 ET). Days are ET calendar days.
- A guest is a distinct player name (trimmed, any case) across a host's boards; phones are distinct
  pick-device tags, on player-picks boards only. A real game is a Live board in a feed league,
  grouped by league, date and the two teams either way round; everything else is "Other or no game
  picked".
- "Live now" is a locked board whose game date is today (ET): an approximation that drops a game running past
  midnight ET and keeps a postponed one. "TVs paired" is pairings live now.
- Top referring boards are shown by join code, which can read that board: accepted, as only admins see
  it, and a code is already printed on the board's own QR sign.

### 3. Daily counters
- `usage_counters` (migration 012; `data/usage-counters.json` in the fs store): one row per UTC day and
  key, `calls`, `failed`, the busiest minute (`peak_minute`, kept by the same upsert) and `last_at`.
- One upsert per outside call, best effort: a failed count never fails the call, and without the
  table nothing counts. No timer, no cron (007).
- Keys: `feed:<provider>` per provider tried in a slate refresh (failed when it failed);
  `feed:fallback` when the answer came from a provider other than the first tried; `feed:down` when
  none answered (a server with no provider configured tries nothing and counts nothing);
  `mail:sent` per sign-in email sent through Resend (failed when Resend refused; a local console sign-in counts nothing); `mail:refused` per request our own
  limit refused; `login:code` and `login:link` per sign-in completed.
- Time on the fallback is estimated as fallback refreshes × the 15 s refresh interval: refreshes only
  happen while someone is watching, which is when it matters.

### 4. Split
- **R45a** (this entry): access, counters, the route. **R45b**: the `#admin` screen. **R45c**: the
  "where did you hear about us" question with `?src=` links (`hosts` columns, privacy text), and the
  Neon and Vercel cards with their keys (`NEON_API_KEY`, `VERCEL_API_TOKEN`); see section 5.

### 5. Where hosts heard about us, and the outside cards (R45c, 2026-11-26)
- `?src=<tag>` (1–32 of `a-z 0-9 - _`, lowercased; anything else dropped) is kept in the browser and sent
  with the sign-in request like `ref`; `login_requests.src` is copied to `hosts.src` on the first sign-in
  only (migration 013).
- `GET /api/session` answers `askHeard: true` for a signed-in host with no answer yet and no referral
  (a friend's board already says where they came from). The page asks once; `PUT /api/heard` takes one
  of `friend`, `search`, `video`, `group`, `ad`, `other` (with up to 80 characters of text) or `skip`, and
  the first answer stands. Accounts mode only. Hosts from before migration 013 are asked once too: only
  test accounts exist before R2.
- The stats add `heard` (answers, skips, from a friend's board, not asked yet, top 10 tags, the latest
  "something else" text), and Recent hosts' `from` becomes board, link tag or answer.
- **Outside cards.** `lib/admin-services.js` reads Neon (this period's compute and active hours, data
  moved and written, the default branch's size, last active) and Vercel (the production deployment's
  state, time and commit) with GET requests only, 4 s each, and passes on only those fields (Neon's
  answer includes the owner's email, which is dropped). No key: `null` and the card links to the
  dashboard; a failure: `{ ok: false }`, never a failed page. Row counts per table come from
  `pg_stat_user_tables` (no scan). **Neither provider offers a read-only key**, so the protection is
  scope: a Neon API key for this project only, a Vercel token for this team with an expiry, both on
  Production only and read only by the admin route.
- Not built: Vercel function metrics (Active CPU, calls, errors, cache share, p95, firewall blocks) need
  the observability query API, and Neon cold starts and the slowest query need `pg_stat_statements`;
  the cards link to the dashboards for those.

| Option | Why not |
|---|---|
| Page-view analytics (a script or a vendor) | Breaks "no analytics" on the privacy page; the counts we need are in our own data |
| A counter table per minute | 1,440 rows a day per key; one row per day with the busiest minute answers "peak against ≤4" |
| Admin in password mode | That mode has one shared password and no email, so anyone who can host could read every host's count |
| Full emails in the payload, masked in the browser | The page would hold every email at once; reveal-one keeps them out of a screenshot or a cache |

## Consequences
- Migration 012 adds a table only; applied to `ci-tests` 2026-11-26 (queries checked there); apply it to production before the push that ships R45a (runbook). Without it the
  page shows no service counts and nothing fails.
- Sums run in Node over small per-board facts, so a season is a few thousand short rows per request.
  If that grows too slow, move the sums into SQL behind the same `adminFacts` shape.
- `ADMIN_EMAILS` is a Vercel variable; changing who is an admin needs no deploy beyond the env change.

## Tests (required)
`test-admin.js`: 403 for a signed-out visitor and a non-admin host in accounts mode, for everyone in
password, off and misconfigured modes, for an old session and for an unset list; 200 `no-store` for an
admin; no full email in the answer and reveal for admins only; the sums (headline, funnel, games,
guests per host, how boards run, services, per day across a clock change); the slate refresh's counts;
the fs counters. `test-store-pg.js`: the upsert under concurrent calls and the board facts.

## As built (R45b, 2026-11-26)
- `public/screen-admin.js`, opened by typing `#admin` (nothing links to it). A 401, 403 or 503 shows one plain
  "This page is for the site admin." with a link Home, and nothing from the answer.
- Range picker (7 days, 30 days, Season), "Updated" time and Refresh; no polling. The shell and skeleton cards draw at
  once, with "Waking the database…" after 2 s.
- Cards in the roadmap's order; charts are inline SVG with a hidden table for screen readers; a game row opens its
  stages by click or keyboard; feeds over the 4-a-minute target are marked. "Where hosts heard about us" says
  "Coming with R45c", and Database and Hosting link to their dashboards.
- A masked email is a button: one full email on screen at a time, never stored in the browser.

