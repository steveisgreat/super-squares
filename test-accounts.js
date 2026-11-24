// Zero-dependency tests for host accounts (decision 012): who may do what to
// whose board, the sign-in link and code, sessions, and failing closed. The
// store and the mailer are stand-ins, so these always run. The SQL behind the
// same rules (limits, tries, one-time use) is tested in test-store-pg.js.
//
// Run with:  node test-accounts.js   (or: npm test)
'use strict';

// Must be settled before lib/store.js is required: it picks its backend once.
delete process.env.DATABASE_URL;

const crypto = require('crypto');
const G = require('./public/compute.js');
const auth = require('./lib/auth.js');
const store = require('./lib/store.js');
const mailer = require('./lib/mailer.js');
const realSend = mailer.sendLoginEmail;
const { handleApi, readBody } = require('./lib/api.js');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    reset();
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- environment ----------

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const ACCOUNTS_ENV = {
  AUTH_MODE: 'accounts',
  DATABASE_URL: 'postgresql://not-used',
  SESSION_SECRET: SECRET,
  APP_ORIGIN: 'https://app.example.com',
  RESEND_API_KEY: 'not-used',
  EMAIL_FROM: 'Squares <no-reply@example.com>'
};
const ALL_VARS = [...Object.keys(ACCOUNTS_ENV), 'HOST_PASSWORD', 'VERCEL', 'LOGIN_EMAILS_PER_HOUR'];

function setEnv(values) {
  ALL_VARS.forEach(k => { delete process.env[k]; });
  Object.assign(process.env, values);
}
const without = (key) => { const env = { ...ACCOUNTS_ENV }; delete env[key]; return env; };

// ---------- stand-in store and mailer ----------

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GAME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GAME_NONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNKNOWN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let db;
let mail;

function board(id) {
  return {
    id, league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    status: 'started', scoring: 'manual', squares: new Array(100).fill(null),
    axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    results: {}, players: {}, updatedAt: '2026-11-23T00:00:00.000Z'
  };
}

function reset() {
  setEnv(ACCOUNTS_ENV);
  mail = [];
  mailer.sendLoginEmail = async (m) => { mail.push(m); };
  db = {
    hosts: { [A]: { email: 'a@example.com', sessionVersion: 1 }, [B]: { email: 'b@example.com', sessionVersion: 1 } },
    games: {
      [GAME_A]: { doc: board(GAME_A), ownerId: A },
      [GAME_NONE]: { doc: board(GAME_NONE), ownerId: null }
    },
    logins: [],
    writes: 0
  };
}

Object.assign(store, {
  async listGames(scope) {
    if (scope.all) throw new Error('accounts mode must never list every board');
    return Object.values(db.games).filter(g => g.ownerId === scope.ownerId).map(g => ({ id: g.doc.id }));
  },
  async getGame(id) { return db.games[id] ? JSON.parse(JSON.stringify(db.games[id].doc)) : null; },
  async createGame(game, ownerId) {
    db.writes++;
    db.games[game.id] = { doc: game, ownerId: ownerId || null };
    return game;
  },
  async updateGame(id, game, expected, opts) {
    if (!db.games[id] && opts && opts.mustExist) return { ok: false, game: null };
    db.writes++;
    if (!db.games[id]) db.games[id] = { doc: null, ownerId: null };
    db.games[id].doc = game;
    return { ok: true, game };
  },
  async deleteGame(id) { db.writes++; const had = !!db.games[id]; delete db.games[id]; return had; },
  async getGameAccess(id, hostId) {
    const g = db.games[id];
    const h = db.hosts[hostId];
    return { exists: !!g, ownerId: g ? g.ownerId : null, sessionVersion: h ? h.sessionVersion : null };
  },
  async getHost(hostId) { return db.hosts[hostId] || null; },
  async createLoginRequest(r) {
    if (db.logins.filter(l => l.email === r.email).length >= r.perEmail) return false;
    if (db.logins.length >= r.perSite) return false;
    db.logins.push({ ...r, tries: 0, used: false });
    return true;
  },
  async useLoginToken(tokenHash) {
    const l = db.logins.find(x => x.tokenHash === tokenHash && !x.used);
    return l ? signedIn(l) : null;
  },
  async useLoginCode(id, codeHash, maxTries) {
    const l = db.logins.find(x => x.id === id && !x.used && x.tries < maxTries);
    if (!l) return null;
    l.tries++;
    return l.codeHash === codeHash ? signedIn(l) : null;
  },
  async revokeSessions(hostId, version) {
    const h = db.hosts[hostId];
    if (!h || h.sessionVersion !== version) return false;
    h.sessionVersion++;
    return true;
  }
});

