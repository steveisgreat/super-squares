# 025 — Helpers: two jobs on one board, inside Player View, and one score pad

**Date:** 2026-11-25 · **Status:** accepted (Steve approved the two-job design and mockup
2026-11-25); not built. The points marked *(recommended)* in section 7 can still change ·
**Roadmap:** R36–R39 · **Related:** 008, 009, 011, 012, 015, 016, 018 (its access and lifetime rules
are replaced when R37 ships), 019, 020

Mockup: the "Helpers and one score pad" design canvas (claude.ai artifact
`TxJaeNkrcqrnAe9WoKY99Z`, private); local copy in `docs/working/mockups/helpers/` (git-ignored).

## Context
A phone that takes a scorer code (018) becomes score entry and nothing else, so a scorekeeper loses
sight of their own squares. Only the host can collect money, add people, clear squares nobody paid
for, or change player picks. And there are several score windows with different controls: the
score panel (phone, Game Day, Party View strip), the phone keypad on `#score`, the narrow quarter
cards, the panel's Edit form, the wide quarter pencil, and the scorer's read-only page. The keypad,
the cards and the pencil on a non-manual board save the whole document instead of one operation.
Many helpers will never have seen the app.

## Decision

### 1. One concept, two jobs
A **helper** is a person the host gives a job on one board: **Scorekeeper**, **Squares manager**, or
both. The host can do everything. No account, and never a host session.

| Action | Host | Scorekeeper | Squares manager |
|---|---|---|---|
| Points, set, end, final, undo, fix a quarter | yes | yes | no |
| Take over from the live feed, resume it | yes | yes | no |
| Draw the final winner on an empty square | yes | yes *(recommended)* | no |
| Add squares for someone | yes | no | before lock |
| Remove unpaid squares | yes | no | before lock |
| Remove or move paid squares, rename | yes | no | no |
| Player picks on or off, limit | yes | no | before lock |
| Mark people paid or part paid | yes | no | yes |
| Lock, price, pot, payouts, teams, mark a winner paid out, helpers, delete | yes | no | no |

| Option | Why not |
|---|---|
| One Game Manager role with everything | Someone asked to keep score would also hold the money record |
| The scorekeeper also collects money | Different trust and a different time. The host ticks both jobs when one person does both |
| A permission switch per action | Too much to understand at a party |
| Removing non-payers stays with the host | It is the end of collecting; sending the helper back to the host defeats the job |

