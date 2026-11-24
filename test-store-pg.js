// Postgres-specific tests for lib/store-pg.js.
//
// These cover the cases the backend-agnostic contract suite (test-store.js)
// structurally cannot reach, because it only ever creates documents through
// createGame and so never produces the shapes that broke this file:
//
//   * a stored document with no createdAt key, which makes the STRICT
//     jsonb_set in the upsert return NULL and trip the not-null constraint;
//   * a listGames pass that has to write, where the document in hand is the
//     TRIMMED projection and writing it back would silently gut the game.
//
// Both were real. Reverting either fix makes tests here fail against a real
// database — the first with "null value in column doc violates not-null
// constraint", the second by leaving a game with no squares at all.
//
// ---------------------------------------------------------------------------
// Running these
// ---------------------------------------------------------------------------
//
// They need a real Postgres, so they SKIP (exit 0) unless DATABASE_URL is set.
// That keeps `npm test` green offline while still covering the SQL whenever
// you point it at a database.
//
//   DATABASE_URL=postgres://... node test-store-pg.js
//
// Point it at a THROWAWAY NEON BRANCH, not at production. Like test-store.js
// these only touch rows under freshly generated UUIDs and delete them in a
// finally block, but a branch costs nothing and removes the question entirely:
//
//   npx neonctl branches create --project-id <id> --name tmp-store-pg
//   ... run the tests ...
//   npx neonctl branches delete <branch-id> --project-id <id>
//
// The schema is applied from migrations/*.sql on startup, so a fresh
// branch needs no preparation.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.log('');
  console.log('  Skipped: store-pg tests need DATABASE_URL (point it at a Neon branch).');
  console.log('');
  return;
}

const { neon } = require('@neondatabase/serverless');
const store = require('./lib/store-pg.js');
const sql = neon(process.env.DATABASE_URL);

let passed = 0;
const failures = [];
const cleanupIds = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Postgres jsonb does NOT preserve object key order — it normalises keys on
// storage, where the fs backend round-trips JSON.stringify output verbatim.
// Nothing in the app depends on key order, but comparisons of stored documents
// have to canonicalise or they fail on ordering alone.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  }
  return v;
}

function eq(actual, expected, what) {
  const a = JSON.stringify(canonical(actual));
  const b = JSON.stringify(canonical(expected));
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}

function makeGame(overrides) {
  const id = crypto.randomUUID();
  cleanupIds.push(id);
  return Object.assign({
    id,
    league: 'nfl',
    teamA: 'Chiefs',
    teamB: 'Eagles',
    gameDate: '2026-02-08',
    squarePrice: 10,
    payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    status: 'picking',
    squares: new Array(100).fill(null),
    axisX: null,
    axisY: null,
    results: {},
    players: {}
  }, overrides || {});
}

// One source of truth for the schema: the migration itself. The HTTP driver
// refuses multiple commands in one prepared statement, so it goes across one
// statement at a time.
async function applySchema() {
  const dir = path.join(__dirname, 'migrations');
  const statements = fs.readdirSync(dir).sort()
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    // sql`` is a tagged template; a plain string has to go through sql.query.
    await sql.query(statement);
  }
}

