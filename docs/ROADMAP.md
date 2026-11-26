# Roadmap — Super-Squares

**Goal:** launch Super-Squares to the public as a hosted web app, free this season, in
time for the NFL championship game on **2027-02-14**. Exposure comes first; paid passes
start in 2027–28 ([decision 022](decisions/022-postseason-pass.md)). Written 2026-11-23 from a design
session; Steve owns the order.

**Profile:** hosted app (recorded in `CLAUDE.md`; decision 010).
There is no BRD yet, so items cite this roadmap's IDs instead of FR IDs.

**Standing decisions from the 2026-11-23 session** (decisions 001–005 in `docs/decisions/`):
- **Web app first.** No native iOS, Android or Apple TV app before 2027-02-14.
  Phone wrappers are reconsidered after (see Later).
- **The host pays; players never do, and 2026–27 is free.** The launch season is free for
  every host, with next year's price announced from day one: from 2027–28 the regular
  season stays free, postseason boards are free up to 10 players, and one **$7.99**
  Postseason Pass per host covers the rest
  ([decision 022](decisions/022-postseason-pass.md)). Every board keeps the "Host your own
  board" footer.
- **We never hold or move pool money.** We sell software. Terms of Service say
  "entertainment and tracking only".
- **No NFL marks in marketing.** Marketing says "the Big Game", never "Super Bowl".
  Team names, colors and logos stay in the app (decision 013 restored the logos,
  accepting the trademark risk).
- **Manual scoring is the launch default; Live mode uses two providers.** A
  primary and a secondary score API (ESPN, with BALLDONTLIE
  as backup) feed one shared cache, so
  call volume doesn't grow with the number of boards
  ([decision 001](decisions/001-score-providers.md)).

---

## Now

### Milestone 1 — Launch blockers (target 2026-12-21)

**R0. Port to the RileySoft model** — `Sonnet` — ✅ shipped 2026-11-23.
Run the `port-project` skill: `CLAUDE.md` with profile and where-to-look table,
decisions 002–005 for the other standing decisions above (001 exists), `ARCHITECTURE.md`,
`docs/runbook.md`, version visible in the footer. Folds `MIGRATION-PLAN.md`
into decisions and archive.
*Done:* CLAUDE.md under 15 KB, decisions 002–005 written, version shows in the app.

**R1. Host accounts design** — `Opus` — ✅ approved 2026-11-23 ([decision 012](decisions/012-host-accounts.md)).
Replace the single `HOST_PASSWORD` with one account per host: magic-link email
sign-in (Resend), `games.owner_id`, `GET /api/games` scoped to the owner,
every write checked against the owner. Keep the LAN build working with auth off.
Choose library vs. the existing signed-cookie code (new dependency rule applies).
*Done:* decision entry approved by Steve, with the schema migration and the
endpoint access table.

