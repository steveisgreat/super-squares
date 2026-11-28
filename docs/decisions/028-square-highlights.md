# 028 — Square highlights: yellow winners, dashed red for unpaid, quarter corners on phones

**Date:** 2026-11-28 · **Status:** accepted (Steve approved the mock 2026-11-28) ·
**Related:** 013 (team colors stay in the app), R22 (the TV never shows who has not paid), R47 (phone grids)

## Context
A square can carry several highlights at once: it won a quarter, its owner has not paid, or (on the
TV) it is leading right now. The winner frame took the theme's own color, the unpaid ring was red,
and the live pulse was red too. In Neon the winner color is hot pink, so a winner and an unpaid square
looked the same, and the live pulse always looked like an unpaid ring. On a phone, every winner showed
one corner triangle, so a square that won twice looked like one that won once.

## Decision
- **Won a quarter: yellow in every theme** (`--q-win`, `#ffd60a`, in `public/styles.css`): the frame,
  the Q badges and the TV and glass-board glow. `--winner` stays the theme's color for everything
  else (final standings, the draw reveal).
- **Not paid: a dashed ring in the theme's `--danger`**, plus a small red **$** tag in the
  bottom-left corner where the square is big enough. The two differ by shape as well as color.
  When a square won and is not paid, the red stays at the edge and the yellow frame steps inside it.
  Legend swatches are dashed to match.
- **Leading right now (TV): the pulse uses the theme's `--accent`**, never red or yellow.
- **Phone-width boards (under 480 px, and a phone on its side for the player view): one yellow
  corner per quarter won**: Q1 top-left, Q2 top-right, Q3 bottom-left, Final bottom-right; 10 px,
  or 9 px and 3 px in from the edge when the square is not paid, so they sit inside the red ring. A pushed
  quarter's corner is red. The $ tag is dropped there, since there is no room and the corners take all four.
  `board.js` adds the corners (`.qcorners`, hidden to screen readers; the badge text stays for them).

## Consequences
- Every theme reads the same way, and a theme can no longer pick a winner color that clashes.
- The picking board's unpaid ring is also dashed now, so "not paid" looks the same everywhere.
- The mock used to choose this is `docs/working/highlight-mock.html` (scratch, not committed).
