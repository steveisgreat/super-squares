// Helpers (R37, decision 025): the store contract (fs always; Postgres when DATABASE_URL is set,
// pointed at a throwaway Neon branch with migrations 001 to 010 applied) and the routes (accounts
// mode with a stand-in store, then password, off and misconfigured). The clock is injected, so
// nothing sleeps.
//
// Run with:  node test-helpers.js   (or: npm test)
'use strict';

const PG_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const auth = require('./lib/auth.js');
const store = require('./lib/store.js');
const { handleApi } = require('./lib/api.js');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2027, 1, 14, 18, 0, 0);
const secret = () => crypto.randomBytes(32).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---------- the store contract ----------

// `newGame()` makes a board whose current host version is `version` (null = password and off
// modes). `accounts` is the mode the contract runs in.
async function storeContract(label, s, { newGame, accounts, version }) {
  const QR = 5 * 60;
  const make = (gameId, now, extra) => {
    const tokenHash = hash(secret());
    return s.createHelper(Object.assign({
      gameId, hostVersion: version, label: 'Dana', canScore: true, canSquares: false, tokenHash, tokenSeconds: QR, max: 5
    }, extra), now).then(id => ({ id, tokenHash }));
  };
  const use = (tokenHash, now) => {
    const sessionHash = hash(secret());
    return s.useHelperToken({ tokenHash, sessionHash, accounts }, now).then(r => ({ gameId: r && r.gameId, r, sessionHash }));
  };
  const access = (gameId, sessionHash, now) => s.helperAccess({ gameId, sessionHash, accounts }, now);
  const allowed = async (gameId, sessionHash, now) => !!(await access(gameId, sessionHash, now));
  const flags = async (g, now) => (await s.listHelpers(g, version, now)).map(h => [h.connected, h.waiting]);

  await check(`${label}: a code becomes one phone's jobs on its own board only`, async () => {
    const g = await newGame();
    const other = await newGame();
    const a = await make(g, T0);
    eq(await s.listHelpers(g, version, T0), [{ id: a.id, label: 'Dana', canScore: true, canSquares: false, connected: false, waiting: true }], 'waiting');
    const u = await use(a.tokenHash, T0 + MIN);
    eq(u.r, { gameId: g, label: 'Dana', canScore: true, canSquares: false }, 'used');
    eq(await flags(g, T0 + MIN), [[true, false]], 'connected');
    eq(await access(g, u.sessionHash, T0 + MIN), { id: a.id, label: 'Dana', canScore: true, canSquares: false }, 'access');
    eq(await allowed(other, u.sessionHash, T0 + MIN), false, 'another board');
    eq(await allowed(g, hash(secret()), T0 + MIN), false, 'another phone');
    eq(await allowed(g, a.tokenHash, T0 + MIN), false, 'the token is not a session');
    eq(await allowed(g, null, T0 + MIN), false, 'no session');
    eq((await use(u.sessionHash, T0 + MIN)).gameId, null, 'a session is not a token');
    eq((await use(null, T0 + MIN)).gameId, null, 'no token');
  });

  await check(`${label}: a code works once, also when phones race`, async () => {
    const g = await newGame();
    const a = await make(g, T0);
    assert((await use(a.tokenHash, T0)).gameId, 'first use');
    eq((await use(a.tokenHash, T0)).gameId, null, 'second use');
    const b = await make(g, T0);
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => use(b.tokenHash, T0)));
    eq(got.filter(x => x.gameId).length, 1, 'winners of the race');
    const winner = got.find(x => x.gameId);
    for (const x of got) eq(await allowed(g, x.sessionHash, T0), x === winner, 'only the winner is in');
    eq((await use(hash(secret()), T0)).gameId, null, 'unknown code');
  });

  await check(`${label}: a QR code ends at 5 minutes and a texted link at 24 hours`, async () => {
    const g = await newGame();
    const a = await make(g, T0);
    eq(await flags(g, T0 + 5 * MIN), [[false, false]], 'listed, not waiting');
    eq((await use(a.tokenHash, T0 + 5 * MIN)).gameId, null, 'expired');
    const b = await make(g, T0);
    eq((await use(b.tokenHash, T0 + 5 * MIN - 1)).gameId, g, 'just before');
    const c = await make(g, T0, { tokenSeconds: 24 * 3600 });
    eq((await use(c.tokenHash, T0 + 24 * HOUR)).gameId, null, 'link expired');
    const d = await make(g, T0, { tokenSeconds: 24 * 3600 });
    eq((await use(d.tokenHash, T0 + 24 * HOUR - 1)).gameId, g, 'link just before');
  });

  await check(`${label}: a job ends 180 days after it was taken`, async () => {
    const g = await newGame();
    const u = await use((await make(g, T0)).tokenHash, T0 + MIN);
    const end = T0 + MIN + 180 * 24 * HOUR;
    eq(await allowed(g, u.sessionHash, end - 1), true, 'just before');
    eq(await allowed(g, u.sessionHash, end), false, 'at 180 days');
    eq(await flags(g, end), [[false, false]], 'not connected');
  });

  await check(`${label}: a job and a waiting code end 24 hours after a final board was last saved`, async () => {
    const g = await newGame();
    const u = await use((await make(g, T0)).tokenHash, T0);
    const waiting = await make(g, T0, { tokenSeconds: 48 * 3600 });
    const doc = await s.getGame(g);
    const saved = await s.updateGame(g, Object.assign(doc, {
      status: 'finished', results: { q1: { a: 7, b: 0 }, q2: { a: 7, b: 3 }, q3: { a: 14, b: 3 }, final: { a: 14, b: 10 } }
    }), null);
    const end = Date.parse(saved.game.updatedAt) + 24 * HOUR;
    eq(await allowed(g, u.sessionHash, end - 1000), true, 'within the day');
    eq(await allowed(g, u.sessionHash, end), false, 'after it');
    eq(await flags(g, end), [[false, false], [false, false]], 'list');
    const before = Date.parse(saved.game.updatedAt);
    const late = await make(g, before, { tokenSeconds: 48 * 3600 });
    eq((await use(late.tokenHash, end)).gameId, null, 'code after the end');
    eq((await use(waiting.tokenHash, Math.min(end - 1000, T0 + HOUR))).gameId, g, 'code before the end');
  });

  await check(`${label}: no more than max helpers; a dead one makes room`, async () => {
    const g = await newGame();
    const a = await make(g, T0, { max: 2 });
    await use((await make(g, T0, { max: 2 })).tokenHash, T0);
    eq((await make(g, T0, { max: 2 })).id, null, 'full');
    eq((await s.listHelpers(g, version, T0)).length, 2, 'nothing stored when full');
    eq(await s.removeHelper({ gameId: g, id: a.id }), true, 'remove one');
    assert((await make(g, T0, { max: 2 })).id, 'room after a removal');
    assert((await make(g, T0 + 5 * MIN + 24 * HOUR, { max: 2 })).id, 'room a day after an unused code ended');
  });

  await check(`${label}: no more than max when several are added at once`, async () => {
    const g = await newGame();
    const got = await Promise.all([1, 2, 3, 4].map(() => make(g, T0, { max: 2 })));
    eq(got.filter(x => x.id).length, 2, 'added');
  });

  await check(`${label}: jobs switch on and off at once, on that helper only`, async () => {
    const g = await newGame();
    const other = await newGame();
    const a = await make(g, T0);
    const b = await make(g, T0 + 1);
    const u = await use(a.tokenHash, T0);
    const set = (extra) => s.setHelperJobs(Object.assign({ gameId: g, id: a.id, hostVersion: version, canScore: false, canSquares: true }, extra));
    eq(await set({ gameId: other }), false, 'through another board');
    eq(await set({ hostVersion: version === null ? 1 : version + 1 }), false, 'another session version');
    eq(await set({ id: crypto.randomUUID() }), false, 'unknown helper');
    eq((await access(g, u.sessionHash, T0)).canScore, true, 'nothing changed yet');
    eq(await set(), true, 'set');
    eq(await access(g, u.sessionHash, T0), { id: a.id, label: 'Dana', canScore: false, canSquares: true }, 'next request');
    eq((await s.listHelpers(g, version, T0)).find(h => h.id === b.id).canScore, true, 'the other helper');
  });

  await check(`${label}: a new code replaces the waiting one; the old phone works until it is used`, async () => {
    const g = await newGame();
    const other = await newGame();
    const a = await make(g, T0);
    const fresh = (now, extra) => {
      const tokenHash = hash(secret());
      return s.newHelperCode(Object.assign({ gameId: g, id: a.id, hostVersion: version, tokenHash, tokenSeconds: QR }, extra), now).then(ok => ({ ok, tokenHash }));
    };
    eq((await fresh(T0, { gameId: other })).ok, false, 'through another board');
    const b = await fresh(T0);
    eq(b.ok, true, 'made');
    eq((await use(a.tokenHash, T0)).gameId, null, 'the first code is cancelled');
    const first = await use(b.tokenHash, T0);
    eq(first.gameId, g, 'the second works');
    const c = await fresh(T0 + MIN);
    eq(await allowed(g, first.sessionHash, T0 + MIN), true, 'old phone meanwhile');
    const second = await use(c.tokenHash, T0 + MIN);
    eq([await allowed(g, first.sessionHash, T0 + MIN), await allowed(g, second.sessionHash, T0 + MIN)], [false, true], 'replaced');
  });

  await check(`${label}: remove ends that one helper's phone and waiting code, and no other's`, async () => {
    const g = await newGame();
    const other = await newGame();
    const a = await make(g, T0);
    const ua = await use(a.tokenHash, T0);
    const ub = await use((await make(g, T0)).tokenHash, T0);
    const c = await make(g, T0);
    eq(await s.removeHelper({ gameId: other, id: a.id }), false, 'through another board');
    eq(await allowed(g, ua.sessionHash, T0), true, 'still there');
    eq(await s.removeHelper({ gameId: g, id: a.id }), true, 'removed');
    eq(await s.removeHelper({ gameId: g, id: a.id }), false, 'again');
    eq([await allowed(g, ua.sessionHash, T0), await allowed(g, ub.sessionHash, T0)], [false, true], 'phones');
    await s.removeHelper({ gameId: g, id: c.id });
    eq((await use(c.tokenHash, T0)).gameId, null, 'waiting code');
  });

  await check(`${label}: deleting the board ends its helpers`, async () => {
    const g = await newGame();
    const u = await use((await make(g, T0)).tokenHash, T0);
    const waiting = await make(g, T0);
    await s.deleteGame(g);
    eq(await allowed(g, u.sessionHash, T0), false, 'phone');
    eq((await use(waiting.tokenHash, T0)).gameId, null, 'waiting code');
    eq(await s.listHelpers(g, version, T0), [], 'rows');
  });

  await check(`${label}: a row made in another auth mode never counts`, async () => {
    const g = await newGame();
    const foreign = version === null ? 1 : null;
    const a = await make(g, T0, { hostVersion: foreign });
    eq((await use(a.tokenHash, T0)).gameId, null, 'cannot be used in this mode');
    eq(await s.listHelpers(g, version, T0), [], 'not listed');
    const own = await make(g, T0);
    eq(await s.useHelperToken({ tokenHash: own.tokenHash, sessionHash: hash(secret()), accounts: !accounts }, T0), null, 'used from the other mode');
    const u = await use(own.tokenHash, T0);
    eq(u.gameId, g, 'the refused try did not spend it');
    eq(await s.helperAccess({ gameId: g, sessionHash: u.sessionHash, accounts: !accounts }, T0), null, 'asked from the other mode');
  });
}

