# 001 — Live scores: two pluggable providers behind one shared cache

**Date:** 2026-11-23 · **Status:** accepted; **ESPN primary, BALLDONTLIE
secondary** (Steve, 2026-11-23) ·
**Roadmap:** R3, R4a, R8

## Context

Today each board calls ESPN on its own (`server-livescore.js`): one lookup per
board every 20 s, three scoreboard fetches per lookup, and a database write on
every check. At Super Bowl scale (about 3,000 boards) that is about 450 ESPN
requests a second, and a write per board per check. ESPN is also unofficial and
unlicensed. We use **two score APIs, a primary and a secondary** (chosen in §2;
also considered: Goalserve, Highlightly). The design must not depend on which
ones they are.

What the 2026-11-23 probe (`scripts/poll-scores.js`) established so far:
- ESPN and BALLDONTLIE both return **every game for a date in one call**.
- BALLDONTLIE has per-quarter scores, and its period and clock only inside the
  `status` text (§5). Scores are `null` (not 0) before kickoff, and a late game appears
  under the next UTC date.
- At most about 10 NFL games run at once. One call per 15 s covers them all.

## Decision

### 1. One normalized shape, one adapter per provider
`lib/scores/<provider>.js` exports
`{ name, capabilities: { period, clock }, fetchSlate(league, etDate) }`.
`fetchSlate` makes **one** request and returns
`{ ok, games: [LiveGame], ms, error }`, where

```
LiveGame = {
  provider, providerGameId, league, etDate,          // etDate: YYYY-MM-DD, America/New_York
  home: { abbr, score, quarters: [q1,q2,q3,q4], ot }, // abbr in OUR teams.js form; null = not played
  away: { abbr, score, quarters: [...], ot },
  state: 'pre' | 'in' | 'break' | 'post',            // 'break' = end of quarter or halftime
  period: number | null, clock: string | null,       // null when the provider lacks them
  providerUpdatedAt: ISO | null, fetchedAt: ISO
}
```

Each adapter maps its own team abbreviations to `teams.js` (for example,
WSH and WAS are the same team) and turns null pre-game scores into 0 only when
`state` is not `pre`. Adding a provider means one file and its fixture tests,
nothing else.

### 2. Primary and secondary by configuration
**Choice: `SCORE_PRIMARY=espn`, `SCORE_SECONDARY=balldontlie`.** ESPN was faster
in every comparison on 2026-11-23 (16–52 s on scores, 30 s on the end of Q1; table
in `docs/research/2026-11-23-score-feed-probe.md`), and as a primary it needs no key
or rate budget. BALLDONTLIE is good enough to carry a board through an ESPN outage.

Set `SCORE_PRIMARY` and `SCORE_SECONDARY` to adapter names, and keep keys in
env vars (`BALLDONTLIE_API_KEY`, …). If they are unset, the LAN default is
`espn` with no secondary, and the cloud default is none (Live mode hidden).
Failover happens **per refresh**: primary first, with a 4 s timeout; if it
errors, times out, fails to parse, or lacks a game the slate should contain,
the secondary is tried in the same request. A healthy secondary is never
called, which keeps a free secondary tier (5 calls/min) usable.

**A switch must not move a game backward.** BALLDONTLIE runs up to about a minute
behind, so a failover could turn 10–0 back into 3–0. When the provider of a game
changes, keep the stored `LiveGame` until the new provider's period and clock reach
it, for at most 120 s. Within one provider, a lower score is a real correction and
is accepted.

### 3. One shared cache row per league and date
New table (fs backend: same contract, in memory):

```sql
create table live_slates (
  league text, et_date date,
  payload jsonb,           -- { provider, games: [LiveGame] }
  checked_at timestamptz,  -- last attempt, success or not: the throttle
  fetched_at timestamptz,  -- last success
  primary key (league, et_date)
);
```

