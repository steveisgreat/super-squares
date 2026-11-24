# Live-score feed probe — 2026-11-23 (Bengals at Commanders, MNF)

Feeds roadmap R4a and decision 001. Raw data is **git-ignored** at
`docs/working/score-poll-2026-11-23/` (`raw.jsonl` = every 15 s poll, `changes.log` =
changes only). R4a must trim it into committed test fixtures.

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
| End of quarter | `STATUS_END_PERIOD` (also `STATUS_HALFTIME`) | `status` = `"End of 1st"` (expect `"Halftime"`, `"End of 3rd"` — unconfirmed) |
| Quarter scores | `linescores[]` per competitor | `home_team_q1..q4`, `_ot`; **a quarter's field fills in DURING that quarter** (q1 showed 0 at 14:54 1st) |
| Update cadence | clock moves every ~30–45 s | fixed 15 s cycle (`updated_at` on :00/:15/:30/:45) |
| Lag | baseline; **ahead of Steve's TV broadcast** | ~15–30 s behind ESPN |
| Response time | ~130 ms | ~200–1,400 ms |
| Includes previous night's late game | no | yes (MIN@SF on the 11-23 query) — filter by team pair |

Quarter 1 end timeline (UTC): ESPN `STATUS_END_PERIOD` 01:49:17 → ESPN Q2 01:49:47 →
BDL `"End of 1st"` 01:49:47 (+30 s) → BDL `"15:00 - 2nd"` 01:50:03 → BDL `q2` field
appears 01:50:35 (+78 s). Q1 result 0–0 in both, matching totals. Steve's TV still showed
0:05 when ESPN reported the quarter over.

## Not yet observed (check raw.jsonl after the game)
First score latency per feed; halftime text; end of Q3; final (`STATUS_FINAL` vs
BDL `status_state: final`, `"Final"`); overtime if any.

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
