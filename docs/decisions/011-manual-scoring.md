# 011 — Manual scoring is a per-game mode driven by score operations

**Date:** 2026-11-23 · **Status:** accepted · **Roadmap:** R3 (R4a builds on it)

## Decision
- Each game has `scoring`: `'manual'` (default for new games), `'live'` or
  `'simulation'`. A stored game with no `scoring` reads as `'simulation'` if
  `game.simulation` is set, else `'live'`, which keeps boards made before R3 unchanged.
  `GameLogic.scoringMode(game)` is the only place this rule lives.
- Manual games never call ESPN. `refreshLiveScore` returns early for them and never
  overwrites a manual `liveScore`.
- The manual current score lives in `game.liveScore` (`manual: true`, `state: 'in'`), so
  the TV highlight, live bar and My Squares view work unchanged. The live bar reads MANUAL
  and shows "updated N min ago".
- Every tap is one **operation**, sent to the host-only `PATCH /api/game/:id/score`:
  `add`, `set`, `end`, `final`, `undo`, `edit`. The server reads the current document,
  applies the op with the pure `GameLogic.applyScoreOp`, and writes with that document's
  `updatedAt`, retrying up to 3 times on a conflict. A malformed op returns 400, and an
  op not allowed in the current state returns 409. The client runs the same function
  for instant display.
- End Q1–Q3 copies the current score into that quarter. End Q4 on a tie goes to
  overtime (period 5), otherwise it acts as Final. Final writes `results.final` and
  finishes the game. Edit changes one ended quarter's result only. Undo reopens the last
  ended period. Scores are whole numbers from 0 to 999.
- A randomly drawn final winner (`results.final.autoResolve`) survives both Edit and
  Undo. `computeGame` ignores a draw whose key no longer matches, so Undo then Final can
  never re-roll a winner.
- In Manual mode, the Game Day quarter inputs are read-only; corrections go through Edit.
  Simulation can be chosen only before the grid numbers are generated.

## Why
Taps must not rewrite the whole document or collide with square picks. Pure transitions
are testable money logic (`test-score.js`).

## Not done
One overtime period only. Multiple OTs (NBA) end with "End OT" at whatever score stands.
Owner checks replace the host check in R2.
