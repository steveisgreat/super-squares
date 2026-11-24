# Runbook — Super-Squares

How to run, configure, deploy, recover and roll back. Accurate as of 2026-11-24.

**Production:** <https://play-super-squares.vercel.app> (Vercel project
`super-squares`). `super-squares.vercel.app` is an unrelated third-party site; never
link to it.

## Environment variables

Template: `.env.example`. Real values live in `.env.local` (git-ignored) and in the
Vercel project settings. Never commit them.

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | cloud | Neon **pooled** connection string (host contains `-pooler`). Unset means the fs backend. |
| `HOST_PASSWORD` | cloud | Host sign-in. Use 20+ random characters; it is the only brute-force defense. Unset disables auth off Vercel (local dev); on Vercel, unset with no accounts means 503 on every host route. |
| `SESSION_SECRET` | accounts (optional for password) | Signs the session cookie. Accounts mode requires 32+ random characters; password mode defaults to `HOST_PASSWORD`. |
| `AUTH_MODE` | cloud, after R2 | `accounts` turns on host accounts (decision 012). Unset keeps password mode. Any other value fails closed (503). Turn it on with the steps in "Turn on host accounts" below. |
| `APP_ORIGIN` | accounts | The site's own `https://` origin, used in emailed links. |
| `RESEND_API_KEY`, `EMAIL_FROM` | accounts | Sign-in email. Off Vercel, without the key, the link and code print to the server console. Turn click tracking off for the domain in Resend: it rewrites the link. |
| `LOGIN_EMAILS_PER_HOUR` | optional | Site-wide cap on sign-in emails. Default 200. |
| `SCORE_PRIMARY`, `SCORE_SECONDARY` | cloud, for Live mode | Score provider adapter names (decision 001): `espn` and `balldontlie`. Local default is `espn` with no secondary; on Vercel, unset means no provider, so every Live board shows "live feed unavailable" and falls back to the manual panel. |
| `BALLDONTLIE_API_KEY` | when it is the secondary | Key for BALLDONTLIE; never logged or returned. |
| `PORT` | local dev | Defaults to 3000. |

Node does not read `.env.local` by itself. Export the variables in the shell before
`npm start`, or deploy to Vercel where they are set per environment.

## Run locally (development)

`npm start` serves <http://localhost:3000> on 127.0.0.1 only (decision 014). Data goes to
`data/`. A phone can't reach it; check phone flows on a Vercel preview.

To run the cloud storage locally, set `DATABASE_URL` to a Neon **branch**, never the
production database, then `npm start`.

## Tests

`npm test` runs every suite. `test-store-pg.js` skips unless `DATABASE_URL` is set; point
it at a Neon branch, since it writes rows.

CI (`.github/workflows/test.yml`) runs the offline suites on every push to `master` and
every pull request. The Postgres suites run there too once the repository secret
`TEST_DATABASE_URL` exists. It is set (2026-11-24) to the **pooled** string of the Neon
branch `ci-tests` (project Super-Squares), made from production with its `games` rows
deleted. Use the same branch for local runs. To replace it, copy a branch's pooled string
and run `gh secret set TEST_DATABASE_URL` (it asks for the value, so the string stays out
of the shell history). Never the production string. Delete the secret to turn them off.

## Database

Schema is every file in `migrations/`, in number order (each is idempotent). Apply one by
hand with the Neon SQL editor or `psql "$DATABASE_URL" -f migrations/<file>.sql`
before the first deploy that needs it. `003_live_slates.sql` (the shared live-score row, R4a) should be applied before the deploy that ships it: without the table, Live boards read as "live feed unavailable" and log an error, and nothing else breaks. `002_host_accounts.sql` is needed only before
`AUTH_MODE=accounts` is set; password mode runs without it (tested 2026-11-23). Migrations only add (expand, then contract).
Neon free tier suspends after about 5 minutes idle, so the first query pays a 1–3 s cold
start. Do not add a keepalive or scheduled ping.

## Turn on host accounts

Once, after R16 (sending domain). R10's firewall rule is already live (below).

1. Deploy with `AUTH_MODE` unset. Password mode keeps working.
2. Apply `migrations/002_host_accounts.sql`.
3. `node --env-file=.env.local scripts/assign-owner.js <email>` prints the database host
   and the counts. Check both, then run it again with `--apply`.
4. Set `SESSION_SECRET`, `APP_ORIGIN`, `RESEND_API_KEY`, `EMAIL_FROM`, then
   `AUTH_MODE=accounts`, and redeploy.
5. Run step 3 again, for boards made in between. Sign in and check the list.

To go back, unset `AUTH_MODE` and redeploy. Boards keep their owner.

## Sign-in rate limit (R10)

A Vercel Firewall custom rule, live since 2026-11-24. It is project config, not in
`vercel.json`, so it applies at once with no deploy, to production and previews:

- Name `Sign-in rate limit` (id `rule_sign_in_rate_limit_2w2DWH`).
- Matches `POST /api/login` or `POST /api/login/verify`. That covers `HOST_PASSWORD`
  sign-in today and the email and code steps in accounts mode.
- Fixed window, 10 requests per 60 s per client IP. Over that, Vercel answers 429 before
  the function runs.

It sits on top of the app's own limits (the code's try count, `LOGIN_EMAILS_PER_HOUR`).
Hobby allows one rate-limit rule and fixed window only, and counters are per region.
See or change it in the dashboard (Project, Firewall) or with
`vercel firewall rules inspect "Sign-in rate limit"`. To turn it off, set it inactive
there. Never delete it while `HOST_PASSWORD` is the only defense.

## Security headers

The Content-Security-Policy is in `vercel.json` and nowhere else; `server.js` reads it
from there. It allows scripts from this origin only: no inline script, no `on…=`
attributes, no third-party script. Images may come from this origin, `data:` and
`https://a.espncdn.com` (team logos, decision 013). A new font, script, image or API host
needs a change there. On previews it blocks the Vercel toolbar, which is expected.

## Deploy (Vercel)

- Project: `steveisgreat/super-squares`, linked in `.vercel/` (git-ignored). Framework
  preset "Other", no build command, output directory `public` (`vercel.json`).
- **Production tracks `master`: pushing `master` deploys production.** Only Steve pushes.
  Other branches (for example `cloud`) get preview URLs.
- **Before the first push that ships R4a part 2:** apply `migrations/003_live_slates.sql`
  and set `SCORE_PRIMARY=espn` (plus `SCORE_SECONDARY` and `BALLDONTLIE_API_KEY` if
  wanted) in Vercel production. On Vercel, unset means no provider (decision 001), so
  without them every Live board shows "live feed unavailable" and the New Game picker
  answers 502.
- Check a preview on a phone over cellular data, not WiFi. The version in the Home footer
  shows `+<short hash>` on preview builds; production shows the plain version.
- Vercel Hobby forbids commercial use; the paid launch needs Pro (roadmap R7).

## Smoke check after a deploy

1. Open the site, confirm the version in the Home footer is the one you expect.
2. Sign in with `HOST_PASSWORD`, create a game, open its `#player-<id>` link in a private
   window (public read works signed out).
3. `GET /api/games` signed out returns 401.
4. The page response has a `Content-Security-Policy` header, and the browser console shows
   no policy errors on Home and on a `#tv-<id>` view.

## Roll back

Vercel dashboard (or `vercel rollback`): promote the previous production deployment.
Database changes only add, so the previous code runs against the newer schema. The
pre-cloud LAN version is tagged `local-lan-v1`.

## Not yet written

Monitoring and alerts, the game-day checklist, Neon compute scaling before game day,
and the load-test results (roadmap R8–R11).