**R2. Host accounts build** — `Opus` — Depends on: R1 ✅, R16 (sending domain; code
can start before it, going live can't).
Implement [decision 012](decisions/012-host-accounts.md) in its order of work: emailed
link and 8-digit code, `games.owner_id`, fail closed on Vercel. Includes the
output-escaping audit and Content-Security-Policy (strangers become hosts), a GitHub
Actions workflow (the repo has no CI), and R10's firewall rule. Existing games get
assigned to Steve's account by script. Large: plan 2–3 sessions.
*Done:* tenant-isolation tests pass in CI (host A cannot list, read-for-write,
edit or delete host B's games); `/code-review high` clean.
*Progress:* part 1 done 2026-11-23 (migration 002, store scoping, sign-in and owner
checks on the server, mailer, tests; see the decision's build notes). Part 2 done
2026-11-23 (client sign-in: email and code prompt, `#login-` page, sign out everywhere,
403 handling). Part 3 done 2026-11-23 (escaping audit, stricter board validation,
Content-Security-Policy, 28 KB game limit, `scripts/assign-owner.js`, CI workflow, privacy
draft). Not live: `AUTH_MODE` stays unset. `TEST_DATABASE_URL` set 2026-11-24 (Neon
branch `ci-tests`; the Postgres suites passed there). Left: the first CI run after a push,
then going live (runbook, "Turn on host accounts") once R16 is done.

**R3. Manual current score** — `Sonnet` — ✅ shipped 2026-11-23 ([decision 011](decisions/011-manual-scoring.md)); R2 later swaps its
host check for an owner check.
- Scoring mode per game in Setup: **Manual** (default), Live, Simulation.
  Manual never calls ESPN.
- Current score panel on Phone Score Entry and Game Day: full score per team
  with quick buttons (NFL `+7 +6 +3 +2 +1 −1`; NBA `+1 +2 +3 −1`; Other `±1`
  plus typed entry) and the current quarter. It writes `game.liveScore`
  (`state: 'in'`, `manual: true`), so the TV running highlight
  (`computeLiveHighlight`), live bar and My Squares view work unchanged.
- "End Q1 / End Q2 (Halftime) / End Q3" copy the current score into that
  quarter's result and advance the period. "End Q4" on a tie goes to overtime;
  "Final" sets the final result and finishes the game. Warn if the current
  score is below an ended quarter's.
- Fixing mistakes: "Edit score" on any ended quarter changes only that
  quarter's result (recalculates winners and rollovers, leaves the current
  score); "Undo end of quarter" reopens the last ended quarter.
- New host-only `PATCH /api/game/:id/score` so taps never rewrite the whole
  document or collide with square picks.
- Live bar reads **MANUAL** and shows "updated N min ago".
*Done:* tests for the quarter-end, undo, edit and overtime state transitions
(money logic, so test-first); browser check of TV, phone and My Squares views.

**R4. Remove NFL logos** — `Haiku` — ✅ shipped 2026-11-23; reversed 2026-11-24 ([decision 013](decisions/013-team-logos-restored.md)): logos are back.
Drop the ESPN logo CDN; keep team colors and abbreviations with the generic
badge.
*Done:* no request to any logo CDN during a full game; browser check of TV,
grid and setup.

**R4a. Score provider layer and shared cache** (part 1, adapters and failover in
`lib/scores/`, done 2026-11-23; part 2, the `live_slates` table, slate refresh, merge on read,
fallback panel and picker, built 2026-11-24; `/code-review medium` done 2026-11-24 with its
fixes: write paths survive an unreadable slate and answer with the feed status. Left: the provider
keys (Steve), and a date window on the setup picker's refresh, which Steve decides) — `Sonnet` (design done in
[decision 001](decisions/001-score-providers.md)) — Depends on: R3 ✅ (the
`scoring` field, `GameLogic.scoringMode`), probe fixtures.
Adapters for ESPN (primary) and BALLDONTLIE (secondary) behind one `LiveGame` shape;
`SCORE_PRIMARY` / `SCORE_SECONDARY` with failover; `live_slates` table and
fs equivalent; one claimed refresh per league and date every 15 s; boards merge
the slate into `liveScore` on read and write only on quarter completion; the
"live feed unavailable" fallback to the manual panel; `/api/todays-games` reads
the slate. Probe findings and API call details:
`docs/research/2026-11-23-score-feed-probe.md`.
*Done:* fixture tests from the 2026-11-23 probe for both adapters, failover (with no
backward step on a provider switch),
quarter-end detection with and without `period`, host-wins, and claim
concurrency in both stores; `/code-review medium` clean; a simulated 50-board
run makes ≤4 provider calls a minute.

**R5. Payments** — moved to Later (2026-11-24, decision 022: 2026–27 is free).

**R6. Legal and trust pages** — `Sonnet` — drafted 2026-11-23, **not done**: needs
Steve's and a lawyer's review, and the bracketed placeholders filled (name, company,
support email, state; R16). Pages carry a draft banner and `noindex`.
Terms of Service (entertainment and tracking only, no pot handling), privacy
policy, contact/support email, footer links. Draft only — Steve reviews with a
lawyer.
Also: first sign-in asks the host to accept the Terms ("By signing in you agree to the
Terms and Privacy Policy", with links), and we record which version they accepted and
when (a column on `hosts`, migration). Wording follows the lawyer review. Auth code:
Opus review. The notice and the record are built (2026-11-25, with R34,
[decision 024](decisions/024-consent-at-sign-in.md)); left: the reviewed wording, then set
`TERMS_VERSION` in `lib/auth.js` (a `draft-` version today).
*Done:* pages live on preview; lawyer review booked (Steve).

**R7. Accounts and plans** — `Steve` — Depends on: none.
Vercel Pro (Hobby forbids commercial use), Neon paid plan with autoscaling for
game day, Resend (free plan now, for sign-in email; its 100 emails a day cover the soft
launch). The Stripe account and optional LLC wait for R5. The domain moved to R16. **By 2027-02-01:** move
Resend to the paid plan, before launch-week sign-ups pass the daily limit.
*Done:* all accounts exist; Resend is on the paid plan by 2027-02-01.

**R16. Name and domain** — `Sonnet` research, `Steve` buys — Depends on: none.
Research notes are private (git-ignored):
`docs/working/research/2026-11-23-name-and-trademark.md`. Don't copy them into this
public repo.
**Blocks R2** (magic-link email needs a verified sending domain), **R5** (Stripe
needs a business website) **and R17.**
Trademark knockout search on the name (GleanMark connector needs `/mcp` sign-in)
and a domain shortlist with availability and prices (Vercel domain tools).
Steve picks and buys. Then DNS: the apex for the website (R17), `app.` for the
app, and `support@` plus the email-sending records (Resend: SPF, DKIM, DMARC).
Production loses Vercel Authentication on the custom domain so guests can open
board links.
*Done:* domain bought; `app.<domain>` serves production over HTTPS without a
Vercel sign-in; Resend shows the domain verified; runbook updated.

**R17. Marketing website** — `Opus` plan, `Sonnet` build — Depends on: R16, R6.
A second profile (**website**) beside the app. First a short decision: where it
lives (same Vercel project as static pages vs. its own repo) and whether to use
the RileySoft standard UI. Then the website Phase 1 (audience, message, pages,
calls to action) and mockups of the home page for Steve's approval. Pages: home
with the TV-view demo, how it works, pricing (decision 022), FAQ, legal (R6),
the search pages from R12, and "Start a board" into the app. No NFL marks.
**Live by 2027-01-04** so search engines index it before the playoffs.
*Done:* mockups approved; site live on the apex domain; Lighthouse, link check
and accessibility pass in every look; version in the footer and `<meta
name="version">`; Search Console set up and pages submitted.

### Milestone 1b — Game-night experience (target 2027-01-10)

From the 2026-11-24 flow review: Steve's game flow (sign up → set up → fill grid and
collect → lock → watch → score → pay out, plus s1 remove player, s2 mark paid, s3 feed
down) across phone (iPhone and Android), iPad, PC/laptop and TV, live and manual.
Mock: the "Super-Squares flow redesign mock" design canvas (claude.ai artifact
`EdFD9pgkFqqtHXdzQgiQmv`, private), with a device map of which screens get their own
layout. The phone is the baseline (every screen works at 360 px); iPad and laptop get
their own layouts only around the grid; the TV only shows boards. The order below is
Steve's call (2026-11-24): all nine are launch must-haves, built in roadmap order.

**R18. Score-link pop-up copy on cloud** — `Haiku` — bug — ✅ shipped 2026-11-24.
"Phone Score Entry" on Vercel shows LAN-only text (same WiFi, self-signed certificate
warning, Limit IP Address Tracking). Show it only on the LAN build. The player view's
"Scan to view your squares" pop-up had the same certificate line; fixed with it.
*Done:* cloud pop-up has no LAN text; LAN pop-up unchanged.

**R19. Live-first setup** — `Sonnet` — ✅ shipped 2026-11-24.
The game picker moves into the form after league and date; picking a game fills teams,
description and kickoff, sets the cutoff to kickoff and switches Scoring to Live.
Manual is the fallback (no game picked, or Other). "Auto Fetch Score" becomes "Live";
the raw-ESPN Details button goes.
*Done:* browser check at 375, 1366 and 1920 px.

**R20. Phone Game Day** — `Sonnet` — Depends on: R18 ✅ — ✅ shipped 2026-11-24.
Tabs Score | Board | Players (Score first on Manual boards, Board first on Live); the
whole 10×10 grid fits a 360 px phone; labeled actions instead of four bare icons;
feed-down banner (s3) with take over and resume.
*Done:* browser check at 360 and 390 px, TV view unchanged.

**R21. Payout tracking** — `Opus` (money logic, test-first) — Depends on: R20 ✅ — ✅ shipped 2026-11-24 (decision 015).
"Mark paid out" per quarter (the host pays off-app, decision 004); a game-over "who to
pay" list; correcting a quarter that was already paid out warns and marks it
"Needs settling" until the host clears it.
*Done:* transition tests in `compute.js` for paid-out, correction and settle;
`/code-review high` clean.

**R22. Join codes and guest view** — `Sonnet` build, `Opus` review (new column,
migration) — Depends on: none. — ✅ shipped 2026-11-24 ([decision 016](decisions/016-join-codes.md),
migration 004: apply before the push).
A short join code per board (`/<code>`), a share button (system share sheet, iPhone and
Android), guest link available before lock, the TV view shows the board filling with a
big join QR before lock, and the guest view gets a small grid with my squares, "Not yet"
instead of "Locked", and "scored by host" on Manual boards.
*Done:* code uniqueness test; browser check on phone sizes and the TV view.

**R23. TV pairing and the device chooser** — `Sonnet` build, `Opus` review — Depends on: R22. — ✅ shipped 2026-11-24
([decision 017](decisions/017-tv-pairing.md), migration 005: apply before the push). Not checked on a
real smart-TV browser. "Score from another phone" is text only until R24.
After lock, "What's in the room?" (Show on a TV, Score from another phone, Invite
players). A TV opens `/tv`, shows a short code, and the host's phone enters it; the
paired TV follows the host's current game. No server timers (the TV's normal poll
picks up the pairing).
*Done:* pairing works on a smart-TV browser and a second desktop browser; a TV never
gets write access.

**R24. Scorer-phone hand-off** — `Opus` (auth) — Depends on: R2. — ✅ shipped 2026-11-24
([decision 018](decisions/018-scorer-hand-off.md), migration 006: apply before the push).
Score entry on one board only (Steve's choice). Not scanned with a real phone camera yet.
A one-time QR on the host's iPad or laptop signs a phone in for that board without an
email code. Related to "per-board scorekeeper links" in Later (decision 012).
*Done:* decision approved; token is single-use and short-lived; `/code-review high` clean.

**R25. iPad and laptop layouts** — `Sonnet` — Depends on: R20 ✅. ✅ built 2026-11-24: picking
screen (wide layout, tap squares to claim, paste a list, players panel) and Game Day (board left,
panel right with Players, keyboard scoring switch off by default, Present on an HDMI TV). Not tried
on a real iPad, a real second screen or Firefox/Safari yet.
iPad: fill the grid by tapping squares; a table board with scoring and players in a side
panel. Laptop: the same wide layouts plus paste-a-list of players, keyboard scoring
shortcuts and "Present on the TV" over HDMI (TV view full screen on the second display).
*Done:* browser check at 1180×820, 1366 and 1920 px.

**R26. Mirror mode for one phone** — `Sonnet` — Depends on: R20. ✅ built 2026-11-24 (`#mirror-<id>`,
from "What's in the room?" on a phone). Not tried with real AirPlay or Cast yet.
For AirPlay (iPhone) or Cast / Smart View (Android) with no second device: a landscape
TV view with a tap-to-show score strip, Players blocked while mirroring, and a Do Not
Disturb tip.
*Done:* browser check in phone landscape; the strip hides after 3 s.

**R27. Retire the LAN build** — `Sonnet` — ✅ shipped 2026-11-24 ([decision 014](decisions/014-retire-lan-build.md)).
Steve's call (2026-11-24). The cloud app is the only product; `npm start` is a
localhost-only dev server. Removed the certificates, LAN discovery, `/api/hosts`, the
`.bat` scripts, the `selfsigned` dependency and the LAN README.
*Done:* tests pass; preview runs on 127.0.0.1; pop-ups and the TV corner QR use the page's origin.

**R28. Guests pick their own squares** — `Opus` decision and review (first guest write),
`Sonnet` build — ✅ built 2026-11-24 ([decision 019](decisions/019-guest-picks.md), no
migration). Not tried on a real phone yet. Depends on: R22 ✅. **Launch must-have** (Steve, 2026-11-24). Build after
R24, before R25.
The host shares the `/<code>` link (for example in an Evite) and guests claim squares
before the party.
- **Setup flag:** "Let guests pick their own squares" when creating a game (off by default).
- **Identity (Steve chose option A):** the guest types their name; their browser keeps a
  private device key, so that device can release or change its own picks. No email, no
  account. Accepted limits: the cap is honor-system (a new name or a private window gets
  around it), and a lost device key means the host fixes the picks.
- **Cap:** the host sets a maximum number of squares per person. It lifts at a time the
  host sets, or when the host flips a switch. Enforced on the server in the same atomic
  write as the pick (decision 008), so two phones can't race past it.
- **Rules:** a guest can claim or release only their own empty squares, only while the
  board is picking; never scores, settings or anyone else's squares. Guest picks start
  unpaid; the host marks paid as today (decision 004).
- **Host oversight:** every pick shows its name and time; the host can remove or
  reassign any pick.
- **Later (not for launch):** a per-board "Require email" switch (option D) using the
  host sign-in code.
*Done:* a decision entry approved by Steve before code; server tests for the cap, the
lift time and switch, own-squares-only, and picking-only; `/code-review high`; browser
check at 360 px and on the TV view.

**R29. Game Day header: Connect and Party View** — `Sonnet` build, `Opus` design and review —
✅ built 2026-11-24 (Steve approved the mockup in a design session). Depends on: R25 ✅, R26 ✅.
The Game Day top bar is Home, the matchup (one line: short team names when full ones would wrap),
Party View and Connect; wide screens add a join-code chip (copies the link) and an "On the TV ·
Stop" pill while presenting. Connect (was "What's in the room?") is a bottom sheet on a phone and
a popover on wide screens, in three sections: Players (code, Share or Copy link, Show QR, Print a
Letter QR sign; since 2026-11-25 a single View QR button opens the QR window, which has Print), TV
(smart TV pairing, Present on HDMI, Mirror this phone) and Scoring (hand-off).
"TV view" is now **Party View**, its own button, opening in the same tab with Exit back to Game
Day; on a phone it is the mirror screen with a new portrait layout. A touch device that cannot
keep the screen awake gets a one-time Auto-Lock tip. Hashes `#tv-<id>` and `#mirror-<id>` are
unchanged. Not tried: real printing, real AirPlay, a real iPhone wake lock.

**R30. Home redesign: compact cards, one clear button, TV tiles** — `Sonnet` build, `Opus` design
and review — ✅ built 2026-11-24 (Steve approved the mockups; no squares count or score on cards,
no store change). Home's top bar holds New game and an account menu (Sign out, Sign out
everywhere). Boards sit in Today (live first, then by kickoff), Coming up (soonest first; unfinished
past-dated boards on top) and a collapsed Past games, with no panel around them. Each card has a
status chip (Live, Kickoff, Picking squares, Final), one-line matchup, a primary button (Pick
squares, Open Game Day, See results), Party View in the same tab with Exit back to Home, and a ⋯
menu (Edit, Players, Score from another phone, Delete) as a sheet on a phone or a popover on wide
screens. A TV browser gets up to six focusable tiles driven by the remote's arrows, or the pairing
screen when there is no host session. The brand keeps its glowing pill (tighter on a phone, where
the account button drops its chevron). Party View adds one history entry, so a phone's Back or a TV
remote's Back leaves it like Exit, and that entry remembers where it was opened from, so Exit
still returns Home after a reload. Not tried: a real TV remote and TV browser.

**R31. Picking screen redesign and part payments** — `Opus` — ✅ built 2026-11-24 (Steve approved
the mock, then dropped its three-column layout for two). Depends on: R25, R28, R29. Centered matchup with the
join chip and Connect; the board in a team-colored frame with "?" until the lock; two columns
from 1024 px (one panel with Add squares and Players tabs, Player picks and the lock; the board),
one below that; a phone has Squares, Grid and Players tabs with the grid fitted to the width, like
phone Game Day. The number of squares is required and shows its total, Already paid starts off, and pills are
green Paid, yellow Partial and red Unpaid. Manual pick is a tap on the board, and paste a
list works on every size. Player picks settings open in a dialog, and the screen's join card and
Connect's Scoring section (before the lock) are gone. "Guest picks" is now "Player picks: Allow
picks in Player View"; the guest page is Player View. Part payments:
[decision 020](decisions/020-paid-per-square.md). Not tried on a real iPad or phone. The privacy
and terms pages still say "guest picks" (wording waits for the lawyer review).
*Changed 2026-11-25:* the sold bar is four stat panels (Sold, Open, Pot, Per square) on every size, the One
player / Paste a list buttons are gone, and an icon at the top right of the panel opens Paste a list in a
dialog (the text is kept if it is closed).

**R32. Team pills, glass buttons and Home placement** — `Sonnet` — ✅ built 2026-11-24. Team pills:
the logo disc is 2 px taller than the pill, names are centered and every team font's capitals are
the same height (`TEAM_CAPS` in `ui.js`), and a team color close to the dark cards gets an outline.
Button colors are theme tokens (R33). Home is top left on every host screen, and
the phone Game Day header shows only the matchup.

**R33. Host themes** — `Opus` (storage, access, review), `Sonnet` (front end) — ✅ built 2026-11-24
([decision 021](decisions/021-host-themes.md), migration 007, applied to production 2026-11-24). Six themes,
one per host, chosen on a Theme page in the account menu; the original palette is "Neon", with solid
buttons. Player View, Party View and paired TVs wear the board's host's theme.

**R35. Wide Game Day and the Party View grid on the host screens** — `Opus` design (Steve approved the
mockups), `Sonnet` build — ✅ built 2026-11-25. From 1024 px (not a phone) Game Day fits the
window with no page scroll: a tabbed panel on the left (Score, Players (n)), the grid on the right. Score
holds the current-score panel (the key letters sit on the buttons while Keyboard scoring is on; the legend
is gone, Ctrl+Z still works), then one line per quarter: score, winner, Mark paid out or Paid out (tap to
undo) and an edit pencil. That replaces the big quarter cards and the panel's own ended list on wide; PUSH,
rollover, Randomly Draw Winner, Needs settling, the paid-quarter warnings and not overwriting a field
being typed in all remain. A Live board shows its score read-only (with the period and clock); a down feed
or a taken-over score shows the panel with Resume live feed; Simulation shows its score; a finished board
shows Who to pay and Undo. Players is the existing card, and only its list scrolls. Above the grid, on both
tabs: score and period, what feeds the score (LIVE, SIMULATION, MANUAL, FEED OFFLINE, which replaces the
board's live-score bar on wide), squares sold, an editable pot and the price. The stat strip goes on wide
(Still owed is in Players). The top bar centers the matchup, as on the picking screen. Wide Game Day and
wide picking wear Party View's grid (glass frame, thick fading team bars with the row team's vertical and
flush to the numbers, stretched squares, glowing numbers, the winner's pulse), sharing its rules through
`.glass-board`; the quiet red ring for an unpaid square stays on host screens. Below 1024 px and on a
phone nothing changed, and neither did Party View (computed styles compared with the previous build).
Not tried: a real iPad, a real touch screen, a window under 560 px tall (it scrolls instead).

Helpers and one score pad (R36–R39): [decision 025](decisions/025-helpers-and-score-pad.md), Steve approved the
design and mockup 2026-11-25 ("Helpers and one score pad" canvas, claude.ai artifact
`TxJaeNkrcqrnAe9WoKY99Z`, private). Build in this order.

**R36. One score pad** — `Opus` (score operations, test-first), `Sonnet` (UI) — ✅ built 2026-11-25, not pushed. Depends on: none.
The labeled pad replaces the score panel's layout on Game Day (phone and wide) and in the Party View
strip, with one Undo, an end-of-quarter question that names the winner, and Fix per quarter. The
quarter score boxes, the Edit form and the wide pencil form go. `edit` works on Live and
Simulation boards (and clears a quarter) without taking over from the feed, and the Final draw becomes a server
operation. The `#score` page shows the pad in place of its keypad until R37 retires it; this also
fixes it running off the right edge of a 375 px phone (429 px wide, measured 2026-11-25).
*Done:* operation tests first; no score is saved by a whole-document `PUT`; browser check at 360, 390,
1366 and 1920 px and the Party View strip; `/code-review high` clean.

**R37. Helpers and the Scorekeeper tab** — `Opus` (auth, migration 010) — ✅ built 2026-11-25, not pushed (Postgres tests passed on `ci-tests`; real phones not checked). Depends on: R36.
The Helpers screen (add, jobs, code or texted link, remove one), Player View tabs, the helper cookie,
and the Score tab. Retires the scorer hand-off (018) and the `#score` page; old links still open
something sensible. Not shipped on a game day: phones already scoring need a new code.
*Done:* access and lifetime tests in all auth modes and both stores; privacy page updated; scanned
with a real iPhone and Android phone; `/code-review high` clean.

**R38. Squares manager** — `Opus` (money records, access) — ✅ built 2026-11-25, not pushed (Postgres tests passed on `ci-tests`; real phones not checked). Depends on: R37.
`PATCH /api/game/:id/squares` with `applySquaresOp` (test-first) and the Players tab: add squares, mark
paid or part paid, remove unpaid squares, player picks on/off and limit; after lock, paid marks only.
*Done:* rule and race tests from decision 025; browser check at 360 and 390 px; `/code-review high` clean.

**R39. Recent changes** — `Sonnet` build, `Opus` review (migration 011) — ✅ shipped 2026-11-26 (migration 011 applied to production first)
(Postgres tests passed on `ci-tests`, where 011 is applied; `/code-review high` done; real phones not checked). Depends on:
R37 (covers squares once R38 ships).
A host-only list of who did what on the board, the last 50. A failed log write never fails a score.
*Done:* host-only access test; entries for score, squares and helper changes; deleted with the board.

Editing a locked game (R40–R43): [decision 026](decisions/026-editing-a-locked-game.md), Steve approved the
design 2026-11-25 ("Editing a locked game" canvas, claude.ai artifact `JJmzusrbdA7Cro7XCiWWHo`, private).

**R40. Settings rules on the server** — `Opus` (money logic, test-first) — ✅ shipped 2026-11-26
(`test-settings.js`; Postgres run on `ci-tests`; lock and Total Pot checked at 1366 and 1920 px and on the TV). Depends on: none.
`gameUnderWay`, `applySettingsOp` (`edit`, `lock`), `PATCH /api/game/:id/settings`, and the guards on `PUT`. The
server draws the numbers at lock. No save makes a quarter's amount negative (a $100 pot on a $1,000 board
pays a Final of -$500 today). Locking and Total Pot move to the new route.
*Done:* decision 026 tests; no browser draws the numbers that count; `/code-review high` clean.

**R41. Edit form after lock** — `Sonnet` build, `Opus` review — ✅ shipped 2026-11-26; Opus review done, findings fixed in dd28824
(`screen-edit.js`; browser check at 360, 390, 1366 and 1920 px, also 1024, in all four stages, the TV view,
and a stale save from a second tab; not tried on a real phone). Depends on: R40.
Edit game from Home, the picking screen and Game Day; blocked fields with the reason, the review sheet, the paid-marks
choice, a Kickoff field, and "Keep theirs or use mine". A date change no longer drops the kickoff and turns Live off on
a locked board.
*Done:* browser check at 360, 390, 1366 and 1920 px in all four stages; a stale form never reverts another device's change.

**R42. Unlock and wrong game** — `Opus` (test-first) — Depends on: R40, R41. — ✅ built 2026-11-26, not pushed (decision 026, "As built (R42)"; `/code-review high` done with its fixes).
`unlock` and `relink` with their confirm sheets.
*Done:* decision 026 tests, including a past cutoff and a paid-out quarter; `/code-review high` clean.

**R43. Changed by the host** — `Sonnet` build, `Opus` review — Depends on: R40, R42 ✅ (shows redraws: an unlock's
`numbers` change then the new numbers, and a changed game).
`game.changes` (written by R40's and R42's operations), the list on Player View, and the ten-minute line on the TV.
*Done:* browser check on Player View and the TV; a board with no changes looks as it does today.

**R44. Player View tabs: Home, Players, Live, Picks** — `Sonnet` build, `Opus` review — ✅ built 2026-11-25
(`player-home.js`; guest read-only mode in `screen-mirror.js`; overtime counts toward the Final, checked in
`lib/scores` and the score pad; wins share one banner; not tried on a real phone). Depends on: R28 ✅,
R37, R38. Steve approved the design 2026-11-25 (design session, inline phone mockups). Front end only: decision 019's
rules, the pick cookie and the API stay as they are. Today a guest lands on "Pick your squares" while picking is
open; now everyone lands on **Home**, and picking is a tab.
- **Tabs** at the bottom: Home, Players, then **Picks** before the lock (only while player picks are on and the board
  is picking) or **Live** after it, so three at a time. Helper tabs follow; the squares manager's Players tab merges
  into this one, with its editing controls added for that helper. The first tab is always Home.
- **Home:** status line (kickoff countdown, live score, or Final); who you are ("You are Steve R · Change"), or an
  inline card on a phone that doesn't know yet: "Join and pick squares" / "Find my name" while picking is open,
  "Which squares are yours?" with search otherwise, always with "Just watching? Skip this." No pop-up. Your squares
  (row and column before the lock, digit pairs after) with one word each: Winning, Close (the existing one-likely-score
  logic), Out, or Won Q1/Half/Q3/Final; won so far. Before the lock only, and only on the phone that picked: the amount
  owed and "You can pick N more" (opens Picks). **View the board** opens the read-only Party View full screen;
  **Rules and payouts** opens a sheet (price, pot, quarter split, rollover when nobody holds the square, "the host
  collects and pays, never the app"). "Updated N s ago · live score" (or "scored by host"). Invite friends before the
  game and "Host your own board" (R13) at the bottom; at Final, your total, all winners and Host your own board up top.
- **Who you are:** a phone that picked is "You" by its key (the server's answer) and is the only one shown an amount
  owed. Anyone else picks a name from a list: a remembered choice that only changes what this phone shows, undone
  with Change or "Not you?". **Owed is hidden after the lock** (no server change; the host settles up in person).
- **Players:** everyone A to Z with square counts (winnings once live), you pinned on top, search past 8 names. Tap a
  player for their squares and a **This is me** button. Names held by another phone say "Picked on another phone".
- **Live:** winning now (name, square, what the quarter pays if it ended now), squares one score away, every quarter
  with its winner and payout, including the ones still to come. On a hand-scored board, quarter results only.
- **Picks:** the guest pick panel on its own tab: name box first ("First name and last initial", 10 characters),
  warning as you type when the name is taken ("Not you? Add your last initial"), then the grid, Pick for me, and a
  claim bar. Claiming returns to Home with "You have N squares". When picking closes, picks go off or the board locks,
  the tab leaves; a guest on it goes to Home with "Picking just closed" and what they kept.
- **Read-only Party View for guests:** the phone Party View (`screen-mirror.js`) without the host check or score strip,
  your squares outlined, tap a square for its name, sideways for a bigger board; Exit and Back return to Home.
- **You won:** when a quarter resolves to your square, a banner on Home ("You won the half · $300 · Collect from the
  host", Dismiss) and a slim one on other tabs that opens Home; once per win per phone, one vibration where supported.
- Open fast from the last copy kept on the phone, then refresh (cold-start rule); keep the 15 s poll.
*Check during the build:* that overtime counts toward the Final before the rules sheet says so.
*Done:* browser check at 360, 390, 1366 and 1920 px for a new phone, a phone that picked and a phone that chose a
name, with picks on, off and closed, locked, live, hand-scored and final; a helper with both jobs; the TV view
unchanged; `/code-review medium`.

**R46. Animated number draw** — `Sonnet` build, `Opus` review (the draw stays the server's) — Depends on: R42.
Requested by Steve 2026-11-26; not scheduled yet. A board setting, **Number draw: Quick pick or Animated** (set at
setup and in Edit game until the lock; Quick pick, today's instant draw, is the default). With Animated, when the
board locks (and after an unlock and a new lock), a fun reveal pulls the numbers one at a time onto the board's axes,
on Game Day, Player View and the TV/Party View. Reuse the drawn-winner reveal for a final score where it fits. The animation only **reveals** the numbers the
server already drew with `crypto.randomInt` (decision 026); the browser never picks them, so every screen shows
the same digits. Each screen plays it once per draw, and a screen that opens later shows the finished axes.
*Done:* the setting saves and is closed after the lock like pick mode (decision 026 table); Quick pick boards look as they do today; no change to the drawn numbers or the lock route; every screen plays the same order; reduced-motion users
get no animation; skip by tap; TV view checked at 1366 and 1920 px; `/code-review medium`.

### Milestone 2 — Ready for game-day load (target 2027-01-10)

**R8. Cache board reads at the edge** — `Opus` — ✅ built 2026-11-24 ([decision 023](decisions/023-edge-cached-reads.md)), not pushed. Depends on: R3, R4a.
`GET /api/game/:id` currently reads Neon on every poll (ETag is computed after
the read) and may write (auto-cutoff; R4a already removes the live-score
writes). Move the remaining server-owned writes off the read path, then send `s-maxage=2, stale-while-revalidate` so eight screens
on one board cost about one function call. Host writes return the fresh
document directly.
*Done:* at 8 pollers per board, function invocations per board fall to
≤1 per 2 s in a measured test; no stale view lasts over ~5 s.
*Measured on a preview:* one run per 2.5 s at 8 pollers every 4 s, 3.2 s at every 8 s; oldest view
3.3 s. The cutoff lock and quarter results stay on the read (one-time writes, decision 023).

**R9. Load test** — `Sonnet` — Depends on: R8.
A dependency-free Node script simulating 25,000 screens across 3,000 boards
(5× the estimate) against a preview deploy and a Neon branch.
*Done:* p95 under 500 ms and error rate under 0.5% at target; results and cost
estimate recorded in the runbook.
*Deferred (2026-11-25):* run it near launch, after Steve upgrades Vercel to Pro (Hobby's
4 h Fluid Active CPU was 41% used and an overage pauses every project on the account).
Set a Pro spend limit first. Deploy from a clean copy with `DATABASE_URL` overridden to
the `ci-tests` branch (`vercel deploy -e`): Preview's `DATABASE_URL` is the production host.
Measure CPU per function run with a small step, then size the ramp.

**R10. Sign-in rate limit** — `Sonnet` — ✅ live 2026-11-24 (runbook, "Sign-in rate limit").
Vercel Firewall rule on `/api/login` and `/api/login/verify`.
*Done:* rule live; documented in the runbook.

**R11. Monitoring and game-day runbook** — `Sonnet` — Depends on: R9.
Error alerts, a status check, the rollback path, and a game-day checklist
(Neon compute raised beforehand — never a keepalive ping). Spending limits set on Vercel
and Neon, because free use brings load with no income (decision 022).
*Done:* runbook section reviewed by Steve.

**R13. Guest-to-host loop** — `Sonnet` — Depends on: R2. Moved up from Milestone 3: the
main growth item for the free season (decision 022).
"Host your own board" on the player and TV views, with a referral code
tracked to sign-ups.
*Done:* referral attribution visible in the database.
*Built 2026-11-25, pushed:* the referral is the board's join code. The player view links to
`/?ref=<code>` ("Running your own pool? Host your own board"); the TV's join panel prints the same
address while a board is filling (not after it locks). The app keeps the code in the browser,
sends it with the sign-in request, and it lands in `hosts.referred_by` only when the account is
first created (migration 008; an existing host is never re-attributed). Checked on `ci-tests` with
throwaway rows, and in the preview. Not tried: a real email sign-in (needs R16), a real phone.
Migration 008 goes on production with 002 (runbook, "Turn on host accounts").

**R34. Opt-in for next season** — `Sonnet` build, `Opus` review (auth code, migration) —
Depends on: R2, R6 (wording).
An unticked "Tell me about next season" checkbox at sign-in, stored on `hosts` with the
time, and a way to turn it off.
*Done:* choice recorded and reversible; privacy policy covers it.
*Built 2026-11-25, not pushed* ([decision 024](decisions/024-consent-at-sign-in.md), migration 009): the box and the
Terms notice (R6) are on the code step and the emailed-link page, and travel with the sign-in itself;
"News about next season" in the account menu turns it on or off. Checked on `ci-tests` with throwaway
rows and end to end in the browser in accounts mode (360, 1366 and 1920 px); `/code-review high` done with its fixes. Not tried: a real email
sign-in (needs R16), a real phone. Wording waits for the lawyer review. Nothing sends the news yet;
whatever does needs an unsubscribe link that works signed out.

**R45. Admin usage page** — `Opus` (admin access, migration, outside API keys), `Sonnet` (front end) —
Depends on: R2 (real data once host accounts are live). Steve approved the design 2026-11-25 (inline mockups in a
design session). Not a host page: it tracks use of the whole site, for Steve.
- **Access:** `#admin`, open only to accounts in `ADMIN_EMAILS`. One `GET /api/admin/stats` route, answered
  `no-store`; it returns counts only, never board contents. Host emails are masked (`j•••@gmail.com`), with the
  full email shown one at a time on click. A range picker covers the last 7 days, 30 days or the season.
- **Headline counts:** hosts (and new this week), boards created, boards locked, players on boards, live now and
  TVs paired.
- **Signups and new boards per day** (chart).
- **Host funnel:** signed up → created a board → locked one → finished a game → came back for a second board.
- **Growth loop:** hosts from "Host your own board" (R13), next-season opt-ins (R34), the Terms version accepted
  (R6), and the top referring boards.
- **Where hosts heard about us:** an optional one-question step after a host's first sign-in (a friend, Search,
  TikTok/Reels/Shorts, a Facebook or Reddit group, an ad, something else with a short text box; Skip). It's skipped
  when a referral code already says "a friend's board". Ad and video links carry `?src=<tag>`, kept and sent with
  sign-in like `ref`. Stored on `hosts` (migration). The card shows the answers, skips, tagged links and the
  latest "something else" text. The privacy page must say we ask.
- **Hosts by game:** per real game and date, the hosts, boards, guests and share locked, matched by the feed event
  ID or league, date and teams; "Other or no game picked" collects the rest. Tap a game for its boards' stages.
- **Guests per host:** median, average and most; a chart of hosts by guest count; top hosts. A guest is a distinct
  player name on the host's boards; phones are distinct pick-device keys (player-picks boards only).
- **How boards are run:** scoring mode, league, player picks on, a helper, shown on a TV, average squares sold.
- **Services:** score feeds (calls and failures per provider, times we fell back to BALLDONTLIE and for how long,
  feed fully down, peak calls a minute against the ≤4 target, the last failover) and Resend (sent today against
  100 a day, this month against 3,000, failures, sign-ins refused by our limit, code and link use). Both come from
  a new daily counter table (migration, and an fs equivalent): one upsert per outside call, and a failed count
  never fails the call. Database: compute hours and storage from the Neon API, plus row counts, cold starts and
  the slowest query. Hosting: Fluid Active CPU, function calls and errors, the share of board reads served from
  cache, p95, firewall blocks and the production deploy, from the Vercel API. The two keys (`NEON_API_KEY`,
  `VERCEL_API_TOKEN`) are read-only and used only by the admin route. A card with no key shows "Open dashboard".
- **Recent hosts:** masked email, joined, boards and stage, last sign-in, where they came from.
- No page-view analytics: the privacy page's "no analytics" stays true.
*Done:* a decision entry (admin access, the counters, the outside keys, the heard-about-us question); access tests
(a non-admin host and a signed-out visitor get 403 in every auth mode); counter tests in both stores; privacy
page updated; browser check at 1366 and 1920 px; `/code-review high` clean.

### Milestone 3 — Go to market (2027-01-11 → 2027-02-14)

**R12. Landing and search pages** — merged into R17 (2026-11-23), which ships
them earlier so they are indexed before the playoffs.

**R14. Soft launch on the NFL playoffs** — `Steve` — Depends on: M1, M2.
Invite-only use starting with Wild Card weekend (mid-January 2027) as the real
load test; feedback through GitHub Issues.

**R15. Ads and short videos** — `Steve` (Sonnet drafts copy) — Depends on: R17.
TikTok, Reels and Shorts of the TV grid and the winner reveal; Google and Meta
ads on generic squares terms in the last three weeks; Reddit and Facebook
office-pool groups.

---

## Later (after 2027-02-14)

- **R5. Payments** — `Opus` — Depends on: R2, R16. Live before the 2027–28 postseason.
  Stripe Checkout for the Postseason Pass ([decision 022](decisions/022-postseason-pass.md)),
  a signed webhook that grants the entitlement, the postseason free limit (10 players)
  enforced server-side, receipts by Stripe. Settles the open rules 022 lists. Stripe test
  mode until Steve approves live keys.
  *Done:* webhook signature and idempotency tests; free limit cannot be bypassed from the
  client; `/code-review high` clean.
- Phone app wrappers (Capacitor) for App Store and Google Play discovery —
  check Apple's real-money gaming guideline first.
- Guests claim their own squares from their phones, the host confirms and marks paid
  (2026-11-24 flow review; needs a claim capability and auth review, Opus).
- Account upkeep: change email, self-service deletion, co-hosts (decision 012).
- Spring basketball tournament push (NBA/Other already supported).
- Unlimited squares after a grid sells out (open questions in memory notes).
- Apple TV: not planned — AirPlay and smart-TV browsers cover it.
- Player View extras (after R44): "What it takes" per square ("Both teams need a touchdown"), "good numbers" odds
  from a sourced table (needs a decision entry), "Request a spot" that tells the host, a host-approved "link this
  phone" so a host-typed name can pick from a phone, and owed after the lock (pick-key endpoint answers read-only;
  Opus, note in decision 019).

## Recently shipped

- Decision 013: team and league logos restored (ESPN logo CDN, helmet fallback, CSP
  `img-src` widened); the same-millisecond save race fixed in both stores, issue #3
  (2026-11-24)
- R1: host accounts designed and approved, decision 012 (2026-11-23)
- Issue #2: the phone keypad keeps the drawn final winner; the TV reveal ignores a stale
  draw (2026-11-23)
- R4: NFL and NBA team and league logos removed (ESPN logo CDN gone); badges show
  names and abbreviations in team colors (2026-11-23)
- R3: manual current score: Manual/Live/Simulation per game, score panel on phone and
  Game Day, `PATCH /api/game/:id/score`, 43 transition tests (2026-11-23)
- R0: ported to the RileySoft model: `CLAUDE.md`, `ARCHITECTURE.md`, runbook,
  decisions 002–010, issue templates, version in the Home footer (2026-11-23)
- Postgres tests for store-pg, skipped without `DATABASE_URL` (d8fa14b)
- Atomic-save rename retried instead of losing the write (5d272f3)
- Lower poll load; ESPN look-up stampede closed (a6dc651)
- Code-review fixes across server, store and client (9e2c655)
- TV grid winner glow no longer clipped on the bottom row (bf9bff4)
- Cloud migration Phases 1–4: storage interface, Postgres backend, Vercel
  entry point, host sign-in (see `docs/archive/migration-plan.md`)

## Open questions for Steve

1. Ad budget for the final three weeks?
2. Form an LLC before taking payments (R5, Later)?
3. Product name (R16): pick the public name. Decides the domain.
4. Founder price next year for hosts who used the launch season (decision 022)?
5. Helper defaults (decision 025, section 7): job lifetime, texted links, the scorekeeper drawing the
   final winner, and the change log. Built as recommended unless you say otherwise.
