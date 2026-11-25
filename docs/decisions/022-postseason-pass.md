# 022 — Free launch season, then a $7.99 Postseason Pass

**Date:** 2026-11-24 · **Status:** accepted (Steve's call, 2026-11-24; the price is a
hypothesis) · **Roadmap:** R5, R7, R11, R13, R17, R34 · **Supersedes:** 003's prices and
free limit

## Context
Decision 003 sold a per-board pass and a season pass, with boards free up to about 25
players. Many office and party boards are smaller than that, so most hosts would never
pay. Steve's main goal for 2026–27 is exposure, not income, and payments are the largest
unbuilt launch item. The risk in a free year is hosts leaving when a price appears.

## Decision
The host pays and players never do (003's rule stands).

**2026–27, the launch season:** free for every host, any number of players, every game
through the Big Game on 2027-02-14. No payments are built for it.
- Next year's price is announced from day one, wherever pricing appears: "Free for our
  launch season. The Postseason Pass will be $7.99 next year."
- Never show a crossed-out price: the pass has not been sold at $7.99.
- Every board keeps the "Host your own board" footer.

**From 2027–28:**
- **Regular season:** free, any number of players.
- **Postseason** (Wild Card weekend through the Big Game): free up to **10 players** per
  board.
- **Postseason Pass: $7.99 once per host**, covering all of that host's postseason boards
  above 10 players, through the Big Game.
- The per-board Big Game Pass and the $24.99 Season Pass are dropped.
- Basketball and other games stay free for now, except as below.

## Alternatives
| Option | Why not |
|---|---|
| Charge in 2026–27 | Little income expected with no audience, and the largest, riskiest build left before launch |
| Free year with no price announced | The later charge would be a surprise |
| $7.99 for every postseason board, any size | A host running every game would pay about $104, and a full paywall hides the guest-to-host footer |
| 003's free limit of 25 | Few boards would ever pay |
| Pass per board above 10 players | More to explain, for few repeat sales |

## Consequences
- R5 moves to after 2027-02-14 and must be live before the 2027–28 postseason. Stripe and
  the LLC question move with it.
- R13 (guest-to-host) no longer waits on payments and becomes the main growth item. R34
  collects opt-in emails so this year's hosts can be reached next season.
- Free use adds load with no income, so R8, R9 and R11 matter more, with spending limits
  on Vercel and Neon (R11).
- We won't learn this year whether hosts pay.
- From 2027–28 the limit is enforced server-side (R5). League alone is not enough: a host
  could label a playoff game "Other", so the check also uses the game's date.
- R5 settles: what counts as a player, which dates and leagues make a board postseason,
  how "Other" boards on those dates are treated, what happens to a board already over the
  limit, and whether the pass carries to the next season.
- Open: a founder price next year for hosts who used the launch season (Steve).