### 2. A job adds a tab, it never replaces the screen
The helper uses Player View with a bottom tab bar: **My squares**, plus **Score** and/or **Players**
for the jobs held. Player View stays public and needs no job; the tabs come from `GET …/role`. The
score shows in the header on every tab. The helper confirms whose squares are theirs once (or "I'm
not playing"). Opening a tab changes nothing on the server.

### 3. Assigning
Host: **Helpers** (Connect on a phone, a tab on wide Game Day) → a person, or "Someone else" → jobs
→ a one-time code. The list shows each helper, whether their phone is connected, a switch per job,
and Remove for that one helper. A job switched off ends at the next request. Helpers can be added
before lock, because a squares manager works while the board fills.

### 4. Identity, storage, lifetime
- **Same token and cookie rules as 018:** 32 random bytes each, SHA-256 stored, single use by one
  conditional update, token in the URL fragment and spent only on a tap, HttpOnly cookie scoped to
  `/api/game/<id>`, host `session_version` checked in the same query, modes kept apart.
- **Table `helpers`** (migration 010, adds only): `game_id` (cascade), `host_version`, `label` (at
  most 10 characters, for the host's list and the log), `can_score`, `can_squares`, `token_hash`,
  `token_expires_at`, `session_hash`, `created_at`, `used_at`. At most 5 connected phones a board.
- The label is **never** used to authorize anything and is not tied to the player's name or key.
- `scorer_grants` is left in place and unused after R37; a later migration drops it. A phone that
  holds a grant at the deploy needs a new code, so don't ship R37 on a game day.
- Lifetime: section 7. Judged at read time, no timers (007).

### 5. Writes: limited operations only
A helper never gets `PUT /api/game/:id`. Authorization stays in `lib/api.js`
(`denyUnlessOwnerOrHelper(job)`), one check per route.

- **`PATCH /api/game/:id/score`**: owner or scorekeeper. New operation `draw`: refused unless the
  final needs a draw; the server picks the square and stamps the time, so nobody's browser chooses
  the winner. The host's draw buttons use it too. A stored draw survives undo, as today (011).
- **`PATCH /api/game/:id/squares`** (new): owner or squares manager. A pure
  `GameLogic.applySquaresOp(game, op, ctx)`, written with `updateGame` and bounded retries like
  `/guest`: `claim { name, squares }` or `{ name, count, have }`; `removeUnpaid { name, have }`;
  `paid { name, paidSquares }`; `picks { on, max }`. Every rule, including "before lock" and "never a
  paid square", is checked in the document the write is conditional on. `have` refuses a retry or a
  stale screen. Paid rules are 020's (`unpaidSquares`, `paidSquareCount`).
- Host whole-document saves keep working; the client already re-applies one change after a 409 (019).

### 6. One score pad
One component, `score-panel.js`, is the only place a score is entered: helper's Score tab, host
phone, wide Game Day, the Party View strip's sheet, and taken-over live boards.

- Two team columns with labeled plays. NFL: Touchdown +6, Extra point +1, Field goal +3, 2-pt or
  safety +2. NBA: Free throw +1, Basket +2, Three +3. Other: +1. Tap the number to type it. No
  minus button: Undo or type.
- After a touchdown the Extra point button is lit. It is a hint, not a step.
- **One Undo** for the last thing done here, with a line saying what it was. It covers points, typed
  scores, ends, and fixes. After a change from another device it only offers what is still safe to
  undo (today's rule). Undo of a server result still uses the `undo` operation.
- Ending a quarter asks first and names the score, the winner and the amount. A tie after Q4 offers
  overtime. "Make this the final score" early stays, in a less prominent place.
- **Fix** on each ended quarter shows whether the winner changes, and keeps the paid-out warning (015).
- Live with the feed up: read-only, with "Enter the score myself". Feed down or taken over: the pad,
  with "Back to live". Simulation stays read-only.
- Keyboard letters on wide screens become Q W E R and U I O P, left to right down the buttons.

Removed: the `#score` screen and keypad (old `#score-` links open the board's Score tab or Player
View), the quarter score boxes, the panel's Edit form, the wide pencil form. Fixing a quarter on a
Live or Simulation board moves from a whole-document save to an operation, so `edit` must accept
those boards without taking the score over from the feed, and clear a quarter (today's blank
boxes). That is money logic: test-first.

### 7. Defaults that can still change *(recommended)*
1. **Lifetime:** a job ends when the host removes it, on sign out everywhere, 24 hours after the board
   is final, or 180 days after it was taken. (A board has no "finished at", so "24 hours after" is
   measured from its last save.)
2. **Text a link** as well as the QR: single use, 24 hours, and the host can cancel it. The QR stays
   at 5 minutes. A link can be forwarded; single use and Remove limit that.
3. **The scorekeeper may draw** the final winner (server-chosen).
4. **Recent changes:** a host-only list of who did what, in a new table (`board_changes`, migration
   011: board, time, helper id or null for the host, label, short text; last 50 kept per board). It
   records score and squares operations and helpers joining or leaving, not whole-document host saves. It
   is best effort: a failed log write never fails a score.

## Consequences
- **Deploy order:** migration 010 before R37; 011 before R39. Without them only helper features fail.
- The privacy page's scorer-cookie paragraph is rewritten for helpers (new cookie `sbs_helper`).
- Helper labels and log text are personal data: deleted with the board.
- Accepted risk: someone else can scan the host's code first. The host sees the phone connect and can
  remove it; a squares manager can't touch paid squares or anything after lock except paid marks.
- Accepted risk: a squares manager's paid mark is as trusted as the host's. The log shows who made it.

## Tests (required)
Test-first on `applyScoreOp` (`edit` on live and simulation, clear, `draw`), `inverseScoreOp` and
`applySquaresOp`. On the routes: each job is refused the other's operations and every host route;
another board's cookie; before-lock rules with a lock landing in between; paid squares never removed;
retries never claim or remove twice; token single use, expiry and cancel; a job switched off, remove,
sign out everywhere and the final each end access; all auth modes; foreign `Origin`; both stores.