async function main() {
  await applySchema();

  // ---------- the STRICT jsonb_set trap ----------

  await check('updateGame survives a stored document that has no createdAt', async () => {
    const game = makeGame();
    const legacy = Object.assign({}, game);
    delete legacy.createdAt;
    delete legacy.updatedAt;
    // Written the way a document predating these timestamps would have been.
    await sql`insert into games (id, doc, updated_at) values (${game.id}, ${JSON.stringify(legacy)}::jsonb, now())`;

    const stored = await sql`select doc from games where id = ${game.id}`;
    assert(stored[0].doc.createdAt === undefined, 'precondition: the row must have no createdAt');

    // Unconditional, so this takes the ON CONFLICT DO UPDATE branch where
    // jsonb_set reads games.doc->'createdAt' — SQL NULL for this row.
    const result = await store.updateGame(game.id, makeGame({ id: game.id, teamA: 'Rams' }), null);

    assert(result.ok, 'the write must succeed, not trip the not-null constraint');
    assert(result.game.createdAt, 'createdAt must be backfilled rather than left null');
    eq(result.game.teamA, 'Rams', 'the incoming document must win');
    eq(result.game.squares.length, 100, 'squares must survive');
  });

  await check('an existing createdAt survives the update branch unchanged', async () => {
    const game = makeGame();
    const created = await store.createGame(game);
    const originalCreatedAt = created.createdAt;
    assert(originalCreatedAt, 'precondition: createGame stamps createdAt');

    await new Promise(r => setTimeout(r, 10));
    const result = await store.updateGame(game.id, makeGame({ id: game.id, teamA: 'Bills' }), null);
    assert(result.ok, 'write must succeed');
    eq(result.game.createdAt, originalCreatedAt, 'createdAt must be the original, not re-stamped');
    assert(result.game.updatedAt !== originalCreatedAt, 'updatedAt must be fresh');
  });

  // ---------- listGames trims, but must never write the trimmed document ----------

  await check('a cutoff firing during listGames does not truncate the document', async () => {
    const squares = new Array(100).fill(null);
    squares[0] = { name: 'Steve' };
    squares[42] = { name: 'Colton' };
    const game = makeGame({
      status: 'picking',
      autoCutoffEnabled: true,
      autoCutoffTime: new Date(Date.now() - 60000).toISOString(),
      squares,
      players: { Steve: { paid: true } },
      simulation: true,
      simPlan: { startedAt: new Date().toISOString(), quarterMs: 1000, events: [{ team: 'a', atMs: 1, points: 7 }] }
    });
    await store.createGame(game);

    const row = (await store.listGames({ all: true })).find(g => g.id === game.id);
    assert(row, 'the game must appear in the listing');
    eq(row.status, 'started', 'the cutoff must have fired and locked the game');

    const after = await store.getGame(game.id);
    eq(after.squares.length, 100, 'squares must survive the cutoff write');
    eq(after.squares[0], { name: 'Steve' }, 'a claimed square must survive');
    eq(after.squares[42], { name: 'Colton' }, 'a second claimed square must survive');
    eq(after.players, { Steve: { paid: true } }, 'players must survive');
    // lockGame deliberately REGENERATES simPlan (a simulated game's trajectory
    // is drawn at lock time), so the original plan is expected to be gone. What
    // matters is that the key still holds a usable plan — had the trimmed
    // document been written back it would be absent entirely.
    assert(after.simPlan && Array.isArray(after.simPlan.events) && after.simPlan.events.length > 0,
      'simPlan must still be present and usable');
    assert(Array.isArray(after.axisX) && after.axisX.length === 10, 'the lock must have drawn axes');
  });

  await check('a status-only write during listGames preserves simPlan exactly', async () => {
    const simPlan = { startedAt: new Date().toISOString(), quarterMs: 1000, events: [{ team: 'a', atMs: 1, points: 7 }] };
    const squares = new Array(100).fill(null);
    squares[7] = { name: 'Karen' };
    // 'started' with a final score: syncStatus flips it to 'finished' so
    // applyAutoCutoff writes — but cutoffPassed is false, so lockGame never
    // runs and nothing is allowed to change simPlan.
    const game = makeGame({
      status: 'started',
      axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      results: { final: { a: 31, b: 38 } },
      squares,
      players: { Karen: { paid: false } },
      simulation: true,
      simPlan
    });
    await store.createGame(game);

    const row = (await store.listGames({ all: true })).find(g => g.id === game.id);
    eq(row.status, 'finished', 'syncStatus must have flipped the status, forcing a write');

    const after = await store.getGame(game.id);
    eq(after.simPlan, simPlan, 'simPlan must be untouched by a status-only write');
    eq(after.squares[7], { name: 'Karen' }, 'the claimed square must be untouched');
    eq(after.players, { Karen: { paid: false } }, 'players must be untouched');
    eq(after.squares.length, 100, 'squares must still be a full grid');
  });

  await check('the trimmed projection still carries every summary field', async () => {
    const game = makeGame({
      status: 'finished',
      description: 'Super Bowl party',
      kickoffTime: '2026-02-08T23:30:00Z',
      teamAColor: '#336699',
      teamBColor: '#996633',
      results: { final: { a: 31, b: 38 } }
    });
    await store.createGame(game);

    const row = (await store.listGames({ all: true })).find(g => g.id === game.id);
    assert(row, 'the game must be listed');
    for (const field of ['teamA', 'teamB', 'league', 'gameDate', 'status', 'updatedAt']) {
      assert(row[field] !== undefined && row[field] !== null, `${field} must be present`);
    }
    eq(row.description, 'Super Bowl party', 'description');
    eq(row.kickoffTime, '2026-02-08T23:30:00Z', 'kickoffTime');
    eq(row.teamAColor, '#336699', 'teamAColor');
    assert(row.squares === undefined, 'the summary must not carry the squares array');
  });

  // ---------- the conditional write ----------

  await check('a lost conditional write returns the winning document', async () => {
    const game = makeGame();
    const created = await store.createGame(game);
    const stale = created.updatedAt;

    const winner = await store.updateGame(game.id, makeGame({ id: game.id, teamA: 'Winner' }), stale);
    assert(winner.ok, 'the first write holds the expected token and must win');

    const loser = await store.updateGame(game.id, makeGame({ id: game.id, teamA: 'Loser' }), stale);
    assert(!loser.ok, 'the second write carries a stale token and must lose');
    assert(loser.game, 'the loser must be handed a document to show the user');
    eq(loser.game.teamA, 'Winner', 'that document must be the one that actually won');
  });

  await check('losing the write on a row that no longer exists returns null, not a crash', async () => {
    const game = makeGame();
    const created = await store.createGame(game);
    await store.deleteGame(game.id);
    await sql`insert into games (id, doc, updated_at) values (${game.id}, ${JSON.stringify(created)}::jsonb, now())`;

    // Race the losing write against the row disappearing. Whether the row
    // survives long enough to be re-read is timing-dependent; what must never
    // happen is a TypeError reading current[0].doc.
    const pending = store.updateGame(game.id, makeGame({ id: game.id, teamA: 'Racer' }), '2020-01-01T00:00:00.000Z');
    await sql`delete from games where id = ${game.id}`;
    const result = await pending;

    assert(!result.ok, 'the stale token must lose');
    assert(result.game === null || typeof result.game === 'object',
      'game must be null or a document, never a throw');
  });

  // ---------- host accounts (decision 012) ----------

  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const tag = crypto.randomUUID().slice(0, 8);
  const address = (name) => `${name}-${tag}@test.invalid`;
  const HUGE = 1000000;
  async function ask(name, limits) {
    const r = Object.assign({
      id: crypto.randomUUID(), email: address(name),
      tokenHash: hash(crypto.randomUUID()), codeHash: hash(crypto.randomUUID()),
      perEmail: 5, perSite: HUGE
    }, limits);
    r.stored = await store.createLoginRequest(r);
    return r;
  }
  async function signIn(name) {
    const r = await ask(name);
    return store.useLoginToken(r.tokenHash);
  }

  try {
    await check('listGames needs a scope and throws on anything else', async () => {
      for (const scope of [undefined, null, {}, { all: false }, { ownerId: undefined }, { ownerId: null }, { ownerId: '' }, { ownerId: 'x' },
        { all: true, ownerId: crypto.randomUUID() }, { all: false, ownerId: crypto.randomUUID() }]) {
        let threw = false;
        await store.listGames(scope).catch(() => { threw = true; });
        assert(threw, `must throw for ${JSON.stringify(scope)}`);
      }
    });

    await check('each host lists only their own boards, and getGameAccess names the owner', async () => {
      const a = await signIn('a');
      const b = await signIn('b');
      const mine = await store.createGame(makeGame(), a.id);
      const unowned = await store.createGame(makeGame());
      eq((await store.listGames({ ownerId: a.id })).map(g => g.id), [mine.id], 'host A');
      eq(await store.listGames({ ownerId: b.id }), [], 'host B');
      eq(await store.getGameAccess(mine.id, b.id), { exists: true, ownerId: a.id, sessionVersion: 1 }, 'owned');
      eq(await store.getGameAccess(unowned.id, a.id), { exists: true, ownerId: null, sessionVersion: 1 }, 'unowned');
      eq(await store.getGameAccess(crypto.randomUUID(), a.id), { exists: false, ownerId: null, sessionVersion: 1 }, 'unknown board');
      eq(await store.getGameAccess('-'.repeat(36), a.id), { exists: false, ownerId: null, sessionVersion: 1 }, 'not an id');
      eq((await store.getGameAccess(mine.id, crypto.randomUUID())).sessionVersion, null, 'unknown host');
      assert(!JSON.stringify(await store.getGame(mine.id)).includes(a.id), 'the owner must not be in the document');

      // A save keeps the owner.
      const saved = await store.updateGame(mine.id, { ...mine, teamA: 'Bills' }, mine.updatedAt, { mustExist: true });
      assert(saved.ok, 'save');
      eq((await store.getGameAccess(mine.id, a.id)).ownerId, a.id, 'owner after a save');
    });

    await check('mustExist never creates a row, and keeps the conditional write', async () => {
      const g = makeGame();
      eq(await store.updateGame(g.id, g, null, { mustExist: true }), { ok: false, game: null }, 'unknown id');
      eq(await store.getGame(g.id), null, 'nothing created');
      const made = await store.createGame(g);
      eq((await store.updateGame(g.id, g, '2020-01-01T00:00:00.000Z', { mustExist: true })).ok, false, 'stale');
      const ok = await store.updateGame(g.id, g, made.updatedAt, { mustExist: true });
      eq([ok.ok, ok.game.createdAt], [true, made.createdAt], 'current');
      eq((await store.updateGame(g.id, g, null, { mustExist: true })).ok, true, 'no token');
    });

    await check('a link works once, and the account is created on the first sign-in only', async () => {
      const r = await ask('link');
      eq((await sql`select 1 from hosts where email = ${r.email}`).length, 0, 'no account before sign-in');
      const host = await store.useLoginToken(r.tokenHash);
      eq([host.email, host.sessionVersion], [r.email, 1], 'host');
      eq(await store.getHost(host.id), { email: r.email, sessionVersion: 1 }, 'getHost');
      eq(await store.useLoginToken(r.tokenHash), null, 'second use');
      eq(await store.useLoginToken(hash('never issued')), null, 'unknown token');
      eq((await signIn('link')).id, host.id, 'the same account next time');
    });

    await check('a link spent by many requests at once signs in exactly one', async () => {
      const r = await ask('race');
      const got = await Promise.all(Array.from({ length: 8 }, () => store.useLoginToken(r.tokenHash)));
      eq(got.filter(Boolean).length, 1, 'winners');
    });

    await check('an expired link and code fail', async () => {
      const r = await ask('expired');
      await sql`update login_requests set expires_at = now() - interval '1 second' where id = ${r.id}`;
      eq(await store.useLoginToken(r.tokenHash), null, 'link');
      eq(await store.useLoginCode(r.id, r.codeHash, 5), null, 'code');
    });

    await check('a code works once, only under its own request, and uses up the link', async () => {
      const r = await ask('code');
      const other = await ask('code-other');
      eq(await store.useLoginCode(other.id, r.codeHash, 5), null, 'another request');
      eq((await store.useLoginCode(r.id, r.codeHash, 5)).email, r.email, 'right');
      eq(await store.useLoginCode(r.id, r.codeHash, 5), null, 'second use');
      eq(await store.useLoginToken(r.tokenHash), null, 'the link afterwards');
    });

    await check('four wrong tries leave the fifth; a sixth fails even if right; the link still works', async () => {
      const four = await ask('four');
      for (let i = 0; i < 4; i++) eq(await store.useLoginCode(four.id, hash('wrong' + i), 5), null, 'wrong');
      eq((await store.useLoginCode(four.id, four.codeHash, 5)).email, four.email, 'fifth, right');
      const five = await ask('five');
      for (let i = 0; i < 5; i++) await store.useLoginCode(five.id, hash('wrong' + i), 5);
      eq(await store.useLoginCode(five.id, five.codeHash, 5), null, 'sixth, right');
      eq((await store.useLoginToken(five.tokenHash)).email, five.email, 'link');
    });

    await check('parallel tries cannot get past the limit', async () => {
      const r = await ask('parallel');
      await Promise.all(Array.from({ length: 12 }, (_, i) => store.useLoginCode(r.id, hash('wrong' + i), 5)));
      eq((await sql`select attempts from login_requests where id = ${r.id}`)[0].attempts, 5, 'attempts');
      eq(await store.useLoginCode(r.id, r.codeHash, 5), null, 'right, too late');
    });

    await check('parallel sign-in requests cannot get past the per-email limit', async () => {
      const got = await Promise.all(Array.from({ length: 12 }, () => ask('flood')));
      eq(got.filter(r => r.stored).length, 5, 'stored');
      const refused = got.find(r => !r.stored);
      eq(await store.useLoginToken(refused.tokenHash), null, 'a refused request has no link');
      // An hour later there is room again.
      await sql`update login_requests set created_at = now() - interval '61 minutes' where email = ${address('flood')}`;
      assert((await ask('flood')).stored, 'room after an hour');
    });

    await check('the site-wide cap refuses, and rows over a day old are cleared', async () => {
      const now = (await sql`select count(*)::int as n from login_requests where created_at > now() - interval '1 hour'`)[0].n;
      eq((await ask('cap', { perSite: now })).stored, false, 'at the cap');
      const old = await ask('old', { perSite: now + 1 });
      assert(old.stored, 'one under the cap');
      await sql`update login_requests set created_at = now() - interval '25 hours' where id = ${old.id}`;
      await ask('sweep');
      eq((await sql`select 1 from login_requests where id = ${old.id}`).length, 0, 'old rows');
    });

    await check('revoking needs the current version and moves it on by one', async () => {
      const host = await signIn('revoke');
      eq(await store.revokeSessions(host.id, 1), true, 'current');
      eq((await store.getHost(host.id)).sessionVersion, 2, 'version');
      eq(await store.revokeSessions(host.id, 1), false, 'old session');
      eq((await signIn('revoke')).sessionVersion, 2, 'the next sign-in carries the new version');
    });
  } finally {
    const mine = `%-${tag}@test.invalid`;
    await sql`delete from games where owner_id in (select id from hosts where email like ${mine})`;
    await sql`delete from hosts where email like ${mine}`;
    await sql`delete from login_requests where email like ${mine}`;
  }

  // ---------- shared live slates (decision 001 section 3) ----------

  const slateLeague = 't' + crypto.randomBytes(6).toString('hex');
  try {
    await check('live slate: 50 concurrent claims on an empty row, exactly one wins', async () => {
      const wins = await Promise.all(Array.from({ length: 50 }, () =>
        store.claimLiveSlate(slateLeague, '2099-12-31', null, '2099-12-31T00:00:00.000Z')));
      eq(wins.filter(Boolean).length, 1, 'winners');
      eq((await store.getLiveSlate(slateLeague, '2099-12-31')).checkedAt, '2099-12-31T00:00:00.000Z', 'checkedAt');
    });

    await check('live slate: 50 concurrent claims holding the same seen value, exactly one wins', async () => {
      const seen = '2099-12-31T00:00:00.000Z';
      const wins = await Promise.all(Array.from({ length: 50 }, (_, i) =>
        store.claimLiveSlate(slateLeague, '2099-12-31', seen, new Date(Date.UTC(2099, 11, 31, 0, 0, 15 + i)).toISOString())));
      eq(wins.filter(Boolean).length, 1, 'winners');
    });

    await check('live slate: a stale seen value loses; save round-trips the payload and keeps fetchedAt on a failure', async () => {
      eq(await store.claimLiveSlate(slateLeague, '2099-12-31', '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'), false, 'stale');
      await store.saveLiveSlate(slateLeague, '2099-12-31', { provider: 'espn', games: [{ a: 1 }] }, '2099-12-31T00:00:09.000Z');
      await store.saveLiveSlate(slateLeague, '2099-12-31', { provider: 'espn', games: [{ a: 1 }], error: 'down' }, null);
      const row = await store.getLiveSlate(slateLeague, '2099-12-31');
      eq([row.fetchedAt, row.payload.games, row.payload.error], ['2099-12-31T00:00:09.000Z', [{ a: 1 }], 'down'], 'row');
      eq(await store.getLiveSlate(slateLeague, '2099-12-30'), null, 'a missing row');
    });
  } finally {
    await sql`delete from live_slates where league = ${slateLeague}`;
  }

  // ---------- report ----------

  for (const id of cleanupIds) {
    try { await store.deleteGame(id); } catch (e) { /* best effort */ }
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`  All ${passed} tests passed.`);
    console.log('');
  } else {
    console.log(`  ${passed} passed, ${failures.length} FAILED:`);
    console.log('');
    failures.forEach(f => console.log(`  ✗ ${f}\n`));
    process.exitCode = 1;
  }
}

main();