// ---------- fs: the real helpers file is put back afterwards ----------
const FILE = path.join(__dirname, 'data', 'helpers.json');
const hadFile = fs.existsSync(FILE);
const backup = hadFile ? fs.readFileSync(FILE) : null;
const createdFs = [];
function restoreFile() {
  try {
    if (hadFile) fs.writeFileSync(FILE, backup); else fs.unlinkSync(FILE);
  } catch (e) { /* none */ }
}

function board(id) {
  return {
    id: id || crypto.randomUUID(), league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    status: 'started', scoring: 'manual', squares: Array.from({ length: 100 }, () => ({ name: 'Ann' })),
    axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    results: {}, players: { Ann: { paid: false } }, updatedAt: '2026-11-23T00:00:00.000Z'
  };
}

// ---------- routes ----------

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const ACCOUNTS_ENV = {
  AUTH_MODE: 'accounts', DATABASE_URL: 'postgresql://not-used', SESSION_SECRET: SECRET,
  APP_ORIGIN: 'https://app.example.com', RESEND_API_KEY: 'x', EMAIL_FROM: 'a <a@example.com>'
};
const ALL_VARS = [...Object.keys(ACCOUNTS_ENV), 'HOST_PASSWORD', 'VERCEL'];
function setEnv(values) {
  ALL_VARS.forEach(k => { delete process.env[k]; });
  Object.assign(process.env, values);
}

