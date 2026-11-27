# 026 — Editing a locked game: three lines, judged on the server

**Date:** 2026-11-25 · **Status:** accepted (Steve approved the design 2026-11-25); server rules built
2026-11-25 (R40); the form built 2026-11-26 (R41); unlock and wrong game built 2026-11-26 (R42); the players' list (R43) not built ·
**Roadmap:** R40–R43 · **Related:** 004, 007, 008, 011, 012, 015, 019, 020, 023, 025 (its host column in
section 1 is narrowed after lock, see section 2)

Mockup: the "Editing a locked game" design canvas (claude.ai artifact `JJmzusrbdA7Cro7XCiWWHo`,
private); local copy in `docs/working/mockups/edit-after-lock/` (git-ignored).

## Context
Edit game is closed once the numbers are drawn, so a typo in the price, the wrong live game or an
auto cutoff set to the wrong time can't be fixed. The rule lives only in the Home menu: the server's
`PUT /api/game/:id` accepts other drawn numbers, or a locked board put back to picking, and writes
without a version check when `updatedAt` is missing. The board's "started" status means locked, not
that the real game is on.

## Decision

### 1. Only the host edits, at every stage. Three lines close things off, in order
1. **Lock** (numbers drawn): squares, player picks, pick mode and Simulation are fixed. The numbers
   change only by Unlock.
2. **The game starts:** no Unlock, no redraw, no row/column swap.
3. **The first quarter ends** (a recorded result or a paid-out record): price and payout split are fixed,
   and nobody's squares can be removed.

### 2. Field by stage

| Field | Picking | Locked, before kickoff | Under way | Over |
|---|---|---|---|---|
| Description, colors, team spelling (same team), rename a person, paid marks, winner paid out | Free | Free | Free | Free |
| A different team (Manual) | Free | Warn | Warn: scores stay with that side | Warn |
| Rows and columns swapped | Free | Warn: every square changes meaning | Blocked | Blocked |
| Linked live game, and league, date and kickoff on a Live board | Free | Warn | Wrong game only (section 5) | Blocked |
| League (Manual) | Free | Free | Free | Free |
| Date (Manual) | Free | Free | Free | Free |
| Kickoff (Manual) | Free | Free | Warn: only with no score yet | No effect |
| Auto cutoff | Free; warn if already past | Hidden | Hidden | Hidden |
| Square price, payout split | Free; warn once anyone has paid | Warn | Warn until line 3, then blocked | Blocked |
| Total pot | Not shown | Warn: changes only the Final | Same | Same; Needs settling if the Final is paid out |
| Pick mode, player picks, limit | Free | Closed | Closed | Closed |
| Number draw (R46) | Free | Closed | Closed | Closed |
| Manual or Live scoring | Free | Warn | Warn either way; entered quarters stay. Live to Manual keeps the running score (the way out of a wrong or stuck feed; see the 2026-11-26 update) | Blocked |
| To or from Simulation | Free | Blocked | Blocked | Blocked |
| Drawn numbers | Not drawn | Unlock only | Blocked | Blocked |
| Add squares | Free | Blocked: unlock first | Blocked | Blocked |
| Move a square to someone else | Free | Warn | Blocked | Blocked |
| Remove a person's squares | Free; warn if paid | Warn: the pot goes down | Warn until line 3, then blocked | Blocked |
| Scores of ended quarters | Not yet | Not yet | Fix on the score pad (025) | Same |

No save may make a quarter's amount negative. Today a $100 pot on a $1,000 board shows a Final of -$500 and saves.

### 3. How "the game has started" is known
`GameLogic.gameUnderWay(game, now, feed)`: pure, worked out on each request, never stored.
- **Every mode:** any quarter result or paid-out record means yes.
- **Live:** the feed says in play, at a break or over; or a host-held score past 0–0 in Q1. A feed that says
  "not started" counts only if that reading was taken after the kickoff time. Otherwise (feed down or stale, game
  not matched) yes once the kickoff time has passed.
- **Manual:** a score above 0–0, a later period, or the kickoff time passed. The form gets a Kickoff field. With none,
  the game starts at the first score.
- **Simulation:** from the lock, because its plan starts then.

Line 3 needs no clock or feed: it is in the document, after the slate is merged as `/score` and `/payout` do.

### 4. The server decides; the form only shows it
`PATCH /api/game/:id/settings`, owner only (`denyUnlessOwner`; no helper job). A pure
`GameLogic.applySettingsOp(game, op, ctx)`, written with `updateGame` and bounded retries (008).

| Operation | Rules |
|---|---|
| `edit { set, saw, ack, marks }` | Only the changed fields, each with the value the host saw. A stored value that differs from `saw` is refused (409, naming the field). The server works out the warnings; one not in `ack` is refused with the list, so a board that crossed a line while the form was open asks again. `marks` (`keep` or `clear`) is required when the price changes and anyone is marked paid |
| `lock` | The server draws the numbers. Today the browser does |
| `unlock { ack }` | Section 5 |
| `relink { game, ack }` | Section 5 |

