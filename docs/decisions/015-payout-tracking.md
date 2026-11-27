# 015 — Payout tracking: a paid-out record, with "Needs settling" worked out

**Date:** 2026-11-24 · **Status:** accepted · **Roadmap:** R21 · **Related:** 004, 011

## Context
Hosts pay winners themselves, outside the app (decision 004: we never hold or move pool
money). R21 lets the host note which quarters they have paid, shows a "who to pay" list
when the game is over, and must catch the case where a quarter is paid and its result
then changes: a corrected score, a changed Total Pot, or an earlier quarter whose
rollover (carry) changes.

## Decision
- **Data shape.** The game document gains an optional `paidOut` object:
  `paidOut[q] = { name, amount, at }` for `q` in `q1`, `q2`, `q3`, `final`. It records
  who the host paid and how much, at the time they marked it. It holds no payment
  details and moves no money. `validateGame` checks it (quarter keys only, a valid player
  name, a whole number 0 to 1e9, an ISO timestamp). An emptied record stays as `{}`.
- **State is derived, never stored.** `GameLogic.payoutStatus(game)` compares each
  record with the current result from `computeGame`: `paid` when the winner's name and
  amount still match, `needsSettling` when they don't (or the quarter no longer pays
  anyone). The other states are `pending`, `pushed`, `needsDraw` and `unpaid`. Because
  the check runs on every read, every path that changes a result is covered: the score
  panel, the keypad, the live feed, the pot override, a draw, and carry from an earlier
  quarter. Matching by name means the same person winning on another of their squares
  stays paid.
- **Operations.** `PATCH /api/game/:id/payout` takes `{ op, quarter }`, plus the `name` and
  `amount` the host was shown for `paid` and `settle`. If the result moved since the
  screen drew (a feed update, another device), the op is refused (409) and the screen
  reloads, so a mark is never recorded against someone the host didn't pay. Host only, applied
  by the pure `GameLogic.applyPayoutOp` with the same bounded retry as `/score`
  (decision 011): `paid` (unpaid to paid), `unpaid` (undo a mistaken mark), `settle`
  (needs settling to paid to the current winner, or no record if the quarter owes
  nothing now). `paid` and `unpaid` are refused on a quarter that needs settling, so the
  only way out is the host saying it is settled.
- **Warning.** Before a change that would turn a paid quarter to needs settling, the
  score panel, the phone keypad, the Game Day keypad and the pot field confirm first
  (`GameLogic.paidQuartersDisturbed`). The live feed can't ask, so its changes simply
  show "Needs settling".
- **Who to pay.** At game over, Game Day lists each person and what's still owed. When
  the same person won but the amount changed after they were paid, only the difference
  counts (below zero reads "overpaid").
- **Who sees it.** Host screens only (Game Day, which includes the phone tabs). The TV
  and the player view never show payout state.

## Consequences
- No migration: `paidOut` lives in the game document.
- A paid record survives undo, a reset score or a pot change, and shows as "Needs
  settling" until the host acts. That is deliberate: forgetting a payment is worse than
  one extra tap.
- Renaming a player (the player window, 2026-11-26; Manage Players before) renames their paid-out records too, so a rename
  alone never reads as "Needs settling".
