# 010 — Ported to the RileySoft model

**Date:** 2026-11-23 · **Status:** accepted · **Roadmap:** R0

## What changed
- Profile: **hosted app** (Vercel + Neon, plus a LAN build from the same code).
- Added `CLAUDE.md`, `ARCHITECTURE.md`, `docs/runbook.md`; decisions 002–010.
- `MIGRATION-PLAN.md` moved intact to `docs/archive/migration-plan.md`; its lasting
  decisions are 006–009.
- Version shown in the Home footer, from `package.json` via `lib/version.js`, served on
  `GET /api/session`. Preview builds add `+<short hash>` from `VERCEL_GIT_COMMIT_SHA`.
- GitHub labels `feature`, `idea`, `chore`, `S1`–`S3` and issue templates added.

## Not done (follow-ups)
- **Layout:** code stays at the repo root (`lib/`, `api/`, `public/`, root `test*.js`),
  not `src/`. Vercel's `api/` and `public/` conventions and the R3/R4 work in `public/`
  make a move costly now; revisit at a milestone checkpoint.
- **No BRD:** reconstruct one (roadmap IDs stand in until then).
- **No CI** (`.github/workflows`), no smoke test, no `.gitattributes`/`.editorconfig`,
  no version-matches-build test (the project rule is no tests unless asked).
- **README** still describes the LAN-only app; its ESPN logo text goes stale after R4.
