# 024 — Consent is given where the sign-in finishes

**Date:** 2026-11-25 · **Status:** accepted (Steve, 2026-11-25), built with R34; the lawyer still
reviews the wording · **Roadmap:** R34, R6 · **Related:** 012, 022

## Context
R34 needs an opt-in for news about next season. R6 needs a record of which Terms a host accepted.
Both belong to sign-in, which has two steps (ask for an email, then a code or a link) and may finish
on another device.

## Decision
- **Consent travels with the proof, not with the request for an email.** The box and the Terms notice
  sit above each button that finishes a sign-in (the code step and the `#login-` page) and go in
  `POST /api/login/verify` as `{ news, terms }`. Anyone can type anyone's address at the first
  step, so a box there could opt in a stranger.
- **Terms:** a notice ("By signing in you agree to the Terms and Privacy Policy"), no tick box. The server
  stores its own `TERMS_VERSION` (`lib/auth.js`) and the time, only when the page says it showed the
  notice. A new version moves the date at the next sign-in; the same version keeps it. The
  version starts with `draft-` until the lawyer review.
- **News:** unticked by default. Ticking sets `hosts.news_opt_in_at`. Leaving it unticked at a later
  sign-in changes nothing: the page can't know who is signing in, so an empty box is not a "no".
  Turning it off is in the account menu (News about next season), which sets the column back to
  null. `GET`, `PUT /api/news` act on the session's host only, in accounts mode only.
- **Storage:** three nullable columns on `hosts` (migration 009), written by the same statement that
  signs the host in. Kept out of `getHost`, which every guarded request runs.

## Consequences
- Without migration 009 every accounts-mode sign-in fails, as with 008.
- A host signed in for 90 days under an old version is not asked again until the next sign-in.
- Nothing sends these emails yet. Whatever does must carry an unsubscribe link that works signed out
  and a postal address, and must read `news_opt_in_at` at send time.
