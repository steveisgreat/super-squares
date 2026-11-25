# 003 — The host pays; players never do

**Date:** 2026-11-23 · **Status:** accepted; prices and free limit **superseded by**
[022](022-postseason-pass.md) (the host-pays rule stands) · **Roadmap:** R5, R12, R13

## Decision
Only the person who hosts a board pays. Players join free, always.
- **Free board:** up to about 25 players, with a "Host your own board" footer that
  turns guests into hosts.
- **Big Game Pass:** $7.99 per board.
- **Season Pass:** $24.99.

The prices are a hypothesis to test in the January 2027 soft launch (R14), not a
commitment. The free-tier limit (25 players, or one free board of any size with the
footer) is still an open question in the roadmap.

## Consequences
The free limit must be enforced server-side (R5). The guest-to-host loop (R13) is the
main growth mechanism, so the footer and referral tracking are part of the product.
