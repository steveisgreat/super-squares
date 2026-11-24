# Live-score feed probe — 2026-11-23 (Bengals at Commanders, MNF)

Feeds roadmap R4a and decision 001. Raw data is **git-ignored** at
`docs/working/score-poll-2026-11-23/` (`raw.jsonl` = every 15 s poll, `changes.log` =
changes only); full response bodies are in `docs/working/score-raw-2026-11-23/`. The
committed fixtures in `test-fixtures/scores/` are trimmed from those bodies.

## How to run the probe
```
node scripts/poll-scores.js [YYYY-MM-DD] [intervalSeconds]   # defaults: today ET, 15
```
- ESPN needs no key: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD`
- BALLDONTLIE needs `BALLDONTLIE_API_KEY` in **`.env.local`** (git-ignored; already set on
  Steve's machine, free tier, created 2026-11-23 via `POST https://api.balldontlie.io/account/v1/signup`).
  Call: `GET https://api.balldontlie.io/nfl/v1/games?dates[]=YYYY-MM-DD&dates[]=<next day>&per_page=100`
  with header `Authorization: <key>`. Ask both dates: a night game is the next UTC day.
  Free tier = 5 req/min; one call per 15 s fits.
- The script stops 10 min after all games are final (max 7 h) and appends if restarted.
- For the cloud build, the key must also go into Vercel env vars (`vercel env add
  BALLDONTLIE_API_KEY`) when R4a ships — not done yet.

## Findings (through the start of Q2)
| | ESPN | BALLDONTLIE |
|---|---|---|
| One call = all games that day | yes | yes (`/nfl/v1/games`, up to 100 per page) |
| Before kickoff | scores `0`, `STATUS_SCHEDULED` | scores **`null`**, status text `"11/23 - 8:15 PM EST"`, `status_state: scheduled` |
| Clock / quarter | separate fields (`period`, `displayClock`) | **inside `status` text**: `"14:54 - 1st"`, `"End of 1st"`, `"15:00 - 2nd"` (no separate fields) |
| End of quarter | `STATUS_END_PERIOD` (also `STATUS_HALFTIME`) | `status` = `"End of 1st"`, `"Halftime"`, `"End of 4th"`; "End of 3rd" never showed (see below) |
| Quarter scores | `linescores[]` per competitor | `home_team_q1..q4`, `_ot`; **a quarter's field fills in DURING that quarter** (q1 showed 0 at 14:54 1st) |
| Update cadence | clock moves every ~30–45 s | fixed 15 s cycle (`updated_at` on :00/:15/:30/:45) |
| Lag | baseline; **ahead of Steve's TV broadcast** | ~15–30 s behind ESPN |
| Response time | ~130 ms | ~200–1,400 ms |
| Includes previous night's late game | no | yes (MIN@SF on the 11-23 query) — filter by team pair |

Quarter 1 end timeline (UTC): ESPN `STATUS_END_PERIOD` 01:49:17 → ESPN Q2 01:49:47 →
BDL `"End of 1st"` 01:49:47 (+30 s) → BDL `"15:00 - 2nd"` 01:50:03 → BDL `q2` field
appears 01:50:35 (+78 s). Q1 result 0–0 in both, matching totals. Steve's TV still showed
0:05 when ESPN reported the quarter over.

## Score latency (UTC; one game, three scores)
| Event | ESPN | BALLDONTLIE | BALLDONTLIE behind |
|---|---|---|---|
| Field goal 3–0 | 02:06:50 | 02:07:06 | 16 s |
| Touchdown 9–0 | 02:24:06 | 02:24:48 | 42 s |
| Extra point 10–0 | 02:24:27 | 02:25:19 | 52 s |

The field goal is from the 15 s poller on both feeds. For the other two, ESPN was checked
every 2 s and BALLDONTLIE by the poller, so its times can be up to 15 s late; its
`updated_at` stamps (02:24:45.7, 02:25:15.5) show most of the lag is in its feed. Steve's
"score" message came at least 23 s before ESPN showed the touchdown, so ESPN is not
always ahead of the broadcast.

**Outcome:** ESPN primary, BALLDONTLIE secondary (decision 001 §2).

## Rest of the game (final: Commanders 22, Bengals 20, no overtime)
BALLDONTLIE showed each later score 15–77 s after ESPN (usually 30–46 s, both from 15 s
polls) and the final 30 s after (04:19:34 vs 04:20:04). No poll failed once the BALLDONTLIE
key was set. Both feeds ended on the same quarters: 0–0, 10–7, 7–6, 3–9 (CIN–WSH).

| Seen | What it means for the code |
|---|---|
| BDL skipped "End of 3rd": the polls went from a Q3 clock to `"15:00 - 4th"` | Break text can be missed; Q3 settles from the next period |
| BDL `"End of 4th"` (22–20) 30 s before `"Final"` | Must not settle the final; it does not |
| BDL `"Delayed"` with `status_state: delayed` (a new value); ESPN `STATUS_DELAYED` | Stays in progress; nothing extra settles |
| BDL flipped back once at kickoff (1st quarter → scheduled, null scores → 1st) and once in the delay (Delayed → Q3 clock → Delayed) | One provider can go backward on its own; the no-backward rule covers provider switches only |
| ESPN total and quarter lines disagreed four times, one 15 s poll each (e.g. 17 vs 0+10+6) | The "must add up" rule was needed: it waits one refresh |

Still not observed: overtime, and BALLDONTLIE "End of 3rd". Those fixtures stay synthetic,
as do the before-kickoff and Q1 ones (bodies were not captured then).

**For R4a part 2:**
- `completedQuarters` is only what one reading supports, and can be empty for one refresh.
  A missing key must never clear a quarter already settled.
- Not seen, but possible: ESPN reports a break before a try or a correction posts, with
  totals that still add up. Decide whether a later reading may update a provider-settled
  quarter (never a host-set one).

## Implications for decision 001 §5 (quarter-end detection)
BALLDONTLIE is NOT period-less: the adapter parses `status` (`/^(\d+:\d\d) - (1st|2nd|3rd|4th|OT)$/`,
`End of Nth`, `Halftime`, `Final`) into `period`/`clock`/`state`. The "next quarter's
field appeared" rule is only a fallback (~80 s slower). Either feed settles a quarter within
~30–60 s of the real end — acceptable; host override still wins.

## Other providers looked at (prices from comparison pages, verify before buying)
BALLDONTLIE free / $9.99 (60/min) / $39.99 (600/min) per sport; Highlightly free–$44.99;
API-American-Football $19–39; Goalserve ~$300/mo or ~$1,200/yr (explicitly commercial);
SportsDataIO and Sportradar ~$500–1,000+/mo; ESPN official >$10k/mo. TheStatsAPI is
soccer only. ESPN's public endpoint is unofficial/unlicensed (no published commercial
terms). Commercial terms for BALLDONTLIE not stated in its docs — ask them before launch.
Max simultaneous NFL games ≈ 10 (Sunday 1 p.m. ET); playoffs and championship = 1.
