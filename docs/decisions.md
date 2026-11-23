# Decisions

One line per decision. Detail lives in `docs/decisions/`.

| # | Date | Decision |
|---|---|---|
| [001](decisions/001-score-providers.md) | 2026-11-23 | Live scores come from a configurable primary and secondary provider behind one shared cache row per league and date; boards read it and never call a provider themselves; the host's entries always win. |
| [002](decisions/002-web-app-first.md) | 2026-11-23 | Web app first: no native iOS, Android or Apple TV app before 2027-02-14. |
| [003](decisions/003-host-pays-pricing.md) | 2026-11-23 | The host pays and players never do: free board up to ~25 players, $7.99 Big Game Pass, $24.99 Season Pass (prices a hypothesis). |
| [004](decisions/004-no-pool-money.md) | 2026-11-23 | We never hold or move pool money; the ToS says entertainment and tracking only. |
| [005](decisions/005-no-nfl-marks.md) | 2026-11-23 | No NFL marks: no team logos, "the Big Game" in marketing; team names and colors stay. |
| [006](decisions/006-one-codebase-two-targets.md) | 2026-08 | One codebase for the LAN and Vercel builds; storage behind `lib/store.js` with fs and Postgres backends. |
| [007](decisions/007-live-scores-on-read.md) | 2026-08 | Live scores refresh on read with a claimed, throttled slot, never on a timer. |
| [008](decisions/008-atomic-concurrency.md) | 2026-08 | `updateGame` is one atomic check-and-write; a stale `updatedAt` returns a conflict. |
| [009](decisions/009-host-password-access.md) | 2026-08 | One site-wide host password; a game id is a read capability only (to be replaced by R1/R2). |
| [010](decisions/010-ported-to-rileysoft-model.md) | 2026-11-23 | Ported to the RileySoft model as a hosted app; code stays at the repo root for now. |