async function call(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({ host: 'app.example.com', 'x-forwarded-proto': 'https' }, o.headers);
  if (o.cookie) headers.cookie = o.cookie;
  const req = {
    method, url: p, headers, socket: {}, destroy() {},
    on(event, cb) {
      if (event === 'data' && o.body !== undefined) cb(Buffer.from(JSON.stringify(o.body)));
      if (event === 'end') cb();
      return req;
    }
  };
  const res = {
    statusCode: null, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(s, h) { this.statusCode = s; Object.keys(h || {}).forEach(k => { this.headers[k.toLowerCase()] = h[k]; }); },
    end(b) { this.body = b === undefined ? '' : String(b); },
    get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
  };
  const url = new URL(p, 'https://app.example.com');
  await handleApi(req, res, url.pathname, url.searchParams);
  return res;
}
const hostCookie = (hostId, version) => {
  const payload = `v1.${hostId}.${version || 1}.${Math.floor(Date.now() / 1000) + 600}`;
  return `sbs_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
};
// The cookie the phone would send back: its name and value, as Set-Cookie gave them.
const phoneCookie = (res) => String(res.headers['set-cookie']).split(';')[0];

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GAME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GAME_A2 = 'abababab-abab-4bab-8bab-abababababab';
const GAME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GAME_PICKING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GAME_NONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// A stand-in store for accounts mode, with the same rules as the Postgres backend.
function standIn() {
  const db = {
    hosts: { [A]: 1, [B]: 1 },
    games: {
      [GAME_A]: { doc: board(GAME_A), owner: A }, [GAME_A2]: { doc: board(GAME_A2), owner: A },
      [GAME_B]: { doc: board(GAME_B), owner: B }, [GAME_NONE]: { doc: board(GAME_NONE), owner: null },
      [GAME_PICKING]: { doc: Object.assign(board(GAME_PICKING), { status: 'picking', axisX: null, axisY: null }), owner: A }
    },
    helpers: [], writes: 0, lookups: 0, missing: false
  };
  const current = (r) => db.games[r.gameId] && db.games[r.gameId].owner && db.hosts[db.games[r.gameId].owner] === r.hostVersion;
  const fakes = {
    async getGame(id) { return db.games[id] ? JSON.parse(JSON.stringify(db.games[id].doc)) : null; },
    async updateGame(id, game) { db.writes++; db.games[id].doc = game; return { ok: true, game }; },
    async deleteGame(id) { db.writes++; delete db.games[id]; return true; },
    async createGame(game) { db.writes++; return game; },
    async listGames(scope) { return Object.values(db.games).filter(g => g.owner === scope.ownerId).map(g => ({ id: g.doc.id })); },
    async assignJoinCode() { return null; },
    async getGameAccess(id, hostId) {
      const g = db.games[id];
      return { exists: !!g, ownerId: g ? g.owner : null, sessionVersion: db.hosts[hostId] || null };
    },
    async getHost(hostId) { return db.hosts[hostId] ? { email: 'x@example.com', sessionVersion: db.hosts[hostId] } : null; },
    async countTvs() { return 0; },
    async revokeSessions(hostId, v) { if (db.hosts[hostId] !== v) return false; db.hosts[hostId]++; return true; },
    async createHelper({ gameId, hostVersion, label, canScore, canSquares, tokenHash, tokenSeconds, max }) {
      if (db.helpers.filter(r => r.gameId === gameId).length >= max) return null;
      const id = crypto.randomUUID();
      db.helpers.push({ id, gameId, hostVersion, label, canScore, canSquares, tokenHash, tokenSeconds, sessionHash: null });
      return id;
    },
    async useHelperToken({ tokenHash, sessionHash, accounts }) {
      const r = db.helpers.find(x => x.tokenHash === tokenHash && accounts && current(x));
      if (!r) return null;
      Object.assign(r, { tokenHash: null, sessionHash });
      return { gameId: r.gameId, label: r.label, canScore: r.canScore, canSquares: r.canSquares };
    },
    async helperAccess({ gameId, sessionHash, accounts }) {
      db.lookups++;
      if (db.missing) throw Object.assign(new Error('relation "helpers" does not exist'), { code: '42P01' });
      const r = db.helpers.find(x => accounts && x.gameId === gameId && x.sessionHash === sessionHash && current(x));
      return r ? { id: r.id, label: r.label, canScore: r.canScore, canSquares: r.canSquares } : null;
    },
    async listHelpers(gameId, v) {
      if (db.missing) throw Object.assign(new Error('relation "helpers" does not exist'), { code: '42P01' });
      return db.helpers.filter(r => r.gameId === gameId && r.hostVersion === v)
        .map(r => ({ id: r.id, label: r.label, canScore: r.canScore, canSquares: r.canSquares, connected: !!r.sessionHash, waiting: !!r.tokenHash }));
    },
    async setHelperJobs({ gameId, id, hostVersion, canScore, canSquares }) {
      const r = db.helpers.find(x => x.id === id && x.gameId === gameId && x.hostVersion === hostVersion);
      if (r) Object.assign(r, { canScore, canSquares });
      return !!r;
    },
    async newHelperCode({ gameId, id, hostVersion, tokenHash, tokenSeconds }) {
      const r = db.helpers.find(x => x.id === id && x.gameId === gameId && x.hostVersion === hostVersion);
      if (r) Object.assign(r, { tokenHash, tokenSeconds });
      return !!r;
    },
    async removeHelper({ gameId, id }) {
      const n = db.helpers.length;
      db.helpers = db.helpers.filter(r => !(r.id === id && r.gameId === gameId));
      return db.helpers.length < n;
    }
  };
  const real = {};
  Object.keys(fakes).forEach(k => { real[k] = store[k]; store[k] = fakes[k]; });
  return { db, restore() { Object.assign(store, real); } };
}

const TAP = { op: 'add', side: 'a', points: 7 };
const PAY = { op: 'paid', name: 'Ann', paidSquares: 100, have: 100, was: 0 };
const SQUARES_OPS = [PAY, { op: 'claim', name: 'Eve', squares: [1], have: 0 }, { op: 'claim', name: 'Eve', count: 1, have: 0 },
  { op: 'removeUnpaid', name: 'Ann', have: 100, unpaid: 100 }, { op: 'picks', on: true, max: 9 }];
const refused = 'That code is wrong, used or expired. Ask the host for a new one.';

async function accountsRoutes() {
  let t;
  const test = (name, fn) => check(`accounts: ${name}`, async () => {
    setEnv(ACCOUNTS_ENV);
    t = standIn();
    try { await fn(); } finally { t.restore(); }
  });
  const base = (id) => `/api/game/${id || GAME_A}/helpers`;
  const add = async (jobs, id, host) => {
    const body = Object.assign({ label: 'Dana', canScore: true, canSquares: false }, jobs);
    const r = await call('POST', base(id), { cookie: hostCookie(host || A), body });
    eq(r.statusCode, 201, `add: ${r.body}`);
    return r.json;
  };
  const join = async (jobs, id, host) => {
    const made = await add(jobs, id, host);
    const r = await call('POST', '/api/helper', { body: { token: made.token } });
    eq(r.statusCode, 200, `join: ${r.body}`);
    return { id: made.id, res: r, cookie: phoneCookie(r) };
  };
  const tap = (cookie, id) => call('PATCH', `/api/game/${id || GAME_A}/score`, { cookie, body: TAP });

  await test('the owner adds a helper; a phone spends the code and scores that board', async () => {
    const made = await add();
    eq(Object.keys(made).sort(), ['expiresInSeconds', 'id', 'token'], 'fields');
    eq(made.expiresInSeconds, 300, 'QR lifetime');
    assert(/^[A-Za-z0-9_-]{43}$/.test(made.token), 'token shape');
    assert(!JSON.stringify(t.db.helpers).includes(made.token), 'raw token stored');
    const r = await call('POST', '/api/helper', { body: { token: made.token } });
    eq(r.json, { gameId: GAME_A }, 'answer');
    const set = r.headers['set-cookie'];
    assert(/^sbs_helper=[A-Za-z0-9_-]{43};/.test(set), `cookie: ${set}`);
    [`Path=/api/game/${GAME_A};`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=15552000', '; Secure'].forEach(x => assert(set.includes(x), `${x} missing: ${set}`));
    assert(!JSON.stringify(t.db.helpers).includes(phoneCookie(r).split('=')[1]), 'raw session stored');
    const scored = await tap(phoneCookie(r));
    eq(scored.statusCode, 200, `score: ${scored.body}`);
    eq(t.db.games[GAME_A].doc.liveScore.a, 7, 'saved');
  });

  await test('a texted link is a 24 hour code for the same helper, and cancels the QR', async () => {
    const made = await add();
    const link = await call('POST', `${base()}/${made.id}/code`, { cookie: hostCookie(A), body: { link: true } });
    eq([link.statusCode, link.json.expiresInSeconds, link.json.id], [201, 86400, made.id], link.body);
    eq((await call('POST', '/api/helper', { body: { token: made.token } })).statusCode, 401, 'QR cancelled');
    eq((await call('POST', '/api/helper', { body: { token: link.json.token } })).statusCode, 200, 'link');
    const other = await add({ link: true });
    eq(other.expiresInSeconds, 86400, 'added with a link');
    eq((await call('DELETE', `${base()}/${other.id}`, { cookie: hostCookie(A) })).statusCode, 200, 'cancelled');
    eq((await call('POST', '/api/helper', { body: { token: other.token } })).statusCode, 401, 'a cancelled link');
  });

  // Every host route, on this board and others. Neither job opens any of them.
  const hostRoutes = (helperId) => [
    ['PUT', `/api/game/${GAME_A}`, board(GAME_A)], ['DELETE', `/api/game/${GAME_A}`],
    ['PATCH', `/api/game/${GAME_A}/payout`, { op: 'paid', quarter: 'q1' }],
    ['GET', base()], ['POST', base(), { label: 'Me', canScore: true, canSquares: true }],
    ['PATCH', `${base()}/${helperId}`, { canScore: true, canSquares: true }],
    ['POST', `${base()}/${helperId}/code`, {}], ['DELETE', `${base()}/${helperId}`],
    ['POST', '/api/game', board()], ['GET', '/api/games'], ['GET', '/api/todays-games'],
    ['POST', '/api/tv/pair', { code: 'ABCDEF', gameId: GAME_A }], ['POST', '/api/tv/follow', { gameId: GAME_A }], ['GET', '/api/tv/mine'],
    ['GET', '/api/theme'], ['PUT', '/api/theme', { theme: 'x' }], ['GET', '/api/news'], ['PUT', '/api/news', { news: true }],
    ['POST', '/api/session/revoke-all'],
    ...[GAME_A2, GAME_B, GAME_NONE].flatMap(g => SQUARES_OPS.map(op => ['PATCH', `/api/game/${g}/squares`, op])),
    ['PATCH', `/api/game/${GAME_A2}/score`, TAP], ['PATCH', `/api/game/${GAME_B}/score`, TAP], ['PATCH', `/api/game/${GAME_NONE}/score`, TAP]
  ];
  for (const [name, jobs] of [['scorekeeper', {}], ['squares manager', { canScore: false, canSquares: true }], ['helper with both jobs', { canSquares: true }]]) {
    await test(`a ${name} can use no host route, on any board`, async () => {
      const h = await join(jobs);
      const before = t.db.writes;
      const rows = JSON.stringify(t.db.helpers);
      for (const [method, p, body] of hostRoutes(h.id)) {
        eq((await call(method, p, { cookie: h.cookie, body })).statusCode, 401, `${method} ${p}`);
      }
      eq([t.db.writes, JSON.stringify(t.db.helpers)], [before, rows], 'nothing changed');
      eq((await call('GET', '/api/session', { cookie: h.cookie })).json.host, false, 'never signed in as the host');
    });
  }

  await test('a squares manager cannot score', async () => {
    const h = await join({ canScore: false, canSquares: true });
    for (const op of [TAP, { op: 'set', a: 1, b: 2 }, { op: 'end' }, { op: 'final' }, { op: 'undo' }, { op: 'resume' }, { op: 'edit', quarter: 'q1', a: 1, b: 2 }, { op: 'draw' }]) {
      eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie: h.cookie, body: op })).statusCode, 401, op.op);
    }
  });

  const squares = (cookie, op, id, headers) => call('PATCH', `/api/game/${id || GAME_A}/squares`, { cookie, body: op, headers });

  await test('a scorekeeper, a guest and a signed-out phone cannot touch squares, picks or paid marks', async () => {
    const h = await join();
    const before = t.db.writes;
    for (const cookie of [h.cookie, undefined, 'sbs_guest=abc', 'sbs_helper=' + secret()]) {
      for (const id of [GAME_A, GAME_PICKING]) {
        for (const op of SQUARES_OPS) eq((await squares(cookie, op, id)).statusCode, 401, `${op.op} on ${id}`);
      }
    }
    eq(t.db.writes, before, 'nothing written');
  });

  await test('a squares manager works on their own board; another board\'s cookie opens nothing', async () => {
    const h = await join({ canScore: false, canSquares: true }, GAME_PICKING);
    const r = await squares(h.cookie, { op: 'removeUnpaid', name: 'Ann', have: 100, unpaid: 100 }, GAME_PICKING);
    eq([r.statusCode, r.json.game.squares.filter(Boolean).length], [200, 0], r.body.slice(0, 100));
    eq((await squares(h.cookie, { op: 'claim', name: 'Bob', squares: [4, 5], have: 0 }, GAME_PICKING)).statusCode, 200, 'claim');
    eq((await squares(h.cookie, { op: 'picks', on: true, max: 3 }, GAME_PICKING)).json.game.guestPick.max, 3, 'picks');
    const paid = await squares(h.cookie, { op: 'paid', name: 'Bob', paidSquares: 1, have: 2, was: 0 }, GAME_PICKING);
    eq([paid.statusCode, paid.json.name, paid.json.game.players.Bob.paidSquares], [200, 'Bob', 1], 'paid');
    for (const id of [GAME_A, GAME_A2, GAME_B, GAME_NONE]) {
      for (const op of SQUARES_OPS) eq((await squares(h.cookie, op, id)).statusCode, 401, `${op.op} on ${id}`);
    }
    eq((await squares(h.cookie, PAY, crypto.randomUUID())).statusCode, 401, 'no such board');
  });

  await test('the owner may use it too; another host may not', async () => {
    eq((await squares(hostCookie(A), PAY)).statusCode, 200, 'owner');
    eq((await squares(hostCookie(B), PAY)).statusCode, 403, 'another host');
    eq((await squares(hostCookie(A), PAY, GAME_NONE)).statusCode, 403, 'a board nobody owns');
    eq((await squares(hostCookie(A, 9), PAY)).statusCode, 401, 'an old session');
  });

  await test('squares ops carry nothing but themselves, and a locked board takes paid marks only', async () => {
    const h = await join({ canScore: false, canSquares: true });
    const r = await squares(h.cookie, Object.assign({ squares: [], players: {}, squarePrice: 0, status: 'picking', owner_id: B }, PAY));
    eq(r.statusCode, 200, r.body);
    const doc = t.db.games[GAME_A].doc;
    eq([doc.squarePrice, doc.status, doc.squares.length, doc.players.Ann.paid, 'owner_id' in doc, 'owner_id' in r.json.game], [10, 'started', 100, true, false, false], 'untouched');
    for (const op of SQUARES_OPS.slice(1)) {
      const x = await squares(h.cookie, op);
      eq([x.statusCode, /locked/.test(x.json.error)], [409, true], op.op);
    }
    eq((await squares(h.cookie, { op: 'lock' })).statusCode, 400, 'unknown');
    eq((await call('PATCH', `/api/game/${GAME_A}/squares`, { cookie: h.cookie, body: Object.assign({ pad: 'x'.repeat(5000) }, PAY) })).statusCode, 413, 'size');
  });

  await test('a squares job switched off, removed, or signed out everywhere ends at the next request', async () => {
    for (const end of ['off', 'remove', 'revoke']) {
      const h = await join({ canScore: true, canSquares: true });
      eq((await squares(h.cookie, PAY)).statusCode, 200, `${end}: before`);
      const one = `${base()}/${h.id}`;
      const owner = { cookie: hostCookie(A, t.db.hosts[A]) };
      if (end === 'off') await call('PATCH', one, Object.assign({ body: { canScore: true, canSquares: false } }, owner));
      if (end === 'remove') await call('DELETE', one, owner);
      if (end === 'revoke') await call('POST', '/api/session/revoke-all', owner);
      eq((await squares(h.cookie, PAY)).statusCode, 401, `${end}: after`);
      eq((await tap(h.cookie)).statusCode, end === 'off' ? 200 : 401, `${end}: the other job`);
    }
  });

  await test('the score survives a paid mark', async () => {
    const h = await join({ canScore: false, canSquares: true });
    Object.assign(t.db.games[GAME_A].doc, { scoring: 'manual', liveScore: { manual: true, a: 7, b: 3, period: 2, state: 'in' } });
    const r = await squares(h.cookie, PAY);
    eq([r.statusCode, r.json.game.liveScore.a, t.db.games[GAME_A].doc.liveScore.b], [200, 7, 3], r.body.slice(0, 100));
    // A score merged on read (here a simulation) is in the answer too, and the mark is stored.
    const plan = { startedAt: new Date(Date.now() - 5000).toISOString(), events: [{ team: 'a', atMs: 1, points: 7 }] };
    Object.assign(t.db.games[GAME_A].doc, { scoring: 'simulation', simulation: true, simPlan: plan, liveScore: null, players: { Ann: { paid: false } } });
    const sim = await squares(h.cookie, PAY);
    eq([sim.statusCode, sim.json.game.liveScore.a, t.db.games[GAME_A].doc.players.Ann.paid], [200, 7, true], sim.body.slice(0, 100));
  });

  await test('score ops cannot carry anything but a score', async () => {
    const { cookie } = await join();
    const r = await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: { ...TAP, squares: [], players: {}, squarePrice: 0, owner_id: B } });
    eq(r.statusCode, 200, 'status');
    const doc = t.db.games[GAME_A].doc;
    eq([doc.squares.length, doc.squarePrice, doc.players.Ann.paid, 'owner_id' in doc], [100, 10, false, false], 'untouched');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: { op: 'draw', row: 0, col: 0 } })).statusCode, 409, 'no draw unless the final needs one');
  });

  await test('a code works once; wrong, used, replaced and malformed all get one answer and no cookie', async () => {
    const made = await add();
    const second = (await call('POST', `${base()}/${made.id}/code`, { cookie: hostCookie(A), body: {} })).json;
    eq((await call('POST', '/api/helper', { body: { token: second.token } })).statusCode, 200, 'newest works');
    for (const token of [made.token, second.token, secret(), 'short', 7, null, undefined, { a: 1 }, second.token + 'x']) {
      const r = await call('POST', '/api/helper', { body: { token } });
      eq([r.statusCode, r.json.error, r.headers['set-cookie']], [401, refused, undefined], String(token));
      assert(!r.json.authRequired, 'must not open the sign-in prompt');
    }
  });

  await test('two phones spending one code together: one gets in', async () => {
    const { token } = await add();
    const got = await Promise.all([1, 2, 3].map(() => call('POST', '/api/helper', { body: { token } })));
    eq(got.map(r => r.statusCode).sort(), [200, 401, 401], 'statuses');
  });

  await test('the token is not a cookie, a cookie is not a token, and the old scorer cookie opens nothing', async () => {
    const { token } = await add();
    eq((await tap(`sbs_helper=${token}`)).statusCode, 401, 'token as cookie');
    const used = (await join()).cookie.split('=')[1];
    eq((await call('POST', '/api/helper', { body: { token: used } })).statusCode, 401, 'cookie as token');
    for (const cookie of ['sbs_helper=', 'sbs_helper=x', `sbs_helper=${secret()}`, 'sbs_helper=%E0%A4%A', `sbs_session=${used}`, `sbs_host=${used}`, `sbs_scorer=${used}`]) {
      eq((await tap(cookie)).statusCode, 401, cookie);
    }
  });

  await test('only the owner can add, see, change, code or remove', async () => {
    const made = await add();
    const one = `${base()}/${made.id}`;
    const body = { label: 'Eve', canScore: true, canSquares: true };
    const none = `${base(GAME_NONE)}`;
    const rows = JSON.stringify(t.db.helpers);
    for (const [method, p] of [['GET', base()], ['POST', base()], ['PATCH', one], ['DELETE', one], ['POST', `${one}/code`]]) {
      eq((await call(method, p, { body })).statusCode, 401, `${method} ${p} anonymous`);
      eq((await call(method, p, { body, cookie: hostCookie(B) })).statusCode, 403, `${method} ${p} another host`);
      eq((await call(method, p, { body, cookie: hostCookie(A, 9) })).statusCode, 401, `${method} ${p} ended session`);
      eq((await call(method, p.replace(GAME_A, GAME_NONE), { body, cookie: hostCookie(A) })).statusCode, 403, `${method} ${none} unowned`);
      eq((await call(method, p.replace(GAME_A, crypto.randomUUID()), { body, cookie: hostCookie(A) })).statusCode, 404, `${method} unknown board`);
      // B's own board is B's, but A's helper is not on it.
      const r = await call(method, p.replace(GAME_A, GAME_B), { body, cookie: hostCookie(B) });
      if (p !== base()) assert(r.statusCode === 404 || (method === 'DELETE' && r.statusCode === 200), `${method} through B's board: ${r.statusCode}`);
    }
    eq(JSON.stringify(t.db.helpers.filter(r => r.gameId === GAME_A)), rows, 'untouched');
  });

  await test('a helper is refused without a fair label, a job, or room', async () => {
    const post = async (body) => (await call('POST', base(), { cookie: hostCookie(A), body })).statusCode;
    for (const label of [undefined, '', '   ', 7, null, 'elevenchars', 'x'.repeat(200), '​‮']) eq(await post({ label, canScore: true }), 400, String(label));
    eq(await post({ label: 'Dana' }), 400, 'no job');
    eq(await post({ label: 'Dana', canScore: 'yes', canSquares: 1 }), 400, 'jobs must be true');
    eq(await post({ label: ' Ann‮  B ', canScore: true }), 201, 'tidied');
    eq(t.db.helpers[0].label, 'Ann B', 'label');
    for (let i = 0; i < 4; i++) await add();
    eq(await post({ label: 'Sixth', canScore: true }), 409, 'sixth');
  });

  await test('helpers can be added while the board is picking, and not a day after it ended', async () => {
    const h = await join({}, GAME_PICKING);
    eq((await tap(h.cookie, GAME_PICKING)).statusCode, 409, 'scoring waits for the lock');
    const g = t.db.games[GAME_A].doc;
    Object.assign(g, { status: 'finished', updatedAt: new Date(Date.now() - 25 * HOUR).toISOString() });
    eq((await call('POST', base(), { cookie: hostCookie(A), body: { label: 'Dana', canScore: true } })).statusCode, 409, 'over');
    g.updatedAt = new Date(Date.now() - HOUR).toISOString();
    await add();
  });

  await test('a job switched off ends at the next request; remove ends the phone', async () => {
    const h = await join();
    const other = await join();
    const set = (canScore, canSquares) => call('PATCH', `${base()}/${h.id}`, { cookie: hostCookie(A), body: { canScore, canSquares } });
    eq((await set(false, true)).statusCode, 200, 'off');
    eq((await tap(h.cookie)).statusCode, 401, 'after off');
    eq((await set(true, false)).statusCode, 200, 'on');
    eq((await tap(h.cookie)).statusCode, 200, 'after on');
    eq((await set('yes', 1)).statusCode, 400, 'jobs must be true or false');
    const gone = await call('DELETE', `${base()}/${h.id}`, { cookie: hostCookie(A) });
    eq(gone.json.helpers.map(x => x.id), [other.id], 'list after remove');
    eq((await tap(h.cookie)).statusCode, 401, 'after remove');
    eq((await tap(other.cookie)).statusCode, 200, 'the other helper');
    eq((await set(true, true)).statusCode, 404, 'change a removed helper');
    eq((await call('DELETE', `${base()}/${h.id}`, { cookie: hostCookie(A) })).statusCode, 200, 'remove again');
  });

  await test('sign out everywhere ends the phones and the waiting code; plain sign-out does not', async () => {
    const { cookie } = await join();
    await call('DELETE', '/api/session', { cookie: hostCookie(A) });
    eq((await tap(cookie)).statusCode, 200, 'after sign-out');
    const { token } = await add();
    eq((await call('POST', '/api/session/revoke-all', { cookie: hostCookie(A) })).statusCode, 200, 'revoke');
    eq((await tap(cookie)).statusCode, 401, 'phone');
    eq((await call('POST', '/api/helper', { body: { token } })).statusCode, 401, 'waiting code');
    eq((await call('GET', base(), { cookie: hostCookie(A, 2) })).json, { helpers: [] }, 'list');
  });

  await test('role names only the asking phone', async () => {
    const h = await join({ canSquares: true });
    const role = async (id, c) => (await call('GET', `/api/game/${id}/role`, { cookie: c })).json;
    eq(await role(GAME_A, hostCookie(A)), { role: 'host' }, 'host');
    eq(await role(GAME_A, h.cookie), { role: 'helper', label: 'Dana', canScore: true, canSquares: true }, 'helper');
    eq(await role(GAME_A, `${hostCookie(A)}; ${h.cookie}`), { role: 'host', label: 'Dana', canScore: true, canSquares: true }, 'both');
    eq([await role(GAME_A), await role(GAME_A, hostCookie(B)), await role(GAME_A2, h.cookie)], [{ role: 'none' }, { role: 'none' }, { role: 'none' }], 'none');
    eq((await call('GET', `/api/game/${GAME_A}/role`)).headers['cache-control'], 'no-store', 'cache');
  });

  await test('the shared board read carries nothing about helpers', async () => {
    const h = await join({ label: 'Zebra' });
    const r = await call('GET', `/api/game/${GAME_A}`, { cookie: h.cookie });
    assert(!r.headers['set-cookie'] && !/helper|Zebra/i.test(r.body), 'helper data in a cached read');
  });

  await test('another host keeps 403 without a job, and can score with one', async () => {
    eq((await tap(hostCookie(B))).statusCode, 403, 'no job');
    const cookie = `${hostCookie(B)}; ${(await join()).cookie}`;
    eq((await tap(cookie)).statusCode, 200, 'with one');
    eq((await call('PUT', `/api/game/${GAME_A}`, { cookie, body: board(GAME_A) })).statusCode, 403, 'PUT');
    eq((await call('DELETE', `/api/game/${GAME_A}`, { cookie })).statusCode, 403, 'DELETE');
  });

  await test('no extra lookup for a device without the cookie', async () => {
    await tap(hostCookie(A));
    await tap();
    eq(t.db.lookups, 0, 'lookups');
  });

  await test('without migration 010 only helper features fail', async () => {
    const h = await join();
    t.db.missing = true;
    eq((await tap(hostCookie(A))).statusCode, 200, 'host scores');
    eq((await tap(`${hostCookie(A)}; ${h.cookie}`)).statusCode, 200, 'host who also holds a cookie');
    eq((await tap(h.cookie)).statusCode, 401, 'helper');
    eq((await call('GET', `/api/game/${GAME_A}/role`, { cookie: h.cookie })).json, { role: 'none' }, 'role');
    eq((await call('GET', base(), { cookie: hostCookie(A) })).statusCode, 503, 'list');
    eq((await call('GET', base())).statusCode, 401, 'list, anonymous');
  });

  await test('a foreign Origin is refused on every helper write', async () => {
    const made = await add();
    const headers = { origin: 'https://evil.example' };
    const one = `${base()}/${made.id}`;
    eq((await call('POST', '/api/helper', { body: { token: made.token }, headers })).statusCode, 403, 'redeem');
    for (const [m, p] of [['POST', base()], ['PATCH', one], ['DELETE', one], ['POST', `${one}/code`]]) {
      eq((await call(m, p, { cookie: hostCookie(A), body: { label: 'Eve', canScore: true, canSquares: true }, headers })).statusCode, 403, `${m} ${p}`);
    }
    const cookie = phoneCookie(await call('POST', '/api/helper', { body: { token: made.token } }));
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP, headers })).statusCode, 403, 'score');
    const manager = await join({ canScore: false, canSquares: true });
    for (const op of SQUARES_OPS) eq((await squares(manager.cookie, op, GAME_A, headers)).statusCode, 403, op.op);
    eq(t.db.games[GAME_A].doc.players.Ann.paid, false, 'not paid');
  });

  await test('a broken sign-in setup lets no helper in', async () => {
    const { cookie } = await join({ canSquares: true });
    const { token } = await add();
    for (const broken of [{ ...ACCOUNTS_ENV, AUTH_MODE: 'acounts' }, { VERCEL: '1' }, { ...ACCOUNTS_ENV, SESSION_SECRET: 'short' }]) {
      setEnv(broken);
      eq(auth.authMode(), 'misconfigured', 'mode');
      eq((await call('POST', '/api/helper', { body: { token } })).statusCode, 503, 'redeem');
      eq((await tap(cookie)).statusCode, 503, 'score');
      eq((await squares(cookie, PAY)).statusCode, 503, 'squares');
      eq((await call('POST', base(), { cookie: hostCookie(A) })).statusCode, 503, 'add');
      eq((await call('GET', `/api/game/${GAME_A}/role`, { cookie })).json, { role: 'none' }, 'role');
    }
  });
}

