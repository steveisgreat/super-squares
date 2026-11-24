# 009 — Access model: one site-wide host session; the game id is a read capability

**Date:** 2026-08 (recorded 2026-11-23) · **Status:** accepted; **to be replaced** by
[012](012-host-accounts.md) when R2 ships · **Source:** migration plan Phase 4

## Context
On the LAN the network was the boundary. In the cloud the game UUID is not secret: it is
on the player QR, the TV link and the score-entry link, so every guest holds it.

## Decision
The id authorizes reading one game and nothing else. Everything that manages games is
host-only behind one site-wide password.

| Endpoint | Access |
|---|---|
| `GET /api/game/:id`, `GET /api/hosts`, `GET /api/session` | public |
| `GET /api/games`, `GET /api/todays-games` | host only |
| `POST /api/game`, `PUT` and `DELETE /api/game/:id` | host only |

`HOST_PASSWORD` is checked with `timingSafeEqual`; `POST /api/session` sets a stateless
signed cookie (`<expiry>.<HMAC-SHA256>`, 30 days, key `SESSION_SECRET` or the password).
No session store, no schema change, no dependency. **`HOST_PASSWORD` unset disables auth
entirely**, which keeps the LAN build prompt-free. Authorization is route-level, never in
the store, so server-owned writes triggered by anonymous reads keep working.

## Consequences accepted
Phone score entry needs the password; the TV auto-jump falls through to Home when
signed out (`#tv-<id>` still works); there is no real rate limit on serverless, only a
fixed 400 ms delay on failed logins plus a long random password. Host accounts (R1)
will supersede the single password.
