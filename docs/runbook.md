# Runbook — Super-Squares

How to run, configure, deploy, recover and roll back. Accurate as of 2026-11-23.

## Environment variables

Template: `.env.example`. Real values live in `.env.local` (git-ignored) and in the
Vercel project settings. Never commit them.

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | cloud | Neon **pooled** connection string (host contains `-pooler`). Unset means the fs backend. |
| `HOST_PASSWORD` | cloud | Host sign-in. Use 20+ random characters; it is the only brute-force defense. Unset disables auth on the LAN; on Vercel, unset with no accounts means 503 on every host route. |
| `SESSION_SECRET` | accounts (optional for password) | Signs the session cookie. Accounts mode requires 32+ random characters; password mode defaults to `HOST_PASSWORD`. |
| `AUTH_MODE` | cloud, after R2 | `accounts` turns on host accounts (decision 012). Unset keeps password mode. Any other value fails closed (503). **Leave unset until the rest of R2 ships (escaping audit, CSP, assigning existing boards).** |
| `APP_ORIGIN` | accounts | The site's own `https://` origin, used in emailed links. |
| `RESEND_API_KEY`, `EMAIL_FROM` | accounts | Sign-in email. Off Vercel, without the key, the link and code print to the server console. Turn click tracking off for the domain in Resend: it rewrites the link. |
| `LOGIN_EMAILS_PER_HOUR` | optional | Site-wide cap on sign-in emails. Default 200. |
| `PORT` | LAN | Defaults to 3000. |

Node does not read `.env.local` by itself. Export the variables in the shell before
`npm start`, or deploy to Vercel where they are set per environment.

## Run locally (LAN build)

`start-app.bat` (opens the browser), `start-server.bat` (logs in the window),
`stop-server.bat`, or `npm start`. The server prints the localhost and phone URLs. Data
goes to `data/`; back that folder up (the RileySoftLabs backup script covers it).
Phones on the same WiFi use the printed `https://<ip>:3000` and accept the one-time
certificate warning.

To run the cloud storage locally, set `DATABASE_URL` to a Neon **branch**, never the
production database, then `npm start`.

## Tests

`npm test` runs every suite. `test-store-pg.js` skips unless `DATABASE_URL` is set; point
it at a Neon branch, since it writes rows.

## Database

Schema is every file in `migrations/`, in number order (each is idempotent). Apply one by
hand with the Neon SQL editor or `psql "$DATABASE_URL" -f migrations/<file>.sql`
before the first deploy that needs it. `002_host_accounts.sql` is needed only before
`AUTH_MODE=accounts` is set; password mode runs without it (tested 2026-11-23). Migrations only add (expand, then contract).
Neon free tier suspends after about 5 minutes idle, so the first query pays a 1–3 s cold
start. Do not add a keepalive or scheduled ping.

## Deploy (Vercel)

- Project: `steveisgreat/super-squares`, linked in `.vercel/` (git-ignored). Framework
  preset "Other", no build command, output directory `public` (`vercel.json`).
- **Production tracks `master`: pushing `master` deploys production.** Only Steve pushes.
  Other branches (for example `cloud`) get preview URLs.
- Check a preview on a phone over cellular data, not WiFi. The version in the Home footer
  shows `+<short hash>` on preview builds; production shows the plain version.
- Vercel Hobby forbids commercial use; the paid launch needs Pro (roadmap R7).

## Smoke check after a deploy

1. Open the site, confirm the version in the Home footer is the one you expect.
2. Sign in with `HOST_PASSWORD`, create a game, open its `#player-<id>` link in a private
   window (public read works signed out).
3. `GET /api/games` signed out returns 401.

## Roll back

Vercel dashboard (or `vercel rollback`): promote the previous production deployment.
Database changes only add, so the previous code runs against the newer schema. The
pre-cloud LAN version is tagged `local-lan-v1`.

## Not yet written

Monitoring and alerts, the game-day checklist, Neon compute scaling before game day,
and the load-test results (roadmap R8–R11).
