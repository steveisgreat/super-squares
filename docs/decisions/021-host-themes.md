# 021 — One color theme per host

**Date:** 2026-11-24 · **Status:** accepted (Steve chose the six themes and one per host, 2026-11-24)
· **Roadmap:** R33 · **Related:** 008, 009, 012, 017

## Context
Steve wanted a calmer palette and asked for all five proposals, plus today's, as a choice the
host makes once. A per-game or per-device setting was ruled out.

## Decision
- **Six fixed themes** (`GameLogic.THEMES`): `classic` (shown as "Neon", the default, with solid buttons),
  `cyan`, `blue`, `slate`, `indigo`, `emerald`. No custom colors. The colors are CSS tokens under
  `[data-theme]` in `styles.css`; adding a theme is a token block and an id.
- **One per host, for everything of theirs.** Every screen that shows a host's board (Game Day, Player View,
  Party View, a paired TV, a scorer phone) wears that host's theme. Team colors, gold winner colors and
  payment colors keep their meaning in every theme.
- **Storage:** table `host_themes` (migration 007), keyed by host id, or `site` in password and off modes
  where there is one host. Not a column on `hosts` (password mode has no host row) and not in a
  board's document (hosts PUT the whole document, and a theme is not per game).
- **Access:** `GET` and `PUT /api/theme` need a host session, and the key comes from the session, never
  from the request. `GET /api/game/:id/theme` is public, like the board: it says a color name and
  nothing about the host.
- **A board read is unchanged.** The theme is its own request, made once per page load, so polling
  and the game's ETag are not touched. A screen already open shows a change at its next load.
- If migration 007 is missing, reads answer `classic` and a change answers 503.

## Consequences
One extra small query per page load of a board. Every new color must be a token, or it will not
follow the theme.