function signedIn(login) {
  login.used = true;
  let id = Object.keys(db.hosts).find(k => db.hosts[k].email === login.email);
  if (!id) {
    id = crypto.randomUUID();
    db.hosts[id] = { email: login.email, sessionVersion: 1 };
  }
  return { id, email: login.email, sessionVersion: db.hosts[id].sessionVersion };
}

// ---------- request harness ----------

async function call(method, path, opts) {
  const o = opts || {};
  const headers = Object.assign({ host: 'app.example.com', 'x-forwarded-proto': 'https' }, o.headers);
  if (o.as) headers.cookie = cookie(o.as);
  if (o.cookie) headers.cookie = o.cookie;
  const req = {
    method, url: path, headers, socket: {}, destroy() {},
    on(event, cb) {
      if (event === 'data' && o.body !== undefined) {
        cb(Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)));
      }
      if (event === 'end') cb();
      return req;
    }
  };
  const res = {
    statusCode: null, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, h) {
      this.statusCode = status;
      Object.keys(h || {}).forEach(k => { this.headers[k.toLowerCase()] = h[k]; });
    },
    end(b) { this.body = b === undefined ? '' : String(b); },
    get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
  };
  const url = new URL(path, 'https://app.example.com');
  await handleApi(req, res, url.pathname, url.searchParams);
  return res;
}

// The cookie format written out longhand, so changing it has to be deliberate.
function cookie(hostId, version, exp, key) {
  const e = exp === undefined ? Math.floor(Date.now() / 1000) + 600 : exp;
  const payload = `v1.${hostId}.${version === undefined ? 1 : version}.${e}`;
  return `sbs_session=${payload}.${crypto.createHmac('sha256', key || SECRET).update(payload).digest('hex')}`;
}
const cookieFrom = (res) => String(res.headers['set-cookie']).split(';')[0];
const newBoard = () => { const b = board(UNKNOWN); delete b.id; return b; };

async function askToSignIn(email) {
  const res = await call('POST', '/api/login', { body: { email } });
  eq(res.statusCode, 200, 'login status');
  const sent = mail[mail.length - 1];
  return { requestId: res.json.requestId, code: sent.code, token: sent.link.split('#login-')[1], res };
}
const verify = (body) => call('POST', '/api/login/verify', { body });

