# 013 — Team and league logos restored

**Date:** 2026-11-24 · **Status:** accepted (Steve's call, 2026-11-24) · **Roadmap:** R4
· **Replaces:** the "no team logos" part of 005. The rest of 005 stands: marketing says
"the Big Game", never "Super Bowl".

## Decision
NFL and NBA team and league logos are back in the app, as before R4: the grid's axis
labels, team badges, the setup preview and the league badge show the team's logo,
loaded at runtime from ESPN's public logo CDN (`a.espncdn.com`) by team abbreviation.
No logo files are bundled. A logo that fails to load becomes the generic helmet (or, for
a league logo, its text), so nothing looks broken offline.

## Risks Steve accepted
- **Trademark.** Team and league logos are registered marks. Showing them in a product
  we sell, without a license, risks a takedown or cease-and-desist from the leagues.
  That is the risk 005 avoided. If one arrives, revert this decision's commit; the
  badge falls back to names and colors only.
- **The CDN isn't ours.** ESPN's logo CDN is not a published API. It can change, block
  hotlinking, or go away; the helmet fallback covers that.
- **Third-party request.** Each viewer's browser now fetches images from ESPN, which sees
  the viewer's IP address. The privacy page says so.

## Consequences
- The Content-Security-Policy (`vercel.json`) allows `img-src 'self' data:
  https://a.espncdn.com`. `data:` is for the inline helmet image.
- The old inline `onerror=` fallbacks are replaced by one capturing `error` listener in
  `public/ui.js`, since the policy forbids inline handlers.
- R4's done check ("no request to any logo CDN") no longer applies.
