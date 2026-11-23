# 006 — One codebase, two deployment targets; storage behind an interface

**Date:** 2026-08 (cloud migration, recorded 2026-11-23) · **Status:** accepted ·
**Source:** `docs/archive/migration-plan.md` Phases 1–3

## Context
The app began as a LAN-hosted Node server saving one JSON file per game. It had to move
to Vercel + Neon without breaking the LAN build.

## Decision
One repo, two targets. Storage sits behind `lib/store.js` (five functions: `listGames`,
`getGame`, `createGame`, `updateGame`, `deleteGame`) with two backends: `lib/store-fs.js`
(JSON files in `data/`) and `lib/store-pg.js` (Neon Postgres, whole game as a `jsonb`
document). `DATABASE_URL` set selects Postgres; unset selects fs. `lib/api.js` is
framework-free and shared by `server.js` (LAN) and `api/[...path].js` (Vercel). LAN-only
code (self-signed certs, the HTTP/HTTPS single-port multiplexer, `localIPs()`, the
`.bat` scripts) stays in `server.js` and never loads in the cloud path.

Other consequences recorded at the time: the whole-document model means no
field-by-field schema; Node is pinned in `engines`; the QR and link generators fall
back to `location.origin` when `/api/hosts` reports no addresses; existing `data/*.json`
was test data and was not migrated.

## Risks accepted
- Vercel Hobby is non-commercial only. Selling the app needs Pro (roadmap R7).
- Neon free tier suspends after about 5 minutes idle and the first query pays a cold
  start. No keepalive pings (global rule); paid autoscaling is R7/R11.
- ESPN's endpoint is unofficial and is now called from Vercel's shared IPs (see 001).
