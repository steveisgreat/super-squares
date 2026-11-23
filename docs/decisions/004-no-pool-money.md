# 004 — We never hold or move pool money

**Date:** 2026-11-23 · **Status:** accepted · **Roadmap:** R5, R6

## Decision
Super-Squares is software for tracking a squares pool. We never collect, hold or pay
out the pot. Hosts and players settle money between themselves. The Terms of Service
say the product is for "entertainment and tracking only". The only money we take is
the host's pass purchase (decision 003).

## Consequences
The "Mark as Paid" checkbox and payment list stay as bookkeeping aids, with no payment
processing behind them. Marketing and the Terms (R6) must not imply that we handle
winnings. Stripe is used only for pass purchases (R5). The Terms get a lawyer's review
before launch (Steve).
