# Architecture — Super-Squares

Current state only. Reasons are in `docs/decisions/`; history is in `docs/archive/`.
Last checked against the code: 2026-11-25.

## Shape

One Node codebase, two ways to run it (decisions 006, 014):

| | Local dev | Cloud (the product) |
|---|---|---|
| Entry | `server.js` (`npm start`, plain HTTP on 127.0.0.1) | `api/[...path].js` (Vercel function) plus `public/` served statically (`vercel.json`) |
| Storage | `lib/store-fs.js`, one JSON file per game in `data/` | `lib/store-pg.js`, Neon Postgres |
| Selected by | `DATABASE_URL` unset | `DATABASE_URL` set |
| Auth | off (nothing set) | password (`HOST_PASSWORD`); accounts (`AUTH_MODE=accounts`) once R2 ships; never off |
| Reach | this computer only | one public origin |

The same `lib/api.js` handles every `/api/*` request in both targets. It is
framework-free (`handleApi(req, res, pathname, query)`).

## Server modules

| File | Role |
|---|---|
| `lib/api.js` | Route table, guards (`denyUnlessSignedIn`, `denyUnlessOwner`), cross-site check, whole-game GET/PUT/POST/DELETE, edge caching and ETag on game reads (decision 023) |
| `lib/auth.js` | Mode (`authMode`: accounts, password, off, misconfigured), signed cookies `sbs_session` (accounts) and `sbs_host` (password), sign-in tokens and codes, `identify(req)` (decisions 009, 012) |
| `lib/mailer.js` | The sign-in email, one `fetch` to Resend |
| `lib/store.js` | Storage contract and backend switch (decision 008) |
| `lib/changes.js` | The wording of the host's "Recent changes" entries (R39) |
| `lib/admin-stats.js` | The admin usage page's sums from the store's facts and daily counters (R45a, decision 027) |
| `lib/store-fs.js`, `lib/store-pg.js` | The two backends; both apply auto-cutoff on read (Postgres: only if the row is unchanged since it was read) |
| `lib/version.js` | App version from `package.json`; adds `+<short hash>` on Vercel non-production |
| `lib/scores/` | Score providers (decision 001): `espn.js` and `balldontlie.js` adapters, `index.js` (config, failover, no-backward merge, quarter completion), `slate.js` (the shared slate: one claimed refresh per league and date every 15 s, merge into a board, `listGames` for the picker) |
| `server-livescore.js` | Simulation scoring (`applySimulatedData`). Its ESPN lookup (`refreshLiveScore`, `findEvent`, `getTodaysGames`) is no longer called by the API and remains only for its tests |
| `server.js` | Local dev only: static files and the API on 127.0.0.1; sends the security headers it reads from `vercel.json` |
| `scripts/assign-owner.js` | One-off: gives boards with no owner to an account (runbook) |
| `scripts/poll-scores.js` | Probe for the score providers (decision 001); not part of the app |

## API

