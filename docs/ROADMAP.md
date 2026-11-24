# Roadmap — Super-Squares

**Goal:** sell Super-Squares to the public as a hosted web app in time for the
NFL championship game on **2027-02-14**. Written 2026-11-23 from a design
session; Steve owns the order.

**Profile:** hosted app (recorded in `CLAUDE.md`; decision 010).
There is no BRD yet, so items cite this roadmap's IDs instead of FR IDs.

**Standing decisions from the 2026-11-23 session** (decisions 001–005 in `docs/decisions/`):
- **Web app first.** No native iOS, Android or Apple TV app before 2027-02-14.
  Phone wrappers are reconsidered after (see Later).
- **The host pays; players never do.** Free board up to ~25 players with a
  "Host your own board" footer; Big Game Pass **$7.99** per board; Season Pass
  **$24.99**. Prices are a hypothesis to test in the January soft launch.
- **We never hold or move pool money.** We sell software. Terms of Service say
  "entertainment and tracking only".
- **No NFL marks.** No team logos, and marketing says "the Big Game", never
  "Super Bowl". Team names and colors stay.
- **Manual scoring is the launch default; Live mode uses two providers.** A
  primary and a secondary score API (not yet chosen) feed one shared cache, so
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

**R1. Host accounts design** — `Opus` — Depends on: R0.
Replace the single `HOST_PASSWORD` with one account per host: magic-link email
sign-in (Resend), `games.owner_id`, `GET /api/games` scoped to the owner,
every write checked against the owner. Keep the LAN build working with auth off.
Choose library vs. the existing signed-cookie code (new dependency rule applies).
*Done:* decision entry approved by Steve, with the schema migration and the
endpoint access table.

**R2. Host accounts build** — `Opus` — Depends on: R1, R16 (sending domain).
Implement R1. Migration only adds (expand, then contract). Existing games get
assigned to Steve's account.
*Done:* tenant-isolation tests pass in CI (host A cannot list, read-for-write,
edit or delete host B's games); `/code-review high` clean.

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

**R4. Remove NFL logos** — `Haiku` — ✅ shipped 2026-11-23.
Drop the ESPN logo CDN; keep team colors and abbreviations with the generic
badge.
*Done:* no request to any logo CDN during a full game; browser check of TV,
grid and setup.

**R4a. Score provider layer and shared cache** — `Sonnet` (design done in
[decision 001](decisions/001-score-providers.md)) — Depends on: R3 ✅ (the
`scoring` field, `GameLogic.scoringMode`), probe fixtures.
Adapters for ESPN and BALLDONTLIE behind one `LiveGame` shape;
`SCORE_PRIMARY` / `SCORE_SECONDARY` with failover; `live_slates` table and
fs equivalent; one claimed refresh per league and date every 15 s; boards merge
the slate into `liveScore` on read and write only on quarter completion; the
"live feed unavailable" fallback to the manual panel; `/api/todays-games` reads
the slate.
*Done:* fixture tests from the 2026-11-23 probe for both adapters, failover,
quarter-end detection with and without `period`, host-wins, and claim
concurrency in both stores; `/code-review medium` clean; a simulated 50-board
run makes ≤4 provider calls a minute.

**R5. Payments** — `Opus` — Depends on: R2, R16.
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
Vercel Pro (Hobby forbids commercial use), Neon paid plan with autoscaling for
game day, Stripe account, optional LLC. The domain moved to R16.
*Done:* all accounts exist.

**R16. Name and domain** — `Sonnet` research, `Steve` buys — Depends on: none.
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
with the TV-view demo, how it works, pricing (decision 003), FAQ, legal (R6),
the search pages from R12, and "Start a board" into the app. No NFL marks.
**Live by 2027-01-04** so search engines index it before the playoffs.
*Done:* mockups approved; site live on the apex domain; Lighthouse, link check
and accessibility pass in every look; version in the footer and `<meta
name="version">`; Search Console set up and pages submitted.

### Milestone 2 — Ready for game-day load (target 2027-01-10)

**R8. Cache board reads at the edge** — `Opus` — Depends on: R3, R4a.
`GET /api/game/:id` currently reads Neon on every poll (ETag is computed after
the read) and may write (auto-cutoff; R4a already removes the live-score
writes). Move the remaining server-owned writes off the read path, then send `s-maxage=2, stale-while-revalidate` so eight screens
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

**R12. Landing and search pages** — merged into R17 (2026-11-23), which ships
them earlier so they are indexed before the playoffs.

**R13. Guest-to-host loop** — `Sonnet` — Depends on: R5.
"Host your own board" on the player and TV views, with a referral code
tracked to sign-ups.
*Done:* referral attribution visible in the database.

**R14. Soft launch on the NFL playoffs** — `Steve` — Depends on: M1, M2.
Invite-only use starting with Wild Card weekend (mid-January 2027) as the real
load test; feedback through GitHub Issues.

**R15. Ads and short videos** — `Steve` (Sonnet drafts copy) — Depends on: R17.
TikTok, Reels and Shorts of the TV grid and the winner reveal; Google and Meta
ads on generic squares terms in the last three weeks; Reddit and Facebook
office-pool groups.

---

## Later (after 2027-02-14)

- Phone app wrappers (Capacitor) for App Store and Google Play discovery —
  check Apple's real-money gaming guideline first.
- Spring basketball tournament push (NBA/Other already supported).
- Unlimited squares after a grid sells out (open questions in memory notes).
- Apple TV: not planned — AirPlay and smart-TV browsers cover it.

## Recently shipped

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

1. Free-tier limit: 25 players, or one free board of any size with the footer?
2. Ad budget for the final three weeks?
3. Form an LLC before taking payments?
4. Keep the name "Super-Squares" pending the trademark check? (Decides the
   domain, R16.)
