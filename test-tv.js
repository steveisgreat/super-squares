// TV pairing (R23): the store contract (fs always; Postgres when DATABASE_URL is set,
// pointed at a throwaway Neon branch with migrations/005_tv_pairings.sql applied) and the
// /api/tv routes (auth off, then accounts mode with a stand-in for the board lookup).
// The clock is injected, so nothing sleeps.
//
// Run with:  node test-tv.js   (or: npm test)
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
const cleanups = [];

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
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const gid = () => crypto.randomUUID();
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

// ---------- the store contract, run once per backend ----------
async function storeContract(label, s, cleanup) {
  const make = async (now, gen) => {
    const hashed = hash(newToken());
    cleanups.push(() => cleanup(hashed));
    const code = await s.createTvPairing(hashed, gen, now);
    return { hashed, code };
  };

  await check(`${label}: create gives a waiting pairing with a valid code`, async () => {
    const { hashed, code } = await make(T0);
    assert(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code), `bad code ${code}`);
    eq(await s.getTvPairing(hashed, T0), { code, gameId: null }, 'waiting');
    eq(await s.getTvPairing(hash('nope'), T0), null, 'unknown');
  });

  await check(`${label}: pair sets the game, owner and retires the code`, async () => {
    const { hashed, code } = await make(T0);
    const g = gid();
    assert(await s.pairTv(code.toLowerCase(), g, OWNER_A, T0 + MIN), 'pair (lowercase code)');
    eq(await s.getTvPairing(hashed, T0 + MIN), { code: null, gameId: g }, 'paired');
    eq(await s.pairTv(code, gid(), OWNER_A, T0 + MIN), false, 'second pair by code');
    eq((await s.getTvPairing(hashed, T0 + MIN)).gameId, g, 'unchanged after second pair');
  });

  await check(`${label}: a retired code can be reissued`, async () => {
    const { code } = await make(T0);
    await s.pairTv(code, gid(), OWNER_A, T0);
    const again = await s.createTvPairing(hash(newToken()), () => code, T0);
    eq(again, code, 'reissued');
    cleanups.push(() => cleanup(null, code));
  });

  await check(`${label}: a live code collision draws a fresh code`, async () => {
    const a = await make(T0);
    const other = a.code[0] === '2' ? '3' : '2';
    const fresh = other + a.code.slice(1);
    const queue = [a.code, a.code, fresh];
    const b = await make(T0, () => queue.shift());
    eq(b.code, fresh, 'retried');
  });

  await check(`${label}: unpaired expires after 15 minutes, read-time`, async () => {
    const { hashed, code } = await make(T0);
    assert(await s.getTvPairing(hashed, T0 + 15 * MIN - 1), 'still live just before');
    eq(await s.getTvPairing(hashed, T0 + 15 * MIN), null, 'gone at 15 min');
    eq(await s.pairTv(code, gid(), OWNER_A, T0 + 15 * MIN), false, 'cannot pair an expired code');
  });

  await check(`${label}: paired expires 24 hours after paired_at`, async () => {
    const { hashed, code } = await make(T0);
    await s.pairTv(code, gid(), OWNER_A, T0 + 10 * MIN);
    assert(await s.getTvPairing(hashed, T0 + 10 * MIN + 24 * HOUR - 1), 'live just before');
    eq(await s.getTvPairing(hashed, T0 + 10 * MIN + 24 * HOUR), null, 'gone at 24 h');
  });

  await check(`${label}: follow moves only the caller's pairings, and counts`, async () => {
    const a1 = await make(T0);
    const a2 = await make(T0);
    const b1 = await make(T0);
    const w = await make(T0);
    const g1 = gid();
    const g2 = gid();
    await s.pairTv(a1.code, g1, OWNER_A, T0);
    await s.pairTv(a2.code, g1, OWNER_A, T0);
    await s.pairTv(b1.code, g1, OWNER_B, T0);
    assert((await s.countTvs(OWNER_A, T0)) >= 2, 'count A');
    const moved = await s.followTv(OWNER_A, g2, T0 + MIN);
    assert(moved >= 2, `moved ${moved}`);
    eq((await s.getTvPairing(a1.hashed, T0 + MIN)).gameId, g2, 'A1 follows');
    eq((await s.getTvPairing(a2.hashed, T0 + MIN)).gameId, g2, 'A2 follows');
    eq((await s.getTvPairing(b1.hashed, T0 + MIN)).gameId, g1, 'B untouched');
    eq((await s.getTvPairing(w.hashed, T0 + MIN)).gameId, null, 'waiting TV untouched');
  });

  await check(`${label}: follow restarts the 24 hours`, async () => {
    const { hashed, code } = await make(T0);
    const owner = crypto.randomUUID();
    await s.pairTv(code, gid(), owner, T0);
    await s.followTv(owner, gid(), T0 + 20 * HOUR);
    assert(await s.getTvPairing(hashed, T0 + 40 * HOUR), 'still live 40 h after pairing');
  });

  await check(`${label}: an expired pairing is not moved or counted`, async () => {
    const { hashed, code } = await make(T0);
    const owner = crypto.randomUUID();
    await s.pairTv(code, gid(), owner, T0);
    eq(await s.countTvs(owner, T0 + 25 * HOUR), 0, 'count');
    eq(await s.followTv(owner, gid(), T0 + 25 * HOUR), 0, 'follow');
    eq(await s.getTvPairing(hashed, T0 + 25 * HOUR), null, 'gone');
  });

  await check(`${label}: a null owner (auth off) follows only null-owner pairings`, async () => {
    const x = await make(T0);
    const y = await make(T0);
    const g1 = gid();
    await s.pairTv(x.code, g1, null, T0);
    await s.pairTv(y.code, g1, OWNER_A, T0);
    const g2 = gid();
    await s.followTv(null, g2, T0);
    eq((await s.getTvPairing(x.hashed, T0)).gameId, g2, 'null owner moved');
    eq((await s.getTvPairing(y.hashed, T0)).gameId, g1, 'account owner untouched');
  });

  await check(`${label}: creating a pairing deletes expired rows`, async () => {
    const old = await make(T0);
    await make(T0 + 2 * HOUR);
    eq(await s.getTvPairing(old.hashed, T0 + 3 * MIN), null, 'swept (read at an earlier time, row is gone)');
  });
}

