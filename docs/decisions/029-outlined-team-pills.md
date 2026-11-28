# 029 — Outlined team pills

**Date:** 2026-11-28 · **Status:** accepted (Steve chose style D from the mock 2026-11-28) ·
**Related:** 013 (team colors and logos stay in the app), 028 (square highlights)

## Context
Team pills (`teamBadge` in `public/ui.js`) were filled with the team's first color, which made a
row of headers heavy, and dark team colors (navy, midnight green) needed an extra edge to show on the
dark pages.

## Decision
- A team pill is **outlined**: no fill, a 2 px ring and the name in white (`--text-strong`).
- The ring color (`teamOutline`) is the team's first color when it has at least 2.2:1 contrast with
  the page, else its second color, else a light gray. A thin line needs more contrast than the
  old filled edge did, so Seattle is green, the Giants red, the Eagles silver.
- The logo keeps its round white disc with **no ring on the disc**. The ring is drawn (a
  `::before`) from the middle of the logo rightward, so its left end is completely hidden behind the
  logo and nothing stands outside the pill to be clipped by a `.badge-fit` container.
- With no logo shown (`mode-nologo`), the ring closes around the whole pill.
- Team fonts that arrive after the first fit are wider than their fallback, so `fitTeamBadges` runs
  again when fonts finish loading; otherwise a matchup that fitted could be cut off on a phone.

## Consequences
- Every pill (Game Day header, TV quarter chips, Party View, picking, the theme picker) changes at once.
- The board's axis team bars are not pills and stay filled.
