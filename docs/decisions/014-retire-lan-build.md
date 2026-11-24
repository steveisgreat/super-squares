# 014 — Retire the LAN build

**Date:** 2026-11-24 · **Status:** accepted (Steve's call, 2026-11-24: "Yes, retire it") ·
**Roadmap:** R27 · **Partly supersedes:** 006

## Context
Decision 006 kept a LAN build alive beside the cloud app: self-signed HTTPS, LAN IP
discovery, `.bat` start/stop scripts and a README for running a game over home WiFi. The
product is now the hosted app, sold for the 2027-02-14 game. The LAN build was extra
code and docs to carry, a second set of phone-link tips in the UI (R18), and a
`selfsigned` dependency, for a product we no longer ship.

## Decision
The LAN build is retired. The cloud app (Vercel + Neon) is the only product.

Removed: the certificate code, the HTTP/HTTPS single-port multiplexer, `localIPs()`, the
three `.bat` scripts, the `selfsigned` dependency, the `GET /api/hosts` route with its
three client callers (the QR and link pop-ups now always use `location.origin`), and the
LAN README.

Kept from 006: one code path, and storage behind `lib/store.js` with the fs and Postgres
backends. `npm start` still runs `server.js`, now a plain `http` server bound to
`127.0.0.1` (port from `PORT`, default 3000) for local development, the preview pane and
tests. It uses fs storage, and auth stays off there unless configured (decision 012).

## Consequences
- Runtime dependencies drop to one (`@neondatabase/serverless`).
- `lib/` and `api/` must work on Vercel and under the local dev server; nothing is
  LAN-only any more.
- A phone can't open the local dev server. Test phone flows on a Vercel preview.
- The pre-cloud LAN version stays available at the git tag `local-lan-v1`.
- Decisions 006, 009 and 012 still mention the LAN as history; they are not rewritten.
