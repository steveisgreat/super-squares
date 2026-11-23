# Roadmap — Super-Squares

**Goal:** sell Super-Squares to the public as a hosted web app in time for the
NFL championship game on **2027-02-14**. Written 2026-11-23 from a design
session; Steve owns the order.

**Profile:** hosted app (not yet recorded — the repo has no `CLAUDE.md`; see R0).
There is no BRD yet, so items cite this roadmap's IDs instead of FR IDs.

**Standing decisions from the 2026-11-23 session** (each needs a decision entry
under `docs/decisions/` when R0 creates that folder):
- **Web app first.** No native iOS, Android or Apple TV app before 2027-02-14.
  Phone wrappers are reconsidered after (see Later).
- **The host pays; players never do.** Free board up to ~25 players with a
  "Host your own board" footer; Big Game Pass **$7.99** per board; Season Pass
  **$24.99**. Prices are a hypothesis to test in the January soft launch.
- **We never hold or move pool money.** We sell software. Terms of Service say
  "entertainment and tracking only".
- **No NFL marks.** No team logos, and marketing says "the Big Game", never
  "Super Bowl". Team names and colors stay.
- **Manual scoring is the launch default.** The unofficial ESPN feed is off in
  the cloud until a licensed feed replaces it.

---

## Now

### Milestone 1 — Launch blockers (target 2026-12-21)

**R0. Port to the RileySoft model** — `Sonnet` — Depends on: none.
Run the `port-project` skill: `CLAUDE.md` with profile and where-to-look table,
`docs/decisions/` with the five standing decisions above, `ARCHITECTURE.md`,
`docs/runbook.md`, version visible in the footer. Folds `MIGRATION-PLAN.md`
into decisions and archive.
*Done:* CLAUDE.md under 15 KB, decisions 1–5 written, version shows in the app.

**R1. Host accounts design** — `Opus` — Depends on: R0.
Replace the single `HOST_PASSWORD` with one account per host: magic-link email
sign-in (Resend), `games.owner_id`, `GET /api/games` scoped to the owner,
every write checked against the owner. Keep the LAN build working with auth off.
Choose library vs. the existing signed-cookie code (new dependency rule applies).
*Done:* decision entry approved by Steve, with the schema migration and the
endpoint access table.

**R2. Host accounts build** — `Opus` — Depends on: R1.
Implement R1. Migration only adds (expand, then contract). Existing games get
assigned to Steve's account.
*Done:* tenant-isolation tests pass in CI (host A cannot list, read-for-write,
edit or delete host B's games); `/code-review high` clean.

**R3. Manual current score** — `Sonnet` — Depends on: none (R2 later swaps its
host check for an owner check).
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

**R4. Remove NFL logos and ESPN calls from the cloud path** — `Sonnet` —
Depends on: R3.
Drop the ESPN logo CDN; keep team colors and abbreviations with the generic
badge. Disable Live mode and `/api/todays-games` in the cloud build (LAN build
may keep them).
*Done:* no request to any ESPN host from the cloud build during a full game.

**R5. Payments** — `Opus` — Depends on: R2.
Stripe Checkout for Big Game Pass and Season Pass, a signed webhook that grants
the entitlement, free-tier limit enforced server-side, receipts by Stripe.
Use Stripe test mode until Steve approves live keys.
*Done:* webhook signature and idempotency tests; free limit cannot be bypassed
from the client; `/code-review high` clean.

**R6. Legal and trust pages** — `Sonnet` — Depends on: R0.
Terms of Service (entertainment and tracking only, no pot handling), privacy
policy, contact/support email, footer links. Draft only — Steve reviews with a
lawyer.
*Done:* pages live on preview; lawyer review booked (Steve).

**R7. Accounts and plans** — `Steve` — Depends on: none.
Vercel Pro (Hobby forbids commercial use), domain, Neon paid plan with
autoscaling for game day, Stripe account, optional LLC, trademark check on the
name (GleanMark connector needs `/mcp` sign-in).
*Done:* all accounts exist and the domain points at production.

### Milestone 2 — Ready for game-day load (target 2027-01-10)

**R8. Cache board reads at the edge** — `Opus` — Depends on: R3, R4.
`GET /api/game/:id` currently reads Neon on every poll (ETag is computed after
the read) and may write (auto-cutoff, live claim). Move server-owned writes off
the read path, then send `s-maxage=2, stale-while-revalidate` so eight screens
on one board cost about one function call. Host writes return the fresh
document directly.
*Done:* at 8 pollers per board, function invocations per board fall to
≤1 per 2 s in a measured test; no stale view lasts over ~5 s.

**R9. Load test** — `Sonnet` — Depends on: R8.
A dependency-free Node script simulating 25,000 screens across 3,000 boards
(5× the estimate) against a preview deploy and a Neon branch.
*Done:* p95 under 500 ms and error rate under 0.5% at target; results and cost
estimate recorded in the runbook.

**R10. Sign-in rate limit** — `Sonnet` — Depends on: R2.
Vercel Firewall rule on the sign-in and magic-link endpoints.
*Done:* rule live; documented in the runbook.

**R11. Monitoring and game-day runbook** — `Sonnet` — Depends on: R9.
Error alerts, a status check, the rollback path, and a game-day checklist
(Neon compute raised beforehand — never a keepalive ping).
*Done:* runbook section reviewed by Steve.

### Milestone 3 — Go to market (2027-01-11 → 2027-02-14)

**R12. Landing and search pages** — `Sonnet` — Depends on: R5, R6.
Home page with the TV-view demo, pricing, and pages for "football squares
generator" and "Big Game squares template". No NFL marks.
*Done:* Lighthouse and link check pass; pages indexed.

**R13. Guest-to-host loop** — `Sonnet` — Depends on: R5.
"Host your own board" on the player and TV views, with a referral code
tracked to sign-ups.
*Done:* referral attribution visible in the database.

**R14. Soft launch on the NFL playoffs** — `Steve` — Depends on: M1, M2.
Invite-only use starting with Wild Card weekend (mid-January 2027) as the real
load test; feedback through GitHub Issues.

**R15. Ads and short videos** — `Steve` (Sonnet drafts copy) — Depends on: R12.
TikTok, Reels and Shorts of the TV grid and the winner reveal; Google and Meta
ads on generic squares terms in the last three weeks; Reddit and Facebook
office-pool groups.

---

## Later (after 2027-02-14)

- Phone app wrappers (Capacitor) for App Store and Google Play discovery —
  check Apple's real-money gaming guideline first.
- Licensed live-score feed, looked up **once per real game** and shared by
  every board, to bring back Live mode.
- Spring basketball tournament push (NBA/Other already supported).
- Unlimited squares after a grid sells out (open questions in memory notes).
- Apple TV: not planned — AirPlay and smart-TV browsers cover it.

## Recently shipped

- Postgres tests for store-pg, skipped without `DATABASE_URL` (d8fa14b)
- Atomic-save rename retried instead of losing the write (5d272f3)
- Lower poll load; ESPN look-up stampede closed (a6dc651)
- Code-review fixes across server, store and client (9e2c655)
- TV grid winner glow no longer clipped on the bottom row (bf9bff4)
- Cloud migration Phases 1–4: storage interface, Postgres backend, Vercel
  entry point, host sign-in (see `MIGRATION-PLAN.md`)

## Open questions for Steve

1. Free-tier limit: 25 players, or one free board of any size with the footer?
2. Ad budget for the final three weeks?
3. Form an LLC before taking payments?
4. Keep the name "Super-Squares" pending the trademark check?
