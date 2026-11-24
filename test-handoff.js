// Scorer-phone hand-off (R24, decision 018): the store contract (fs always; Postgres when
// DATABASE_URL is set, pointed at a throwaway Neon branch with migrations 001 to 006 applied)
// and the routes (accounts mode with a stand-in store, then password, off and misconfigured).
// The clock is injected, so nothing sleeps.
//
// Run with:  node test-handoff.js   (or: npm test)
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

// `newGame(version)` makes a board whose current host version is `version` (null = password
// and off modes). `accounts` is the mode the contract runs in.
async function storeContract(label, s, { newGame, accounts, version }) {
  const make = (gameId, now, extra) => {
    const tokenHash = hash(secret());
    return s.createScorerGrant(Object.assign({ gameId, hostVersion: version, tokenHash, max: 5 }, extra), now)
      .then(scorers => ({ tokenHash, scorers }));
  };
  const use = (tokenHash, now) => {
    const sessionHash = hash(secret());
    return s.useScorerToken({ tokenHash, sessionHash, accounts }, now).then(gameId => ({ gameId, sessionHash }));
  };
  const allowed = (gameId, sessionHash, now) => s.scorerAllowed({ gameId, sessionHash, accounts }, now);

  await check(`${label}: a code becomes a grant for its own board only`, async () => {
    const g = await newGame();
    const other = await newGame();
    const { tokenHash, scorers } = await make(g, T0);
    eq(scorers, 0, 'scorers before');
    eq(await s.scorerStatus(g, version, T0), { waiting: true, scorers: 0 }, 'waiting');
    const u = await use(tokenHash, T0 + MIN);
    eq(u.gameId, g, 'board');
    eq(await s.scorerStatus(g, version, T0 + MIN), { waiting: false, scorers: 1 }, 'used');
    eq(await allowed(g, u.sessionHash, T0 + MIN), true, 'allowed');
    eq(await allowed(other, u.sessionHash, T0 + MIN), false, 'another board');
    eq(await allowed(g, hash(secret()), T0 + MIN), false, 'another phone');
    eq(await allowed(g, tokenHash, T0 + MIN), false, 'the token is not a session');
    eq(await allowed(g, null, T0 + MIN), false, 'no session');
  });

  await check(`${label}: a code works once, also when two phones race`, async () => {
    const g = await newGame();
    const a = await make(g, T0);
    assert((await use(a.tokenHash, T0)).gameId, 'first use');
    eq((await use(a.tokenHash, T0)).gameId, null, 'second use');
    const b = await make(g, T0);
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => use(b.tokenHash, T0)));
    eq(got.filter(x => x.gameId).length, 1, 'winners of the race');
    eq((await use(hash(secret()), T0)).gameId, null, 'unknown code');
  });

  await check(`${label}: an unused code ends at 5 minutes`, async () => {
    const g = await newGame();
    const a = await make(g, T0);
    eq((await s.scorerStatus(g, version, T0 + 5 * MIN)).waiting, false, 'not waiting at 5 min');
    eq((await use(a.tokenHash, T0 + 5 * MIN)).gameId, null, 'expired');
    const b = await make(g, T0);
    eq((await use(b.tokenHash, T0 + 5 * MIN - 1)).gameId, g, 'just before');
  });

  await check(`${label}: a grant ends at 24 hours`, async () => {
    const g = await newGame();
    const u = await use((await make(g, T0)).tokenHash, T0);
    eq(await allowed(g, u.sessionHash, T0 + 24 * HOUR - 1), true, 'just before');
    eq(await allowed(g, u.sessionHash, T0 + 24 * HOUR), false, 'at 24 h');
    eq((await s.scorerStatus(g, version, T0 + 24 * HOUR)).scorers, 0, 'not counted');
  });

  await check(`${label}: a new code cancels the board's earlier one, and no other board's`, async () => {
    const g = await newGame();
    const other = await newGame();
    const old = await make(g, T0);
    const elsewhere = await make(other, T0);
    const fresh = await make(g, T0 + MIN);
    eq((await use(old.tokenHash, T0 + MIN)).gameId, null, 'cancelled');
    eq((await use(elsewhere.tokenHash, T0 + MIN)).gameId, other, 'other board untouched');
    eq((await use(fresh.tokenHash, T0 + MIN)).gameId, g, 'new one works');
  });

  await check(`${label}: no more than max phones; an expired one makes room`, async () => {
    const g = await newGame();
    for (let i = 0; i < 2; i++) await use((await make(g, T0, { max: 2 })).tokenHash, T0);
    eq((await make(g, T0, { max: 2 })).scorers, null, 'full');
    eq((await s.scorerStatus(g, version, T0)).waiting, false, 'nothing stored when full');
    eq((await make(g, T0 + 24 * HOUR, { max: 2 })).scorers, 0, 'room again after 24 h');
  });

  await check(`${label}: remove ends every grant and the waiting code, on that board only`, async () => {
    const g = await newGame();
    const other = await newGame();
    const u1 = await use((await make(g, T0)).tokenHash, T0);
    const u2 = await use((await make(g, T0)).tokenHash, T0);
    const keep = await use((await make(other, T0)).tokenHash, T0);
    const waiting = await make(g, T0);
    await s.removeScorers(g);
    eq(await s.scorerStatus(g, version, T0), { waiting: false, scorers: 0 }, 'status');
    eq([await allowed(g, u1.sessionHash, T0), await allowed(g, u2.sessionHash, T0)], [false, false], 'removed');
    eq((await use(waiting.tokenHash, T0)).gameId, null, 'waiting code');
    eq(await allowed(other, keep.sessionHash, T0), true, 'other board keeps its phone');
  });

  await check(`${label}: deleting the board ends its grants`, async () => {
    const g = await newGame();
    const u = await use((await make(g, T0)).tokenHash, T0);
    const waiting = await make(g, T0);
    await s.deleteGame(g);
    eq(await allowed(g, u.sessionHash, T0), false, 'grant');
    eq((await use(waiting.tokenHash, T0)).gameId, null, 'waiting code');
  });

  await check(`${label}: a row made in another auth mode never counts`, async () => {
    const g = await newGame();
    const foreign = version === null ? 1 : null;
    const a = await make(g, T0, { hostVersion: foreign });
    eq((await use(a.tokenHash, T0)).gameId, null, 'cannot be used in this mode');
    const own = await make(g, T0);
    eq(await s.useScorerToken({ tokenHash: own.tokenHash, sessionHash: hash(secret()), accounts: !accounts }, T0), null, 'used from the other mode');
    const u = await use((await make(g, T0)).tokenHash, T0);
    eq(await s.scorerAllowed({ gameId: g, sessionHash: u.sessionHash, accounts: !accounts }, T0), false, 'checked from the other mode');
  });
}