Total Pot moves from a whole-document save to `edit`. Guards on `PUT`, for screens that still use it and pages
cached from before:
- The stored document is read first, and a board that exists needs a matching `updatedAt`.
- A save that locks a board keeps none of the client's numbers: the server draws them.
- On a locked board the numbers, the status going back to picking, and every settings field above must match the
  stored ones. An empty square stays empty. Moving and removing follow the table. A rename replaces a
  name everywhere at once, and only the matching paid-out names may follow it.

### 5. Unlock and wrong game
- **Unlock** (before the game starts): throws the numbers away and opens picking again. Squares, paid marks and
  the player-picks setting stay, and helpers get their before-lock powers back (025). It turns auto cutoff off: otherwise the next read
  locks the board again. New numbers come at the next lock. Redraws are not limited; each is shown to everyone.
- **Wrong game** (Live): sets teams, league, date and kickoff together and clears the results, the score, a host-held score
  and any drawn final winner. Refused while a quarter is marked paid out, and once the board is final. If the new game has not started, the
  board is before kickoff again.

### 6. Money already collected
The app records which squares are paid, not dollars, so a price change rewrites what "paid" is worth. The warning gives the pot
before and after, and how many squares are paid at the old price. The host must choose to keep the marks and settle the difference, or
clear them. Winners paid before a change go to Needs settling by themselves (015).

### 7. Flow, and what players see
- Home ⋯ → **Edit game**, and Edit game on the picking screen and Game Day (a popup over the screen, since UI-E). Saving
  returns to where the host came from.
- Blocked fields show as text with the reason. Changes with no warning just save; the rest open one review sheet.
- A refused field asks "Keep theirs or use mine" for that field only, and the other edits stay. Today a stale form puts back
  every old value.
- **Changed by the host:** price, payouts, pot, swap, teams, live game and numbers drawn again are kept in `game.changes` (kind, from, to,
  time; last 5; exact types; only changes after the first lock) in the same atomic write. Player View lists them; the TV shows
  each for ten minutes, judged on read. It is public and separate from R39's host-only log.

| Option | Why not |
|---|---|
| Fix the money at kickoff | Typos get noticed when the board goes up on the TV, and kickoff is less certain than a recorded quarter |
| No unlock | A cutoff that fired early has no other fix; selling squares with the numbers known is unfair |
| Limit redraws | A limit stops honest fixes; showing each one is the control |
| Block only in the form | Stale screens and old cached pages would still write |

## Consequences
- No migration: everything is in the board document. No form-only rules.
- Accepted: a host who types the scores can undo a quarter or move the kickoff and reopen a line. That can't be policed. The rules
  stop accidents and stale screens; visible notices protect players.
- After line 3 a non-payer can't be removed (today it is only a warning).
- The app messages nobody: the host tells players about a change.

## Tests (required)
Test-first on `gameUnderWay` (each mode; feed down, stale, unmatched, postponed) and `applySettingsOp`: every row of the table at
every stage; a line crossed between read and write; `saw` and `ack` refusals; paid marks kept and cleared; no negative amount; unlock with a
past cutoff; wrong game with a quarter paid out. On the routes: owner only in all auth modes, helpers refused, foreign `Origin`; the `PUT` guards,
including a missing `updatedAt` and a lock from an old page; both stores.

## As built (R40, 2026-11-25)
- `public/compute.js`: `gameUnderWay`, `settingsStage`, `firstQuarterEnded`, `applySettingsOp` (`lock`, `edit`) and
  `guardPut`; tests in `test-settings.js` (the table at every stage, both stores, every auth mode).
- Warning codes in `ack`: `team`, `liveGame`, `swap`, `kickoff`, `cutoffPast`, `money`, `pot`, `scoring`. A swap is
  `set: { swap: true }` with the teams seen in `saw`. A team name change that is a spelling fix (case, spacing,
  punctuation, or the same team in the team list) is free.
- The negative rule refuses a save that makes the lowest quarter worse and below zero, so a board saved below zero
  before this can still be put right. It applies to settings edits and `PUT`, not to guests' picks.
- `game.changes` kinds: `price`, `payouts`, `pot` (the pot shown, before and after), `swap`, `teams` (Manual),
  `game` (Live: teams, league, date, kickoff) and `numbers` (for R42). The first lock writes none.
- Beyond section 4, `POST /api/game` (and a `PUT` that creates a board, in password and off modes) draws the numbers
  too when a board is created already locked. The cutoff lock on read was already the server's; it now draws with
  `crypto.randomInt` like the rest.
- The Total Pot box and Lock board call the new route; the confirm shows the server's warning.

