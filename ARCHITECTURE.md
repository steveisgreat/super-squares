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
| `PATCH /api/game/:id/score` | host, or a scorer phone of that board (decision 018); one manual-score operation (decision 011) |
| `POST`, `GET`, `DELETE /api/game/:id/handoff` | host only; make a one-time scorer code → `{ token, scorers, expiresInSeconds }`, count → `{ waiting, scorers }`, remove all scorer phones |
| `POST /api/handoff` | anonymous; `{ token }` spends the code once, sets `sbs_scorer` (24 h, `Path=/api/game/<id>`) → `{ gameId }`; 401 otherwise |
| `GET /api/game/:id/role` | public; `{ role: 'host' \| 'scorer' \| 'none' }` for this device |
| `POST /api/tv` | anonymous; a TV asks to pair → `{ code, token }` (decision 017) |
| `GET /api/tv/:token` | the TV reads its pairing → `{ state: 'waiting', code }` or `{ state: 'paired', gameId }`; 404 unknown or expired |
| `POST /api/tv/pair` | owner of `gameId`; `{ code, gameId }` pairs a waiting TV and retires the code |
| `POST /api/tv/follow` | owner of `gameId`; moves all the caller's paired TVs to that board |
| `GET /api/tv/mine` | signed in; `{ count }` of the caller's paired TVs |
| `GET`, `PUT /api/theme` | host only; the caller's color theme → `{ theme }`; 400 unknown theme (decision 021) |
| `GET /api/game/:id/theme` | public; the theme of the board's host → `{ theme }`; 404 unknown board |
| `GET /api/join/:code` | public; a join code resolves to `{ id }` (decision 016); 400 malformed, 404 unknown |
| `POST /api/game/:id/guest` | anyone with the board id; `{ name }` this device holds, sets `sbs_guest` (180 d, `Path=/api/game/<id>`) if it has none; 409 unless guest picks are on and the board is picking (decision 019) |
| `PATCH /api/game/:id/guest` | a device with that key; claim or release its own squares, one atomic write → `{ game, name }`; 400, 401 (never the host prompt), 409 with the current `game` |
| `GET /<code>` (6 characters) | static; serves `index.html`, which resolves the code and opens Player View |
| `PATCH /api/game/:id/payout` | host only; mark a quarter paid out, undo, or settle (decision 015); a record only, no money moves |

"Host only" means the board's owner in accounts mode: another account gets 403, and the
list holds only the caller's boards. A foreign `Origin` on any write gets 403. A broken
sign-in setup gets 503, as does a Vercel deploy with no sign-in set up at all.

`PUT` sends the whole document with `updatedAt`; a stale `updatedAt` returns 409 with the
current document. Game bodies over 40 KB and other bodies over 4 KB get 413.
`validateGame` (`compute.js`) holds every field that reaches markup to an exact type.

## Data

A game is one JSON document (the shape is built by `public/compute.js` and the setup
screen). Postgres: table `games (id uuid pk, doc jsonb, updated_at timestamptz)` with an
index on `updated_at desc` (`migrations/001_games.sql`, applied by hand, see runbook).
Accounts (`migrations/002_host_accounts.sql`): `hosts`, `login_requests`, and
`games.owner_id`, a nullable column that is never copied into `doc`. The store stamps `createdAt` and `updatedAt`.

Scorer phones (`migrations/006_scorer_grants.sql`): `scorer_grants`, one row per one-time
code, which becomes that phone's grant when used (decision 018). Only hashes are stored.

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
`players.js`, `board.js`, `score-panel.js` (manual score; keyboard scoring on a laptop), `present.js` (Present on an HDMI TV:
Party View in its own window, on the second screen when the browser can), then screens: `screen-home` (Home: top bar with New game and the account menu, Today / Coming up / Past games sections of cards with a primary button, Party View and a ⋯ menu, tiles for a TV browser; also setup and the version
footer), `screen-picking` (two columns from 1024 px, one below, three tabs on a phone; `players.js` has the Players card and payment box it shares with Game Day), `screen-gameday` (from 1024 px, not a phone: a tabbed panel left, the grid right, the page fitted to the window by `#app.fit-screen`; below that, the stat strip, score panel, quarter cards and grid in one column), `screen-phone` (score entry),
`screen-player` (Player View: pick while picking is open, then My Squares), `screen-tvpair` (TV pairing and the Connect box),
`screen-mirror` (Mirror mode for one phone, `#mirror-<id>`: TV-style board, score strip on tap),
`screen-handoff` (scorer-phone code and the `#handoff-<token>` page), and `app.js` (hash router: `#tv-<id>`,
`#score-<id>`, `#player-<id>`). Every polling screen refetches its game every 4 to 15 s through
`SBS.api.pollGame` (the edge's copy, never older than what the tab has seen); other reads use
`SBS.api.getGame` (`?fresh=1`).
Wide Game Day (`gd-wide`) and wide picking (`is-wide`) draw their grid with Party View's look: the board card
gets `.glass-board`, whose rules are shared with `.tv-screen` in `styles.css` (the sizes are the screen's own,
at the end of the file). `board.js` refits a holder marked `data-fit` when its room changes (`ResizeObserver`),
and `fitNames` covers `.glass-board` as well as `.pick-fill` and `.mirror-screen`.
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