const FILE = path.join(__dirname, 'data', 'scorer-grants.json');
const hadFile = fs.existsSync(FILE);
const backup = hadFile ? fs.readFileSync(FILE) : null;
const createdFs = [];
// The fs tests share the dev server's file, so put it back as it was, crash or not.
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
    grants: [], writes: 0, scorerLookups: 0
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
    async createScorerGrant({ gameId, hostVersion, tokenHash, max }) {
      db.grants = db.grants.filter(r => r.gameId !== gameId || r.sessionHash);
      const n = db.grants.filter(r => r.gameId === gameId).length;
      if (n >= max) return null;
      db.grants.push({ gameId, hostVersion, tokenHash, sessionHash: null });
      return n;
    },
    async useScorerToken({ tokenHash, sessionHash, accounts }) {
      const r = db.grants.find(x => x.tokenHash === tokenHash && !x.sessionHash && accounts && current(x));
      if (!r) return null;
      r.sessionHash = sessionHash;
      return r.gameId;
    },
    async scorerAllowed({ gameId, sessionHash, accounts }) {
      db.scorerLookups++;
      return db.grants.some(r => accounts && r.gameId === gameId && r.sessionHash === sessionHash && current(r));
    },
    async scorerStatus(gameId) {
      const rows = db.grants.filter(r => r.gameId === gameId);
      return { waiting: rows.some(r => !r.sessionHash), scorers: rows.filter(r => r.sessionHash).length };
    },
    async removeScorers(gameId) { db.grants = db.grants.filter(r => r.gameId !== gameId); }
  };
  const real = {};
  Object.keys(fakes).forEach(k => { real[k] = store[k]; store[k] = fakes[k]; });
  return { db, restore() { Object.assign(store, real); } };
}

const TAP = { op: 'add', side: 'a', points: 7 };
const refused = 'That code is wrong, used or expired. Ask the host for a new one.';

