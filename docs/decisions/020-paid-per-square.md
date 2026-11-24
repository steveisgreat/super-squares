# 020 — Paid is per square, for every player

**Date:** 2026-11-24 · **Status:** accepted (approved by Steve 2026-11-24) · **Roadmap:** R31 · **Related:** 004, 019

## Context
Decision 019 gave names picked in Player View a part-paid count (`players[name].paidSquares`).
Names only the host had added kept the older rule, where paid belonged to the whole name:
someone paid for 4 who got 2 more unpaid squares showed as paid for 6 (under-collecting), and
someone owing for 4 who got 2 paid ones also showed as paid for 6. Players also pay in parts.

## Decision
- **One rule for every name.** Adding squares never pays for, or un-pays, the ones a name already
  had: "Already paid" speaks only for the squares being added (`GameLogic.hostAddSquares`).
- **The host can set how many squares are paid for** (`GameLogic.setPaidCount`): a name or its
  Part paid pill opens a stepper; the Paid and Unpaid pills still settle all or none. The save is
  refused when that name's squares changed since the host looked.
- **Whole squares only.** No dollar amounts; $15 at $10 a square cannot be recorded.
- The stored shape is 019's: `paid: true` alone for paid in full, `paidSquares` only for a
  part-paid name. No migration, and a saved board reads exactly as it did.

## Consequences
Which squares are outlined as unpaid is still derived (the oldest claims count as paid first), so
the outline can sit on a different square of the same name than the one the money was for.
