# 001 — Live scores: two pluggable providers behind one shared cache

**Date:** 2026-11-23 · **Status:** accepted (design); providers not yet chosen ·
**Roadmap:** R3, R4a, R8

## Context

Today each board calls ESPN on its own (`server-livescore.js`): one lookup per
board every 20 s, three scoreboard fetches per lookup, and a database write on
every check. At Super Bowl scale (about 3,000 boards) that is about 450 ESPN
requests a second, and a write per board per check. ESPN is also unofficial and
unlicensed. We will use **two paid or free score APIs, a primary and a
secondary**, chosen later (candidates: BALLDONTLIE, ESPN, Goalserve,
Highlightly). The design must not depend on which ones win.

What the 2026-11-23 probe (`scripts/poll-scores.js`) established so far:
- ESPN and BALLDONTLIE both return **every game for a date in one call**.
- BALLDONTLIE has per-quarter scores and a status, but **no period and no
  clock**. Scores are `null` (not 0) before kickoff, and a late game appears
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
Set `SCORE_PRIMARY` and `SCORE_SECONDARY` to adapter names, and keep keys in
env vars (`BALLDONTLIE_API_KEY`, …). If they are unset, the LAN default is
`espn` with no secondary, and the cloud default is none (Live mode hidden).
Failover happens **per refresh**: primary first, with a 4 s timeout; if it
errors, times out, fails to parse, or lacks a game the slate should contain,
the secondary is tried in the same request. A healthy secondary is never
called, which keeps a free secondary tier (5 calls/min) usable.

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
2. With no `period` (BALLDONTLIE): quarter n is complete once quarter n+1 has a
   non-null value, or the game is `post`. **Provisional**: the probe has to
   confirm whether a quarter's field fills in during that quarter or only after
   it ends. If this is the only signal, Q2 settles only when the second half
   starts. That is acceptable because the host can end Q2 at halftime.
3. **The host always wins.** A quarter result entered or edited by the host is
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
has them**. With BALLDONTLIE it shows the score and "updated N s ago".

## Consequences
- `server-livescore.js` is reduced to the slate refresh plus the
  quarter-backfill logic. `findEvent`, the three-date fan-out and
  `liveCheckedAt` on the game go away. Simulation mode is unchanged.
- `/api/todays-games` (the setup picker) reads the same slate instead of
  calling ESPN directly.
- Required tests: adapter normalization against **saved fixtures** (the
  2026-11-23 probe's `raw.jsonl`, trimmed), failover, quarter-end detection for
  both capability sets, host-wins, and claim concurrency in both stores.

## Open questions
1. Which providers? This depends on the probe results, commercial terms, and
   Steve's call.
2. Should stale data trigger failover, for example when the primary's score
   hasn't moved for 5 min while the secondary's has? That would cost secondary
   calls. Decide after the probe.
3. NBA support: the same adapters, if the chosen providers cover it. Otherwise
   Live mode is NFL-only.
