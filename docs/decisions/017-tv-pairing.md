# 017 — TV pairing: a code to pair, a secret token to follow

**Date:** 2026-11-24 · **Status:** accepted · **Roadmap:** R23 · **Related:** 007, 012, 016

## Context
At a party the TV is a smart-TV browser or a spare laptop that nobody wants to sign in
on. The host needs to point it at a board from their phone, and when the host moves to
another board the TV should move too. A TV must never be able to change anything.

## Decision
- **Code and token.** A TV opening `/tv` calls `POST /api/tv` (anonymous) and gets a
  6-character code from the join-code alphabet (decision 016), which it shows large, and
  a 32-byte random token, which it keeps in localStorage (memory if blocked). The code
  only lets a host pair. The token is the only key that reads the pairing.
- **Storage.** Table `tv_pairings` (migration 005), and `data/tv-pairings.json` in the fs
  store. Only the sha256 of the token is stored, like session tokens (decision 012).
- **Pairing.** `POST /api/tv/pair { code, gameId }` is owner-checked on the board
  (`denyUnlessOwner`; in password and off modes, the board must exist). It sets `game_id`
  and `owner_id` and sets `code` to null in one conditional update, which retires the code.
- **Expiry at read time, no timers** (decision 007). An unpaired pairing lives 15 minutes.
  A paired one lives 24 hours from `paired_at`, and each follow restarts that time.
  Expired rows are deleted when a new pairing is created. Waiting pairings are capped at
  100,000, as a guard on storage size, not as a rate limit.
- **Follow rule.** `POST /api/tv/follow { gameId }` (owner-checked) moves every live
  pairing of the caller to that board. Game Day calls it when the host opens a **live**
  (`started`) board they own, never a finished one, so reviewing an old board doesn't
  pull the TV off the game. Pairing from the chooser also moves every TV of that host.
  With auth off, or in password mode, the one host's pairings have a null owner.
- **The TV reads, never writes.** The TV holds only the token. It never gets a session,
  a cookie or an owner flag. `/api/tv/*` answers carry only `code`, `state` and `gameId`,
  and a game id is a read capability (decisions 009, 012). A paired TV runs the
  read-only TV view (`renderTV`), without the Exit button.
- **Device chooser.** "What's in the room?" on Game Day once the board is locked: Show on
  a TV (type the code), Score from another phone (text pointing to today's path, signing
  in as the host; R24 replaces it), Invite players (the R22 share). It opens once per
  board on lock and stays on an **In the room** button.

## Consequences
- **Deploy order:** apply migration 005 to production before the push that ships R23.
  Only the `/api/tv` routes touch the table, so other features keep working without it,
  but pairing fails.
- **Guessing risk:** a signed-in host could try codes and point a stranger's waiting TV
  at their own board. The codes have about 887 million values and last 15 minutes, and
  the worst outcome is that a TV shows the wrong board. Accepted, with no throttle
  beyond the firewall rule (R10).
- **Flooding:** anyone can create waiting pairings. Locking out real TVs takes about
  100 requests a second for 15 minutes, which R10's per-IP rule should stop.
- Not checked on a real smart-TV browser. The `/tv` page uses only `fetch` and
  `localStorage`, as the existing TV view does.
