# 016 — Join codes: a short read-only link per board

**Date:** 2026-11-24 · **Status:** accepted · **Roadmap:** R22 · **Related:** 009, 012

## Context
Guests open a board from a QR code or a long `#player-<uuid>` link. At a party people
also need a link they can type or read aloud, and the TV needs something to show before
the board locks so the room can join while squares are still being claimed.

## Decision
- **Format.** 6 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O/1/I/L), made on
  the server with `crypto.randomInt` (`lib/joincode.js`), shown uppercase and matched
  case-insensitively.
- **Storage.** The `games.join_code` column with a unique index (migration 004), never
  inside `doc`, like `owner_id` (decision 012). The fs backend keeps a `data/<id>.code`
  file beside the board. Game responses carry it as a response-only `joinCode`, and both
  stores remove it from every write.
- **Assignment.** New boards get a code when they're created. Older boards get one the
  first time their owner reads them, with no backfill. A collision is retried.
- **Access.** A code is a public read capability exactly like a game id (decisions 009,
  012). `GET /api/join/:code` returns only `{ id }` (400 malformed, 404 unknown), and a
  code never authorizes a write. `/<code>` serves `index.html` (the rewrite in `vercel.json`
  and the same pattern in `server.js`), and the client resolves it and opens the guest
  view.
- **Where it shows.** A join card with a **Share link** button (system share sheet, or
  copy the link) on the picking screen and Game Day. The TV shows a big join QR and the
  code while the board is picking. The guest view, the host's QR pop-up and the guest's
  QR all use the `/<code>` link.
- **TV rule.** The TV never shows who hasn't paid: no Unpaid Total and no unpaid marks on
  cells, before or after lock.

## Consequences
- **Deploy order:** every game read now selects `join_code`, so migration 004 must be
  applied to production **before** the push that ships this (runbook). The migration only
  adds, so applying it early is safe.
- **Guessing risk:** about 887 million codes; a hit reads one board, which is already
  readable by anyone holding its link. Accepted. Each guess costs a database query, and
  the per-IP firewall rule (R10) limits scanning.
- The Vercel rewrite pattern is checked only by the test; check `/<code>` on a preview
  before the push.
