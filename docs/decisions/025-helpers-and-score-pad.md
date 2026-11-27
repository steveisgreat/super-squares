# 025 — Helpers: two jobs on one board, inside Player View, and one score pad

**Date:** 2026-11-25 · **Status:** accepted (Steve approved the two-job design and mockup
2026-11-25); section 6 (the score pad, R36), the helpers and Score tab (R37) and the squares manager (R38) built 2026-11-25; recent changes (R39) built 2026-11-25. The points marked *(recommended)* in section 7 can still change ·
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
(`allowOwnerOrHelper(job)`), one check per route.

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
  *Update 2026-11-26:* one banner at the top of the Score tab says "Live scoring is Active / Paused /
  Down" (green dot, amber pause mark, red dot), with its one control beside it: "Pause live" (take
  over) or "Enable live" (back to the feed). Nothing sits under the score.
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

### 8. As built: R36 (2026-11-25)
- Operations may carry `from` (the score and period the screen showed; for `edit` the quarter's old score or
  null) and `undo` may carry `expect`. A mismatch is refused, so two devices never end two quarters and an
  undo never overwrites a score it has not seen. Without them an operation applies as before.
- With nothing left to undo from this screen, Undo offers the board's newest ended quarter and asks first.
- Taking a Live board over is an `add` of 0 points, so it starts from the server's copy of the feed.
- Game Day's phone page uses the wide quarters list (score, winner, Mark paid out, Fix). On Live and Simulation
  boards an open quarter has Enter, and Fix has Clear this score. After a clear the feed may fill it in again.
- The scorer phone (018) may draw the final winner from now on.
- The pad is hidden in Party View while the feed keeps the score, as before.

### 9. As built: R37 (2026-11-25)
- `POST /api/game/:id/helpers/:helper/code` makes a new code for the same helper (a phone swap, or the texted
  link). It cancels the waiting code; the old phone works until the new code is used. `token_hash` is nullable and
  cleared on use.
- The cap is 5 helpers a board, connected or not, so it can never be passed by redeeming codes. An unused code's row
  is dropped a day after it ended, and rows from before "sign out everywhere" when the next helper is added.
- `GET …/role` may answer `host` with the helper fields too, so an owner's phone that took a code still gets its tabs.
- Player View asks for the role only on a phone that took a code (a localStorage flag; never on a timer): on load,
  when the phone is shown again, on a tab tap and after a refusal. Guests make no extra call.
- Old `#score-<id>` links open Game Day (host), the Score tab (scorekeeper) or Player View. Old `#handoff-` links ask
  for a new code. The `/handoff` routes are gone.
- Steve, 2026-11-25: helpers keep their own numbers, and a helper need not be playing. The first tab is Player View
  as any player sees it (squares, numbers, status, winners, total won, own picks), and no job, switched off or ended,
  takes it away. A helper can be added under any typed label, before anyone has squares; on the phone "I'm not
  playing" is a choice like a name. The tab then reads **Board**. The choice can be changed there at any time; it is
  display only and authorizes nothing.
- "24 hours after the final" counts from the board's last save, so a late paid mark keeps a helper a little longer.

### 10. As built: R38 (2026-11-25)
- Every operation on a name carries what the screen shows: `have` (their squares) on all of them, `unpaid` (how many of those
  are not paid for) on `removeUnpaid`, `was` (how many are paid) on `paid`. Anything else now is refused (409), so a retry, a stale screen or two
  devices never claim, remove or mark twice. A claim of squares that are all already theirs, and a paid mark that is already so, count as done.
- `claim` adds to someone already there only by their exact name; a near-match (020's `nameKey`) is refused, naming them. New squares start unpaid,
  by 020's `hostAddSquares`. The board's pick mode holds; a player's own limit does not (it doesn't for the host either).
- `picks` takes either field alone, so one device's switch never puts back another's limit. The host's lift stays the host's.
- Remove unpaid asks first and has no Undo: a removed player-picked square loses its claim time and, with the last one, the phone that picked it.
  Paid marks and the picks switch have Undo, which is the opposite operation and is refused once the board moved.
- After an answer that never came, the add sheet closes and says to check the list: a second tap would count as a new request.
- Player View's tabs and welcome come from a list of jobs, so a job that ends takes only its own tab. Neither the operations nor the
  tab use the helper's own name or squares; a non-player works on a board with no squares yet. With both jobs, Continue opens Score once the
  board is started, else Players.

### 11. As built: R39 (2026-11-25)
- `GET /api/game/:id/changes` (owner only) → `{ changes: [{ id, at, helperId, label, text }] }`, newest first, at most 50.
  The list sits under the helpers on the Helpers screen, read when it opens and after the host changes a helper there.
- Recorded: each score and squares operation that wrote something, a helper added, joined, removed, or given other jobs.
  Not recorded: refused operations, ones that were already so (a repeated claim or paid mark), a new code, payout
  marks, whole-document saves, and "sign out everywhere" or a job ending by itself.
- Who: the helper whose job let the request in. A signed-in owner whose phone also took a code is the host. With
  sign-in off every device is the host, so there the helper cookie names the entry. A join is always the helper's.
- The text is written once, by `lib/changes.js`, with names as they were then; it is cut to 120 characters.
- The write is one awaited insert (with its trim) after the operation is stored, and it never throws. Without
  migration 011 nothing is written and the list is empty. The fs backend keeps `data/<id>.changes.json`.
- `useHelperToken` now returns the helper's `id` too.

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
