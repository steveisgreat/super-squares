# Super-Squares

A football/basketball squares-pool web app: hosts create boards, players claim squares,
scores pay out per quarter, a TV view shows the grid. Being readied for public sale for
the NFL championship game on **2027-02-14** (`docs/ROADMAP.md`).

**Profile: hosted app** (Vercel + Neon). The LAN build was retired
(decision 014). The global `~/.claude/CLAUDE.md` and the `project-docs` skill apply;
this file overrides them where they differ.

## Stack and commands

Node 24, no build step, vanilla JS front end in `public/`, one runtime dependency
(`@neondatabase/serverless`). Branch is **`master`**, not `main`.

| Task | Command |
|---|---|
| Run locally (dev server, fs storage, 127.0.0.1) | `npm start` (port 3000) |
| All tests | `npm test` (Postgres tests skip without `DATABASE_URL`) |
| One suite | `npm run test:store`, `test:auth`, `test:accounts`, `test:livescore`, `test:store-fs`, `test:store-pg` |
| Preview pane | `preview_start` with name `super-squares` (`.claude/launch.json`) |

Details for env vars, deploy and rollback: `docs/runbook.md`.

## Where to look

| Question | Document |
|---|---|
| What's next? | `docs/ROADMAP.md` (Now, Later, open questions) |
| Why is it built this way? | `docs/decisions.md` index, entries in `docs/decisions/` |
| What shape is the system? | `ARCHITECTURE.md` |
| How do I deploy, configure, roll back? | `docs/runbook.md`, `.env.example` |
| Live-score provider design | `docs/decisions/001-score-providers.md` |
| Research notes (score-feed probe) | `docs/research/` |
| How do I run it locally? | `README.md` |
| Old migration plan, retired notes | `docs/archive/` (grep it, never read it whole) |
| Scratch: briefs, ledgers, probe logs | `docs/working/` (git-ignored) |

There is no BRD yet; roadmap items (R0…R17) stand in for requirement IDs. Intake is
GitHub Issues on `steveisgreat/super-squares` (labels `bug`, `feature`, `idea`, `chore`,
`S1`–`S3`).

## Project rules

- **Pushing `master` deploys production.** Never push, reset or force-push it without
  Steve's word. Sessions commit locally only when asked.
- **No tests unless asked** (project memory). Exception: money logic in
  `public/compute.js` is test-first, and a fix to a bug found in review keeps its
  regression test. Never delete or skip a test to get green.
- **One code path.** Anything under `lib/` or `api/` must work on Vercel and under the
  local dev server (`server.js`, localhost only). No LAN-only code (decision 014).
- **Storage goes through `lib/store.js` only.** Never read `data/` or call Postgres
  from a route. `updateGame` is the one atomic check-and-write (decision 008).
- **Authorization is route-level** in `lib/api.js` (`denyUnlessSignedIn`,
  `denyUnlessOwner`), never in the store. A game id is a read capability only
  (decisions 009, 012). With nothing set, auth is off off-Vercel only, and local dev
  must keep working that way. `owner_id` is a column, never in `doc`.
- **Never add a keepalive, cron ping or poller** for Neon. Design for the cold start
  (global rule). No timer-based server work: Vercel has no long-lived process
  (decision 007).
- **Secrets:** `.env.local` holds the real Neon string and is ignored; only
  `.env.example` is committed. Never print or commit real values.
- **No NFL marks in marketing** (decision 005): it says "the Big Game". Team names,
  colors and logos stay in the app (decision 013: ESPN logo CDN, helmet fallback). **We never hold or move pool money** (decision 004).
- **New dependencies** need a stated reason and a decision entry (global rule).
- **American English** everywhere. Client code is plain scripts loaded in order from
  `public/index.html`; keep that shape, no bundler.
- **Version** comes from `package.json` only (`lib/version.js`, shown in the Home
  footer). Bump it in `package.json` at a release, never by hand elsewhere.
- **Migrations only add** (expand, then contract). Apply by hand per the runbook.
- **Verify UI changes in the browser** at about 1366 px and 1920 px (DOM evidence), and
  check the TV view (`#tv-<id>`) when the board changes.
- **Same commit:** a change and the doc it affects land together. Decisions are numbered
  and never renumbered; add the index row in `docs/decisions.md`.

## Layout note

Code sits at the repo root (`lib/`, `api/`, `public/`, `scripts/`, `migrations/`,
root `test*.js`) rather than the standard `src/` layout. Moving it is deferred
(decision 010); do not reorganize as a side effect of other work.

## Model tiers for this repo

Money logic, auth and migrations: Opus (review at `/code-review high`). UI and routine
features: Sonnet. Copy and mechanical edits: Haiku. Roadmap items carry their tier.
