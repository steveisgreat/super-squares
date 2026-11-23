# 007 — Live scores refresh on read, not on a timer

**Date:** 2026-08 (recorded 2026-11-23) · **Status:** accepted; refined by
[001](001-score-providers.md) · **Source:** migration plan step 1.2

## Decision
There is no `setInterval` score poller: serverless has no long-lived process. A read of
`GET /api/game/:id` calls `refreshLiveScore(game, claimSlot)`. Real lookups are throttled
per game (about once per 20 s) by claiming the slot with a conditional store write before
the network call, so a roomful of polling phones triggers one lookup. Simulation mode is
a pure function of the wall clock and needs no throttle. Clients still poll every 8 s.

## Consequences
No provider traffic when nobody is watching a board. Decision 001 replaces the
per-board lookup with a shared per-league cache, and roadmap R8 moves the remaining
server-owned writes off the read path.
