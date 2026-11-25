# 023 — Board reads are cached at the edge

**Date:** 2026-11-24 · **Status:** accepted · **Roadmap:** R8 · Refines
[007](007-live-scores-on-read.md) and [001](001-score-providers.md)

## Decision
- **Two reads of one board.** `GET /api/game/:id` answers everyone alike and is kept by Vercel's
  edge: `Vercel-CDN-Cache-Control: public, s-maxage=3, stale-while-revalidate=2`. Nothing served
  is over about 5 s old. The browser is told to revalidate every time. `GET /api/game/:id?fresh=1`
  is never cached.
- **Screens that poll use the cached read** (`SBS.api.pollGame`). Opening a board, recovering from
  a refused save and checking before an undo use the fresh one (`SBS.api.getGame`). So does a phone
  that picks squares when it reloads.
- **A poll never takes a screen backward.** The tab remembers the newest version of each board it
  has been handed (writes return the new document) and drops an older poll for 12 s. After that an
  older board is real (a database restore) and is shown.
- **The cached read depends on nothing about the caller**: no cookie read, no `Set-Cookie`, no
  owner check. Giving an old board its join code moved to the fresh read.
- **The function never answers 304 on the cached read.** The edge forwards `If-None-Match` and
  does not keep a 304, so every poll would come through. The edge answers 304 to browsers itself.
- **No write per poll.** A simulated score is merged on read like a feed's, and its row is written
  only when a quarter completes.

## What stays on the read path
The roadmap said to move the remaining server-owned writes off it. The ones left are one-time:
the cutoff lock, and at most four quarter results per board. Moving them to a call made by the
clients would send one call per screen at the cutoff, where a cached read sends about one per 3 s.
Each is a conditional write, so running it twice does nothing. No timer or cron (decision 007).

## Measured (Vercel preview, iad1, Neon branch `ci-tests`, 2026-11-24, 60 s each)

| Pollers on one board | Polls | Function runs | One run per | Oldest view after a host's save |
|---|---|---|---|---|
| 8, every 4 s | 120 | 24 | 2.5 s | 3.3 s |
| 8, every 8 s | 60 | 19 | 3.2 s | 2.4 s |
| 40, every 4 s | 599 | 63 | 0.95 s | 2.7 s |

With `s-maxage=2, stale-while-revalidate=3` the first row was one run per 1.9 s. Polls that arrive
together while a copy is stale can each start a run (the edge does not collapse them), which is why
40 pollers cost more than 8. A cold board is never served stale: past 5 s the next poll waits for
the server.

## Consequences
- The cache is per region, so a board watched from several regions costs one stream per region.
- A deleted board can still show for about 5 s.
- `?fresh=1` is public, as every read was before. R11's alerts should watch its rate.
- Game Day, Party View and Player View now redraw when only a Live score moves. They compared
  `updatedAt`, which a merged score never changes, so the score stood still between saves.