// The squares route over a real store, in password mode: rules judged in the document the write is
// conditional on. `s` takes the place of the store behind the routes; `made(id)` notes a board to delete.
async function squaresRace(label, s, made) {
  const real = {};
  const names = ['getGame', 'updateGame', 'createGame', 'createHelper', 'useHelperToken', 'helperAccess', 'setHelperJobs', 'removeHelper', 'listHelpers', 'assignJoinCode'];
  const open = { status: 'picking', axisX: null, axisY: null, squares: new Array(100).fill(null), players: {} };
  const start = async (extra, jobs) => {
    const g = await s.createGame(Object.assign(board(), open, extra), null);
    made(g.id);
    const token = secret();
    // Not a player, no squares on the board.
    await s.createHelper({ gameId: g.id, hostVersion: null, label: 'Pat', canScore: false, canSquares: true, tokenHash: hash(token), tokenSeconds: 300, max: 5 });
    const cookie = phoneCookie(await call('POST', '/api/helper', { body: { token } }));
    return { id: g.id, send: (op) => call('PATCH', `/api/game/${g.id}/squares`, { cookie, body: op }) };
  };
  // Another device's save lands between the route's read and its write, once.
  const between = (change) => {
    store.getGame = async (id) => {
      const g = await s.getGame(id);
      store.getGame = s.getGame;
      const other = JSON.parse(JSON.stringify(g));
      change(other);
      assert((await s.updateGame(id, other, g.updatedAt)).ok, 'the other save');
      return g;
    };
  };
  const heldBy = (g, n) => g.squares.filter(x => x && x.name === n).length;
  const lock = (g) => { g.status = 'started'; g.axisX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; g.axisY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; };
  const gus = { squares: new Array(100).fill(null).map((x, i) => (i < 3 ? { name: 'Gus', at: 100 + i } : null)), players: { Gus: { paid: false } } };
  const test = (name, fn) => check(`${label}: ${name}`, async () => {
    setEnv({ HOST_PASSWORD: 'correct horse' });
    names.forEach(n => { real[n] = store[n]; store[n] = s[n]; });
    try { await fn(); } finally { names.forEach(n => { store[n] = real[n]; }); }
  });

  await test('a non-player manages a board with no squares yet', async () => {
    const b = await start();
    eq((await b.send({ op: 'picks', on: true, max: 4 })).statusCode, 200, 'picks');
    eq((await b.send({ op: 'claim', name: 'Gus', count: 3, have: 0 })).statusCode, 200, 'claim');
    eq((await b.send({ op: 'paid', name: 'Gus', paidSquares: 1, have: 3, was: 0 })).statusCode, 200, 'paid');
    eq((await b.send({ op: 'removeUnpaid', name: 'Gus', have: 3, unpaid: 2 })).statusCode, 200, 'remove');
    const g = await s.getGame(b.id);
    eq([heldBy(g, 'Gus'), g.players.Gus.paid, g.guestPick.max], [1, true, 4], 'stored');
  });

  await test('a lock in between refuses everything but a paid mark', async () => {
    for (const op of [{ op: 'claim', name: 'Eve', count: 1, have: 0 }, { op: 'claim', name: 'Eve', squares: [50], have: 0 },
      { op: 'removeUnpaid', name: 'Gus', have: 3, unpaid: 3 }, { op: 'picks', on: true, max: 4 }]) {
      const b = await start(gus);
      between(lock);
      eq((await b.send(op)).statusCode, 409, op.op);
      const g = await s.getGame(b.id);
      eq([g.status, heldBy(g, 'Gus'), heldBy(g, 'Eve'), g.guestPick], ['started', 3, 0, undefined], op.op);
    }
    const b = await start(gus);
    between(lock);
    eq((await b.send({ op: 'paid', name: 'Gus', paidSquares: 3, have: 3, was: 0 })).statusCode, 200, 'paid');
    const g = await s.getGame(b.id);
    eq([g.status, g.players.Gus.paid, !!g.axisX], ['started', true, true], 'the lock stays');
  });

  await test('a paid mark in between saves the squares it paid for', async () => {
    const b = await start(gus);
    between(g => { g.players.Gus = { paid: false, paidSquares: 1 }; });
    eq((await b.send({ op: 'removeUnpaid', name: 'Gus', have: 3, unpaid: 3 })).statusCode, 409, 'refused');
    eq(heldBy(await s.getGame(b.id), 'Gus'), 3, 'squares');
  });

  await test('two devices: one square, one mark; nothing is done twice', async () => {
    const b = await start();
    const claim = { op: 'claim', name: 'Gus', count: 3, have: 0 };
    const twice = await Promise.all([b.send(claim), b.send(claim)]);
    eq(twice.map(r => r.statusCode).sort(), [200, 409], 'the same claim sent twice');
    eq(heldBy(await s.getGame(b.id), 'Gus'), 3, 'claimed once');
    const g0 = await s.getGame(b.id);
    const free = g0.squares.findIndex(x => !x);
    const race = await Promise.all(['Ann', 'Bob'].map(name => b.send({ op: 'claim', name, squares: [free], have: 0 })));
    eq(race.map(r => r.statusCode).sort(), [200, 409], 'one square');
    eq(race.find(r => r.statusCode === 409).json.taken, [free], 'names it');
    const gone = { op: 'removeUnpaid', name: 'Gus', have: 3, unpaid: 3 };
    const removed = await Promise.all([b.send(gone), b.send(gone)]);
    eq(removed.map(r => r.statusCode).sort(), [200, 409], 'the same removal sent twice');
    eq(heldBy(await s.getGame(b.id), 'Gus'), 0, 'removed once');
  });

  await test('different people served at once all get through', async () => {
    const b = await start();
    const got = await Promise.all([0, 1, 2, 3].map(n => b.send({ op: 'claim', name: `P${n}`, count: 2, have: 0 })));
    eq(got.map(r => r.statusCode), [200, 200, 200, 200], 'all');
    eq((await s.getGame(b.id)).squares.filter(Boolean).length, 8, 'squares');
  });

  await test('a board deleted in between is gone', async () => {
    const b = await start(gus);
    store.getGame = async () => null;
    eq((await b.send({ op: 'paid', name: 'Gus', paidSquares: 1, have: 3, was: 0 })).statusCode, 404, 'deleted');
  });
}

