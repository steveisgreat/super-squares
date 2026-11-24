// Tests for the shared live slate (R4a part 2, decision 001 sections 3 to 6):
// claim concurrency in the fs store, one claimed refresh per window, merge on read,
// host-wins, quarter-completion writes, no backward step on a provider switch, the
// feed-unavailable state, and a simulated 50-board run that stays within 4 provider
// calls a minute. No network and no real clock: providers are fakes and time is passed
// in. The Postgres claim test is in test-store-pg.js (it needs DATABASE_URL).
//
// Run with:  node test-slates.js   (or: npm test)
'use strict';

// A stray environment must not turn on sign-in or reach a provider.
delete process.env.DATABASE_URL;
delete process.env.HOST_PASSWORD;
delete process.env.AUTH_MODE;
delete process.env.VERCEL;

const crypto = require('crypto');
const store = require('./lib/store-fs.js');
const Slate = require('./lib/scores/slate.js');
const G = require('./public/compute.js');
const { handleApi } = require('./lib/api.js');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}\n      ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A LiveGame, KC (our team A) away at PHI (team B) home.
function lg(o) {
  const x = Object.assign({
    provider: 'espn', league: 'nfl', etDate: '2099-01-01', state: 'in', period: 1, clock: '5:00',
    hs: 0, as: 0, hq: [0, null, null, null], aq: [0, null, null, null], hot: null, aot: null
  }, o);
  return {
    provider: x.provider, providerGameId: '1', league: x.league, etDate: x.etDate,
    home: { abbr: 'phi', score: x.hs, quarters: x.hq, ot: x.hot },
    away: { abbr: 'kc', score: x.as, quarters: x.aq, ot: x.aot },
    state: x.state, period: x.period, clock: x.clock,
    startsAt: null, providerUpdatedAt: null, fetchedAt: '2099-01-01T00:00:00.000Z'
  };
}
const ok = (provider, games) => ({ ok: true, provider, games, ms: 1, error: null, missing: [], tried: [] });
const fail = error => ({ ok: false, provider: null, games: [], ms: 1, error, missing: [], tried: [] });

function board(date, extra) {
  const squares = G.emptyGrid();
  return Object.assign({
    league: 'nfl', gameDate: date, teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 20, q2: 20, q3: 20, final: 40 },
    status: 'started', scoring: 'live', squares, pickMode: 'both',
    axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], results: {}, players: {}
  }, extra || {});
}

// Writes a slate row directly, as a refresh would, stamped `nowMs`.
let seedStamp = Date.now();
async function seed(date, games, opts) {
  const o = opts || {};
  const seen = (await store.getLiveSlate('nfl', date));
  const at = new Date(o.at || (seedStamp += 1)).toISOString();
  assert(await store.claimLiveSlate('nfl', date, seen ? seen.checkedAt : null, at), 'seed claim failed');
  await store.saveLiveSlate('nfl', date, Object.assign({ provider: 'espn', games }, o.payload || {}), o.failed ? null : at);
}

