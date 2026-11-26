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
2. Apply `migrations/002_host_accounts.sql`, then `008_referrals.sql` and `009_host_consent.sql`
   (both alter the tables 002 makes). **Without 008 and 009 every sign-in fails.** Check that
   `TERMS_VERSION` in `lib/auth.js` is the reviewed version, not a `draft-` one.
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
- **Before the push that ships R22:** apply `migrations/004_join_codes.sql` to production
  (decision 016). Every game read selects `join_code`, so without it every board fails to
  load. It only adds a nullable column and a unique index, so applying it early is safe.
  Then check `/<code>` on the preview: the rewrite is tested only locally.
- **Before the push that ships R23:** apply `migrations/005_tv_pairings.sql` to production
  (decision 017). Only `/api/tv` uses it, so without it only TV pairing fails. Then check
  `/tv` on the preview (rewrite in `vercel.json`).
- **Before the push that ships R24:** apply `migrations/006_scorer_grants.sql` to production
  (decision 018). Only the scorer-phone hand-off uses it, so without it only that fails.
- **R37 (and R38, which adds no migration):** `migrations/010_helpers.sql` was applied to production on 2026-11-25, before the push (decision 025). Only helper
  features use it, so without it only those fail (the host's Helpers screen says so). A phone holding a scorer code
  from before needs a new one, so don't ship R37 on a game day. It was applied to
  `ci-tests` the same day and the Postgres suites pass there. Rollback needs no database change.
- **R39:** `migrations/011_board_changes.sql` was applied to production on 2026-11-26, before the push
  (decision 025; applied to `ci-tests` 2026-11-25). Without it nothing fails: changes are not recorded and the host's list stays empty.
  It only adds a table.
- **R45a:** `migrations/012_usage_counters.sql` was applied to production on 2026-11-26, before the push (and to `ci-tests`;
  decision 027). `ADMIN_EMAILS` is set on Vercel Production. `#admin` opens only in accounts mode, so it refuses everyone until R2. Without it nothing fails: no service counts are kept and the admin page shows none. It only adds a
  table. Set `ADMIN_EMAILS` on Vercel (Production) to Steve's sign-in email; unset means nobody can open `#admin`.
- **R45c:** `migrations/013_heard_about_us.sql` must be applied to production **before** the push that
  ships R45c (applied to `ci-tests` 2026-11-26). Sign-in writes `login_requests.src` and `hosts.src`, and
  `#admin` reads the new `hosts` columns, so both fail without it once accounts mode is on. It only adds
  columns. Optional env (Production only) for the Database and Hosting cards: `NEON_API_KEY` +
  `NEON_PROJECT_ID` (`misty-lake-58761091`), `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID` + `VERCEL_TEAM_ID`
  (from `.vercel/project.json`). Neither provider offers a read-only key (see decision 027 section 5).
- **R33:** `migrations/007_host_themes.sql` was applied to production on 2026-11-24
  (decision 021). Without it every board shows the default theme and choosing one answers 503.
- **R13:** `migrations/008_referrals.sql` alters the tables of 002, which production doesn't have
  yet (checked 2026-11-25), so it goes on with it: "Turn on host accounts", step 2. Applied to
  `ci-tests` 2026-11-25. The sign-in request writes the new `login_requests.ref` column, so
  **without it every sign-in fails** once accounts are live. Count
  sign-ups per board: `select referred_by, count(*) from hosts where referred_by is not null group by 1 order by 2 desc;`
- **R34 and R6:** `migrations/009_host_consent.sql` (decision 024) goes on with 002 and 008, in that
  same step. Applied to `ci-tests` 2026-11-25. Who opted in to news:
  `select email from hosts where news_opt_in_at is not null;`
- **Before the first push that ships R4a part 2:** apply `migrations/003_live_slates.sql`
  and set `SCORE_PRIMARY=espn` (plus `SCORE_SECONDARY` and `BALLDONTLIE_API_KEY` if
  wanted) in Vercel production. On Vercel, unset means no provider (decision 001), so
  without them every Live board shows "live feed unavailable" and the New Game picker
  answers 502.
- Check a preview on a phone over cellular data, not WiFi. The version in the Home footer
  shows `+<short hash>` on preview builds; production shows the plain version.
- **Preview deployments use the production database.** Vercel's Preview `DATABASE_URL` has
  the same host as Production (checked 2026-11-25). To test writes or load, deploy a clean
  copy with `vercel deploy -e DATABASE_URL=<ci-tests pooled string>`, never printing it.
- Vercel Hobby forbids commercial use; the paid launch needs Pro (roadmap R7).

## Smoke check after a deploy

1. Open the site, confirm the version in the Home footer is the one you expect.
2. Sign in with `HOST_PASSWORD`, create a game, open its `#player-<id>` link in a private
   window (public read works signed out).
3. `GET /api/games` signed out returns 401. Two quick `GET /api/game/<id>` in a row: the second has
   `x-vercel-cache: HIT` (decision 023).
4. The page response has a `Content-Security-Policy` header, and the browser console shows
   no policy errors on Home and on a `#tv-<id>` view.

## Roll back

Vercel dashboard (or `vercel rollback`): promote the previous production deployment.
Database changes only add, so the previous code runs against the newer schema. The
pre-cloud LAN version is tagged `local-lan-v1`.

## Status check (R11)

`GET /api/health` answers `{"ok":true,"version":"…"}` from the function alone: it proves
Vercel and the code are up and costs no database time. `GET /api/health?db=1` also runs
`select 1` and adds `"db":"ok","dbMs":<n>`; a database failure answers 503 and logs
`health: database check failed`. **`?db=1` wakes a suspended Neon compute, so run it by
hand or from an alert, never from an uptime monitor on a timer** (that would be a keepalive).
An external monitor may poll the plain form only.

## Monitoring and alerts (R11, to set up)

Steve's steps, in the Vercel and Neon dashboards (confirm what the plan offers before relying
on it):

- Vercel: an alert or drain on function errors and 5xx rate; watch `?fresh=1` request volume
  (it skips the edge cache, decision 023).
- Vercel and Neon: spend limits and usage emails (below).
- Logs: `vercel logs`, or Project > Logs; search `health:`, `error`.

## Spending limits (R11, to set up)

Free use brings load with no income (decision 022). Before launch, Steve sets in the
dashboards: a Vercel spend limit (Pro, Settings > Billing > Spend Management) with an email
at about 50% and 80%; Neon usage alerts. Hobby has no overage, so a limit pauses the whole
account; Pro bills on demand until the limit. Neon free suspends compute when CU-hours or
egress run out, which takes the site down for the month.

## Game-day checklist (R11)

A week before: Pro plan on and spend limit set; run the load test (roadmap R9) and record the
result here; confirm `TEST_DATABASE_URL`-style branches are not the production string.
The day before:
1. Neon: raise the compute size/minimum for the day (never a ping). Note the old setting.
2. `GET /api/health?db=1` on production: `ok`, `dbMs` under about 500 once awake.
3. Smoke check above; open a `#tv-<id>` view and a phone `#player-<id>` link.
4. Confirm the last deploy is the one you intend to run on; no pushes to `master` on game day.
During: watch Vercel errors and Neon connections; if the site misbehaves, roll back (below)
before debugging.
After: lower Neon compute again; record peak load and cost here.

## Not yet written

Load-test results (R9, deferred to near launch); the alert rules themselves once set up.