async function fsRoutes() {
  const newBoard = async () => {
    setEnv({});
    const made = await call('POST', '/api/game', { body: board() });
    assert(made.statusCode === 201, `create: ${made.body}`);
    createdFs.push(made.json.id);
    return made.json;
  };
  const DANA = { label: 'Dana', canScore: true, canSquares: false };

  await check('password mode: add, scan, score; the helper is not the host', async () => {
    const g = await newBoard();
    const base = `/api/game/${g.id}/helpers`;
    setEnv({ HOST_PASSWORD: 'correct horse' });
    const host = String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
    eq((await call('POST', base, { body: DANA })).statusCode, 401, 'anonymous');
    const made = await call('POST', base, { cookie: host, body: DANA });
    eq(made.statusCode, 201, made.body);
    const cookie = phoneCookie(await call('POST', '/api/helper', { body: { token: made.json.token } }));
    const tap = () => call('PATCH', `/api/game/${g.id}/score`, { cookie, body: TAP });
    eq((await call('GET', `/api/game/${g.id}/role`, { cookie })).json, { role: 'helper', label: 'Dana', canScore: true, canSquares: false }, 'role');
    eq((await tap()).statusCode, 200, 'score');
    eq((await call('PUT', `/api/game/${g.id}`, { cookie, body: g })).statusCode, 401, 'PUT');
    eq((await call('DELETE', `/api/game/${g.id}`, { cookie })).statusCode, 401, 'DELETE');
    eq((await call('GET', '/api/games', { cookie })).statusCode, 401, 'list');
    setEnv({ AUTH_MODE: 'acounts' });
    eq((await tap()).statusCode, 503, 'score with sign-in broken');
    setEnv({ HOST_PASSWORD: 'correct horse' });
    eq((await call('POST', `/api/game/${crypto.randomUUID()}/helpers`, { cookie: host, body: DANA })).statusCode, 404, 'unknown board');
    eq((await call('PATCH', `${base}/${made.json.id}`, { cookie: host, body: { canScore: false, canSquares: false } })).statusCode, 200, 'job off');
    eq((await tap()).statusCode, 401, 'after the job went off');
    eq((await call('PATCH', `${base}/${made.json.id}`, { cookie: host, body: { canScore: true, canSquares: false } })).statusCode, 200, 'job on');
    eq((await tap()).statusCode, 200, 'again');
    eq((await call('DELETE', `${base}/${made.json.id}`, { cookie: host })).json, { helpers: [] }, 'remove');
    eq((await tap()).statusCode, 401, 'after removal');
  });

  await check('a helper need not be playing, and may come before anyone has squares', async () => {
    for (const jobs of [{ canScore: true, canSquares: false }, { canScore: false, canSquares: true }, { canScore: true, canSquares: true }]) {
      setEnv({});
      const empty = Object.assign(board(), { status: 'picking', axisX: null, axisY: null, squares: new Array(100).fill(null), players: {} });
      const made = (await call('POST', '/api/game', { body: empty })).json;
      createdFs.push(made.id);
      setEnv({ HOST_PASSWORD: 'correct horse' });
      const host = String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
      const added = await call('POST', `/api/game/${made.id}/helpers`, { cookie: host, body: Object.assign({ label: 'Pat' }, jobs) });
      eq(added.statusCode, 201, added.body);
      const r = await call('POST', '/api/helper', { body: { token: added.json.token } });
      eq(r.statusCode, 200, r.body);
      const cookie = phoneCookie(r);
      eq((await call('GET', `/api/game/${made.id}/role`, { cookie })).json, Object.assign({ role: 'helper', label: 'Pat' }, jobs), 'role');
      // The board locks with others' squares on it; the non-player's job is what counts.
      const locked = Object.assign(board(made.id), { updatedAt: (await store.getGame(made.id)).updatedAt });
      eq((await call('PUT', `/api/game/${made.id}`, { cookie: host, body: locked })).statusCode, 200, 'lock');
      eq((await call('PATCH', `/api/game/${made.id}/score`, { cookie, body: TAP })).statusCode, jobs.canScore ? 200 : 401, 'score by job');
    }
  });

  await check('the label authorizes nothing, and a player who helps keeps the job without squares', async () => {
    const g = await newBoard();
    setEnv({ HOST_PASSWORD: 'correct horse' });
    const host = String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
    const one = async (label, canScore) => {
      const made = await call('POST', `/api/game/${g.id}/helpers`, { cookie: host, body: { label, canScore, canSquares: !canScore } });
      return phoneCookie(await call('POST', '/api/helper', { body: { token: made.json.token } }));
    };
    const ann = await one('Ann', true);   // Ann is a player on the board
    const annToo = await one('Ann', false); // the same label, another job
    const gone = Object.assign(await store.getGame(g.id), { squares: Array.from({ length: 100 }, () => ({ name: 'Bob' })), players: { Bob: { paid: false } } });
    eq((await call('PUT', `/api/game/${g.id}`, { cookie: host, body: gone })).statusCode, 200, 'Ann has no squares now');
    eq((await call('PATCH', `/api/game/${g.id}/score`, { cookie: ann, body: TAP })).statusCode, 200, 'job stays');
    eq((await call('PATCH', `/api/game/${g.id}/score`, { cookie: annToo, body: TAP })).statusCode, 401, 'the label opens nothing');
  });

  await check('no job, and no job ended, takes away the helper\'s own numbers or picks', async () => {
    setEnv({});
    const open = Object.assign(board(), {
      status: 'picking', axisX: null, axisY: null, squares: new Array(100).fill(null), players: {},
      pickMode: 'both', guestPick: { on: true, max: 10, liftAt: null, lifted: false }
    });
    const made = await call('POST', '/api/game', { body: open });
    eq(made.statusCode, 201, made.body);
    const id = made.json.id;
    createdFs.push(id);
    setEnv({ HOST_PASSWORD: 'correct horse' });
    const host = String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
    const added = (await call('POST', `/api/game/${id}/helpers`, { cookie: host, body: { label: 'Dana', canScore: true, canSquares: true } })).json;
    let cookie = phoneCookie(await call('POST', '/api/helper', { body: { token: added.token } }));
    const key = await call('POST', `/api/game/${id}/guest`, { cookie });
    eq(key.statusCode, 200, key.body);
    cookie += '; ' + phoneCookie(key);
    const set = (canScore, canSquares) => call('PATCH', `/api/game/${id}/helpers/${added.id}`, { cookie: host, body: { canScore, canSquares } });
    const pick = async (square, what) => {
      const r = await call('PATCH', `/api/game/${id}/guest`, { cookie, body: { op: 'claim', name: 'Dana', squares: [square] } });
      eq([r.statusCode, r.json.name], [200, 'Dana'], `${what}: ${r.body.slice(0, 120)}`);
      const seen = (await call('GET', `/api/game/${id}`, { cookie })).json;
      eq(seen.squares.filter(s => s && s.name === 'Dana').length, square + 1, `${what}: own squares`);
    };
    await pick(0, 'both jobs');
    await set(true, false); await pick(1, 'score only');
    await set(false, true); await pick(2, 'squares only');
    await set(false, false); await pick(3, 'every job off');
    await call('DELETE', `/api/game/${id}/helpers/${added.id}`, { cookie: host });
    await pick(4, 'removed');
  });

  await check('auth off: every device is the host, and the flow still works', async () => {
    const g = await newBoard();
    eq((await call('GET', `/api/game/${g.id}/role`)).json, { role: 'host' }, 'role');
    const made = await call('POST', `/api/game/${g.id}/helpers`, { body: DANA });
    eq(made.statusCode, 201, made.body);
    const r = await call('POST', '/api/helper', { body: { token: made.json.token } });
    eq(r.json, { gameId: g.id }, 'scan');
    eq((await call('GET', `/api/game/${g.id}/role`, { cookie: phoneCookie(r) })).json.canScore, true, 'the phone knows its job');
    eq((await call('GET', `/api/game/${g.id}/helpers`)).json.helpers.map(h => h.connected), [true], 'status');
    eq((await call('PATCH', `/api/game/${g.id}/squares`, { body: PAY })).statusCode, 200, 'squares');
    eq((await call('GET', `/api/game/${g.id}/squares`)).statusCode, 404, 'no read there');
  });

  await check('other methods and the retired hand-off routes are not found', async () => {
    const g = await newBoard();
    const one = `/api/game/${g.id}/helpers/${crypto.randomUUID()}`;
    for (const [m, p] of [['GET', '/api/helper'], ['PUT', `/api/game/${g.id}/helpers`], ['DELETE', `/api/game/${g.id}/helpers`],
      ['GET', one], ['GET', `${one}/code`], ['POST', `/api/game/${g.id}/role`],
      ['POST', '/api/handoff'], ['GET', `/api/game/${g.id}/handoff`], ['POST', `/api/game/${g.id}/handoff`]]) {
      eq((await call(m, p, { body: {} })).statusCode, 404, `${m} ${p}`);
    }
  });
}