| Route | Access |
|---|---|
| `GET /api/session` | public; returns `authRequired`, `host`, `mode`, `version`, and `email` when an account is signed in |
| `POST /api/session` | password sign-in (password mode) |
| `DELETE /api/session` | sign out |
| `POST /api/login`, `POST /api/login/verify` | accounts mode: send the link and code; use either one |
| `POST /api/session/revoke-all` | accounts mode: sign out everywhere |
| `GET /api/game/:id` | public (the id is the read capability); cached at the edge up to about 5 s, the same for every caller (`?fresh=1` is never cached); a Simulation board merges its score; a Live board merges the shared slate into `liveScore` and adds a response-only `liveFeed: { available, fetchedAt }`; writes the game only when a quarter newly completes |
| `GET /api/games` | host only; list summaries |
| `GET /api/todays-games` | host only; the setup screen's schedule, read from the shared slate (no provider call of its own) |
| `POST /api/game`, `PUT /api/game/:id`, `DELETE /api/game/:id` | host only |
| `PATCH /api/game/:id/score` | host, or a scorekeeper helper of that board (decision 025); one score operation (decisions 011 and 025): `add`, `set`, `end`, `final`, `undo`, `resume`, `edit` (fix, fill in or clear a quarter; works on Live and Simulation without taking over) and `draw` (the server picks the final's stand-in winner). An optional `from` (or `expect` on `undo`) is what the screen showed; 409 if it moved |
| `PATCH /api/game/:id/squares` | host, or a squares manager helper of that board (decision 025); one squares operation, `claim`, `removeUnpaid`, `paid` or `picks` (`GameLogic.applySquaresOp`) → `{ game, name }`. Before lock only, except `paid`; 409 when a rule, or what the screen showed, no longer holds |
| `GET`, `POST /api/game/:id/helpers` | host only (decision 025); list → `{ helpers: [{ id, label, canScore, canSquares, connected, waiting }] }`; add `{ label, canScore, canSquares, link? }` → `{ id, token, expiresInSeconds }` (5 minutes, 24 hours with `link`); 409 at 5 helpers or a day after the final |
| `PATCH`, `DELETE /api/game/:id/helpers/:helper` | host only; switch the jobs, remove that helper → `{ helpers }` |
| `POST /api/game/:id/helpers/:helper/code` | host only; a new one-time code for that helper, cancels the waiting one |
| `GET /api/game/:id/changes` | host only (R39, decision 025); the board's last 50 score, squares and helper changes → `{ changes: [{ id, at, helperId, label, text }] }`, newest first; `helperId` null is the host |
| `GET /api/admin/stats` | admins only: accounts mode, `ADMIN_EMAILS` (R45a, decision 027); `?range=7d\|30d\|season` → counts with masked emails; `?reveal=<host id>` → `{ email }`; 403 for everyone else |
| `POST /api/helper` | anonymous; `{ token }` spends the code once, sets `sbs_helper` (180 d, `Path=/api/game/<id>`) → `{ gameId }`; 401 otherwise |
| `GET /api/game/:id/role` | public; `{ role: 'host' \| 'helper' \| 'none' }` for this device, plus `label`, `canScore`, `canSquares` on a helper's phone |
| `POST /api/tv` | anonymous; a TV asks to pair → `{ code, token }` (decision 017) |
| `GET /api/tv/:token` | the TV reads its pairing → `{ state: 'waiting', code }` or `{ state: 'paired', gameId }`; 404 unknown or expired |
| `POST /api/tv/pair` | owner of `gameId`; `{ code, gameId }` pairs a waiting TV and retires the code |
| `POST /api/tv/follow` | owner of `gameId`; moves all the caller's paired TVs to that board |
| `GET /api/tv/mine` | signed in; `{ count }` of the caller's paired TVs |
| `GET`, `PUT /api/theme` | host only; the caller's color theme → `{ theme }`; 400 unknown theme (decision 021) |
| `GET`, `PUT /api/news` | accounts mode, signed in; the caller's own next-season opt-in → `{ news }` (decision 024) |
| `GET /api/game/:id/theme` | public; the theme of the board's host → `{ theme }`; 404 unknown board |
| `GET /api/join/:code` | public; a join code resolves to `{ id }` (decision 016); 400 malformed, 404 unknown |
| `POST /api/game/:id/guest` | anyone with the board id; `{ name }` this device holds, sets `sbs_guest` (180 d, `Path=/api/game/<id>`) if it has none; 409 unless guest picks are on and the board is picking (decision 019) |
| `PATCH /api/game/:id/guest` | a device with that key; claim or release its own squares, one atomic write → `{ game, name }`; 400, 401 (never the host prompt), 409 with the current `game` |
| `GET /<code>` (6 characters) | static; serves `index.html`, which resolves the code and opens Player View |
| `PATCH /api/game/:id/payout` | host only; mark a quarter paid out, undo, or settle (decision 015); a record only, no money moves |
| `PATCH /api/game/:id/settings` | host only, never a helper (R40, decision 026); `{ op: 'lock' }` (the server draws the numbers) or `{ op: 'edit', set, saw, ack, marks }` (`GameLogic.applySettingsOp`). 409 with `code`: `illegal` (blocked at this stage, or a quarter would go negative; names the `field`), `conflict` (a value moved since `saw`), `unacked` (the `warnings` to confirm), `marks` (keep or clear paid marks); 400 `invalid` |

"Host only" means the board's owner in accounts mode: another account gets 403, and the
list holds only the caller's boards. A foreign `Origin` on any write gets 403. A broken
sign-in setup gets 503, as does a Vercel deploy with no sign-in set up at all.

`PUT` sends the whole document with `updatedAt`; a stale or missing `updatedAt` on a board
that exists returns 409 with the current document. `GameLogic.guardPut` then judges it against
the stored board (decision 026): a lock gets the server's numbers, and a locked board keeps its
numbers, status and settings, with squares moved or removed only as the stage allows.
`game.changes` is written only by the settings route. Game bodies over 40 KB and other bodies over 4 KB get 413.
`validateGame` (`compute.js`) holds every field that reaches markup to an exact type.

## Data

A game is one JSON document (the shape is built by `public/compute.js` and the setup
screen). Postgres: table `games (id uuid pk, doc jsonb, updated_at timestamptz)` with an
index on `updated_at desc` (`migrations/001_games.sql`, applied by hand, see runbook).
Accounts (`migrations/002_host_accounts.sql`): `hosts`, `login_requests`, and
`games.owner_id`, a nullable column that is never copied into `doc`. Later columns on `hosts`:
`referred_by` (migration 008), and the next-season opt-in and accepted Terms version (migration
009, decision 024). The store stamps `createdAt` and `updatedAt`.

Helpers (`migrations/010_helpers.sql`): `helpers`, one row per helper: label, two jobs, the one-time
code's hash, then that phone's cookie hash (decision 025). Without the table only helper features
fail. `scorer_grants` (006) is left in place, unused.

Recent changes (`migrations/011_board_changes.sql`): `board_changes`, the last 50 per board: time, helper id (null = the
host), the helper's label then, and a short text. Rows go with the board; writes are best effort. Without the table
the list is empty.

Live scores (`migrations/003_live_slates.sql`): `live_slates (league, et_date, payload jsonb, checked_at, fetched_at)`,
one row per league and ET date, shared by every Live board. `checked_at` is the throttle: a
request that finds it more than 15 s old claims the refresh with a conditional write
(`claimLiveSlate`, one winner in both stores), calls the providers, and saves the slate. The fs
backend keeps the same rows in memory. Nothing refreshes unless a request asks, so there is no
timer. A Live board merges its game from the slate on every read (`lib/scores/slate.js`) and is
written only when a quarter newly completes; a host-entered score (`liveOverride`) or result
always wins.

## Client (`public/`, vanilla JS, no build step)

`index.html` loads plain scripts in order: `compute.js` (payout math, validation,
cutoff rules, shared with the server and unit-tested), `teams.js` (NFL/NBA names
colors and ESPN logo URLs), `qrcode.js`, `core.js` (API client, routing, sign-in prompt by mode and 401 replay, 403 handling), `ui.js`,
`players.js`, `pinch-zoom.js` (pinch-to-zoom on the phone grids: a transform on the grid, state kept on the holder across redraws), `board.js`, `score-panel.js` (the score pad: the only place a score is entered; one Undo, End and Fix dialogs, keyboard scoring on a laptop), `players-tab.js` (Player View's Players tab, with the squares manager's controls), `present.js` (Present on an HDMI TV:
Party View in its own window, on the second screen when the browser can), then screens: `screen-home` (Home: top bar with New game and the account menu, Today / Coming up / Past games sections of cards with a primary button, Party View and a ⋯ menu, tiles for a TV browser; also setup and the version
footer), `screen-picking` (two columns from 1024 px, one below, three tabs on a phone; `players.js` has the Players card and payment box it shares with Game Day), `screen-gameday` (from 1024 px, not a phone: a tabbed panel left, the grid right, the page fitted to the window by `#app.fit-screen`; below that, the stat strip, grid, score pad and quarters list in one column),
`screen-edit` (Edit game, R41: the host's settings at every stage, opened from Home, picking and Game Day, in Game Day's panel on a wide screen; it saves only changed fields to `PATCH .../settings` and asks `applySettingsOp` what is blocked),
`player-home` and `screen-player` (Player View, a bottom tab bar: Home, Players, then Picks while players can pick or Live after the lock, plus Score for a scorekeeper; a squares manager edits in Players; who the phone is comes from its pick key, else a name chosen and kept on that phone), `screen-tvpair` (TV pairing and the Connect box),
`screen-admin` (`#admin`, the site owner's usage page from `GET /api/admin/stats`; nothing links to it; R45b, decision 027),
`screen-mirror` (Mirror mode for one phone, `#mirror-<id>`: TV-style board, score strip on tap; Player View opens the same screen read-only for guests, with no role check or strip),
`screen-helpers` (the Helpers panel: a dialog from Connect and Home, a tab on wide Game Day; the `#helper-<token>` page; where an old `#score-<id>` link goes), and `app.js` (hash router: `#tv-<id>`,
`#player-<id>`, `#helper-<token>`). Every polling screen refetches its game every 4 to 15 s through
`SBS.api.pollGame` (the edge's copy, never older than what the tab has seen); other reads use
`SBS.api.getGame` (`?fresh=1`).
Wide Game Day (`gd-wide`) and wide picking (`is-wide`) draw their grid with Party View's look: the board card
gets `.glass-board`, whose rules are shared with `.tv-screen` in `styles.css` (the sizes are the screen's own,
at the end of the file). `board.js` refits a holder marked `data-fit` when its room changes (`ResizeObserver`),
and `fitNames` covers `.glass-board` as well as `.pick-fill` and `.mirror-screen`.
`styles.css` sizes come from tokens at the top of the file: fixed font sizes `--fs-3xs`…`--fs-4xl`, radii
`--r-xs`…`--r-pill` (`--radius` = `--r-sm`), and theme-independent colors (`--plate`, `--text-strong`,
`--glass-fill`, `--glass-line`, `--silver`, `--bronze`). Fluid `clamp()` sizes on the TV and Party View, `em`
sizes, print styles and a few marked hero numbers stay literal.
It is also a PWA (`manifest.webmanifest`, icons).

`viewport-nudge.js` loads first, in the head. `el(tag, cls, html)` takes HTML, so callers
escape; `textEl`, `showAlert`, `showConfirm` and `showChoice` take plain text. The
Content-Security-Policy in `vercel.json` allows no inline script.

## External dependencies

- Score providers: ESPN's unofficial scoreboard API (primary) and BALLDONTLIE (secondary), reached only through `lib/scores/`.
- Neon Postgres (cloud only). Resend for sign-in email (accounts mode only). Runtime package: `@neondatabase/serverless`.
- Node 24.x (`engines`).

## Known gaps

No BRD, no end-to-end smoke test. CI (`.github/workflows/test.yml`) runs the tests; the
Postgres ones need the `TEST_DATABASE_URL` secret. Tests cover compute, both stores (Postgres
only when `DATABASE_URL` is set), auth, accounts, manual score and live score (`npm test`).
