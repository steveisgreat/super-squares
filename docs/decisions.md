# Decisions

One line per decision. Detail lives in `docs/decisions/`.

| # | Date | Decision |
|---|---|---|
| [001](decisions/001-score-providers.md) | 2026-11-23 | Live scores come from a configurable primary and secondary provider (ESPN, backed up by BALLDONTLIE) behind one shared cache row per league and date; boards read it and never call a provider themselves; the host's entries always win. |
| [002](decisions/002-web-app-first.md) | 2026-11-23 | Web app first: no native iOS, Android or Apple TV app before 2027-02-14. |
| [003](decisions/003-host-pays-pricing.md) | 2026-11-23 | The host pays and players never do: free board up to ~25 players, $7.99 Big Game Pass, $24.99 Season Pass (prices a hypothesis). Prices and free limit superseded by 022; the host-pays rule stands. |
| [004](decisions/004-no-pool-money.md) | 2026-11-23 | We never hold or move pool money; the ToS says entertainment and tracking only. |
| [005](decisions/005-no-nfl-marks.md) | 2026-11-23 | No NFL marks: no team logos (replaced by 013), "the Big Game" in marketing; team names and colors stay. |
| [006](decisions/006-one-codebase-two-targets.md) | 2026-08 | One codebase for the LAN and Vercel builds; storage behind `lib/store.js` with fs and Postgres backends. Partly superseded by 014 (the LAN build is gone; the rest stands). |
| [007](decisions/007-live-scores-on-read.md) | 2026-08 | Live scores refresh on read with a claimed, throttled slot, never on a timer. |
| [008](decisions/008-atomic-concurrency.md) | 2026-08 | `updateGame` is one atomic check-and-write; a stale `updatedAt` returns a conflict. |
| [009](decisions/009-host-password-access.md) | 2026-08 | One site-wide host password; a game id is a read capability only (to be replaced by 012). |
| [010](decisions/010-ported-to-rileysoft-model.md) | 2026-11-23 | Ported to the RileySoft model as a hosted app; code stays at the repo root for now. |
| [011](decisions/011-manual-scoring.md) | 2026-11-23 | Manual scoring is a per-game mode (default for new games); taps are operations on `PATCH /api/game/:id/score` applied by pure `GameLogic.applyScoreOp`; a drawn winner survives edit and undo. |
| [012](decisions/012-host-accounts.md) | 2026-11-23 | Host accounts: emailed link plus 8-digit code, signed cookie with a revocable version, `games.owner_id` column, owner-only writes, fail closed on Vercel; our own code, no auth library (built in R2, replaces 009). |
| [013](decisions/013-team-logos-restored.md) | 2026-11-24 | Team and league logos restored from ESPN's logo CDN, with a helmet fallback; replaces 005's logo rule, accepting the trademark risk. "The Big Game" in marketing stays. |
| [014](decisions/014-retire-lan-build.md) | 2026-11-24 | Retire the LAN build: no certificates, LAN discovery, `.bat` scripts or `/api/hosts`; `npm start` is a localhost-only dev server; one code path and the fs and Postgres stores stay. Partly supersedes 006. |
| [015](decisions/015-payout-tracking.md) | 2026-11-24 | Payout tracking: optional `paidOut` record per quarter (who and how much, no money moves); "Needs settling" is derived by comparing it with the current result; ops on `PATCH /api/game/:id/payout` via pure `GameLogic.applyPayoutOp`. |
| [016](decisions/016-join-codes.md) | 2026-11-24 | Join codes: 6-character `games.join_code` column (migration 004), a public read capability like a game id; `/<code>` opens the guest view; TV shows a join QR before lock and never who hasn't paid. |
| [017](decisions/017-tv-pairing.md) | 2026-11-24 | TV pairing: `/tv` shows a 6-character code and keeps a secret token (stored hashed, table `tv_pairings`, migration 005); the host pairs by code; paired TVs follow the host's live board; expiry at read time; a TV never gets write access. |
| [018](decisions/018-scorer-hand-off.md) | 2026-11-24 | Scorer-phone hand-off: a one-time QR (5 min) gives one phone score entry on one board for 24 h (`scorer_grants`, migration 006, hashes only, cookie scoped to that board's path); never a host session; the host can remove all; sign out everywhere ends it. |
| [019](decisions/019-guest-picks.md) | 2026-11-24 | Guest picks: guests claim and release their own squares while picking, by typed name plus a device key (HttpOnly cookie per board; only a per-board tag in the document); cap and lift judged in the one conditional write; a paid guest's new squares are owed separately; no migration. |
| [020](decisions/020-paid-per-square.md) | 2026-11-24 | Paid is per square for every player: adding squares never pays for or un-pays the ones a name already had; the host can set how many are paid for; whole squares only; no migration. Extends 019 section 5. |
| [021](decisions/021-host-themes.md) | 2026-11-24 | One color theme per host, from six fixed ones (Neon is the default); table `host_themes` (migration 007) keyed by host, or `site` where there is one host; every screen showing a host's board wears it; a separate public read per board, so game reads are unchanged. |
| [022](decisions/022-postseason-pass.md) | 2026-11-24 | 2026–27 is a free launch season with next year's price announced up front. From 2027–28: regular season free, postseason boards free up to 10 players, one $7.99 Postseason Pass per host through the Big Game; no Season Pass. Supersedes 003's prices and free limit. |
