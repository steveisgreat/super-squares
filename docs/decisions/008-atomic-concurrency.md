# 008 — Optimistic concurrency is atomic inside the store

**Date:** 2026-08 (recorded 2026-11-23) · **Status:** accepted · **Source:** migration plan step 1.3

## Decision
`updateGame(id, game, expectedUpdatedAt)` checks and writes in one operation, never
read-then-write. fs does both in one synchronous run; Postgres uses one conditional
`UPDATE ... WHERE updated_at = $expected`. It returns `{ ok, game }`; `ok: false` is the
409 "changed on another device" path. Null `expectedUpdatedAt` means overwrite; a stored
document with no `updatedAt` also skips the check; `updateGame` upserts. The full
contract is the header comment in `lib/store.js`.

## Consequences
Two tabs editing one game still collide into the 409 path. The live-score slot claim
(007) reuses this same conditional write.