## As built (R41, 2026-11-26)
- `public/screen-edit.js` is the one Edit game form, at every stage, picking included; every save is an `edit`. The
  setup screen makes new games only. It opens from Home, the picking screen and Game Day as a popup (UI-E, 2026-11-26: a
  720 px dialog from 768 px, a full-screen sheet below; it replaced the wide Game Day side panel). A poll or redraw
  under it never closes it or drops its changes.
- The form has no rules of its own: it runs `applySettingsOp` in the browser to learn what is blocked (and why), the
  warnings and a negative amount. The server still judges the save, with its own clock and feed reading.
- It keeps only the changed fields, each with the value on screen when first changed, so a board reloaded after a
  refusal can't turn a stale edit into a silent overwrite. A line crossed while the form was open drops that edit,
  says why and keeps the rest.
- A Live board's league, date, teams and kickoff change only together, by picking a game ("Change"), and a conflict
  over any of them is settled for all of them. Changing a date can no longer drop the kickoff or turn Live off.
- Not shown yet: the mockup's line that players see the changes (R43). Unlock and "Wrong game?" came with R42.

## As built (R42, 2026-11-26)
- `applySettingsOp` takes `unlock { ack }` (warning code `unlock`) and `relink { game, ack }` (warning code
  `wrongGame`, `game` = exactly `teamA`, `teamB`, `league`, `gameDate`, `kickoffTime`); tests in `test-settings.js`.
- Unlock: only at the `locked` stage (so never on Simulation, which is under way from the lock). It sets status to
  picking, clears the numbers, turns auto cutoff off and adds a `numbers` change (old numbers to null). The next
  lock, by any path (`lockGame`: the settings op, the cutoff on read, an old page's `PUT`), adds a second `numbers`
  change (null to the new numbers) when the last change is an unlock's.
- Wrong game: Live boards, locked or under way, never with a quarter paid out or once final; picking boards use
  Edit game. It clears the results (drawn winners with them), the score and a host-held score, resets the team
  colors, follows a description that only named the old game, and adds a `game` change. The same game is no change.
- Edit game: "Unlock and reopen picking" in Squares and numbers while locked; "Wrong game?" beside the live game
  under way, which opens the game picker. Each asks once in the server's words and saves on its own; unsaved edits
  in the form are dropped first, on a yes. The host log reads "Unlocked the board" and "Changed the live game".

## As built (R43, 2026-11-26)
- Display only; the server already wrote `game.changes`. The public board `GET` already carried it, so no `lib/` change.
- Player View (`public/player-home.js`): a "Changed by the host" card, newest first, one line and a time each (the date too
  when not today). An unlock followed by its redraw reads as one line, "Board unlocked; numbers drawn again"; an unlock not
  yet relocked reads "Numbers cleared (board unlocked)". Payout splits show as percentages.
- TV (`#tv-<id>`, `public/screen-gameday.js`): one line above the quarter strip for the newest change of the last ten
  minutes, with "+N more", judged on each poll against the TV's clock; it ellipsizes rather than wrap.
- A board with no changes (or, on the TV, none in ten minutes) draws nothing new.

## As built (R46, 2026-11-26)
A board setting **Number draw** (`numberDraw`: `quick` or `animated`; unset is `quick`) follows the pick mode row:
editable while picking and again after an unlock, fixed from the lock on. `lockGame` also writes `game.drawnAt` (ms) on
every lock, whichever path locks. It is server-owned: validated as a whole number, stripped on POST and create-by-PUT,
kept from the stored board on a PUT, refused if a locked board's PUT changes it, and deleted by unlock. With Animated,
every full-board render (Game Day, TV, Party View; `public/board.js`) shows "?" on the axes and reveals the server's
digits one at a time, columns then rows, 400 ms each (8 s). A screen that sees the lock in time keeps step with the
server's clock; one that sees it late (polls of 8-15 s plus the edge cache) but within 30 s, or whose clock runs behind
the server's, plays the whole reveal from the moment it saw it. Later screens show the finished axes. The start is kept
per tab in `sessionStorage`, so a reload carries on rather than replaying. A tap on the board or Escape skips it on that
screen; `prefers-reduced-motion` gets no animation. The browser never picks a digit. Not done: the Player View square
list shows the digit pairs at once (it has no grid), and the Final winner reveal is not reused.

## Update 2026-11-26: Live to Manual once the game is under way

"Pause live" is gone from the Score tab (decision 025 section 6), so Edit game is now the way out of a
feed that is wrong (the wrong game matched, a stuck score). Live to Manual is allowed with the
`scoring` warning while the game is under way, as Manual to Live already was, and blocked once it is
over. The host's pad starts from the score as it stands (a feed overtime period is capped at the one OT
period), and entered quarters stay. A Manual board shows no live strip and no MANUAL tag.