async function run() {
  // ---- fs store: claims --------------------------------------------------------
  await check('fs: 50 concurrent claims on an empty row, exactly one wins', async () => {
    const wins = await Promise.all(Array.from({ length: 50 }, () =>
      store.claimLiveSlate('nfl', '2098-01-01', null, '2098-01-01T00:00:00.000Z')));
    eq(wins.filter(Boolean).length, 1);
    eq((await store.getLiveSlate('nfl', '2098-01-01')).checkedAt, '2098-01-01T00:00:00.000Z');
  });
  await check('fs: 50 concurrent claims holding the same seen value, exactly one wins', async () => {
    const seen = '2098-01-01T00:00:00.000Z';
    const wins = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      store.claimLiveSlate('nfl', '2098-01-01', seen, new Date(Date.UTC(2098, 0, 1, 0, 0, 15 + i)).toISOString())));
    eq(wins.filter(Boolean).length, 1);
  });
  await check('fs: a claim with a stale seen value loses, and a claim on a missing row with a seen value loses', async () => {
    eq(await store.claimLiveSlate('nfl', '2098-01-01', '2000-01-01T00:00:00.000Z', '2098-02-01T00:00:00.000Z'), false);
    eq(await store.claimLiveSlate('nfl', '2098-01-02', '2000-01-01T00:00:00.000Z', '2098-02-01T00:00:00.000Z'), false);
  });
  await check('fs: save keeps the old fetchedAt when given none, and rejects a bad key', async () => {
    await store.claimLiveSlate('nfl', '2098-01-03', null, '2098-01-03T00:00:00.000Z');
    await store.saveLiveSlate('nfl', '2098-01-03', { provider: 'espn', games: [] }, '2098-01-03T00:00:01.000Z');
    await store.saveLiveSlate('nfl', '2098-01-03', { provider: 'espn', games: [], error: 'x' }, null);
    const row = await store.getLiveSlate('nfl', '2098-01-03');
    eq([row.fetchedAt, row.payload.error], ['2098-01-03T00:00:01.000Z', 'x']);
    let threw = false;
    try { await store.getLiveSlate('nfl', 'tomorrow'); } catch (e) { threw = true; }
    assert(threw, 'a bad date should throw');
  });

  // ---- getSlate: one claimed refresh -------------------------------------------
  await check('getSlate: concurrent readers cause one provider call; the next window one more', async () => {
    let calls = 0;
    const fetchWithFailover = async () => { calls++; return ok('espn', [lg({ etDate: '2099-01-02' })]); };
    let t = Date.UTC(2099, 0, 2, 18);
    const read = () => Slate.getSlate('nfl', '2099-01-02', { fetchWithFailover, now: () => t });
    const first = await Promise.all(Array.from({ length: 30 }, read));
    eq(calls, 1);
    eq(first.filter(r => r.claimed).length, 1);
    assert(first.every(r => r.claimed || !r.row || r.row.payload === null || Array.isArray(r.row.payload.games)), 'a loser sees nothing yet or a whole row');
    t += 14999; await read(); eq(calls, 1, 'inside the window');
    t += 1; await read(); eq(calls, 2, 'window over');
  });
  await check('getSlate: a failed refresh is throttled like any attempt and keeps the last good games', async () => {
    let calls = 0;
    let answer = ok('espn', [lg({ etDate: '2099-01-03', hs: 7 })]);
    const fetchWithFailover = async () => { calls++; return answer; };
    let t = Date.UTC(2099, 0, 3, 18);
    const read = () => Slate.getSlate('nfl', '2099-01-03', { fetchWithFailover, now: () => t });
    await read();
    answer = fail('both down'); t += 15000;
    const r = await read();
    await read(); await read();
    eq(calls, 2, 'failure throttled');
    eq(r.row.payload.games[0].home.score, 7);
    eq(typeof r.row.payload.error, 'string');
    answer = ok('espn', [lg({ etDate: '2099-01-03', hs: 10 })]); t += 15000;
    const back = await read();
    eq([back.row.payload.games[0].home.score, back.row.payload.error], [10, undefined]);
  });
  await check('getSlate: a provider that throws, or no provider at all, is a recorded failure and never an exception', async () => {
    const r = await Slate.getSlate('nfl', '2099-01-04', { fetchWithFailover: async () => { throw new Error('boom'); }, now: () => 1 });
    eq(typeof r.row.payload.error, 'string');
    const none = await Slate.getSlate('nfl', '2099-01-05', { env: { VERCEL: '1' }, now: () => 1, fetchWithFailover: require('./lib/scores/index.js').fetchWithFailover });
    eq(none.row.fetchedAt, null);
  });
  await check('getSlate: an unsupported league never calls a provider', async () => {
    let calls = 0;
    const r = await Slate.getSlate('other', '2099-01-06', { fetchWithFailover: async () => { calls++; return ok('espn', []); } });
    eq([calls, r.row], [0, null]);
  });

  // ---- 50 boards, 4 calls a minute ---------------------------------------------
  await check('50 boards polling every second for 10 minutes make at most 4 provider calls a minute', async () => {
    const date = '2099-02-02';
    const boards = Array.from({ length: 50 }, () => board(date));
    const calls = [];
    let t = Date.UTC(2099, 1, 2, 18);
    const fetchWithFailover = async () => { calls.push(t); return ok('espn', [lg({ etDate: date, period: 1, clock: '9:00' })]); };
    for (let s = 0; s < 600; s++) {
      t += 1000;
      const outs = await Promise.all(boards.map(b => Slate.readForGame(b, { fetchWithFailover, now: () => t })));
      if (s > 0) assert(outs.every(o => o.game.liveScore && o.game.liveScore.state === 'in'), 'every board got a score');
    }
    assert(calls.length <= 41, `too many calls: ${calls.length}`);
    for (let i = 0; i + 4 < calls.length; i++) assert(calls[i + 4] - calls[i] >= 60000, 'more than 4 calls inside one minute');
  });

  // ---- merge on read -----------------------------------------------------------
  const NOW = Date.parse('2099-03-01T20:00:00Z');
  const rowOf = (games, o) => Object.assign({
    payload: { provider: 'espn', games }, checkedAt: new Date(NOW).toISOString(), fetchedAt: new Date(NOW).toISOString()
  }, o);

  await check('merge: liveScore follows our team A, whichever side is home', () => {
    const g = board('2099-03-01');
    const m = Slate.applyToGame(g, rowOf([lg({ hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })]), NOW);
    eq([m.game.liveScore.a, m.game.liveScore.b, m.game.liveScore.period, m.game.liveScore.clock, m.game.liveScore.state], [3, 7, 1, '5:00', 'in']);
    eq(m.feed.available, true);
    eq(m.filled, []);
  });
  await check('merge: the input board is never mutated', () => {
    const g = board('2099-03-01');
    const before = JSON.stringify(g);
    Slate.applyToGame(g, rowOf([lg({ hs: 7, as: 3 })]), NOW);
    eq(JSON.stringify(g), before);
  });
  await check('merge: a break shows as in-game with the intermission name; halftime is named', () => {
    const g = board('2099-03-01');
    const half = Slate.applyToGame(g, rowOf([lg({ state: 'break', period: 2, clock: null, hs: 7, as: 10, hq: [7, 0, null, null], aq: [3, 7, null, null] })]), NOW).game.liveScore;
    eq([half.state, half.statusName, half.clock], ['in', 'STATUS_HALFTIME', '']);
    const q1 = Slate.applyToGame(g, rowOf([lg({ state: 'break', period: 1, clock: null })]), NOW).game.liveScore;
    eq(q1.statusName, 'STATUS_END_PERIOD');
  });
  await check('merge: a provider with no period leaves period and clock empty', () => {
    const g = board('2099-03-01');
    const s = Slate.applyToGame(g, rowOf([lg({ provider: 'balldontlie', period: null, clock: null, hs: 1, as: 2 })]), NOW).game.liveScore;
    eq([s.period, s.clock], [null, '']);
  });
  await check('merge: the result validates as a game document', () => {
    const m = Slate.applyToGame(board('2099-03-01'), rowOf([lg({ state: 'pre', period: null, clock: null, hs: null, as: null, hq: [null, null, null, null], aq: [null, null, null, null] })]), NOW);
    eq(G.validateGame(m.game), null);
    const m2 = Slate.applyToGame(board('2099-03-01'), rowOf([lg({ hs: 7, as: 3 })]), NOW);
    eq(G.validateGame(m2.game), null);
  });

  await check('quarter completion: Q1 fills at the end-of-quarter break, as cumulative scores for A and B', () => {
    const g = board('2099-03-01');
    const m = Slate.applyToGame(g, rowOf([lg({ state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })]), NOW);
    eq(m.filled, ['q1']);
    eq(m.game.results.q1, { a: 3, b: 7 });
    eq(m.game.results.q2, undefined);
  });
  await check('quarter completion: nothing fills mid-quarter, or when the totals have not caught up', () => {
    const g = board('2099-03-01');
    eq(Slate.applyToGame(g, rowOf([lg({ hs: 7, as: 3 })]), NOW).filled, []);
    // The total moved before the quarter line: not settled.
    const ahead = lg({ state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [0, null, null, null] });
    eq(Slate.applyToGame(g, rowOf([ahead]), NOW).filled, []);
  });
  await check('quarter completion: the final fills only on a final, finishes the board, and includes OT', () => {
    const g = board('2099-03-01', { results: { q1: { a: 3, b: 7 }, q2: { a: 10, b: 7 }, q3: { a: 13, b: 10 } } });
    const fin = lg({ state: 'post', period: 5, clock: '0:00', hs: 20, as: 23, hq: [7, 0, 3, 7], aq: [3, 7, 3, 7], hot: 3, aot: 3 });
    fin.home.ot = 3; fin.away.ot = 3; fin.home.score = 23; fin.away.score = 26; fin.home.quarters = [7, 0, 3, 10]; fin.away.quarters = [3, 7, 3, 10];
    const m = Slate.applyToGame(g, rowOf([fin]), NOW);
    eq(m.filled, ['final']);
    eq(m.game.results.final, { a: 26, b: 23 });
    eq(m.game.status, 'finished');
    eq(m.game.liveScore.completed, true);
  });
  await check('host wins: a quarter the host already entered is never overwritten', () => {
    const g = board('2099-03-01', { results: { q1: { a: 6, b: 7 } } });
    const m = Slate.applyToGame(g, rowOf([lg({ state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })]), NOW);
    eq(m.filled, []);
    eq(m.game.results.q1, { a: 6, b: 7 });
  });
  await check('host wins: with liveOverride or a manual score, the feed changes neither liveScore nor results', () => {
    const feed = rowOf([lg({ state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })]);
    const held = board('2099-03-01', { liveOverride: true, liveScore: { a: 1, b: 2, period: 1, clock: '', state: 'in', manual: true } });
    const m = Slate.applyToGame(held, feed, NOW);
    eq([m.game.liveScore.a, m.game.liveScore.b, m.filled], [1, 2, []]);
    const manualOnly = board('2099-03-01', { liveScore: { a: 4, b: 5, period: 1, clock: '', state: 'in', manual: true } });
    eq(Slate.applyToGame(manualOnly, feed, NOW).game.liveScore.a, 4);
  });
  await check('a board that is not started, or not locked in a quarter way, is not filled', () => {
    const g = board('2099-03-01', { status: 'picking' });
    const m = Slate.applyToGame(g, rowOf([lg({ state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })]), NOW);
    eq(m.filled, []);
  });

  // ---- feed availability -------------------------------------------------------
  await check('feed: unavailable with no row, a game the slate lacks, or a custom league', () => {
    eq(Slate.applyToGame(board('2099-03-01'), null, NOW).feed.available, false);
    eq(Slate.applyToGame(board('2099-03-01'), rowOf([]), NOW).feed.available, false);
    eq(Slate.applyToGame(board('2099-03-01', { league: 'other' }), rowOf([lg({})]), NOW).feed.available, false);
  });
  await check('feed: unavailable after 60 s of failures, available while merely old or failing for less', () => {
    const g = board('2099-03-01');
    const games = [lg({ hs: 7, as: 3 })];
    const old = new Date(NOW - 61000).toISOString();
    const failing = rowOf(games, { fetchedAt: old });
    failing.payload.error = 'down';
    const m = Slate.applyToGame(g, failing, NOW);
    eq(m.feed.available, false);
    eq(m.game.liveScore.a, 3, 'the last good score still shows');
    eq(Slate.applyToGame(g, rowOf(games, { fetchedAt: old }), NOW).feed.available, true, 'old but no failure recorded');
    const recent = rowOf(games, { fetchedAt: new Date(NOW - 59000).toISOString() });
    recent.payload.error = 'down';
    eq(Slate.applyToGame(g, recent, NOW).feed.available, true);
  });

  // ---- failover: no backward step ----------------------------------------------
  await check('failover: a secondary that is behind never moves a score backward; once it catches up, it is taken', async () => {
    const date = '2099-04-01';
    let t = Date.UTC(2099, 3, 1, 18);
    let answer;
    const fetchWithFailover = async () => answer;
    const read = () => Slate.getSlate('nfl', date, { fetchWithFailover, now: () => t });
    answer = ok('espn', [lg({ etDate: date, hs: 10, as: 0, period: 2, clock: '5:00', hq: [7, 3, null, null], aq: [0, 0, null, null] })]);
    await read();
    t += 16000;
    answer = ok('balldontlie', [lg({ provider: 'balldontlie', etDate: date, hs: 3, as: 0, period: 1, clock: '2:00', hq: [3, null, null, null], aq: [0, null, null, null] })]);
    let r = await read();
    let game = r.row.payload.games[0];
    eq([game.provider, game.home.score, game.period], ['espn', 10, 2], 'held at the primary reading');
    t += 16000;
    answer = ok('balldontlie', [lg({ provider: 'balldontlie', etDate: date, hs: 13, as: 0, period: 2, clock: '4:00', hq: [7, 6, null, null], aq: [0, 0, null, null] })]);
    r = await read();
    game = r.row.payload.games[0];
    eq([game.provider, game.home.score], ['balldontlie', 13], 'caught up');
    // The cap: a secondary that never catches up is taken after 120 s.
    const date2 = '2099-04-02';
    t = Date.UTC(2099, 3, 2, 18);
    const read2 = () => Slate.getSlate('nfl', date2, { fetchWithFailover, now: () => t });
    answer = ok('espn', [lg({ etDate: date2, hs: 10, period: 2, clock: '5:00' })]);
    await read2();
    answer = ok('balldontlie', [lg({ provider: 'balldontlie', etDate: date2, hs: 3, period: 1, clock: '2:00' })]);
    for (let i = 0; i < 9; i++) { t += 16000; r = await read2(); }
    eq(r.row.payload.games[0].provider, 'balldontlie', 'held at most 120 s');
  });

  // ---- through the API ---------------------------------------------------------
  function fakeReq(method, url, body, headers) {
    const req = {
      method, url, headers: Object.assign({ host: 'localhost:3000' }, headers || {}), socket: {},
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
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
      writeHead(s, h) { this.statusCode = s; this.headers = Object.assign({}, h); return this; },
      end(b) { this.body = b === undefined ? '' : String(b); return this; },
      get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    };
  }
  async function call(method, path, body, headers) {
    const res = fakeRes();
    const url = new URL(path, 'http://localhost:3000');
    await handleApi(fakeReq(method, path, body, headers), res, url.pathname, url.searchParams);
    return res;
  }
  const created = [];
  try {
    async function mk(date, extra) {
      const res = await call('POST', '/api/game', board(date, extra));
      assert(res.statusCode === 201, 'create failed: ' + res.body);
      created.push(res.json.id);
      return res.json;
    }
    // The slate rows below are stamped with the real clock so a read inside 15 s never
    // reaches a provider.
    const fresh = () => Date.now();

    await check('GET: a Live board shows the slate score and writes nothing', async () => {
      const date = '2099-05-01';
      await seed(date, [lg({ etDate: date, hs: 7, as: 3 })], { at: fresh() });
      const g = await mk(date);
      const stored = JSON.stringify(await store.getGame(g.id));
      const res = await call('GET', `/api/game/${g.id}`);
      eq(res.statusCode, 200);
      eq([res.json.liveScore.a, res.json.liveScore.b, res.json.liveFeed.available], [3, 7, true]);
      eq(JSON.stringify(await store.getGame(g.id)), stored, 'the stored game is untouched');
    });
    await check('GET: the ETag changes when only the merged score changes', async () => {
      const date = '2099-05-02';
      await seed(date, [lg({ etDate: date, hs: 7, as: 3 })], { at: fresh() });
      const g = await mk(date);
      const one = await call('GET', `/api/game/${g.id}`);
      const again = await call('GET', `/api/game/${g.id}`, undefined, { 'if-none-match': one.headers.ETag });
      eq(again.statusCode, 304);
      await seed(date, [lg({ etDate: date, hs: 14, as: 3 })], { at: fresh() });
      const two = await call('GET', `/api/game/${g.id}`, undefined, { 'if-none-match': one.headers.ETag });
      eq(two.statusCode, 200);
      eq(two.json.liveScore.b, 14);
    });
    await check('GET: a quarter that completes is written once, through updateGame', async () => {
      const date = '2099-05-03';
      await seed(date, [lg({ etDate: date, state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })], { at: fresh() });
      const g = await mk(date);
      const before = (await store.getGame(g.id)).updatedAt;
      let writes = 0;
      const real = store.updateGame;
      const live = require('./lib/store.js');
      assert(live === store, 'the API uses the fs store here');
      store.updateGame = async (...a) => { writes++; return real(...a); };
      try {
        const res = await call('GET', `/api/game/${g.id}`);
        eq(res.json.results.q1, { a: 3, b: 7 });
        eq(writes, 1);
        await call('GET', `/api/game/${g.id}`);
        eq(writes, 1, 'the second read finds Q1 already filled');
      } finally { store.updateGame = real; }
      const after = await store.getGame(g.id);
      assert(after.updatedAt !== before, 'updatedAt moved');
      eq(after.results.q1, { a: 3, b: 7 });
      eq(after.liveFeed, undefined, 'response-only field is never stored');
    });
    await check('GET: a write that loses to a newer save is dropped and the newer document answers', async () => {
      const date = '2099-05-04';
      await seed(date, [lg({ etDate: date, state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })], { at: fresh() });
      const g = await mk(date);
      const real = store.updateGame;
      store.updateGame = async (id, doc, token, opts) => {
        store.updateGame = real;
        await real(id, Object.assign({}, await store.getGame(id), { description: 'host edit' }), null, opts);
        return real(id, doc, token, opts);
      };
      try {
        const res = await call('GET', `/api/game/${g.id}`);
        eq(res.statusCode, 200);
        eq(res.json.description, 'host edit');
        eq((await store.getGame(g.id)).results.q1, undefined, 'the dropped write left no Q1');
      } finally { store.updateGame = real; }
      eq((await call('GET', `/api/game/${g.id}`)).json.results.q1, { a: 3, b: 7 }, 'the next read fills it');
    });
    await check('GET: a host-entered quarter survives the feed', async () => {
      const date = '2099-05-05';
      await seed(date, [lg({ etDate: date, state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })], { at: fresh() });
      const g = await mk(date, { results: { q1: { a: 6, b: 6 } } });
      const res = await call('GET', `/api/game/${g.id}`);
      eq(res.json.results.q1, { a: 6, b: 6 });
    });
    await check('GET: with no feed the board reports it and keeps its stored score', async () => {
      const date = '2099-05-06';
      await seed(date, [], { at: fresh(), failed: true, payload: { error: 'down' } });
      const g = await mk(date);
      const res = await call('GET', `/api/game/${g.id}`);
      eq(res.json.liveFeed.available, false);
      eq(res.statusCode, 200);
    });
    await check('GET: a Manual board never reads the slate', async () => {
      const date = '2099-05-07';
      const g = await mk(date, { scoring: 'manual' });
      const res = await call('GET', `/api/game/${g.id}`);
      eq(res.json.liveFeed, undefined);
      eq(await store.getLiveSlate('nfl', date), null);
    });
    await check('PUT: response-only and feed-merged fields are not stored', async () => {
      const date = '2099-05-08';
      await seed(date, [lg({ etDate: date, hs: 7, as: 3 })], { at: fresh() });
      const g = await mk(date);
      const read = (await call('GET', `/api/game/${g.id}`)).json;
      const put = await call('PUT', `/api/game/${g.id}`, read);
      eq(put.statusCode, 200);
      const stored = await store.getGame(g.id);
      eq([stored.liveFeed, stored.liveScore], [undefined, null]);
    });
    await check('manual fallback: a tap on a Live board needs override, then holds the score; resume hands it back', async () => {
      const date = '2099-05-09';
      await seed(date, [lg({ etDate: date, hs: 7, as: 3 })], { at: fresh() });
      const g = await mk(date);
      eq((await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 3 })).statusCode, 409);
      const tap = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 3, override: true });
      eq(tap.statusCode, 200);
      eq([tap.json.liveOverride, tap.json.liveScore.a, tap.json.liveScore.b, tap.json.liveScore.manual], [true, 6, 7, true], 'starts from the feed score');
      const next = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'b', points: 1 });
      eq(next.statusCode, 200, 'later taps need no flag');
      await seed(date, [lg({ etDate: date, hs: 20, as: 20 })], { at: fresh() });
      const held = (await call('GET', `/api/game/${g.id}`)).json;
      eq([held.liveScore.a, held.liveScore.b], [6, 8], 'the feed does not overwrite the host');
      const back = await call('PATCH', `/api/game/${g.id}/score`, { op: 'resume' });
      eq([back.statusCode, back.json.liveOverride, back.json.liveScore], [200, undefined, null]);
      const live = (await call('GET', `/api/game/${g.id}`)).json;
      eq([live.liveScore.a, live.liveScore.b], [20, 20], 'the feed is back');
    });
    await check('manual fallback: resume on a Manual board is 409', async () => {
      const g = await mk('2099-05-10', { scoring: 'manual' });
      eq((await call('PATCH', `/api/game/${g.id}/score`, { op: 'resume' })).statusCode, 409);
    });
    // Review of R4a part 2: the write paths guard the slate read the way GET does, and
    // answer with the feed status so the client keeps the panel and the offline bar.
    await check('manual fallback: a tap still works when the slate cannot be read', async () => {
      const g = await mk('2099-05-14');
      const real = store.getLiveSlate;
      store.getLiveSlate = async () => { throw new Error('relation "live_slates" does not exist'); };
      const quiet = console.error;
      console.error = () => {};
      try {
        const tap = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 7, override: true });
        eq(tap.statusCode, 200);
        eq([tap.json.liveScore.a, tap.json.liveFeed.available], [7, false]);
      } finally { store.getLiveSlate = real; console.error = quiet; }
    });
    await check('payout and edit: the response carries the feed status and the row keeps no feed score', async () => {
      const date = '2099-05-15';
      await seed(date, [lg({ etDate: date, state: 'break', period: 1, clock: null, hs: 7, as: 3, hq: [7, null, null, null], aq: [3, null, null, null] })], { at: fresh() });
      const g = await mk(date);
      const edit = await call('PATCH', `/api/game/${g.id}/score`, { op: 'edit', quarter: 'q1', a: 4, b: 7, override: true });
      eq(edit.statusCode, 200);
      eq([edit.json.liveFeed.available, edit.json.liveScore.a], [true, 3], 'feed score in the response');
      eq((await store.getGame(g.id)).liveScore, null, 'not in the row');
      // An empty test grid has no winner, so a mark is refused; it must be a 409, not a 500,
      // when the slate cannot be read.
      const real = store.getLiveSlate;
      store.getLiveSlate = async () => { throw new Error('down'); };
      const quiet = console.error;
      console.error = () => {};
      try {
        eq((await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'q1', name: null, amount: 0 })).statusCode, 409);
      } finally { store.getLiveSlate = real; console.error = quiet; }
    });
    await check('manualEntry: Manual, a downed feed, or a held score open the panel; a healthy Live board does not', () => {
      eq(G.manualEntry({ scoring: 'manual' }), true);
      eq(G.manualEntry({ scoring: 'live' }), false);
      eq(G.manualEntry({ scoring: 'live', liveFeed: { available: true } }), false);
      eq(G.manualEntry({ scoring: 'live', liveFeed: { available: false } }), true);
      eq(G.manualEntry({ scoring: 'live', liveOverride: true }), true);
      eq(G.manualEntry({ scoring: 'simulation', liveFeed: { available: false } }), false);
    });
    await check('todays-games: reads the slate and makes no provider call while it is fresh', async () => {
      const date = '2099-05-11';
      const g = lg({ etDate: date });
      g.startsAt = '2099-05-11T23:30:00Z';
      await seed(date, [g], { at: fresh() });
      const res = await call('GET', `/api/todays-games?league=nfl&date=${date}`);
      eq(res.statusCode, 200);
      eq([res.json.games[0].teamA, res.json.games[0].teamB, res.json.games[0].date], ['Kansas City Chiefs', 'Philadelphia Eagles', '2099-05-11T23:30:00Z']);
    });
    await check('todays-games: 502 when no fetch has ever succeeded, [] for a real empty schedule', async () => {
      await seed('2099-05-12', [], { at: fresh(), failed: true, payload: { error: 'down' } });
      eq((await call('GET', '/api/todays-games?league=nfl&date=2099-05-12')).statusCode, 502);
      await seed('2099-05-13', [], { at: fresh() });
      const empty = await call('GET', '/api/todays-games?league=nfl&date=2099-05-13');
      eq([empty.statusCode, empty.json.games], [200, []]);
      eq((await call('GET', '/api/todays-games?league=other&date=2099-05-13')).json.games, []);
    });
  } finally {
    for (const id of created) { try { await store.deleteGame(id); } catch (e) { /* already gone */ } }
  }

  console.log(`test-slates.js: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
}

run();
