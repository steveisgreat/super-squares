// Zero-dependency tests for the admin usage page (R45a, decision 027): who may read
// GET /api/admin/stats in every auth mode, what it answers (counts only, masked emails), the
// sums in lib/admin-stats.js, and the fs store's counters. The store is a stand-in for the route
// tests; the Postgres counters are tested in test-store-pg.js.
//
// Run with:  node test-admin.js   (or: npm test)
'use strict';

// Must be settled before lib/store.js is required: it picks its backend once.
delete process.env.DATABASE_URL;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store.js');
// lib/store.js is the fs store here (no DATABASE_URL): keep its real counters before the stand-ins.
const fsStore = (({ bumpUsage, listUsage }) => ({ bumpUsage, listUsage }))(require('./lib/store-fs.js'));
const AdminStats = require('./lib/admin-stats.js');
const Slate = require('./lib/scores/slate.js');
const { handleApi } = require('./lib/api.js');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const ACCOUNTS_ENV = {
  AUTH_MODE: 'accounts',
  DATABASE_URL: 'postgresql://not-used',
  SESSION_SECRET: SECRET,
  APP_ORIGIN: 'https://app.example.com',
  RESEND_API_KEY: 'not-used',
  EMAIL_FROM: 'Squares <no-reply@example.com>',
  ADMIN_EMAILS: ' Boss@Example.com , other@example.com'
};
const ALL_VARS = [...Object.keys(ACCOUNTS_ENV), 'HOST_PASSWORD', 'VERCEL'];
function setEnv(values) {
  ALL_VARS.forEach(k => { delete process.env[k]; });
  Object.assign(process.env, values);
}

const ADMIN = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
let hosts;

// The parts of the store the route uses, as stand-ins (the real fs store has no hosts).
Object.assign(store, {
  async getHost(id) { return hosts[id] || null; },
  async getHostEmail(id) { return hosts[id] ? hosts[id].email : null; },
  async adminFacts() {
    return {
      boards: [],
      hosts: Object.keys(hosts).map(id => ({ id, email: hosts[id].email, createdAt: '2026-11-20T00:00:00.000Z', lastLoginAt: null,
        referredBy: null, news: false, termsVersion: null, boards: 0, locked: 0, finished: 0 })),
      liveNow: 0, tvsPaired: 0, tvBoards: [], helperBoards: []
    };
  },
  async listUsage() { return []; }
});

