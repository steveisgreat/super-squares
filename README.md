# Super-Squares

A squares-pool web app for any sport: hosts create boards, players claim squares, scores
pay out per quarter, and Party View shows the grid. The product is the hosted app
(Vercel + Neon); its address is in `docs/runbook.md`.

This README covers running it locally for development only.

## Run it locally

Needs [Node.js](https://nodejs.org) 24.

```bash
npm start
```

Then open <http://localhost:3000>. The server listens on `127.0.0.1` only (set `PORT` to
change the port), stores games as JSON files in `data/`, and has no sign-in unless you set
`HOST_PASSWORD` or `AUTH_MODE` (see `.env.example`). It is not reachable from other
devices; to try the app on a phone, use a Vercel preview deployment.

## Tests

```bash
npm test
```

No test runner or extra dependencies. Postgres tests skip without `DATABASE_URL`.

## More

- Architecture: `ARCHITECTURE.md`
- Deploy, configure, roll back: `docs/runbook.md`
- Why it is built this way: `docs/decisions.md`
- What's next: `docs/ROADMAP.md`