async function accountsRoutes() {
  let t;
  const test = (name, fn) => check(`accounts: ${name}`, async () => {
    setEnv(ACCOUNTS_ENV);
    t = standIn();
    try { await fn(); } finally { t.restore(); }
  });
  const handOff = async (id, host) => {
    const r = await call('POST', `/api/game/${id || GAME_A}/handoff`, { cookie: hostCookie(host || A) });
    eq(r.statusCode, 201, `hand-off: ${r.body}`);
    return r.json;
  };
  const scan = async (id, host) => {
    const { token } = await handOff(id, host);
    const r = await call('POST', '/api/handoff', { body: { token } });
    eq(r.statusCode, 200, `scan: ${r.body}`);
    return r;
  };

  await test('the owner makes a code; a phone spends it and scores that board', async () => {
    const made = await handOff();
    eq(Object.keys(made).sort(), ['expiresInSeconds', 'scorers', 'token'], 'fields');
    assert(/^[A-Za-z0-9_-]{43}$/.test(made.token), 'token shape');
    assert(!JSON.stringify(t.db.grants).includes(made.token), 'raw token stored');
    const r = await call('POST', '/api/handoff', { body: { token: made.token } });
    eq(r.json, { gameId: GAME_A }, 'answer');
    const set = r.headers['set-cookie'];
    assert(/^sbs_scorer=[A-Za-z0-9_-]{43};/.test(set), `cookie: ${set}`);
    [`Path=/api/game/${GAME_A};`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=86400', '; Secure'].forEach(x => assert(set.includes(x), `${x} missing: ${set}`));
    const secretValue = phoneCookie(r).split('=')[1];
    assert(!JSON.stringify(t.db.grants).includes(secretValue), 'raw session stored');
    const tap = await call('PATCH', `/api/game/${GAME_A}/score`, { cookie: phoneCookie(r), body: TAP });
    eq(tap.statusCode, 200, `score: ${tap.body}`);
    eq(t.db.games[GAME_A].doc.liveScore.a, 7, 'saved');
  });

  await test('a scorer can do nothing else, on any board', async () => {
    const cookie = phoneCookie(await scan());
    const before = t.db.writes;
    const tries = [
      ['PUT', `/api/game/${GAME_A}`, board(GAME_A)], ['DELETE', `/api/game/${GAME_A}`],
      ['PATCH', `/api/game/${GAME_A}/payout`, { op: 'paid', quarter: 'q1' }],
      ['POST', `/api/game/${GAME_A}/handoff`], ['GET', `/api/game/${GAME_A}/handoff`], ['DELETE', `/api/game/${GAME_A}/handoff`],
      ['POST', '/api/game', board()], ['GET', '/api/games'], ['GET', '/api/todays-games'],
      ['POST', '/api/tv/pair', { code: 'ABCDEF', gameId: GAME_A }], ['POST', '/api/tv/follow', { gameId: GAME_A }], ['GET', '/api/tv/mine'],
      ['POST', '/api/session/revoke-all'],
      ['PATCH', `/api/game/${GAME_A2}/score`, TAP], ['PATCH', `/api/game/${GAME_B}/score`, TAP], ['PATCH', `/api/game/${GAME_NONE}/score`, TAP]
    ];
    for (const [method, p, body] of tries) {
      const r = await call(method, p, { cookie, body });
      eq(r.statusCode, 401, `${method} ${p}`);
    }
    eq(t.db.writes, before, 'writes');
    eq((await call('GET', '/api/session', { cookie })).json.host, false, 'never signed in as the host');
    assert(t.db.games[GAME_A], 'board still there');
  });

  await test('score ops cannot carry anything but a score', async () => {
    const cookie = phoneCookie(await scan());
    const r = await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: { ...TAP, squares: [], players: {}, squarePrice: 0, owner_id: B } });
    eq(r.statusCode, 200, 'status');
    const doc = t.db.games[GAME_A].doc;
    eq([doc.squares.length, doc.squarePrice, doc.players.Ann.paid, 'owner_id' in doc], [100, 10, false, false], 'untouched');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: { op: 'draw' } })).statusCode, 400, 'no draw');
  });

  await test('a code works once; wrong, used, cancelled and malformed all get one answer and no cookie', async () => {
    const first = await handOff();
    const second = await handOff();
    const ok = await call('POST', '/api/handoff', { body: { token: second.token } });
    eq(ok.statusCode, 200, 'newest works');
    for (const token of [first.token, second.token, secret(), 'short', 7, null, undefined, { a: 1 }, second.token + 'x']) {
      const r = await call('POST', '/api/handoff', { body: { token } });
      eq([r.statusCode, r.json.error, r.headers['set-cookie']], [401, refused, undefined], String(token));
      assert(!r.json.authRequired, 'must not open the sign-in prompt');
    }
  });

  await test('two phones spending one code together: one gets in', async () => {
    const { token } = await handOff();
    const got = await Promise.all([1, 2, 3].map(() => call('POST', '/api/handoff', { body: { token } })));
    eq(got.map(r => r.statusCode).sort(), [200, 401, 401], 'statuses');
  });

  await test('the QR token is not a cookie, and a cookie is not a token', async () => {
    const { token } = await handOff();
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie: `sbs_scorer=${token}`, body: TAP })).statusCode, 401, 'token as cookie');
    const used = phoneCookie(await scan()).split('=')[1];
    eq((await call('POST', '/api/handoff', { body: { token: used } })).statusCode, 401, 'cookie as token');
    for (const cookie of ['sbs_scorer=', 'sbs_scorer=x', `sbs_scorer=${secret()}`, 'sbs_scorer=%E0%A4%A', `sbs_session=${used}`, `sbs_host=${used}`]) {
      eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 401, cookie);
    }
  });

  await test('only the owner can make, see or remove', async () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      eq((await call(method, `/api/game/${GAME_A}/handoff`)).statusCode, 401, `${method} anonymous`);
      eq((await call(method, `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(B) })).statusCode, 403, `${method} another host`);
      eq((await call(method, `/api/game/${GAME_NONE}/handoff`, { cookie: hostCookie(A) })).statusCode, 403, `${method} unowned board`);
      eq((await call(method, `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A, 9) })).statusCode, 401, `${method} ended session`);
      eq((await call(method, `/api/game/${crypto.randomUUID()}/handoff`, { cookie: hostCookie(A) })).statusCode, 404, `${method} unknown board`);
    }
    eq(t.db.grants.length, 0, 'grants');
  });

  await test('remove ends the phones at once', async () => {
    const cookie = phoneCookie(await scan());
    eq((await call('GET', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A) })).json, { waiting: false, scorers: 1 }, 'status');
    eq((await call('DELETE', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A) })).json, { waiting: false, scorers: 0 }, 'removed');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 401, 'score after removal');
  });

  await test('sign out everywhere ends the phones and the waiting code; plain sign-out does not', async () => {
    const cookie = phoneCookie(await scan());
    await call('DELETE', '/api/session', { cookie: hostCookie(A) });
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 200, 'after sign-out');
    const { token } = await handOff();
    eq((await call('POST', '/api/session/revoke-all', { cookie: hostCookie(A) })).statusCode, 200, 'revoke');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 401, 'phone');
    eq((await call('POST', '/api/handoff', { body: { token } })).statusCode, 401, 'waiting code');
  });

  await test('at most five phones; not before the board is locked', async () => {
    for (let i = 0; i < 5; i++) await scan();
    const r = await call('POST', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A) });
    eq(r.statusCode, 409, `sixth: ${r.body}`);
    eq((await call('POST', `/api/game/${GAME_PICKING}/handoff`, { cookie: hostCookie(A) })).statusCode, 409, 'picking');
  });

  await test('role says host, scorer or none', async () => {
    const cookie = phoneCookie(await scan());
    const role = async (id, c) => (await call('GET', `/api/game/${id}/role`, { cookie: c })).json.role;
    eq([await role(GAME_A, hostCookie(A)), await role(GAME_A, cookie), await role(GAME_A), await role(GAME_A, hostCookie(B)), await role(GAME_A2, cookie)],
      ['host', 'scorer', 'none', 'none', 'none'], 'roles');
    eq((await call('GET', `/api/game/${GAME_A}/role`)).headers['cache-control'], 'no-store', 'cache');
  });

  await test('another host keeps 403 without a grant, and can score with one', async () => {
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie: hostCookie(B), body: TAP })).statusCode, 403, 'no grant');
    const cookie = `${hostCookie(B)}; ${phoneCookie(await scan())}`;
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 200, 'with one');
    eq((await call('PUT', `/api/game/${GAME_A}`, { cookie, body: board(GAME_A) })).statusCode, 403, 'PUT');
    eq((await call('DELETE', `/api/game/${GAME_A}`, { cookie })).statusCode, 403, 'DELETE');
  });

  await test('no extra lookup for a device without the cookie', async () => {
    await call('PATCH', `/api/game/${GAME_A}/score`, { cookie: hostCookie(A), body: TAP });
    await call('PATCH', `/api/game/${GAME_A}/score`, { body: TAP });
    eq(t.db.scorerLookups, 0, 'lookups');
  });

  await test('a foreign Origin is refused on every hand-off write', async () => {
    const { token } = await handOff();
    const headers = { origin: 'https://evil.example' };
    eq((await call('POST', '/api/handoff', { body: { token }, headers })).statusCode, 403, 'redeem');
    eq((await call('POST', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A), headers })).statusCode, 403, 'make');
    eq((await call('DELETE', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A), headers })).statusCode, 403, 'remove');
    const cookie = phoneCookie(await call('POST', '/api/handoff', { body: { token } }));
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP, headers })).statusCode, 403, 'score');
  });

  await test('a broken sign-in setup lets no scorer in', async () => {
    const cookie = phoneCookie(await scan());
    const { token } = await handOff();
    for (const broken of [{ ...ACCOUNTS_ENV, AUTH_MODE: 'acounts' }, { VERCEL: '1' }, { ...ACCOUNTS_ENV, SESSION_SECRET: 'short' }]) {
      setEnv(broken);
      eq(auth.authMode(), 'misconfigured', 'mode');
      eq((await call('POST', '/api/handoff', { body: { token } })).statusCode, 503, 'redeem');
      eq((await call('PATCH', `/api/game/${GAME_A}/score`, { cookie, body: TAP })).statusCode, 503, 'score');
      eq((await call('POST', `/api/game/${GAME_A}/handoff`, { cookie: hostCookie(A) })).statusCode, 503, 'make');
      eq((await call('GET', `/api/game/${GAME_A}/role`, { cookie })).json.role, 'none', 'role');
    }
  });
}

