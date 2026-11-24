// Join codes (R22, decision 016): the generator, uniqueness in the store, the
// public GET /api/join/:code route, and that a PUT echoing `joinCode` back never
// changes the stored one. The API part always runs against the fs backend; the
// same store contract runs against Postgres when DATABASE_URL is set (point it at
// a throwaway Neon branch with migrations/004_join_codes.sql applied).
//
// Run with:  node test-joincode.js   (or: npm test)
'use strict';

// lib/store.js picks its backend once, so settle this before requiring it.
const PG_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JoinCode = require('./lib/joincode.js');
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

function makeGame(s) {
  const id = crypto.randomUUID();
  return {
    id, league: 'nfl', teamA: 'Chiefs', teamB: 'Eagles', gameDate: '2026-02-08',
    squarePrice: 10, payouts: { q1: 20, q2: 20, q3: 20, final: 40 }, status: 'picking',
    squares: new Array(100).fill(null), axisX: null, axisY: null, results: {}, players: {}
  };
}

function fakeReq(method, url, body) {
  const req = {
    method, url, headers: { host: 'localhost:3000' }, socket: {},
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
async function call(method, p, body) {
  const url = new URL(p, 'http://localhost:3000');
  const res = fakeRes();
  await handleApi(fakeReq(method, p, body), res, url.pathname, url.searchParams);
  return res;
}

// The store contract, written once and run against each backend.
async function storeContract(label, s, rawDelete) {
  const make = async () => {
    const g = makeGame();
    await s.createGame(g);
    cleanups.push(() => rawDelete(g.id));
    return g;
  };

  await check(`${label}: a new board has no code until one is assigned`, async () => {
    const g = await make();
    assert(!(await s.getGame(g.id)).joinCode, 'unexpected code');
  });

  await check(`${label}: assignJoinCode gives a valid code and is idempotent`, async () => {
    const g = await make();
    const code = await s.assignJoinCode(g.id);
    assert(JoinCode.CODE_RE.test(code), `bad code ${code}`);
    eq(await s.assignJoinCode(g.id), code, 'second assignment');
    eq((await s.getGame(g.id)).joinCode, code, 'getGame joinCode');
    eq(await s.getGameIdByJoinCode(code), g.id, 'lookup');
    eq(await s.getGameIdByJoinCode(code.toLowerCase()), g.id, 'case-insensitive lookup');
  });

  await check(`${label}: a duplicate code is refused and a fresh one is drawn`, async () => {
    const a = await make();
    const b = await make();
    const code = await s.assignJoinCode(a.id);
    const other = code[0] === '2' ? '3' : '2';
    const fresh = other + code.slice(1);
    const queue = [code, code, fresh];
    const got = await s.assignJoinCode(b.id, () => queue.shift());
    eq(got, fresh, 'retried code');
    assert(got !== code, 'duplicate was accepted');
    eq(await s.getGameIdByJoinCode(code), a.id, 'original owner keeps it');
  });

  await check(`${label}: it gives up (throws) when only duplicates come out`, async () => {
    const a = await make();
    const b = await make();
    const code = await s.assignJoinCode(a.id);
    let threw = false;
    try { await s.assignJoinCode(b.id, () => code); } catch (e) { threw = true; }
    assert(threw, 'expected an error');
    assert(!(await s.getGame(b.id)).joinCode, 'b must have no code');
  });

  await check(`${label}: a write never stores joinCode in the document`, async () => {
    const g = await make();
    const code = await s.assignJoinCode(g.id);
    const cur = await s.getGame(g.id);
    const echoed = Object.assign({}, cur, { joinCode: 'ZZZZZZ', description: 'edited' });
    const r = await s.updateGame(g.id, echoed, cur.updatedAt);
    assert(r.ok, 'update refused');
    eq(r.game.joinCode, code, 'returned code');
    eq((await s.getGame(g.id)).joinCode, code, 'stored code');
    eq(await s.getGameIdByJoinCode('ZZZZZZ'), null, 'forged code');
  });

  await check(`${label}: unknown and malformed codes find nothing`, async () => {
    eq(await s.getGameIdByJoinCode('ABCDEF'), null, 'unknown');
    eq(await s.getGameIdByJoinCode('abc'), null, 'short');
    eq(await s.getGameIdByJoinCode('OOOOOO'), null, 'bad characters');
  });

  await check(`${label}: deleting a board frees its code`, async () => {
    const g = await make();
    const code = await s.assignJoinCode(g.id);
    assert(await s.deleteGame(g.id), 'delete');
    eq(await s.getGameIdByJoinCode(code), null, 'lookup after delete');
  });
}

async function main() {
  // ---------- generator ----------
  await check('alphabet has 31 characters, none of 0 O 1 I L', () => {
    eq(JoinCode.ALPHABET.length, 31, 'length');
    assert(!/[01OIL]/.test(JoinCode.ALPHABET), 'ambiguous character');
    eq(new Set(JoinCode.ALPHABET).size, 31, 'distinct');
  });

  await check('20000 generated codes are all six valid characters', () => {
    const seen = new Set();
    for (let i = 0; i < 20000; i++) {
      const c = JoinCode.generate();
      assert(c.length === 6 && JoinCode.CODE_RE.test(c), `bad code ${c}`);
      seen.add(c);
    }
    assert(seen.size > 19900, `suspiciously many repeats: ${seen.size} distinct`);
  });

  await check('normalize uppercases, trims, and rejects the malformed', () => {
    eq(JoinCode.normalize(' ab3k7m '), 'AB3K7M', 'lowercase');
    eq(JoinCode.normalize('AB3K7'), null, 'short');
    eq(JoinCode.normalize('AB3K7MX'), null, 'long');
    eq(JoinCode.normalize('AB0K7M'), null, 'zero');
    eq(JoinCode.normalize(null), null, 'null');
    eq(JoinCode.normalize({}), null, 'object');
  });

  await check('vercel.json and the dev server rewrite the same codes', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
    const rw = cfg.rewrites.find(r => r.destination === '/index.html');
    assert(rw, 'no rewrite to /index.html');
    const m = rw.source.match(/^\/:code\((.+)\)$/);
    assert(m, `unexpected source ${rw.source}`);
    const re = new RegExp('^' + m[1] + '$');
    for (const ok of ['AB3K7M', 'ab3k7m', 'ZZZZZZ', '234567']) {
      assert(re.test(ok), `${ok} should rewrite`);
      assert(JoinCode.PATH_RE.test('/' + ok), `${ok} should serve the page locally`);
    }
    for (const no of ['api', 'tv', 'AB0K7M', 'ABCDEFG', 'AB3K7', 'ab-k7m', 'contact']) {
      assert(!re.test(no), `${no} must not rewrite`);
      assert(!JoinCode.PATH_RE.test('/' + no), `${no} must not serve the page locally`);
    }
  });

  // ---------- store, fs ----------
  const DATA_DIR = path.join(__dirname, 'data');
  await storeContract('fs', store, async (id) => {
    for (const ext of ['json', 'code']) {
      try { fs.unlinkSync(path.join(DATA_DIR, `${id}.${ext}`)); } catch (e) { /* gone */ }
    }
  });

  // ---------- API (fs backend, auth off) ----------
  const created = [];
  async function apiGame() {
    const r = await call('POST', '/api/game', makeGame());
    assert(r.statusCode === 201, `create answered ${r.statusCode}: ${r.body}`);
    created.push(r.json.id);
    return r.json;
  }

  await check('POST /api/game gives the new board a code', async () => {
    const g = await apiGame();
    assert(JoinCode.CODE_RE.test(g.joinCode), `no code on create: ${g.joinCode}`);
    const got = await call('GET', `/api/game/${g.id}`);
    eq(got.json.joinCode, g.joinCode, 'GET joinCode');
  });

  await check('GET /api/join/:code answers 200, 404 and 400, any case', async () => {
    const g = await apiGame();
    const ok = await call('GET', `/api/join/${g.joinCode}`);
    eq(ok.statusCode, 200, 'status');
    eq(ok.json, { id: g.id }, 'body');
    eq((await call('GET', `/api/join/${g.joinCode.toLowerCase()}`)).json, { id: g.id }, 'lowercase');
    eq((await call('GET', '/api/join/ABCDEF')).statusCode, g.joinCode === 'ABCDEF' ? 200 : 404, 'unknown');
    eq((await call('GET', '/api/join/ABC')).statusCode, 400, 'short');
    eq((await call('GET', '/api/join/ABC0EF')).statusCode, 400, 'bad character');
    eq((await call('GET', '/api/join/%E0%A4%A')).statusCode, 400, 'bad escape');
  });

  await check('the join route is read-only', async () => {
    const g = await apiGame();
    eq((await call('DELETE', `/api/join/${g.joinCode}`)).statusCode, 404, 'DELETE');
    eq((await call('PUT', `/api/join/${g.joinCode}`, {})).statusCode, 404, 'PUT');
    assert(await store.getGame(g.id), 'board must survive');
  });

  await check('a PUT echoing joinCode does not change the stored code', async () => {
    const g = await apiGame();
    const echoed = Object.assign({}, g, { joinCode: 'ZZZZZZ', description: 'edited' });
    const r = await call('PUT', `/api/game/${g.id}`, echoed);
    eq(r.statusCode, 200, `PUT status: ${r.body}`);
    eq(r.json.joinCode, g.joinCode, 'PUT response code');
    eq((await call('GET', `/api/game/${g.id}`)).json.joinCode, g.joinCode, 'GET after PUT');
    eq((await call('GET', '/api/join/ZZZZZZ')).statusCode, 404, 'forged code');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${g.id}.json`), 'utf8'));
    assert(!('joinCode' in raw), 'joinCode leaked into the stored document');
  });

  await check('an older board gets a code the first time its owner reads it', async () => {
    const g = makeGame();
    await store.createGame(g);
    created.push(g.id);
    assert(!(await store.getGame(g.id)).joinCode, 'precondition');
    const r = await call('GET', `/api/game/${g.id}`);
    assert(JoinCode.CODE_RE.test(r.json.joinCode), 'owner read should assign');
    eq((await call('GET', `/api/join/${r.json.joinCode}`)).json, { id: g.id }, 'resolves');
  });

  // ---------- store, Postgres ----------
  if (PG_URL) {
    process.env.DATABASE_URL = PG_URL;
    const pg = require('./lib/store-pg.js');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(PG_URL);
    await storeContract('pg', pg, async (id) => { await sql`delete from games where id = ${id}`; });
  } else {
    console.log('  (Postgres join-code tests skipped: no DATABASE_URL)');
  }

  for (const id of created) await store.deleteGame(id);
  for (const fn of cleanups) { try { await fn(); } catch (e) { /* best effort */ } }

  console.log('');
  if (failures.length) {
    console.log(`  ${failures.length} failed, ${passed} passed`);
    failures.forEach(f => console.log('  FAIL ' + f));
    process.exit(1);
  }
  console.log(`  join codes: ${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