function cookie(hostId, version) {
  const payload = `v1.${hostId}.${version === undefined ? 1 : version}.${Math.floor(Date.now() / 1000) + 600}`;
  return `sbs_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
}

async function call(path, opts) {
  const o = opts || {};
  const headers = { host: 'app.example.com', 'x-forwarded-proto': 'https' };
  if (o.cookie) headers.cookie = o.cookie;
  const req = { method: o.method || 'GET', url: path, headers, socket: {}, destroy() {}, on(e, cb) { if (e === 'end') cb(); return req; } };
  const res = {
    statusCode: null, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, h) { this.statusCode = status; Object.keys(h || {}).forEach(k => { this.headers[k.toLowerCase()] = h[k]; }); },
    end(b) { this.body = b === undefined ? '' : String(b); },
    get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
  };
  const url = new URL(path, 'https://app.example.com');
  await handleApi(req, res, url.pathname, url.searchParams);
  return res;
}

function reset() {
  setEnv(ACCOUNTS_ENV);
  hosts = { [ADMIN]: { email: 'boss@example.com', sessionVersion: 1 }, [HOST]: { email: 'jane@gmail.com', sessionVersion: 1 } };
}

const DAY = 24 * 60 * 60 * 1000;

async function run() {
  // ---------- access ----------

  await check('accounts mode: a signed-out visitor and a non-admin host get 403', async () => {
    reset();
    eq((await call('/api/admin/stats')).statusCode, 403, 'signed out');
    eq((await call('/api/admin/stats', { cookie: cookie(HOST) })).statusCode, 403, 'host');
  });

  await check('accounts mode: an admin in ADMIN_EMAILS (any case, spaces) gets the counts, no-store', async () => {
    reset();
    const res = await call('/api/admin/stats?range=30d', { cookie: cookie(ADMIN) });
    eq(res.statusCode, 200, 'status');
    eq(res.headers['cache-control'], 'no-store', 'cache');
    eq(res.json.range, '30d', 'range');
    eq(res.json.headline.hosts, 2, 'hosts');
  });

  await check('an admin with an old session version, or with ADMIN_EMAILS unset, gets 403', async () => {
    reset();
    eq((await call('/api/admin/stats', { cookie: cookie(ADMIN, 0) })).statusCode, 403, 'old session');
    delete process.env.ADMIN_EMAILS;
    eq((await call('/api/admin/stats', { cookie: cookie(ADMIN) })).statusCode, 403, 'no list');
  });

  await check('password, off and misconfigured modes: nobody is an admin, signed in or not', async () => {
    reset();
    setEnv({ HOST_PASSWORD: 'correct horse battery staple', ADMIN_EMAILS: 'boss@example.com' });
    eq((await call('/api/admin/stats')).statusCode, 403, 'password, signed out');
    setEnv({ ADMIN_EMAILS: 'boss@example.com' });
    eq((await call('/api/admin/stats')).statusCode, 403, 'off (every request is the host)');
    eq((await call('/api/admin/stats', { cookie: cookie(ADMIN) })).statusCode, 403, 'off, with a session cookie');
    setEnv({ AUTH_MODE: 'accounts', ADMIN_EMAILS: 'boss@example.com' });
    eq((await call('/api/admin/stats', { cookie: cookie(ADMIN) })).statusCode, 403, 'misconfigured');
  });

  await check('the answer masks every email; reveal gives one full email, to an admin only', async () => {
    reset();
    const res = await call('/api/admin/stats', { cookie: cookie(ADMIN) });
    assert(!res.body.includes('jane@gmail.com') && !res.body.includes('boss@example.com'), 'no full email in the counts');
    assert(res.body.includes('j•••@gmail.com'), 'masked');
    eq((await call(`/api/admin/stats?reveal=${HOST}`, { cookie: cookie(ADMIN) })).json, { email: 'jane@gmail.com' }, 'reveal');
    eq((await call(`/api/admin/stats?reveal=${HOST}`, { cookie: cookie(HOST) })).statusCode, 403, 'reveal as a host');
    eq((await call('/api/admin/stats?reveal=33333333-3333-4333-8333-333333333333', { cookie: cookie(ADMIN) })).statusCode, 404, 'unknown');
  });

  await check('only GET; an unknown range is 7 days', async () => {
    reset();
    eq((await call('/api/admin/stats', { cookie: cookie(ADMIN), method: 'POST' })).statusCode, 404, 'POST');
    eq((await call('/api/admin/stats?range=forever', { cookie: cookie(ADMIN) })).json.range, '7d', 'range');
  });

  // ---------- the sums ----------

  await check('rangeStart: 7 and 30 days back; the season from September 1 ET', async () => {
    const now = Date.parse('2026-11-26T15:00:00Z');
    eq(AdminStats.rangeStart('7d', now), now - 7 * DAY, '7d');
    eq(new Date(AdminStats.rangeStart('season', now)).toISOString(), '2026-09-01T04:00:00.000Z', 'season in November');
    eq(new Date(AdminStats.rangeStart('season', Date.parse('2027-02-14T20:00:00Z'))).toISOString(), '2026-09-01T04:00:00.000Z', 'season in February');
  });

  await check('maskEmail keeps the first letter and the domain', async () => {
    eq([AdminStats.maskEmail('jane@gmail.com'), AdminStats.maskEmail('x'), AdminStats.maskEmail(null)], ['j•••@gmail.com', '•••', '•••'], 'masked');
  });

  await check('build: headline, funnel, games, guests per host, how boards run, per day across daylight saving', async () => {
    const now = Date.parse('2026-11-26T15:00:00Z');
    const since = AdminStats.rangeStart('30d', now);
    const b = (id, ownerId, o) => Object.assign({ id, ownerId, createdAt: '2026-11-20T15:00:00.000Z', status: 'setup', league: 'nfl',
      gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles', scoring: 'live', pickMode: null, guestPick: false, sold: 0, names: [], phones: 0 }, o);
    const facts = {
      boards: [
        b('g1', 'h1', { status: 'started', names: ['ann', 'bob'], sold: 10, guestPick: true, phones: 2 }),
        b('g2', 'h1', { teamA: 'Eagles', teamB: 'Chiefs', names: ['ann', 'cat'], sold: 4 }),
        b('g3', 'h2', { scoring: 'manual', league: 'other', status: 'finished', names: ['dan'], sold: 1 }),
        b('g4', null, { createdAt: '2026-11-01T12:00:00.000Z' })
      ],
      hosts: [
        { id: 'h1', email: 'ann@x.com', createdAt: '2026-11-25T00:00:00.000Z', lastLoginAt: null, referredBy: 'ABCDEF', news: true, termsVersion: 'v1', boards: 2, locked: 1, finished: 0 },
        { id: 'h2', email: 'bo@y.com', createdAt: '2026-11-10T00:00:00.000Z', lastLoginAt: null, referredBy: null, news: false, termsVersion: 'v1', boards: 1, locked: 1, finished: 1 },
        { id: 'h3', email: 'cy@z.com', createdAt: '2025-01-01T00:00:00.000Z', lastLoginAt: null, referredBy: null, news: false, termsVersion: null, boards: 0, locked: 0, finished: 0 }
      ],
      liveNow: 1, tvsPaired: 2, tvBoards: ['g1'], helperBoards: ['g3']
    };
    const out = AdminStats.build(facts, [], { range: '30d', now, since, refreshMs: 15000 });
    eq(out.headline, { hosts: 3, hostsNew: 2, hostsNewWeek: 1, boardsCreated: 4, boardsLocked: 2, players: 5, liveNow: 1, tvsPaired: 2 }, 'headline');
    eq(out.funnel, { signedUp: 2, createdBoard: 2, locked: 2, finished: 1, secondBoard: 1 }, 'funnel');
    eq(out.byGame.map(g => [g.key, g.hosts, g.boards, g.guests, g.lockedShare]),
      [['nfl|2027-02-14|chiefs|eagles', 1, 3, 4, 0.33], ['other', 1, 1, 1, 1]], 'by game (sides either way round; unowned board counted)');
    eq([out.guestsPerHost.hosts, out.guestsPerHost.median, out.guestsPerHost.most, out.guestsPerHost.phones], [2, 2, 3, 2], 'guests per host (distinct names across boards)');
    eq(out.guestsPerHost.top[0], { id: 'h1', email: 'a•••@x.com', guests: 3, boards: 2 }, 'top host');
    eq([out.howRun.scoring.live, out.howRun.league.other, out.howRun.playerPicks, out.howRun.helper, out.howRun.onTv, out.howRun.averageSold],
      [3, 1, 1, 1, 1, 3.8], 'how run');
    eq(out.growth.topReferrers, [{ code: 'ABCDEF', hosts: 1 }], 'referrers');
    eq(out.perDay.length, 31, 'one row per day, 30 days back to today');
    const days = AdminStats.build(Object.assign({}, facts, { boards: [], hosts: [] }), [],
      { range: '7d', now: Date.parse('2026-11-03T12:00:00Z'), since: Date.parse('2026-10-31T03:30:00Z'), refreshMs: 15000 }).perDay.map(r => r.day);
    eq(days, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'], 'no day skipped over the clock change');
    eq(out.recentHosts[0], { id: 'h1', email: 'a•••@x.com', joined: '2026-11-25T00:00:00.000Z', boards: 2, stage: 'locked', lastSignIn: null, from: 'board' }, 'recent');
  });

  await check('build: services from the counters (feeds, failover, down, mail today and this month)', async () => {
    const now = Date.parse('2026-11-26T15:00:00Z');
    const usage = [
      { day: '2026-11-25', key: 'feed:espn', calls: 100, failed: 3, peakMinute: 4, lastAt: '2026-11-25T20:00:00.000Z' },
      { day: '2026-11-26', key: 'feed:espn', calls: 50, failed: 0, peakMinute: 6, lastAt: '2026-11-26T14:00:00.000Z' },
      { day: '2026-11-26', key: 'feed:balldontlie', calls: 8, failed: 1, peakMinute: 2, lastAt: '2026-11-26T14:01:00.000Z' },
      { day: '2026-11-26', key: 'feed:fallback', calls: 8, failed: 0, peakMinute: 2, lastAt: '2026-11-26T14:01:00.000Z' },
      { day: '2026-11-26', key: 'feed:down', calls: 1, failed: 0, peakMinute: 1, lastAt: '2026-11-26T14:02:00.000Z' },
      { day: '2026-11-02', key: 'mail:sent', calls: 40, failed: 2, peakMinute: 1, lastAt: null },
      { day: '2026-11-26', key: 'mail:sent', calls: 5, failed: 1, peakMinute: 1, lastAt: null },
      { day: '2026-11-26', key: 'mail:refused', calls: 2, failed: 0, peakMinute: 1, lastAt: null },
      { day: '2026-11-26', key: 'login:code', calls: 3, failed: 0, peakMinute: 1, lastAt: null }
    ];
    const s = AdminStats.build({ boards: [], hosts: [], liveNow: 0, tvsPaired: 0 }, usage,
      { range: '7d', now, since: AdminStats.rangeStart('7d', now), refreshMs: 15000 }).services;
    eq(s.feeds.map(f => [f.provider, f.calls, f.failed, f.peakMinute]), [['balldontlie', 8, 1, 2], ['espn', 150, 3, 6]], 'feeds');
    eq([s.fallback.times, s.fallback.minutes, s.down.times], [8, 2, 1], 'failover and down');
    eq([s.mail.today, s.mail.month, s.mail.failed, s.mail.refused, s.logins.code], [4, 42, 1, 2, 3], 'mail (failures in range only)');
  });

  // ---------- counting ----------

  await check('a slate refresh counts each provider tried, a failover, and a feed fully down', async () => {
    const bumps = [];
    let saved = null;
    const fake = {
      async getLiveSlate() { return saved; },
      async claimLiveSlate() { return true; },
      async saveLiveSlate(l, d, payload) { saved = { payload, checkedAt: '2000-01-01T00:00:00.000Z' }; },
      async bumpUsage(key, o) { bumps.push([key, !!(o && o.failed)]); }
    };
    const answer = (r) => async () => r;
    await Slate.getSlate('nfl', '2099-01-01', { store: fake, fetchWithFailover: answer({ ok: true, provider: 'balldontlie', games: [],
      tried: [{ provider: 'espn', ok: false }, { provider: 'balldontlie', ok: true }] }) });
    await Slate.getSlate('nfl', '2099-01-02', { store: fake, fetchWithFailover: answer({ ok: false, error: 'x',
      tried: [{ provider: 'espn', ok: false }] }) });
    await Slate.getSlate('nfl', '2099-01-03', { store: fake, fetchWithFailover: answer({ ok: false, error: 'no score provider configured', tried: [] }) });
    eq(bumps, [['feed:espn', true], ['feed:balldontlie', false], ['feed:fallback', false], ['feed:espn', true], ['feed:down', false]], 'bumps');
  });

  await check('fs store: counters keep calls, failures, the busiest minute and the latest call', async () => {
    const file = path.join(__dirname, 'data', 'usage-counters.json');
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      const t = Date.parse('2099-12-30T10:00:05Z');
      for (const dt of [0, 1000, 2000]) await fsStore.bumpUsage('test:feed', { now: t + dt });
      await fsStore.bumpUsage('test:feed', { failed: true, now: t + 60000 });
      const rows = (await fsStore.listUsage('2099-12-30')).filter(r => r.key === 'test:feed');
      eq(rows.map(r => [r.day, r.calls, r.failed, r.peakMinute, r.lastAt]), [['2099-12-30', 4, 1, 3, new Date(t + 60000).toISOString()]], 'row');
      eq((await fsStore.listUsage('2099-12-31')).filter(r => r.key === 'test:feed'), [], 'since');
    } finally {
      if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
    }
  });

  await check('fs store: board facts are counts and names, never the document', async () => {
    const doc = { id: 'ABC', status: 'picking', league: 'nfl', scoring: 'manual', squares: [{ name: 'Ann' }, { name: ' ann' }, null, { name: 'Bo' }],
      players: { Ann: { g: 'tag1' }, Bo: { g: 'tag1' }, Cy: {} }, guestPick: { on: true } };
    const f = AdminStats.boardFacts(doc, null);
    eq([f.id, f.sold, f.names, f.phones, f.guestPick, f.squares], ['abc', 3, ['ann', 'bo'], 1, true, undefined], 'facts');
  });

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

run();