async function main() {
  setEnv({});
  await storeContract('fs', store, {
    accounts: false, version: null,
    newGame: async () => {
      const g = await store.createGame(board(), null);
      createdFs.push(g.id);
      return g.id;
    }
  });
  await check('fs: tokens and sessions are stored hashed, never raw', async () => {
    const g = await store.createGame(board(), null);
    createdFs.push(g.id);
    const token = secret();
    const session = secret();
    const add = { gameId: g.id, hostVersion: null, label: 'Dana', canScore: true, canSquares: false, tokenSeconds: 300, max: 5 };
    await store.createHelper({ ...add, tokenHash: hash(token) });
    await store.useHelperToken({ tokenHash: hash(token), sessionHash: hash(session), accounts: false });
    const waiting = secret();
    await store.createHelper({ ...add, tokenHash: hash(waiting) });
    const raw = fs.readFileSync(FILE, 'utf8');
    assert(!raw.includes(token) && !raw.includes(session) && !raw.includes(waiting), 'raw secret on disk');
    assert(raw.includes(hash(waiting)) && raw.includes(hash(session)), 'hash missing');
  });
  await accountsRoutes();
  await fsRoutes();
  await squaresRace('fs squares', Object.assign({}, store), (id) => createdFs.push(id));
  setEnv({});

  if (PG_URL) {
    process.env.DATABASE_URL = PG_URL;
    const pg = require('./lib/store-pg.js');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(PG_URL);
    const games = [];
    const email = `helpers-${crypto.randomUUID()}@example.com`;
    const host = (await sql`insert into hosts (email) values (${email}) returning id, session_version`)[0];
    try {
      const newGame = (owner) => async () => {
        const g = await pg.createGame(board(), owner);
        games.push(g.id);
        return g.id;
      };
      await storeContract('pg accounts', pg, { accounts: true, version: host.session_version, newGame: newGame(host.id) });
      await storeContract('pg password', pg, { accounts: false, version: null, newGame: newGame(null) });
      await squaresRace('pg squares', pg, (id) => games.push(id));

      const add = (g, v, tokenHash) => pg.createHelper({ gameId: g, hostVersion: v, label: 'Dana', canScore: true, canSquares: false, tokenHash, tokenSeconds: 300, max: 5 }, T0);

      await check('pg: an unowned board has no helpers in accounts mode', async () => {
        const g = await newGame(null)();
        const token = hash(secret());
        await add(g, host.session_version, token);
        eq(await pg.useHelperToken({ tokenHash: token, sessionHash: hash(secret()), accounts: true }, T0), null, 'use');
      });

      await check('pg: sign out everywhere ends the helper and the waiting code', async () => {
        const g = await newGame(host.id)();
        const v = host.session_version;
        const token = hash(secret());
        const session = hash(secret());
        await add(g, v, token);
        eq((await pg.useHelperToken({ tokenHash: token, sessionHash: session, accounts: true }, T0)).gameId, g, 'used');
        const waiting = hash(secret());
        await add(g, v, waiting);
        eq(await pg.revokeSessions(host.id, v), true, 'revoke');
        eq(await pg.helperAccess({ gameId: g, sessionHash: session, accounts: true }, T0), null, 'helper');
        eq(await pg.useHelperToken({ tokenHash: waiting, sessionHash: hash(secret()), accounts: true }, T0), null, 'code');
        eq(await pg.listHelpers(g, v + 1, T0), [], 'not listed');
      });
    } finally {
      for (const id of games) await pg.deleteGame(id);
      await sql`delete from hosts where id = ${host.id}`;
    }
  } else {
    console.log('  (Postgres helper tests skipped: no DATABASE_URL)');
  }
}

main()
  .catch(e => failures.push(`crashed\n      ${e.stack}`))
  .then(async () => {
    for (const id of createdFs) { try { await store.deleteGame(id); } catch (e) { /* best effort */ } }
    restoreFile();
    console.log('');
    if (failures.length) {
      console.log(`  ${failures.length} failed, ${passed} passed`);
      failures.forEach(f => console.log('  FAIL ' + f));
      process.exit(1);
    }
    console.log(`  helpers: ${passed} passed`);
  });