const FILE = path.join(__dirname, 'data', 'tv-pairings.json');
const hadFile = fs.existsSync(FILE);
const backup = hadFile ? fs.readFileSync(FILE) : null;
// The fs tests share the dev server's pairing file, so put it back as it was, crash or not.
function restoreFile() {
  try {
    if (hadFile) fs.writeFileSync(FILE, backup); else fs.unlinkSync(FILE);
  } catch (e) { /* none */ }
}

async function main() {
  // ---------- store, fs ----------
  await storeContract('fs', store, async (hashed, code) => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return; }
    for (const k of Object.keys(all)) if (k === hashed || (code && all[k].code === code)) delete all[k];
    fs.writeFileSync(FILE, JSON.stringify(all));
  });

  await check('fs: the token is stored hashed, never raw', async () => {
    const token = newToken();
    cleanups.push(() => {});
    await store.createTvPairing(hash(token));
    const raw = fs.readFileSync(FILE, 'utf8');
    assert(!raw.includes(token), 'raw token on disk');
    assert(raw.includes(hash(token)), 'hash missing');
  });

  // ---------- API, auth off ----------
  function fakeReq(method, url, body, headers) {
    const req = {
      method, url, headers: Object.assign({ host: 'localhost:3000' }, headers), socket: {},
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
        return req;
      },
      destroy() {}
    };
    return req;
  }
  function fakeRes() {
    return {
      statusCode: null, headers: {}, body: '',
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(s, h) { this.statusCode = s; Object.keys(h || {}).forEach(k => { this.headers[k.toLowerCase()] = h[k]; }); return this; },
      end(b) { this.body = b === undefined ? '' : String(b); return this; },
      get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    };
  }
  async function call(method, p, body, headers) {
    const url = new URL(p, 'http://localhost:3000');
    const res = fakeRes();
    await handleApi(fakeReq(method, p, body, headers), res, url.pathname, url.searchParams);
    return res;
  }

  const created = [];
  async function apiGame() {
    const g = {
      id: gid(), league: 'nfl', teamA: 'Chiefs', teamB: 'Eagles', gameDate: '2027-02-14',
      squarePrice: 10, payouts: { q1: 20, q2: 20, q3: 20, final: 40 }, status: 'picking',
      squares: new Array(100).fill(null), axisX: null, axisY: null, results: {}, players: {}
    };
    const r = await call('POST', '/api/game', g);
    assert(r.statusCode === 201, `create game ${r.statusCode}: ${r.body}`);
    created.push(r.json.id);
    return r.json;
  }
  const newPairing = async () => {
    const r = await call('POST', '/api/tv');
    eq(r.statusCode, 201, `POST /api/tv: ${r.body}`);
    return r.json;
  };

  await check('POST /api/tv gives a code and a long random token; GET shows waiting', async () => {
    const { code, token } = await newPairing();
    assert(/^[2-9A-HJKMNP-Z]{6}$/.test(code), `code ${code}`);
    assert(/^[A-Za-z0-9_-]{43,}$/.test(token), 'token shape');
    const r = await call('GET', `/api/tv/${token}`);
    eq(r.statusCode, 200, 'status');
    eq(r.json, { state: 'waiting', code }, 'body');
    assert(r.headers['cache-control'] === 'no-store', 'must not be cached');
  });

  await check('pair as owner (auth off) -> paired with gameId; code retired', async () => {
    const g = await apiGame();
    const { code, token } = await newPairing();
    const p = await call('POST', '/api/tv/pair', { code: code.toLowerCase(), gameId: g.id });
    eq(p.statusCode, 200, `pair: ${p.body}`);
    assert(p.json.count >= 1, 'count');
    const r = await call('GET', `/api/tv/${token}`);
    eq(r.json, { state: 'paired', gameId: g.id }, 'paired state');
    const raw = r.body;
    assert(!raw.includes(token) && !raw.includes(code), 'response leaked token or code');
    const again = await call('POST', '/api/tv/pair', { code, gameId: g.id });
    eq(again.statusCode, 404, 'second pair with the same code');
  });

  await check('GET /api/tv/<wrong token> and malformed tokens answer 404', async () => {
    eq((await call('GET', `/api/tv/${newToken()}`)).statusCode, 404, 'unknown token');
    eq((await call('GET', '/api/tv/short')).statusCode, 404, 'short');
    eq((await call('GET', '/api/tv/%E0%A4%A')).statusCode, 404, 'bad escape');
  });

  await check('pair: 400 for a malformed code or board, 404 for an unknown code or board', async () => {
    const g = await apiGame();
    eq((await call('POST', '/api/tv/pair', { code: 'AB0K7M', gameId: g.id })).statusCode, 400, 'bad char');
    eq((await call('POST', '/api/tv/pair', { code: 'ABC', gameId: g.id })).statusCode, 400, 'short');
    eq((await call('POST', '/api/tv/pair', { code: 'ABCDEF', gameId: 'nope' })).statusCode, 400, 'bad board id');
    eq((await call('POST', '/api/tv/pair', {})).statusCode, 400, 'empty');
    const nobody = await call('POST', '/api/tv/pair', { code: 'ZZZZZZ', gameId: g.id });
    eq(nobody.statusCode, 404, 'unknown code');
  });

  await check('GET /api/tv/mine counts, and follow moves the pairing', async () => {
    const g1 = await apiGame();
    const g2 = await apiGame();
    const { code, token } = await newPairing();
    await call('POST', '/api/tv/pair', { code, gameId: g1.id });
    const mine = await call('GET', '/api/tv/mine');
    eq(mine.statusCode, 200, 'mine status');
    assert(mine.json.count >= 1, 'count');
    const f = await call('POST', '/api/tv/follow', { gameId: g2.id });
    eq(f.statusCode, 200, `follow: ${f.body}`);
    eq((await call('GET', `/api/tv/${token}`)).json, { state: 'paired', gameId: g2.id }, 'followed');
  });

  await check('the TV routes carry no cookie and nothing a write route accepts', async () => {
    const { code, token } = await newPairing();
    const g = await apiGame();
    const post = await call('POST', '/api/tv');
    const get = await call('GET', `/api/tv/${token}`);
    await call('POST', '/api/tv/pair', { code, gameId: g.id });
    const paired = await call('GET', `/api/tv/${token}`);
    for (const r of [post, get, paired]) assert(!r.headers['set-cookie'], 'set-cookie on a TV route');
    eq(Object.keys(paired.json).sort(), ['gameId', 'state'], 'paired keys');
    eq(Object.keys(get.json).sort(), ['code', 'state'], 'waiting keys');
  });

  await check('other methods on the TV routes are not found', async () => {
    const { token } = await newPairing();
    eq((await call('DELETE', `/api/tv/${token}`)).statusCode, 404, 'DELETE');
    eq((await call('PUT', `/api/tv/${token}`, {})).statusCode, 404, 'PUT');
    eq((await call('GET', '/api/tv/pair')).statusCode, 404, 'GET pair');
  });

  // ---------- API, accounts mode (stand-in board lookup) ----------
  const SECRET = 'test-secret-0123456789-0123456789-abcdef';
  const GAME_A = gid();
  const GAME_B = gid();
  const GAME_NONE = gid();
  const owners = { [GAME_A]: OWNER_A, [GAME_B]: OWNER_B, [GAME_NONE]: null };
  const realAccess = store.getGameAccess;
  const realHost = store.getHost;
  Object.assign(store, {
    async getGameAccess(id, hostId) {
      return { exists: id in owners, ownerId: owners[id] || null, sessionVersion: 1 };
    },
    async getHost() { return { email: 'x@example.com', sessionVersion: 1 }; }
  });
  const prev = {};
  const ENV = { AUTH_MODE: 'accounts', DATABASE_URL: 'postgresql://not-used', SESSION_SECRET: SECRET, APP_ORIGIN: 'http://localhost:3000', RESEND_API_KEY: 'x', EMAIL_FROM: 'a <a@example.com>' };
  for (const k of Object.keys(ENV)) { prev[k] = process.env[k]; process.env[k] = ENV[k]; }
  const cookie = (hostId) => {
    const payload = `v1.${hostId}.1.${Math.floor(Date.now() / 1000) + 600}`;
    return `sbs_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
  };
  const as = (hostId) => ({ cookie: cookie(hostId) });
  assert(auth.authMode() === 'accounts', 'accounts mode should be on for these checks');

  await check('accounts: pair as a non-owner -> 403 and the pairing is unchanged', async () => {
    const { code, token } = await newPairing();
    const r = await call('POST', '/api/tv/pair', { code, gameId: GAME_B }, as(OWNER_A));
    eq(r.statusCode, 403, 'status');
    eq((await call('GET', `/api/tv/${token}`)).json, { state: 'waiting', code }, 'still waiting');
    eq((await call('POST', '/api/tv/pair', { code, gameId: GAME_NONE }, as(OWNER_A))).statusCode, 403, 'ownerless board');
    eq((await call('POST', '/api/tv/pair', { code, gameId: GAME_A })).statusCode, 401, 'signed out');
    eq((await call('GET', `/api/tv/${token}`)).json, { state: 'waiting', code }, 'still waiting after refusals');
  });

  await check('accounts: pair as the owner works; follow moves only that host\'s TVs', async () => {
    const a = await newPairing();
    const b = await newPairing();
    eq((await call('POST', '/api/tv/pair', { code: a.code, gameId: GAME_A }, as(OWNER_A))).statusCode, 200, 'A pairs');
    eq((await call('POST', '/api/tv/pair', { code: b.code, gameId: GAME_B }, as(OWNER_B))).statusCode, 200, 'B pairs');
    const f = await call('POST', '/api/tv/follow', { gameId: GAME_A }, as(OWNER_A));
    eq(f.statusCode, 200, 'follow');
    eq((await call('GET', `/api/tv/${a.token}`)).json, { state: 'paired', gameId: GAME_A }, 'A TV');
    eq((await call('GET', `/api/tv/${b.token}`)).json, { state: 'paired', gameId: GAME_B }, 'B TV not moved');
    eq((await call('POST', '/api/tv/follow', { gameId: GAME_B }, as(OWNER_A))).statusCode, 403, 'cannot follow to a board that is not yours');
    eq((await call('POST', '/api/tv/follow', { gameId: GAME_A })).statusCode, 401, 'signed out');
    eq((await call('GET', '/api/tv/mine')).statusCode, 401, 'mine signed out');
  });

  await check('accounts: a TV\'s token is no credential for any write', async () => {
    const t = await newPairing();
    await call('POST', '/api/tv/pair', { code: t.code, gameId: GAME_A }, as(OWNER_A));
    const put = await call('PUT', `/api/game/${GAME_A}`, { id: GAME_A }, { cookie: `sbs_session=${t.token}; sbs_account=${t.token}`, authorization: `Bearer ${t.token}` });
    eq(put.statusCode, 401, 'PUT with the token as a cookie');
    const patch = await call('PATCH', `/api/game/${GAME_A}/score`, { op: 'add' }, { cookie: `sbs_account=${t.token}` });
    eq(patch.statusCode, 401, 'PATCH score');
    const del = await call('DELETE', `/api/game/${GAME_A}`, undefined, {});
    eq(del.statusCode, 401, 'DELETE with nothing');
  });

  for (const k of Object.keys(ENV)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  store.getGameAccess = realAccess;
  store.getHost = realHost;

  // ---------- store, Postgres ----------
  if (PG_URL) {
    process.env.DATABASE_URL = PG_URL;
    const pg = require('./lib/store-pg.js');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(PG_URL);
    await storeContract('pg', pg, async (hashed, code) => {
      if (hashed) await sql`delete from tv_pairings where token_hash = ${hashed}`;
      if (code) await sql`delete from tv_pairings where code = ${code}`;
    });
    await check('pg: the token is stored hashed, never raw', async () => {
      const token = newToken();
      cleanups.push(() => sql`delete from tv_pairings where token_hash = ${hash(token)}`);
      await pg.createTvPairing(hash(token));
      const rows = await sql`select * from tv_pairings where token_hash = ${hash(token)}`;
      eq(rows.length, 1, 'row');
      assert(!JSON.stringify(rows[0]).includes(token), 'raw token in the row');
    });
  } else {
    console.log('  (Postgres TV tests skipped: no DATABASE_URL)');
  }

  for (const id of created) await store.deleteGame(id);
  for (const fn of cleanups) { try { await fn(); } catch (e) { /* best effort */ } }
  restoreFile();

  console.log('');
  if (failures.length) {
    console.log(`  ${failures.length} failed, ${passed} passed`);
    failures.forEach(f => console.log('  FAIL ' + f));
    process.exit(1);
  }
  console.log(`  tv pairing: ${passed} passed`);
}

main().catch(e => { restoreFile(); console.error(e); process.exit(1); });