async function fsRoutes() {
  const newBoard = async () => {
    setEnv({});
    const b = board();
    const made = await call('POST', '/api/game', { body: b });
    assert(made.statusCode === 201, `create: ${made.body}`);
    createdFs.push(made.json.id);
    return made.json;
  };

  await check('password mode: hand-off, scan, score; the scorer is not the host', async () => {
    const g = await newBoard();
    setEnv({ HOST_PASSWORD: 'correct horse' });
    const host = String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
    eq((await call('POST', `/api/game/${g.id}/handoff`)).statusCode, 401, 'anonymous');
    const made = await call('POST', `/api/game/${g.id}/handoff`, { cookie: host });
    eq(made.statusCode, 201, made.body);
    const cookie = phoneCookie(await call('POST', '/api/handoff', { body: { token: made.json.token } }));
    eq((await call('GET', `/api/game/${g.id}/role`, { cookie })).json.role, 'scorer', 'role');
    eq((await call('PATCH', `/api/game/${g.id}/score`, { cookie, body: TAP })).statusCode, 200, 'score');
    eq((await call('PUT', `/api/game/${g.id}`, { cookie, body: g })).statusCode, 401, 'PUT');
    eq((await call('DELETE', `/api/game/${g.id}`, { cookie })).statusCode, 401, 'DELETE');
    eq((await call('GET', '/api/games', { cookie })).statusCode, 401, 'list');
    setEnv({ AUTH_MODE: 'acounts' });
    eq((await call('PATCH', `/api/game/${g.id}/score`, { cookie, body: TAP })).statusCode, 503, 'score with sign-in broken');
    eq((await call('GET', `/api/game/${g.id}/role`, { cookie })).json.role, 'none', 'role with sign-in broken');
    setEnv({ HOST_PASSWORD: 'correct horse' });
    eq((await call('POST', `/api/game/${crypto.randomUUID()}/handoff`, { cookie: host })).statusCode, 404, 'unknown board');
    eq((await call('DELETE', `/api/game/${g.id}/handoff`, { cookie: host })).statusCode, 200, 'remove');
    eq((await call('PATCH', `/api/game/${g.id}/score`, { cookie, body: TAP })).statusCode, 401, 'after removal');
  });

  await check('auth off: every device is the host, and the flow still works', async () => {
    const g = await newBoard();
    eq((await call('GET', `/api/game/${g.id}/role`)).json.role, 'host', 'role');
    const made = await call('POST', `/api/game/${g.id}/handoff`);
    eq(made.statusCode, 201, made.body);
    eq((await call('POST', '/api/handoff', { body: { token: made.json.token } })).json, { gameId: g.id }, 'scan');
    eq((await call('GET', `/api/game/${g.id}/handoff`)).json, { waiting: false, scorers: 1 }, 'status');
  });

  await check('other methods on the hand-off routes are not found', async () => {
    const g = await newBoard();
    for (const [m, p] of [['GET', '/api/handoff'], ['PUT', `/api/game/${g.id}/handoff`], ['POST', `/api/game/${g.id}/role`]]) {
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
    await store.createScorerGrant({ gameId: g.id, hostVersion: null, tokenHash: hash(token), max: 5 });
    await store.useScorerToken({ tokenHash: hash(token), sessionHash: hash(session), accounts: false });
    const raw = fs.readFileSync(FILE, 'utf8');
    assert(!raw.includes(token) && !raw.includes(session), 'raw secret on disk');
    assert(raw.includes(hash(token)) && raw.includes(hash(session)), 'hash missing');
  });
  await accountsRoutes();
  await fsRoutes();
  setEnv({});

  if (PG_URL) {
    process.env.DATABASE_URL = PG_URL;
    const pg = require('./lib/store-pg.js');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(PG_URL);
    const games = [];
    const email = `handoff-${crypto.randomUUID()}@example.com`;
    const host = (await sql`insert into hosts (email) values (${email}) returning id, session_version`)[0];
    try {
      const newGame = (owner) => async () => {
        const g = await pg.createGame(board(), owner);
        games.push(g.id);
        return g.id;
      };
      await storeContract('pg accounts', pg, { accounts: true, version: host.session_version, newGame: newGame(host.id) });
      await storeContract('pg password', pg, { accounts: false, version: null, newGame: newGame(null) });

      await check('pg: sign out everywhere ends the grant and the waiting code', async () => {
        const g = await newGame(host.id)();
        const token = hash(secret());
        const session = hash(secret());
        await pg.createScorerGrant({ gameId: g, hostVersion: 1, tokenHash: token, max: 5 }, T0);
        eq(await pg.useScorerToken({ tokenHash: token, sessionHash: session, accounts: true }, T0), g, 'used');
        const waiting = hash(secret());
        await pg.createScorerGrant({ gameId: g, hostVersion: 1, tokenHash: waiting, max: 5 }, T0);
        eq(await pg.revokeSessions(host.id, 1), true, 'revoke');
        eq(await pg.scorerAllowed({ gameId: g, sessionHash: session, accounts: true }, T0), false, 'grant');
        eq(await pg.useScorerToken({ tokenHash: waiting, sessionHash: hash(secret()), accounts: true }, T0), null, 'code');
        eq(await pg.scorerStatus(g, 2, T0), { waiting: false, scorers: 0 }, 'not counted');
      });

      await check('pg: an unowned board has no scorers in accounts mode', async () => {
        const g = await newGame(null)();
        const token = hash(secret());
        await pg.createScorerGrant({ gameId: g, hostVersion: 1, tokenHash: token, max: 5 }, T0);
        eq(await pg.useScorerToken({ tokenHash: token, sessionHash: hash(secret()), accounts: true }, T0), null, 'use');
      });

      await check('pg: codes made at the same moment leave only one that works', async () => {
        const g = await newGame(host.id)();
        const v = (await sql`select session_version from hosts where id = ${host.id}`)[0].session_version;
        const tokens = [1, 2, 3, 4].map(() => hash(secret()));
        await Promise.all(tokens.map(tokenHash => pg.createScorerGrant({ gameId: g, hostVersion: v, tokenHash, max: 5 }, T0)));
        const got = [];
        for (const tokenHash of tokens) got.push(await pg.useScorerToken({ tokenHash, sessionHash: hash(secret()), accounts: true }, T0));
        eq(got.filter(Boolean).length, 1, 'working codes');
      });
    } finally {
      for (const id of games) await pg.deleteGame(id);
      await sql`delete from hosts where id = ${host.id}`;
    }
  } else {
    console.log('  (Postgres hand-off tests skipped: no DATABASE_URL)');
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
    console.log(`  scorer hand-off: ${passed} passed`);
  });
