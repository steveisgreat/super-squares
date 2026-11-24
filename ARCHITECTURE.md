# Architecture — Super-Squares

Current state only. Reasons are in `docs/decisions/`; history is in `docs/archive/`.
Last checked against the code: 2026-11-23.

## Shape

One Node codebase, two deployment targets (decision 006):

| | LAN build | Cloud build |
|---|---|---|
| Entry | `server.js` (`npm start`, `start-app.bat`) | `api/[...path].js` (Vercel function) plus `public/` served statically (`vercel.json`) |
| Storage | `lib/store-fs.js`, one JSON file per game in `data/` | `lib/store-pg.js`, Neon Postgres |
| Selected by | `DATABASE_URL` unset | `DATABASE_URL` set |
| Auth | off (nothing set) | password (`HOST_PASSWORD`); accounts (`AUTH_MODE=accounts`) once R2 ships; never off |
| Extras | self-signed HTTPS and HTTP on one port, LAN IP discovery, `.bat` scripts | none; one public origin |

The same `lib/api.js` handles every `/api/*` request in both targets. It is
framework-free (`handleApi(req, res, pathname, query, getHostInfo)`) and imports nothing
LAN-only.

## Server modules

| File | Role |
|---|---|
| `lib/api.js` | Route table, guards (`denyUnlessSignedIn`, `denyUnlessOwner`), cross-site check, whole-game GET/PUT/POST/DELETE, ETag on game reads |
| `lib/auth.js` | Mode (`authMode`: accounts, password, off, misconfigured), signed cookies `sbs_session` (accounts) and `sbs_host` (password), sign-in tokens and codes, `identify(req)` (decisions 009, 012) |
| `lib/mailer.js` | The sign-in email, one `fetch` to Resend |
| `lib/store.js` | Storage contract and backend switch (decision 008) |
| `lib/store-fs.js`, `lib/store-pg.js` | The two backends; both apply auto-cutoff on read |
| `lib/version.js` | App version from `package.json`; adds `+<short hash>` on Vercel non-production |
| `server-livescore.js` | ESPN scoreboard lookup, `refreshLiveScore` (refresh on read, decision 007), `getTodaysGames` |
| `server.js` | LAN only: static files, certificate, single-port HTTP/HTTPS, host info |
| `scripts/poll-scores.js` | Probe for the score providers (decision 001); not part of the app |

## API

| Route | Access |
|---|---|
| `GET /api/session` | public; returns `authRequired`, `host`, `mode`, `version`, and `email` when an account is signed in |
| `POST /api/session` | password sign-in (password mode) |
| `DELETE /api/session` | sign out |
| `POST /api/login`, `POST /api/login/verify` | accounts mode: send the link and code; use either one |
| `POST /api/session/revoke-all` | accounts mode: sign out everywhere |
| `GET /api/game/:id` | public (the id is the read capability); refreshes live score |
| `GET /api/hosts` | public; LAN addresses, empty on Vercel |
| `GET /api/games` | host only; list summaries |
| `GET /api/todays-games` | host only; ESPN schedule for the setup screen |
| `POST /api/game`, `PUT /api/game/:id`, `DELETE /api/game/:id` | host only |
| `PATCH /api/game/:id/score` | host only; one manual-score operation (decision 011) |

"Host only" means the board's owner in accounts mode: another account gets 403, and the
list holds only the caller's boards. A foreign `Origin` on any write gets 403. A broken
sign-in setup gets 503, as does a Vercel deploy with no sign-in set up at all.

`PUT` sends the whole document with `updatedAt`; a stale `updatedAt` returns 409 with the
current document.

## Data

A game is one JSON document (the shape is built by `public/compute.js` and the setup
screen). Postgres: table `games (id uuid pk, doc jsonb, updated_at timestamptz)` with an
index on `updated_at desc` (`migrations/001_games.sql`, applied by hand, see runbook).
Accounts (`migrations/002_host_accounts.sql`): `hosts`, `login_requests`, and
`games.owner_id`, a nullable column that is never copied into `doc`. The store stamps `createdAt` and `updatedAt`.

## Client (`public/`, vanilla JS, no build step)

`index.html` loads plain scripts in order: `compute.js` (payout math, validation,
cutoff rules, shared with the server and unit-tested), `teams.js` (NFL/NBA names
and colors, no logos), `qrcode.js`, `core.js` (API client, routing, 401 sign-in replay), `ui.js`,
`players.js`, `board.js`, `score-panel.js` (manual score), then screens: `screen-home` (saved games, setup, version
footer), `screen-picking`, `screen-gameday`, `screen-phone` (score entry),
`screen-player` (read-only My Squares), and `app.js` (hash router: `#tv-<id>`,
`#score-<id>`, `#player-<id>`). Every polling screen refetches its game about every 8 s.
It is also a PWA (`manifest.webmanifest`, icons).

## External dependencies

- ESPN's unofficial scoreboard API (scores and schedule).
- Neon Postgres (cloud only). Resend for sign-in email (accounts mode only). Runtime packages: `@neondatabase/serverless`, `selfsigned`.
- Node 24.x (`engines`).

## Known gaps

No BRD, no CI, no end-to-end smoke test. Tests cover compute, both stores (Postgres
only when `DATABASE_URL` is set), auth, accounts, manual score and live score (`npm test`).