async function run() {

  // ---------- one host cannot touch another's boards ----------

  await check('host B cannot PUT, PATCH or DELETE host A\'s board, and nothing is written', async () => {
    for (const [method, path, body] of [
      ['PUT', `/api/game/${GAME_A}`, board(GAME_A)],
      ['PATCH', `/api/game/${GAME_A}/score`, { op: 'add', side: 'a', points: 7 }],
      ['DELETE', `/api/game/${GAME_A}`]
    ]) {
      const res = await call(method, path, { as: B, body });
      eq(res.statusCode, 403, `${method} status`);
      assert(!res.json.authRequired, `${method}: a 403 must not open the sign-in prompt`);
    }
    eq(db.writes, 0, 'writes');
    assert(db.games[GAME_A], 'the board must still exist');
  });

  await check('an upper-case id does not get around the owner check', async () => {
    const res = await call('PUT', `/api/game/${GAME_A.toUpperCase()}`, { as: B, body: board(GAME_A) });
    eq(res.statusCode, 403, 'status');
    eq((await call('PUT', `/api/game/${GAME_A.toUpperCase()}`, { as: A, body: board(GAME_A) })).statusCode, 200, 'owner status');
  });

  await check('the list holds only the caller\'s own boards', async () => {
    eq((await call('GET', '/api/games', { as: A })).json, [{ id: GAME_A }], 'host A');
    eq((await call('GET', '/api/games', { as: B })).json, [], 'host B');
    eq((await call('GET', '/api/games')).statusCode, 401, 'anonymous');
  });

  await check('the owner can PUT, PATCH and DELETE their own board', async () => {
    eq((await call('PUT', `/api/game/${GAME_A}`, { as: A, body: board(GAME_A) })).statusCode, 200, 'PUT');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { as: A, body: { op: 'add', side: 'a', points: 7 } })).statusCode, 200, 'PATCH');
    eq((await call('DELETE', `/api/game/${GAME_A}`, { as: A })).statusCode, 200, 'DELETE');
  });

  await check('a board with no owner is write-locked for everyone', async () => {
    for (const as of [A, B]) {
      eq((await call('PUT', `/api/game/${GAME_NONE}`, { as, body: board(GAME_NONE) })).statusCode, 403, 'PUT');
      eq((await call('DELETE', `/api/game/${GAME_NONE}`, { as })).statusCode, 403, 'DELETE');
    }
    eq(db.writes, 0, 'writes');
  });

  await check('putting an owner in the body claims nothing and is not stored', async () => {
    const claim = { owner_id: B, ownerId: B };
    eq((await call('PUT', `/api/game/${GAME_NONE}`, { as: B, body: { ...board(GAME_NONE), ...claim } })).statusCode, 403, 'unowned');
    const put = await call('PUT', `/api/game/${GAME_A}`, { as: A, body: { ...board(GAME_A), ...claim } });
    eq(put.statusCode, 200, 'owner save');
    eq(db.games[GAME_A].ownerId, A, 'owner after save');
    const made = await call('POST', '/api/game', { as: A, body: { ...newBoard(), ...claim } });
    eq(db.games[made.json.id].ownerId, A, 'owner of a new board');
    for (const doc of [db.games[GAME_A].doc, db.games[made.json.id].doc]) {
      assert(!('owner_id' in doc) && !('ownerId' in doc), 'the document must not carry an owner');
    }
  });

  await check('creating a board makes the caller its owner', async () => {
    eq((await call('POST', '/api/game', { body: newBoard() })).statusCode, 401, 'anonymous');
    const res = await call('POST', '/api/game', { as: B, body: newBoard() });
    eq(res.statusCode, 201, 'status');
    eq(db.games[res.json.id].ownerId, B, 'owner');
    assert(!res.body.includes(B), 'the response must not carry the owner');
  });

  await check('anonymous callers get 401 and the sign-in prompt on every guarded route', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/games'], ['GET', '/api/todays-games?league=nfl'],
      ['POST', '/api/game', newBoard()], ['PUT', `/api/game/${GAME_A}`, board(GAME_A)],
      ['DELETE', `/api/game/${GAME_A}`], ['PATCH', `/api/game/${GAME_A}/score`, { op: 'end' }],
      ['POST', '/api/session/revoke-all']
    ]) {
      const res = await call(method, path, { body });
      eq([res.statusCode, res.json.authRequired], [401, true], `${method} ${path}`);
    }
    eq(db.writes, 0, 'writes');
  });

  await check('reading one board stays public, and an unknown id on a write is 404', async () => {
    const res = await call('GET', `/api/game/${GAME_A}`);
    eq(res.statusCode, 200, 'public read');
    assert(!res.body.includes(A), 'a guest must not see the owner');
    for (const [method, path] of [['PUT', ''], ['DELETE', ''], ['PATCH', '/score']]) {
      eq((await call(method, `/api/game/${UNKNOWN}${path}`, { as: A, body: board(UNKNOWN) })).statusCode, 404, method);
    }
    eq(db.writes, 0, 'writes');
  });

  await check('a delete landing between the owner check and the save does not re-create the board', async () => {
    const real = store.getGameAccess;
    store.getGameAccess = async (...args) => { const r = await real(...args); delete db.games[GAME_A]; return r; };
    try {
      eq((await call('PUT', `/api/game/${GAME_A}`, { as: A, body: board(GAME_A) })).statusCode, 404, 'status');
    } finally { store.getGameAccess = real; }
    assert(!db.games[GAME_A], 'the board must stay deleted');
  });

  // ---------- signing in ----------

  await check('the emailed link signs in once, on APP_ORIGIN, whatever Host the caller sent', async () => {
    const res = await call('POST', '/api/login', { body: { email: ' New@Example.com ' }, headers: { host: 'evil.example' } });
    eq(Object.keys(res.json), ['requestId'], 'the answer holds only the request id');
    eq(mail[0].to, 'new@example.com', 'address');
    assert(mail[0].link.startsWith('https://app.example.com/#login-'), `link: ${mail[0].link}`);
    const token = mail[0].link.split('#login-')[1];
    assert(!JSON.stringify(db.logins).includes(token), 'the token must not be stored');
    assert(!JSON.stringify(db.logins).includes(mail[0].code), 'the code must not be stored');
    const ok = await verify({ token });
    eq([ok.statusCode, ok.json.email], [200, 'new@example.com'], 'first use');
    const again = await verify({ token });
    eq([again.statusCode, !!again.headers['set-cookie']], [401, false], 'second use');
  });

  await check('the code signs in once, with or without spaces', async () => {
    const { requestId, code } = await askToSignIn('a@example.com');
    const ok = await verify({ requestId, code: `${code.slice(0, 4)} ${code.slice(4)}` });
    eq(ok.statusCode, 200, 'status');
    eq((await call('GET', '/api/games', { cookie: cookieFrom(ok) })).json, [{ id: GAME_A }], 'same account as before');
    eq((await verify({ requestId, code })).statusCode, 401, 'second use');
  });

  await check('using the code also uses up the link', async () => {
    const { requestId, code, token } = await askToSignIn('a@example.com');
    eq((await verify({ requestId, code })).statusCode, 200, 'code');
    eq((await verify({ token })).statusCode, 401, 'link afterwards');
  });

  await check('a code fails under another request id', async () => {
    const one = await askToSignIn('a@example.com');
    const two = await askToSignIn('b@example.com');
    eq((await verify({ requestId: two.requestId, code: one.code })).statusCode, 401, 'status');
  });

  await check('a wrong code, a wrong token and nonsense are all the same 401 with no cookie', async () => {
    const { requestId, code } = await askToSignIn('a@example.com');
    const wrong = code === '00000000' ? '00000001' : '00000000';
    for (const body of [
      { requestId, code: wrong }, { requestId, code: '123' }, { requestId }, { code }, {},
      { requestId: 'x', code }, { requestId, code: Number(code) }, { token: 'short' },
      { token: 'A'.repeat(43) }, { token: { $ne: null } }, { requestId: [requestId], code: [code] }
    ]) {
      const res = await verify(body);
      eq([res.statusCode, !!res.headers['set-cookie']], [401, false], JSON.stringify(body));
    }
    eq((await call('POST', '/api/login/verify', { body: 'not json' })).statusCode, 400, 'malformed');
    eq((await call('POST', '/api/login/verify', { body: 'null' })).statusCode, 400, 'null body');
  });

  await check('the limits on tries and requests reach the store', async () => {
    const { requestId, code } = await askToSignIn('a@example.com');
    const wrong = code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 5; i++) await verify({ requestId, code: wrong });
    eq((await verify({ requestId, code })).statusCode, 401, 'sixth try, right code');

    for (let i = 0; i < 4; i++) await askToSignIn('a@example.com');
    const sent = mail.length;
    eq((await call('POST', '/api/login', { body: { email: 'a@example.com' } })).statusCode, 429, 'sixth request');
    eq(mail.length, sent, 'no mail past the limit');

    process.env.LOGIN_EMAILS_PER_HOUR = String(db.logins.length);
    eq((await call('POST', '/api/login', { body: { email: 'c@example.com' } })).statusCode, 429, 'site-wide cap');
    process.env.LOGIN_EMAILS_PER_HOUR = 'lots';
    eq(auth.loginEmailsPerHour(), 200, 'nonsense falls back to the default, never to unlimited');
  });

  await check('the answer is the same for a known and an unknown address', async () => {
    const known = (await askToSignIn('a@example.com')).res;
    const unknown = (await askToSignIn('nobody@example.com')).res;
    const shape = (r) => [r.statusCode, Object.keys(r.json), Object.keys(r.headers).sort()];
    eq(shape(known), shape(unknown), 'shape');
  });

  await check('only a real address is accepted, and two spellings are one address', () => {
    eq(auth.normalizeEmail('  Steve@Example.COM '), 'steve@example.com');
    ['', 'x', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@c.com\r\nBcc: d@e.com', 'a@c.com,d@e.com',
      '<a@c.com>', 'a@c..com', 'ä@c.com', 'a@exämple.com', 'x'.repeat(65) + '@c.com', null, 5, {}, ['a@c.com']
    ].forEach(v => eq(auth.normalizeEmail(v), null, JSON.stringify(v)));
  });

  await check('a mail failure is a 502 that says nothing about the cause', async () => {
    mailer.sendLoginEmail = async () => { throw new Error('secret detail'); };
    const error = console.error;
    console.error = () => {};
    try {
      const res = await call('POST', '/api/login', { body: { email: 'a@example.com' } });
      eq(res.statusCode, 502, 'status');
      assert(!res.body.includes('secret'), 'the cause must stay on the server');
    } finally { console.error = error; }
  });

  // ---------- sessions ----------

  await check('the session cookie is HttpOnly, Lax, Secure, 90 days and has no Domain', async () => {
    const { token } = await askToSignIn('a@example.com');
    const header = String((await verify({ token })).headers['set-cookie']);
    ['sbs_session=v1.', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/', 'Max-Age=7776000']
      .forEach(part => assert(header.includes(part), `missing ${part}`));
    assert(!/Domain/i.test(header), 'no Domain attribute');
  });

  await check('forged, expired and altered session cookies are refused', async () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    const good = cookie(A);
    const bad = [
      cookie(A, 1, undefined, 'some other key that is long enough 123456'),
      cookie(A, 1, past),
      cookie(A, 2), cookie(A, 0), cookie(UNKNOWN),
      good.replace(A, B),
      good.slice(0, -1), good + '0', good.replace('v1.', 'v2.'),
      cookie(A, 1, past).replace(String(past), String(past + 9999)),
      'sbs_session=', 'sbs_session=....', 'sbs_session=%', 'sbs_host=' + good.slice(12)
    ];
    for (const c of bad) eq((await call('GET', '/api/games', { cookie: c })).statusCode, 401, c);
    eq((await call('GET', '/api/games', { cookie: good })).statusCode, 200, 'the real one');
  });

  await check('a password-mode cookie signed with the same secret is nobody in accounts mode', async () => {
    const exp = String(Math.floor(Date.now() / 1000) + 600);
    const c = `sbs_host=${exp}.${crypto.createHmac('sha256', SECRET).update(exp).digest('hex')}`;
    eq((await call('GET', '/api/games', { cookie: c })).statusCode, 401, 'status');
  });

  await check('sign out everywhere ends every session of that account and no other', async () => {
    const first = cookie(A);
    const res = await call('POST', '/api/session/revoke-all', { cookie: first });
    eq(res.statusCode, 200, 'status');
    assert(/sbs_session=;/.test(res.headers['set-cookie']), 'this device is signed out too');
    eq((await call('GET', '/api/games', { cookie: first })).statusCode, 401, 'list');
    eq((await call('PUT', `/api/game/${GAME_A}`, { cookie: first, body: board(GAME_A) })).statusCode, 401, 'owner write');
    eq((await call('DELETE', `/api/game/${UNKNOWN}`, { cookie: first })).statusCode, 401, 'an ended session on an unknown id');
    eq((await call('POST', '/api/session/revoke-all', { cookie: first })).statusCode, 401, 'an ended session cannot revoke');
    eq((await call('GET', '/api/games', { as: B })).statusCode, 200, 'host B');
    eq(db.writes, 0, 'writes');
  });

  await check('GET /api/session reports the account, is never cached, and goes blank when revoked', async () => {
    const res = await call('GET', '/api/session', { as: A });
    eq([res.json.host, res.json.mode, res.json.email], [true, 'accounts', 'a@example.com'], 'signed in');
    eq(res.headers['cache-control'], 'no-store', 'cache-control');
    for (const opts of [{}, { cookie: cookie(A, 9) }]) {
      const out = (await call('GET', '/api/session', opts)).json;
      eq([out.host, out.authRequired, 'email' in out], [false, true, false], 'signed out');
    }
  });

  await check('password sign-in does not exist in accounts mode', async () => {
    process.env.HOST_PASSWORD = 'still set';
    const res = await call('POST', '/api/session', { body: { password: 'still set' } });
    eq([res.statusCode, !!res.headers['set-cookie']], [404, false], 'status');
  });

  // ---------- cross-site ----------

  await check('a foreign Origin is refused on every method that writes', async () => {
    for (const origin of ['https://example.com', 'https://evil.example', 'null', 'nonsense', 'https://app.example.com:8443', 'file://']) {
      for (const [method, path] of [['PUT', `/api/game/${GAME_A}`], ['DELETE', `/api/game/${GAME_A}`], ['PATCH', `/api/game/${GAME_A}/score`],
        ['POST', '/api/game'], ['POST', '/api/login'], ['POST', '/api/login/verify'], ['DELETE', '/api/session'], ['POST', '/api/session/revoke-all']]) {
        eq((await call(method, path, { as: A, body: board(GAME_A), headers: { origin } })).statusCode, 403, `${method} ${path} from ${origin}`);
      }
    }
    eq([db.writes, mail.length, db.hosts[A].sessionVersion], [0, 0, 1], 'nothing happened');
  });

  await check('the same origin is accepted, with a default port or a LAN address', async () => {
    const put = (headers) => call('PUT', `/api/game/${GAME_A}`, { as: A, body: board(GAME_A), headers });
    eq((await put({ origin: 'https://app.example.com' })).statusCode, 200, 'same');
    eq((await put({ origin: 'https://app.example.com', host: 'app.example.com:443' })).statusCode, 200, 'default port');
    eq((await put({ origin: 'http://192.168.1.5:3000', host: '192.168.1.5:3000' })).statusCode, 200, 'LAN');
    eq((await call('GET', `/api/game/${GAME_A}`, { headers: { origin: 'https://example.com' } })).statusCode, 200, 'a read');
  });

  // ---------- failing closed ----------

  await check('a missing or weak setting in accounts mode is 503, never open', async () => {
    const bad = ['DATABASE_URL', 'SESSION_SECRET', 'APP_ORIGIN', 'EMAIL_FROM'].map(k => [`no ${k}`, without(k)]);
    bad.push(['short secret', { ...ACCOUNTS_ENV, SESSION_SECRET: 'short' }]);
    bad.push(['bad origin', { ...ACCOUNTS_ENV, APP_ORIGIN: 'app.example.com' }]);
    bad.push(['http origin on Vercel', { ...ACCOUNTS_ENV, APP_ORIGIN: 'http://app.example.com', VERCEL: '1' }]);
    bad.push(['no mail key on Vercel', { ...without('RESEND_API_KEY'), VERCEL: '1' }]);
    bad.push(['typo in the mode', { ...ACCOUNTS_ENV, AUTH_MODE: 'acounts' }]);
    bad.push(['typo with a password set', { AUTH_MODE: 'Accounts', HOST_PASSWORD: 'x' }]);
    bad.push(['nothing set on Vercel', { VERCEL: '1' }]);
    for (const [what, env] of bad) {
      setEnv(env);
      for (const [method, path, body] of [
        ['GET', '/api/games'], ['POST', '/api/game', newBoard()], ['PUT', `/api/game/${GAME_A}`, board(GAME_A)],
        ['DELETE', `/api/game/${GAME_A}`], ['PATCH', `/api/game/${GAME_A}/score`, { op: 'end' }], ['GET', '/api/todays-games'],
        ['POST', '/api/session', { password: 'x' }], ['POST', '/api/login', { email: 'a@example.com' }],
        ['POST', '/api/login/verify', { token: 'A'.repeat(43) }], ['POST', '/api/session/revoke-all']
      ]) {
        eq((await call(method, path, { as: A, body })).statusCode, 503, `${what}: ${method} ${path}`);
      }
      const session = (await call('GET', '/api/session', { as: A })).json;
      eq([session.host, session.authRequired], [false, true], `${what}: session`);
      eq((await call('GET', `/api/game/${GAME_A}`)).statusCode, 200, `${what}: reading a board still works`);
    }
    eq([db.writes, mail.length], [0, 0], 'nothing happened');
  });

  await check('off Vercel, accounts mode runs without a mail key', () => {
    setEnv(without('RESEND_API_KEY'));
    eq(auth.authMode(), 'accounts');
  });

  await check('the account routes do not exist in password or off mode', async () => {
    for (const env of [{}, { HOST_PASSWORD: 'x' }]) {
      setEnv(env);
      for (const path of ['/api/login', '/api/login/verify', '/api/session/revoke-all']) {
        eq((await call('POST', path, { body: {} })).statusCode, 404, path);
      }
    }
  });

  await check('with auth off, every LAN write works with no sign-in, upsert included', async () => {
    setEnv({});
    const list = store.listGames;
    store.listGames = async (scope) => { eq(scope, { all: true }, 'scope'); return []; };
    try { eq((await call('GET', '/api/games')).statusCode, 200, 'list'); } finally { store.listGames = list; }
    const made = await call('POST', '/api/game', { body: newBoard() });
    eq([made.statusCode, db.games[made.json.id].ownerId], [201, null], 'create');
    eq((await call('PUT', `/api/game/${UNKNOWN}`, { body: board(UNKNOWN) })).statusCode, 200, 'save re-creates, as before');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { body: { op: 'add', side: 'a', points: 3 } })).statusCode, 200, 'score');
    eq((await call('DELETE', `/api/game/${GAME_A}`)).statusCode, 200, 'delete');
  });

  await check('a name split across two chunks of the body survives, and the size limit holds', async () => {
    const stream = (chunks) => ({ destroy() {}, on(event, cb) {
      if (event === 'data') chunks.forEach(c => cb(c));
      if (event === 'end') cb();
    } });
    const bytes = Buffer.from('{"name":"Zoë"}');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "ë"
    eq(await readBody(stream([bytes.subarray(0, cut), bytes.subarray(cut)])), { name: 'Zoë' });
    let threw = false;
    await readBody(stream([bytes, bytes]), bytes.length).catch(() => { threw = true; });
    assert(threw, 'over the limit');
  });

  await check('a full simulated board is half the limit or less, and anything over it is a 413 that writes nothing', async () => {
    reset();
    const full = Object.assign(board(GAME_A), {
      scoring: 'simulation', simulation: true, status: 'picking',
      description: 'Washington Commanders @ Tampa Bay Buccaneers', potOverride: 1000,
      autoCutoffTime: '2027-02-14T18:45', kickoffTime: '2027-02-14T23:30Z',
      guestPick: { on: true, max: 100, liftAt: '2027-02-14T18:45:00.000Z', lifted: false }
    });
    // The longest name the form allows, at three bytes a character.
    full.squares.forEach((s, i) => {
      const name = '字'.repeat(8) + String(i).padStart(2, '0') + '₁₂';
      full.squares[i] = { name, at: 1787441568 };
      // A guest's tag and a part-paid count, as decision 019 stores them.
      full.players[name] = { paid: false, color: '#feca57', g: 'abcdefghijklmnopqrstuv', paidSquares: 100 };
    });
    G.lockGame(full);
    while (full.simPlan.events.length < 14) full.simPlan.events.push({ team: 'a', atMs: 479999, points: 7 });
    G.QUARTERS.forEach(q => { full.results[q] = { a: 34, b: 31 }; });
    full.results.final.autoResolve = { key: '5-6', row: 4, col: 7, drawnAt: 1787441568511 };
    full.liveScore = { a: 34, b: 31, period: 4, clock: '0:00', state: 'post', completed: true, simulation: true, updatedAt: full.updatedAt };
    const size = Buffer.byteLength(JSON.stringify(full));
    assert(size * 2 <= 40 * 1024, `a full board is ${size} bytes`);
    eq((await call('PUT', `/api/game/${GAME_A}`, { as: A, body: full })).statusCode, 200, 'a full board saves');

    reset();
    const huge = Object.assign(board(GAME_A), { padding: 'x'.repeat(40 * 1024) });
    eq((await call('PUT', `/api/game/${GAME_A}`, { as: A, body: huge })).statusCode, 413, 'PUT');
    eq((await call('POST', '/api/game', { as: A, body: huge })).statusCode, 413, 'POST');
    eq((await call('PATCH', `/api/game/${GAME_A}/score`, { as: A, body: { op: 'end', padding: 'x'.repeat(4096) } })).statusCode, 413, 'PATCH');
    eq((await call('POST', '/api/login', { body: { email: 'x'.repeat(5000) } })).statusCode, 413, 'login');
    eq(db.writes, 0, 'writes');
  });

  await check('a board with a hostile field is a 400 that writes nothing', async () => {
    reset();
    const bad = Object.assign(board(GAME_A), { players: { Ann: { color: '"><img src=x onerror=alert(1)>' } } });
    eq((await call('PUT', `/api/game/${GAME_A}`, { as: A, body: bad })).statusCode, 400, 'PUT');
    eq((await call('POST', '/api/game', { as: A, body: bad })).statusCode, 400, 'POST');
    eq(db.writes, 0, 'writes');
  });

  // ---------- the pages ----------

  await check('the policy allows no inline script, and no page needs one', async () => {
    const fs = require('fs');
    const dir = require('path').join(__dirname, 'public');
    const [rule] = require('./vercel.json').headers;
    const csp = rule.headers.find(h => h.key === 'Content-Security-Policy').value;
    eq(rule.source, '/(.*)', 'every path');
    const scripts = csp.split('; ').find(d => d.startsWith('script-src '));
    eq(scripts, "script-src 'self'");
    assert(csp.includes("default-src 'self'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"), csp);
    fs.readdirSync(dir).filter(f => f.endsWith('.html')).forEach(f => {
      const html = fs.readFileSync(`${dir}/${f}`, 'utf8');
      (html.match(/<script\b[^>]*>[^]*?<\/script>/gi) || []).forEach(s => assert(/^<script src="[^":]+"><\/script>$/.test(s), `${f}: ${s.slice(0, 60)}`));
      assert(!/\son[a-z]+\s*=|javascript:|<style\b/i.test(html), `${f} has an inline handler or style block`);
    });
  });

  // ---------- the mail itself ----------

  await check('the mail goes to Resend with the link and code, and its errors stay vague', async () => {
    const fetchWas = global.fetch;
    let sent;
    global.fetch = async (url, o) => { sent = { url, ...o }; return { ok: true }; };
    const m = { to: 'a@example.com', link: 'https://app.example.com/#login-tok', code: '01234567', requestId: 'r1' };
    try {
      await realSend(m);
      const body = JSON.parse(sent.body);
      eq([sent.url, body.to, body.from], ['https://api.resend.com/emails', ['a@example.com'], ACCOUNTS_ENV.EMAIL_FROM]);
      for (const part of [body.text, body.html]) assert(part.includes(m.link) && part.includes('0123 4567'), 'link and code');
      assert(!body.subject.includes('0123'), 'no code in the subject: it shows on a lock screen');
      global.fetch = async () => ({ ok: false, status: 422, text: async () => 'a@example.com' });
      let message = '';
      await realSend(m).catch(e => { message = e.message; });
      eq(message, 'Resend answered 422');
    } finally { global.fetch = fetchWas; }
  });

  await check('without a key the console gets the code, but never on Vercel', async () => {
    const log = console.log;
    let out = '';
    console.log = (s) => { out += s; };
    const m = { to: 'a@example.com', link: 'L', code: '01234567', requestId: 'r1' };
    let threw = false;
    try {
      setEnv(without('RESEND_API_KEY'));
      await realSend(m);
      assert(out.includes('01234567'), 'printed locally');
      out = '';
      process.env.VERCEL = '1';
      await realSend(m).catch(() => { threw = true; });
    } finally { console.log = log; }
    assert(threw && !out, 'Vercel must refuse and print nothing');
  });

  // ---------- report ----------

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