A board read whose slate has `checked_at` older than **15 s** tries to claim the
refresh with `update … set checked_at = now() where checked_at = $seen` (the
same first-writer-wins pattern as today's `claimSlot`). Exactly one request
fetches, and every other request reads the row. API traffic is then about 4
calls a minute per league in total, whatever the number of boards. There is no
cron, timer or background poller (Neon rule), so nothing runs while nobody is
watching.

### 4. Boards read the slate; they don't copy it on every poll
- A game gets `scoring: 'manual' | 'live' | 'simulation'` (R3 adds the field;
  `manual` is the cloud default) and, for live, a `liveMatch`
  (`{ league, etDate, homeAbbr, awayAbbr }`) resolved at lock time.
- `GET /api/game/:id` merges the matching `LiveGame` into the response as
  `liveScore` (shape kept compatible with `computeLiveHighlight`, the live bar
  and My Squares). It is **not** written to the game row.
- A game row is written only when a quarter newly completes (backfill of
  `results.q1/q2/q3/final`), using the existing conditional update. That is a
  handful of writes per game, not one per poll. This is what makes R8's edge
  caching possible.

### 5. Detecting the end of a quarter
In order of trust:
1. The provider's `state`/`period` (ESPN: period advanced, `break`, or `post`).
2. BALLDONTLIE has no separate period field, but the **probe (2026-11-23) showed
   its `status` text carries it**: `"14:54 - 1st"`, `"End of 1st"`,
   `"15:00 - 2nd"`. The adapter parses that into `period`/`clock`/`state`.
   Quarter fields fill in *during* the quarter, so "quarter n+1 has a value"
   is only a fallback (about 80 s slower than the status text). Details:
   `docs/research/2026-11-23-score-feed-probe.md`.
3. **Only clear signals settle a result.** A quarter settles only when its side's quarter
   and overtime fields add up to the total (a feed can move one before the other). Only a
   "Final" status with both scores present settles the final; canceled, postponed or unknown
   text never does, and the host can still end the game.
4. **The host always wins.** A quarter result entered or edited by the host is
   stamped `source: 'host'` and is never overwritten by a feed. That
   generalizes today's "never touch a quarter that already has a score".

### 6. When both feeds fail
If no successful fetch happens for 60 s during a live game, the board shows
"Live feed unavailable — the host can enter the score". The R3 manual
current-score panel then works on a `live` game. A host entry sets
`liveOverride: true` (manual values win) until the host taps
**Resume live feed**.

### 7. Display
The live bar shows `LIVE` plus the period and clock **only when the provider
has them** (BALLDONTLIE's come from its status text). Otherwise it shows the score
and "updated N s ago".

## Consequences
- `server-livescore.js` is reduced to the slate refresh plus the
  quarter-backfill logic. `findEvent`, the three-date fan-out and
  `liveCheckedAt` on the game go away. Simulation mode is unchanged.
- `/api/todays-games` (the setup picker) reads the same slate instead of
  calling ESPN directly.
- Required tests: adapter normalization against **saved fixtures** (the
  2026-11-23 probe's `raw.jsonl`, trimmed), failover, quarter-end detection for
  both capability sets, host-wins, and claim concurrency in both stores.

- **Accepted risk:** ESPN's feed is unofficial, with no published commercial terms, and
  could block or change without notice. The secondary and the manual panel (§6) are
  the cover, and swapping the primary is a setting, not a code change.
- Before launch: ask BALLDONTLIE for its commercial terms, and set
  `BALLDONTLIE_API_KEY`, `SCORE_PRIMARY` and `SCORE_SECONDARY` in Vercel (R4a).

## Build notes (R4a part 2, 2026-11-24)

Built as designed in §3 to §6, with these differences and additions:
- **Board match is derived on read, not stored.** There is no `liveMatch` on the game: team
  names resolve to abbreviations through `teams.js`, and the ET date comes from `kickoffTime`
  (else `gameDate`). A board that cannot be matched reads as "feed unavailable".
- **`payload.error`.** A failed refresh keeps the last good games and records `error` in the
  payload; "feed unavailable" means no good fetch for 60 s *and* a recorded failure, or no match.
  A row that is merely old (nobody has read it) is not an outage.
- **Response-only `liveFeed`.** `GET /api/game/:id` adds `liveFeed: { available, fetchedAt }` to a
  Live board. It is never stored (PUT drops it, and also drops a feed-merged `liveScore`). The ETag
  now includes the merged score, because `updatedAt` does not move when nothing is written.
- **Host fallback.** The score operations accept a Live board once the op carries
  `override: true` (the client adds it) or the board already has `liveOverride`. The first tap seeds
  from the feed's score and sets `liveOverride: true`; the op `resume` clears it and the
  stored `liveScore`. The panel shows for a Live board when `liveFeed.available === false` or
  `liveOverride` (`GameLogic.manualEntry`).
- **Host wins by position, not a stamp.** The feed fills only quarters with no result, so a
  host entry needs no `source: 'host'` mark.
- **Picker.** `/api/todays-games` lists the slate (names from `teams.js`, kickoff from a new
  `startsAt` field on `LiveGame`). It answers 502 only when no fetch has ever succeeded.
- **Unread slate degrades.** If the table is missing or the read throws, a Live board reads as
  "feed unavailable" and the error is logged.
- No `expect` list is passed to failover, so the secondary is called only on an error, not for a
  game the primary lacks (open question 2 stays open).
- `server-livescore.js` keeps its ESPN code for now: `test-livescore.js` still tests it. Removing it
  means retiring those tests, which was not done here.

## Open questions
1. ~~Which providers?~~ Answered 2026-11-23 (§2).
2. Should stale data trigger failover, for example when the primary's score
   hasn't moved for 5 min while the secondary's has? That would cost secondary
   calls. Decide after the probe.
3. NBA support: the same adapters, if the chosen providers cover it. Otherwise
   Live mode is NFL-only.
