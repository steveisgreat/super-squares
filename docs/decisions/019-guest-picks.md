# 019 — Guest picks: a guest claims squares by name, from one device

**Date:** 2026-11-24 · **Status:** accepted (approved by Steve 2026-11-24) · **Roadmap:** R28 · **Related:** 004, 008, 009, 011, 012, 016, 018, 020 (section 5 now covers every name; the app calls guest picks "player picks" and the page "Player View")

## Context
Until now only the host writes to a board. The host wants to share the `/<code>` link
(for example in an Evite) and have guests claim their own squares before the party. This is
the first write open to someone with no account. Steve chose the identity (option A): a
typed name plus a private key kept by the guest's browser. It must work in password mode on
a database without migration 002, and one person must not be able to race past the cap.

## Decision

### 1. What a guest can do: claim and release their own squares, nothing else
Only while the board is **picking** and the host has guest picks **on** (off by default).
Never another person's square, a name change, paid marks, settings, scores or payouts.
Every other write keeps its current check.

### 2. Identity: a name tied to one device
- **Key.** 32 random bytes made by the server, in an HttpOnly cookie `sbs_guest`
  (SameSite=Lax, Secure on HTTPS, `Path=/api/game/<id>`, 180 days). It is set when the guest
  taps **Pick squares**, not when they view the board. A cookie rather than localStorage:
  Safari deletes script-written storage after 7 days without a visit, and an Evite goes out
  weeks ahead. If cookies are blocked, the page says so before anything is claimed.
- **Tag.** `sha256(gameId + ':' + key)`, shortened to 22 base64url characters, stored as
  `players[name].g`. The board document is public, so it holds only the tag. The tag can't be
  turned back into the key and differs on every board.
- **One device, one name; one name, one device** on a board. The squares with that name are
  the device's squares, so the binding follows a host's rename, and ends when the host removes
  or reassigns them all. After releasing everything a guest may choose a new name.
- **A taken name is refused** (ignoring case, spaces and the ₁₂ suffix), including a name the
  host typed: "Add a last initial, or ask the host." Without this, anyone could take over a
  name, and its paid mark, by typing it.
- **Names** are 1–10 characters: letters, digits, space and `. ' - &`. No control or
  invisible characters.

### 3. The cap
`guestPick: { on, max, liftAt, lifted }` in the board document, changed only by the host
(`max` 1–100, default 5; `liftAt` a UTC time or null; `lifted` the switch). The cap counts
every square under the guest's name. It no longer applies once `lifted` is true or the
server's clock passes `liftAt`, judged at write time, with no timer (decision 007).

### 4. One atomic write (decision 008)
A pure `GameLogic.applyGuestOp(game, op, ctx)` checks every rule against the current document
and returns the next one; the route writes it with `updateGame` and that document's
`updatedAt`, and on a lost race re-reads and checks again (up to 8 tries with a short random
wait, because a shared link brings a crowd). The cap, the names and the squares are all in the
one document that the write is conditional on, so two phones can't get past any of them. A
host lock or cutoff that lands first refuses the pick.

| Operation | Rules |
|---|---|
| `claim { name, squares }` | All or nothing. A square already yours counts as done, so a retry is safe. Any taken square refuses the lot and names which |
| `claim { name, count, have }` | Server picks random empty squares. `have` is how many the phone thinks it holds; a mismatch is refused, so a retry can't claim twice |
| `release { squares }` | Own squares only, and never below the number already paid |

`pickMode` applies to guests: Manual Only refuses `count`, Auto Only refuses `squares`.

### 5. Payment
Guest picks start **unpaid**, and only the host marks paid (decision 004). Paid is kept per
name today, so a paid guest who claims more would look paid for all of it. Therefore:
- Claiming more after being paid keeps the paid squares paid and shows **only the new ones as
  owed**: an optional `players[name].paidSquares` count. Marking the name paid or unpaid
  clears it. A player with no such field behaves exactly as today.
- A guest can't release squares the host has marked paid ("Ask the host").
- A name with no squares left carries no paid mark over to whoever takes it next.

### 6. Host oversight
- Each guest square stores its claim time (`squares[i].at`, server clock). Manage Players
  shows who picked on their own device, their squares and times.
- The host can remove or reassign one square, remove a player as today, turn guest picks off
  (existing picks stay), change the cap, lift it, and **remove all unpaid guest picks** in one
  confirmed step (also the answer to someone flooding the board).
- Host edits still save the whole document, and busy guest picking would make them conflict
  all the time. So on a 409 the client re-applies **that one host change** to the newer
  document (up to 3 times) and reports only a real clash, such as a square just taken. No new
  host route.

### 7. Endpoint access

| Endpoint | Anyone with the board id | Owner |
|---|---|---|
| `POST /api/game/:id/guest` → `{ name }` (name null when unbound); sets the key cookie if there is none | 200; 409 off or not picking; 404 | same |
| `PATCH /api/game/:id/guest` (claim, release) → `{ game, name }` | 200; 400 bad; 401 no key; 409 rule or race | same |
| every other write | as today | as today |

The `Origin` check, the 4 KB operation body limit and the fail-closed 503 (decision 012)
apply. It reads no accounts table, so it behaves the same in accounts, password and off modes.

### 8. Storage: no migration
Everything is in the board document and validated by `validateGame` (exact types for `at`,
`g`, `paidSquares` and `guestPick`). The full-board size test is redone and `MAX_GAME_BODY`
raised to match. Nothing has to run on production before the push.

| Option | Why not |
|---|---|
| A `guests` table (migration 007) | The cap and the pick would be two writes in two places; the HTTP driver can't hold a lock across our rules |
| Key in localStorage | Safari's 7-day deletion; readable by any script on the page |
| Claim open to any name, no key | Anyone could release anyone's squares |

## Accepted risks
- **The cap is honor-system** (Steve): a private window or another phone is a new person.
- **Vandalism:** anyone with the link can fill the board or type a rude name, which shows on
  the TV. The flag is off by default and the host can switch off, remove and clear. Per-IP
  limits come with R10.
- **Lost key** (cleared cookies, an email app's own browser): the guest sees the name as
  taken and the host fixes the picks.
- **Shared phone:** one name per board on that phone.

## Tests (required)
On `applyGuestOp` (test-first) and the route: cap, `liftAt` and switch; parallel claims at the
cap and for one square; own squares only; picking only, off, and a lock between read and
write; taken names; name rules; pick mode; retry safety; paid rules and owed amounts; no
cookie, another board's cookie, foreign `Origin`, misconfigured 503; a host save that loses to
a guest pick gets a 409; the key is never in the document; all three auth modes, and Postgres
on both stores without migration 002.

## Consequences
- The privacy and terms pages must say that guests type their own names and get `sbs_guest`.
- A per-board "Require email" switch (option D) stays in Later.
