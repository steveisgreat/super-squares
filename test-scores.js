// Zero-dependency tests for the live-score provider layer (lib/scores/*).
//
// Adapters are checked against saved fixtures in test-fixtures/scores/. Files named
// *.synthetic.json were built by hand (ESPN: edited from the one captured body;
// BALLDONTLIE: from poll summaries, except bdl-in-2nd.json) and should be
// replaced with real captures when available. completedQuarters and mergeNoBackward
// decide when money-adjacent results are written, so they have the densest cases.
//
// No network: fetch is always injected. Run with:  node test-scores.js   (or: npm test)
'use strict';

const fs = require('fs');
const path = require('path');
const espn = require('./lib/scores/espn.js');
const bdl = require('./lib/scores/balldontlie.js');
const abbr = require('./lib/scores/abbr.js');
const scores = require('./lib/scores/index.js');
const TeamData = require('./public/teams.js');

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

const fixture = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures', 'scores', n), 'utf8'));
const ET = '2026-11-23';
const TEST_KEY = 'test-key-do-not-leak-123';
process.env.BALLDONTLIE_API_KEY = TEST_KEY;

// A fetch stub. `routes` maps 'espn' | 'bdl' to a body, an Error, or a function(url, init).
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const which = url.includes('espn.com') ? 'espn' : url.includes('balldontlie') ? 'bdl' : 'other';
    calls.push({ which, url, init });
    let r = routes[which];
    if (typeof r === 'function') r = await r(url, init);
    if (r instanceof Error) throw r;
    if (r && r.__status) return { ok: false, status: r.__status, text: async () => '' };
    if (r && r.__raw !== undefined) return { ok: true, status: 200, text: async () => r.__raw };
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  fn.calls = calls;
  fn.count = which => calls.filter(c => c.which === which).length;
  return fn;
}
const hangUntilAbort = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
});

const BOTH = { SCORE_PRIMARY: 'espn', SCORE_SECONDARY: 'balldontlie' };
const EXPECT = [{ homeAbbr: 'wsh', awayAbbr: 'cin' }];

function game(o) {
  const base = {
    provider: 'espn', providerGameId: '1', league: 'nfl', etDate: ET,
    home: { abbr: 'wsh', score: 0, quarters: [null, null, null, null], ot: null },
    away: { abbr: 'cin', score: 0, quarters: [null, null, null, null], ot: null },
    state: 'in', period: 1, clock: '10:00', providerUpdatedAt: null, fetchedAt: '2026-11-24T02:00:00.000Z'
  };
  const g = Object.assign(base, o);
  if (o.hs !== undefined) g.home = Object.assign({}, g.home, { score: o.hs });
  if (o.as !== undefined) g.away = Object.assign({}, g.away, { score: o.as });
  const sum = q => q.reduce((t, v) => t + (v || 0), 0);
  if (o.hq) g.home = Object.assign({}, g.home, { quarters: o.hq }, o.hs === undefined ? { score: sum(o.hq) } : {});
  if (o.aq) g.away = Object.assign({}, g.away, { quarters: o.aq }, o.as === undefined ? { score: sum(o.aq) } : {});
  if (o.aot !== undefined) g.away = Object.assign({}, g.away, { ot: o.aot });
  delete g.hs; delete g.as; delete g.hq; delete g.aq; delete g.aot;
  return g;
}

(async () => {
  // ---- team abbreviations -------------------------------------------------
  await check('every teams.js abbreviation survives both providers unchanged (both leagues)', () => {
    for (const league of ['nfl', 'nba']) {
      for (const a of abbr.knownAbbrs(league)) {
        eq(abbr.toOurAbbr(a.toUpperCase(), league), a, `${league} ${a}`);
        assert(abbr.isKnown(abbr.toOurAbbr(a.toUpperCase(), league), league), `${a} not known`);
      }
    }
    assert(abbr.knownAbbrs('nfl').length === 32, 'expected 32 NFL teams');
  });
  await check('provider aliases map to our form (WAS->wsh, JAC->jax, LA->lar)', () => {
    eq(abbr.toOurAbbr('WAS', 'nfl'), 'wsh');
    eq(abbr.toOurAbbr('WSH', 'nfl'), 'wsh');
    eq(abbr.toOurAbbr('JAC', 'nfl'), 'jax');
    eq(abbr.toOurAbbr('LA', 'nfl'), 'lar');
    eq(abbr.toOurAbbr(null, 'nfl'), null);
    eq(abbr.toOurAbbr('XYZ', 'nfl'), 'xyz');
  });
  await check('teams.js has no abbreviation the adapters would rewrite', () => {
    for (const t of TeamData.NFL_TEAMS) eq(abbr.toOurAbbr(t.abbr, 'nfl'), t.abbr, t.abbr);
  });

  // ---- ESPN normalize -----------------------------------------------------
  await check('espn: in progress (captured body) -> exact LiveGame', () => {
    const [g] = espn.normalize(fixture('espn-in-q2.json'), 'nfl', ET, 'T');
    eq(g, {
      provider: 'espn', providerGameId: '401873078', league: 'nfl', etDate: ET,
      home: { abbr: 'wsh', score: 0, quarters: [0, 0, null, null], ot: null },
      away: { abbr: 'cin', score: 10, quarters: [0, 10, null, null], ot: null },
      state: 'in', period: 2, clock: '0:54', providerUpdatedAt: null, fetchedAt: 'T'
    });
  });
  await check('espn: pre -> scores and quarters null, period and clock null', () => {
    const [g] = espn.normalize(fixture('espn-pre.synthetic.json'), 'nfl', ET, 'T');
    eq([g.state, g.period, g.clock, g.home.score, g.away.score], ['pre', null, null, null, null]);
    eq(g.home.quarters, [null, null, null, null]);
  });
  await check('espn: end of quarter and halftime -> break with period', () => {
    const [a] = espn.normalize(fixture('espn-end-q1.synthetic.json'), 'nfl', ET, 'T');
    eq([a.state, a.period], ['break', 1]);
    const [b] = espn.normalize(fixture('espn-halftime.synthetic.json'), 'nfl', ET, 'T');
    eq([b.state, b.period, b.away.score], ['break', 2, 10]);
    const [c] = espn.normalize(fixture('espn-end-q3.synthetic.json'), 'nfl', ET, 'T');
    eq([c.state, c.period], ['break', 3]);
  });
  await check('espn: final -> post with totals', () => {
    const [g] = espn.normalize(fixture('espn-final.synthetic.json'), 'nfl', ET, 'T');
    eq([g.state, g.home.score, g.away.score, g.home.ot], ['post', 14, 13, null]);
  });
  await check('espn: overtime in progress and final OT land in ot', () => {
    const [a] = espn.normalize(fixture('espn-ot.synthetic.json'), 'nfl', ET, 'T');
    eq([a.state, a.period, a.home.ot, a.away.ot], ['in', 5, 0, 0]);
    const [b] = espn.normalize(fixture('espn-final-ot.synthetic.json'), 'nfl', ET, 'T');
    eq([b.state, b.home.ot, b.away.ot, b.home.score, b.away.score], ['post', 0, 3, 17, 20]);
  });
  await check('espn: postponed (state post, not completed) is not reported as final', () => {
    const body = fixture('espn-pre.synthetic.json');
    body.events[0].competitions[0].status.type = { name: 'STATUS_POSTPONED', state: 'post', completed: false };
    eq(espn.normalize(body, 'nfl', ET, 'T')[0].state, 'pre');
  });
  await check('espn: not a scoreboard throws; malformed event is skipped', () => {
    let threw = false;
    try { espn.normalize({ nope: 1 }, 'nfl', ET); } catch (e) { threw = true; }
    assert(threw, 'expected throw');
    eq(espn.normalize({ events: [{ id: 1 }] }, 'nfl', ET).length, 0);
  });

  // ---- ESPN fetchSlate ----------------------------------------------------
  await check('espn fetchSlate: one request, correct URL, ok', async () => {
    const f = stubFetch({ espn: fixture('espn-in-q2.json') });
    const r = await espn.fetchSlate('nfl', ET, { fetch: f });
    assert(r.ok && r.games.length === 1 && r.error === null, JSON.stringify(r));
    eq(f.calls.length, 1);
    assert(f.calls[0].url.endsWith('/football/nfl/scoreboard?dates=20261123'), f.calls[0].url);
  });
  await check('espn fetchSlate: HTTP 429, bad JSON, timeout, network error all return ok:false', async () => {
    eq((await espn.fetchSlate('nfl', ET, { fetch: stubFetch({ espn: { __status: 429 } }) })).error, 'HTTP 429');
    eq((await espn.fetchSlate('nfl', ET, { fetch: stubFetch({ espn: { __raw: '<html>' } }) })).error, 'bad JSON');
    const t = await espn.fetchSlate('nfl', ET, { fetch: stubFetch({ espn: hangUntilAbort }), timeoutMs: 30 });
    eq([t.ok, t.error], [false, 'timeout']);
    const n = await espn.fetchSlate('nfl', ET, { fetch: stubFetch({ espn: new Error('ECONNRESET') }) });
    assert(!n.ok && /ECONNRESET/.test(n.error), n.error);
    const w = await espn.fetchSlate('nfl', ET, { fetch: stubFetch({ espn: { wrong: true } }) });
    assert(!w.ok && /unexpected response/.test(w.error), w.error);
  });

  // ---- BALLDONTLIE status parsing ----------------------------------------
  await check('bdl parseStatus: every known text', () => {
    const p = bdl.parseStatus;
    eq(p('14:54 - 1st', 'in_progress', true), { state: 'in', period: 1, clock: '14:54' });
    eq(p('0:54 - 2nd', 'in_progress', true), { state: 'in', period: 2, clock: '0:54' });
    eq(p('End of 1st', 'in_progress', true), { state: 'break', period: 1, clock: '0:00' });
    eq(p('End of 3rd', 'in_progress', true), { state: 'break', period: 3, clock: '0:00' });
    eq(p('Halftime', 'in_progress', true), { state: 'break', period: 2, clock: '0:00' });
    eq(p('Final', 'final', true), { state: 'post', period: null, clock: null });
    eq(p('Final/OT', 'final', true), { state: 'post', period: null, clock: null });
    eq(p('8:12 - OT', 'in_progress', true), { state: 'in', period: 5, clock: '8:12' });
    eq(p('3:00 - 2OT', 'in_progress', true), { state: 'in', period: 6, clock: '3:00' });
    eq(p('End of OT', 'in_progress', true), { state: 'break', period: 5, clock: '0:00' });
    eq(p('11/23 - 8:15 PM EST', 'scheduled', false), { state: 'pre', period: null, clock: null });
  });
  await check('bdl parseStatus: unknown text never invents break or post', () => {
    const p = bdl.parseStatus;
    eq(p('Delayed - Lightning', 'in_progress', true), { state: 'in', period: null, clock: null });
    eq(p('???', 'scheduled', false), { state: 'pre', period: null, clock: null });
    eq(p('???', undefined, true), { state: 'in', period: null, clock: null });
    eq(p('???', undefined, false), { state: 'pre', period: null, clock: null });
    eq(p(null, 'in_progress', true), { state: 'in', period: null, clock: null });
    eq(p('End of Q9 ish', 'in_progress', true).state, 'in');
  });

  // ---- BALLDONTLIE normalize ---------------------------------------------
  await check('bdl: pre keeps null scores; other-ET-date game (MIN@SF) filtered out', () => {
    const gs = bdl.normalize(fixture('bdl-pre.synthetic.json'), 'nfl', ET, 'T');
    eq(gs.length, 1);
    eq([gs[0].away.abbr, gs[0].home.abbr, gs[0].state, gs[0].home.score, gs[0].away.score], ['cin', 'wsh', 'pre', null, null]);
    eq(gs[0].home.quarters, [null, null, null, null]);
    eq(bdl.normalize(fixture('bdl-pre.synthetic.json'), 'nfl', '2026-11-22', 'T').map(g => g.home.abbr), ['sf']);
  });
  await check('bdl: in progress, end of quarter, halftime, end of Q3', () => {
    const one = n => bdl.normalize(fixture(n), 'nfl', ET, 'T')[0];
    eq([one('bdl-in-1st.synthetic.json').state, one('bdl-in-1st.synthetic.json').period, one('bdl-in-1st.synthetic.json').clock], ['in', 1, '14:54']);
    eq([one('bdl-end-q1.synthetic.json').state, one('bdl-end-q1.synthetic.json').period], ['break', 1]);
    eq([one('bdl-halftime.synthetic.json').state, one('bdl-halftime.synthetic.json').period], ['break', 2]);
    eq([one('bdl-end-q3.synthetic.json').state, one('bdl-end-q3.synthetic.json').period], ['break', 3]);
    const mid = one('bdl-in-2nd.json');
    eq([mid.away.score, mid.home.score, mid.away.quarters, mid.home.quarters], [10, 0, [0, 10, null, null], [0, 0, null, null]]);
    eq(mid.providerUpdatedAt, '2026-11-24T02:35:00.506Z');
  });
  await check('bdl: final, overtime, final OT', () => {
    const one = n => bdl.normalize(fixture(n), 'nfl', ET, 'T')[0];
    const f = one('bdl-final.synthetic.json');
    eq([f.state, f.home.score, f.away.score, f.home.ot], ['post', 14, 13, null]);
    const o = one('bdl-ot.synthetic.json');
    eq([o.state, o.period, o.home.ot], ['in', 5, 0]);
    const fo = one('bdl-final-ot.synthetic.json');
    eq([fo.state, fo.away.ot, fo.away.score], ['post', 3, 20]);
  });
  await check('bdl: unknown status text degrades to null period and clock, state in', () => {
    const g = bdl.normalize(fixture('bdl-unknown-status.synthetic.json'), 'nfl', ET, 'T')[0];
    eq([g.state, g.period, g.clock, g.away.score], ['in', null, null, 10]);
  });
  await check('bdl: a null score in a started game becomes 0', () => {
    const body = fixture('bdl-in-1st.synthetic.json');
    body.data[1].home_team_score = null;
    eq(bdl.normalize(body, 'nfl', ET, 'T')[0].home.score, 0);
  });
  await check('bdl: not a games list throws', () => {
    let threw = false;
    try { bdl.normalize({ events: [] }, 'nfl', ET); } catch (e) { threw = true; }
    assert(threw, 'expected throw');
  });

  // ---- BALLDONTLIE fetchSlate --------------------------------------------
  await check('bdl fetchSlate: one request asking both UTC dates, key in header only', async () => {
    const f = stubFetch({ bdl: fixture('bdl-in-2nd.json') });
    const r = await bdl.fetchSlate('nfl', ET, { fetch: f });
    assert(r.ok && r.games.length === 1, JSON.stringify(r));
    eq(f.calls.length, 1);
    const url = f.calls[0].url;
    assert(url.includes('dates[]=2026-11-23') && url.includes('dates[]=2026-11-24'), url);
    assert(!url.includes(TEST_KEY), 'key in URL');
    eq(f.calls[0].init.headers.Authorization, TEST_KEY);
    assert(!JSON.stringify(r).includes(TEST_KEY), 'key in result');
  });
  await check('bdl fetchSlate: another league returns ok:false without a call', async () => {
    const f = stubFetch({ bdl: fixture('bdl-pre.synthetic.json') });
    const r = await bdl.fetchSlate('nba', ET, { fetch: f });
    eq([r.ok, f.calls.length], [false, 0]);
  });
  await check('bdl fetchSlate: no key returns ok:false without a call', async () => {
    const f = stubFetch({ bdl: fixture('bdl-pre.synthetic.json') });
    const saved = process.env.BALLDONTLIE_API_KEY;
    delete process.env.BALLDONTLIE_API_KEY;
    try {
      const r = await bdl.fetchSlate('nfl', ET, { fetch: f });
      eq([r.ok, f.calls.length], [false, 0]);
    } finally { process.env.BALLDONTLIE_API_KEY = saved; }
  });
  await check('bdl fetchSlate: 429, bad JSON, timeout; the key never appears in an error', async () => {
    eq((await bdl.fetchSlate('nfl', ET, { fetch: stubFetch({ bdl: { __status: 429 } }) })).error, 'HTTP 429');
    eq((await bdl.fetchSlate('nfl', ET, { fetch: stubFetch({ bdl: { __raw: 'nope' } }) })).error, 'bad JSON');
    const t = await bdl.fetchSlate('nfl', ET, { fetch: stubFetch({ bdl: hangUntilAbort }), timeoutMs: 30 });
    eq([t.ok, t.error], [false, 'timeout']);
    const leaky = await bdl.fetchSlate('nfl', ET, { fetch: stubFetch({ bdl: new Error(`bad header ${TEST_KEY}`) }) });
    assert(!leaky.ok && !leaky.error.includes(TEST_KEY), leaky.error);
  });

  // ---- config -------------------------------------------------------------
  await check('getConfig: defaults per decision 001 section 2, read at call time', () => {
    eq([scores.getConfig({}).primary.name, scores.getConfig({}).secondary], ['espn', null]);
    eq(scores.getConfig({ VERCEL: '1' }), { primary: null, secondary: null });
    const c = scores.getConfig(BOTH);
    eq([c.primary.name, c.secondary.name], ['espn', 'balldontlie']);
    eq(scores.getConfig({ SCORE_PRIMARY: 'balldontlie', SCORE_SECONDARY: 'espn' }).primary.name, 'balldontlie');
    eq(scores.getConfig({ SCORE_PRIMARY: 'espn', SCORE_SECONDARY: 'espn' }).secondary, null);
    eq(scores.getConfig({ SCORE_PRIMARY: 'bogus' }).primary, null);
    process.env.SCORE_PRIMARY = 'balldontlie';
    try { eq(scores.getConfig().primary.name, 'balldontlie'); } finally { delete process.env.SCORE_PRIMARY; }
  });

  // ---- failover -----------------------------------------------------------
  await check('failover: healthy primary with every expected game never calls the secondary', async () => {
    const f = stubFetch({ espn: fixture('espn-in-q2.json'), bdl: fixture('bdl-in-2nd.json') });
    const r = await scores.fetchWithFailover('nfl', ET, { env: BOTH, fetch: f, expect: EXPECT });
    eq([r.ok, r.provider, f.count('espn'), f.count('bdl')], [true, 'espn', 1, 0]);
    eq(r.missing, []);
  });
  await check('failover: primary HTTP 429 -> secondary used', async () => {
    const f = stubFetch({ espn: { __status: 429 }, bdl: fixture('bdl-in-2nd.json') });
    const r = await scores.fetchWithFailover('nfl', ET, { env: BOTH, fetch: f, expect: EXPECT });
    eq([r.ok, r.provider, f.count('bdl')], [true, 'balldontlie', 1]);
    eq(r.tried.map(t => [t.provider, t.ok]), [['espn', false], ['balldontlie', true]]);
  });
  await check('failover: primary timeout and bad JSON -> secondary used', async () => {
    const a = await scores.fetchWithFailover('nfl', ET, {
      env: BOTH, timeoutMs: 30, fetch: stubFetch({ espn: hangUntilAbort, bdl: fixture('bdl-in-2nd.json') })
    });
    eq([a.ok, a.provider, a.tried[0].error], [true, 'balldontlie', 'timeout']);
    const b = await scores.fetchWithFailover('nfl', ET, {
      env: BOTH, fetch: stubFetch({ espn: { __raw: '{' }, bdl: fixture('bdl-in-2nd.json') })
    });
    eq([b.ok, b.provider, b.tried[0].error], [true, 'balldontlie', 'bad JSON']);
  });
  await check('failover: primary lacks an expected game -> secondary, if it has it', async () => {
    const f = stubFetch({ espn: { events: [] }, bdl: fixture('bdl-in-2nd.json') });
    const r = await scores.fetchWithFailover('nfl', ET, { env: BOTH, fetch: f, expect: EXPECT });
    eq([r.provider, r.games.length, r.missing], ['balldontlie', 1, []]);
  });
  await check('failover: both lack the game -> primary slate kept, missing reported', async () => {
    const f = stubFetch({ espn: { events: [] }, bdl: { data: [] } });
    const r = await scores.fetchWithFailover('nfl', ET, { env: BOTH, fetch: f, expect: EXPECT });
    eq([r.ok, r.provider, r.missing.length, f.count('bdl')], [true, 'espn', 1, 1]);
  });
  await check('failover: both fail -> ok:false with both errors', async () => {
    const f = stubFetch({ espn: { __status: 503 }, bdl: { __status: 429 } });
    const r = await scores.fetchWithFailover('nfl', ET, { env: BOTH, fetch: f });
    eq(r.ok, false);
    assert(/espn: HTTP 503/.test(r.error) && /balldontlie: HTTP 429/.test(r.error), r.error);
  });
  await check('failover: no secondary configured -> primary failure returned, one call', async () => {
    const f = stubFetch({ espn: { __status: 500 }, bdl: fixture('bdl-in-2nd.json') });
    const r = await scores.fetchWithFailover('nfl', ET, { env: { SCORE_PRIMARY: 'espn' }, fetch: f });
    eq([r.ok, f.calls.length], [false, 1]);
  });
  await check('failover: nothing configured -> ok:false, no calls', async () => {
    const f = stubFetch({});
    const r = await scores.fetchWithFailover('nfl', ET, { env: { VERCEL: '1' }, fetch: f });
    eq([r.ok, f.calls.length], [false, 0]);
  });
  await check('failover: swapped roles work (balldontlie primary)', async () => {
    const f = stubFetch({ espn: fixture('espn-in-q2.json'), bdl: fixture('bdl-in-2nd.json') });
    const r = await scores.fetchWithFailover('nfl', ET, {
      env: { SCORE_PRIMARY: 'balldontlie', SCORE_SECONDARY: 'espn' }, fetch: f, expect: EXPECT
    });
    eq([r.provider, f.count('espn')], ['balldontlie', 0]);
  });

  // ---- completedQuarters (test-first, money-adjacent) ---------------------
  await check('completedQuarters: pre and unknown input -> nothing', () => {
    eq(scores.completedQuarters(game({ state: 'pre', period: null, clock: null })), {});
    eq(scores.completedQuarters(null), {});
  });
  await check('completedQuarters: in Q1 and Q2 -> nothing / only Q1', () => {
    eq(scores.completedQuarters(game({ state: 'in', period: 1, hq: [3, null, null, null], aq: [0, null, null, null] })), {});
    eq(scores.completedQuarters(game({ state: 'in', period: 2, hq: [3, 0, null, null], aq: [0, 7, null, null] })),
      { q1: { home: 3, away: 0 } });
  });
  await check('completedQuarters: end of Q1 (break period 1) -> Q1 at once', () => {
    eq(scores.completedQuarters(game({ state: 'break', period: 1, hq: [0, null, null, null], aq: [0, null, null, null] })),
      { q1: { home: 0, away: 0 } });
  });
  await check('completedQuarters: halftime -> Q1 and Q2 cumulative', () => {
    eq(scores.completedQuarters(game({ state: 'break', period: 2, hq: [0, 0, null, null], aq: [0, 10, null, null] })),
      { q1: { home: 0, away: 0 }, q2: { home: 0, away: 10 } });
  });
  await check('completedQuarters: end of Q3 -> Q1..Q3 cumulative', () => {
    eq(scores.completedQuarters(game({ state: 'break', period: 3, hq: [0, 0, 7, null], aq: [0, 10, 3, null] })),
      { q1: { home: 0, away: 0 }, q2: { home: 0, away: 10 }, q3: { home: 7, away: 13 } });
  });
  await check('completedQuarters: end of Q4 break is not final', () => {
    const r = scores.completedQuarters(game({ state: 'break', period: 4, hq: [0, 0, 7, 7], aq: [0, 10, 3, 3] }));
    assert(!r.final && r.q3, JSON.stringify(r));
  });
  await check('completedQuarters: final includes q1-q3 and the total', () => {
    eq(scores.completedQuarters(game({ state: 'post', period: 4, hs: 14, as: 13, hq: [0, 0, 7, 7], aq: [0, 10, 3, 0] })),
      { q1: { home: 0, away: 0 }, q2: { home: 0, away: 10 }, q3: { home: 7, away: 13 }, final: { home: 14, away: 13 } });
  });
  await check('completedQuarters: final with OT uses the total score, not q1-q4', () => {
    const r = scores.completedQuarters(game({
      state: 'post', period: 5, hs: 17, as: 20, hq: [0, 7, 7, 3], aq: [3, 3, 7, 4], aot: 3
    }));
    eq(r.final, { home: 17, away: 20 });
    eq(r.q3, { home: 14, away: 13 });
  });
  await check('completedQuarters: a missing value withholds that quarter and later ones', () => {
    const r = scores.completedQuarters(game({ state: 'break', period: 3, hq: [0, null, 7, null], aq: [0, 10, 3, null] }));
    eq(r, { q1: { home: 0, away: 0 } });
  });
  await check('completedQuarters: post with a null total withholds final only', () => {
    const r = scores.completedQuarters(game({ state: 'post', period: 4, hs: null, as: null, hq: [0, 0, 7, 7], aq: [0, 10, 3, 0] }));
    assert(r.q3 && !r.final, JSON.stringify(r));
  });
  await check('completedQuarters: no period -> fallback on the next quarter field', () => {
    eq(scores.completedQuarters(game({ state: 'in', period: null, clock: null, hq: [0, 0, null, null], aq: [0, 10, null, null] })),
      { q1: { home: 0, away: 0 } });
    eq(scores.completedQuarters(game({ state: 'in', period: null, clock: null, hq: [0, null, null, null], aq: [0, null, null, null] })), {});
  });
  await check('completedQuarters: quarters that do not add up to the score settle nothing yet', () => {
    // The total moved before the quarter field did: q2 here would be short by 7.
    eq(scores.completedQuarters(game({ state: 'break', period: 2, hs: 7, as: 10, hq: [0, 0, null, null], aq: [0, 10, null, null] })), {});
    eq(scores.completedQuarters(game({ state: 'post', period: 4, hs: 14, as: 13, hq: [0, 0, 7, 0], aq: [0, 10, 3, 0] })),
      { final: { home: 14, away: 13 } });
  });
  await check('completedQuarters: a game that ended with no scores never pays a 0-0 final', () => {
    const body = (status, st) => ({ data: [{
      id: 1, date: '2026-11-24T01:15:00.000Z', status, status_state: st,
      home_team: { abbreviation: 'WSH' }, visitor_team: { abbreviation: 'CIN' }, home_team_score: null, visitor_team_score: null
    }] });
    for (const [status, st] of [['Canceled', 'final'], ['Postponed', 'final'], ['Final', 'final']]) {
      const g = bdl.normalize(body(status, st), 'nfl', ET, 'T')[0];
      eq(scores.completedQuarters(g), {}, status);
    }
    const e = fixture('espn-final.synthetic.json');
    e.events[0].competitions[0].competitors.forEach(c => { delete c.score; });
    assert(!scores.completedQuarters(espn.normalize(e, 'nfl', ET, 'T')[0]).final, 'espn final without scores');
  });
  await check('bdl: canceled, postponed or suspended text is never post, even with scores', () => {
    for (const text of ['Canceled', 'Cancelled', 'Postponed', 'Suspended', 'Delayed', 'Some new text']) {
      assert(bdl.parseStatus(text, 'final', true).state !== 'post', text);
    }
    for (const text of ['Final', 'Final/OT', 'Final OT', 'Final/2OT', 'Final - OT']) {
      eq(bdl.parseStatus(text, 'final', true).state, 'post', text);
    }
  });
  await check('espn: canceled is never final, even if flagged completed', () => {
    const e = fixture('espn-final.synthetic.json');
    e.events[0].competitions[0].status.type = { name: 'STATUS_CANCELED', state: 'post', completed: true };
    eq(scores.completedQuarters(espn.normalize(e, 'nfl', ET, 'T')[0]), {});
  });
  await check('bdl: a zero-filled canceled or postponed game settles nothing', () => {
    for (const text of ['Canceled', 'Cancelled', 'Postponed']) {
      const g = { id: 1, date: '2026-11-24T01:15:00.000Z', status: text, status_state: 'final', home_team: { abbreviation: 'WSH' }, visitor_team: { abbreviation: 'CIN' } };
      for (const s of ['home', 'visitor']) for (const k of ['score', 'q1', 'q2', 'q3', 'q4']) g[s + '_team_' + k] = 0;
      eq(scores.completedQuarters(bdl.normalize({ data: [g] }, 'nfl', ET, 'T')[0]), {}, text);
    }
  });
  await check('merge: a failed fetch keeps the stored slate', () => {
    const prev = { provider: 'espn', games: [game({})] };
    eq(scores.mergeNoBackward(prev, { provider: null, games: [] }, Date.now()), prev);
    eq(scores.mergeNoBackward(prev, null, Date.now()), prev);
  });
  await check('completedQuarters: from real normalized fixtures', () => {
    const g = bdl.normalize(fixture('bdl-end-q1.synthetic.json'), 'nfl', ET, 'T')[0];
    eq(scores.completedQuarters(g), { q1: { home: 0, away: 0 } });
    const e = espn.normalize(fixture('espn-halftime.synthetic.json'), 'nfl', ET, 'T')[0];
    eq(scores.completedQuarters(e), { q1: { home: 0, away: 0 }, q2: { home: 0, away: 10 } });
    const f = espn.normalize(fixture('espn-final-ot.synthetic.json'), 'nfl', ET, 'T')[0];
    eq(scores.completedQuarters(f).final, { home: 17, away: 20 });
  });

  // ---- mergeNoBackward (test-first, money-adjacent) -----------------------
  const T0 = Date.parse('2026-11-24T02:40:00.000Z');
  const slate = (provider, games, extra) => Object.assign({ provider, games }, extra || {});
  const espnLead = game({ provider: 'espn', state: 'in', period: 2, clock: '0:54', hs: 0, as: 10 });
  const bdlBehind = game({ provider: 'balldontlie', state: 'in', period: 1, clock: '1:01', hs: 0, as: 3 });

  await check('merge: no previous slate -> next as is', () => {
    eq(scores.mergeNoBackward(null, slate('espn', [espnLead]), T0), slate('espn', [espnLead]));
  });
  await check('merge: same provider, lower score is a real correction and is accepted', () => {
    const corrected = game({ provider: 'espn', state: 'in', period: 2, clock: '0:50', hs: 0, as: 7 });
    const out = scores.mergeNoBackward(slate('espn', [espnLead]), slate('espn', [corrected]), T0);
    eq(out.games[0].away.score, 7);
    eq(out.switchedAt, undefined);
  });
  await check('merge: switch to a provider that is behind keeps the stored game and stamps switchedAt', () => {
    const out = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [bdlBehind]), T0);
    eq(out.games[0].provider, 'espn');
    eq(out.games[0].away.score, 10);
    eq(out.provider, 'balldontlie');
    eq(out.switchedAt, new Date(T0).toISOString());
  });
  await check('merge: held game is released as soon as the new provider catches up', () => {
    const held = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [bdlBehind]), T0);
    const caught = game({ provider: 'balldontlie', state: 'in', period: 2, clock: '0:54', hs: 0, as: 10 });
    const out = scores.mergeNoBackward(held, slate('balldontlie', [caught]), T0 + 15000);
    eq(out.games[0].provider, 'balldontlie');
    eq(out.switchedAt, undefined);
  });
  await check('merge: still behind inside 120 s -> still held, switchedAt carried unchanged', () => {
    const held = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [bdlBehind]), T0);
    const out = scores.mergeNoBackward(held, slate('balldontlie', [bdlBehind]), T0 + 119000);
    eq(out.games[0].provider, 'espn');
    eq(out.switchedAt, new Date(T0).toISOString());
  });
  await check('merge: the 120 s cap releases a game that never caught up', () => {
    const held = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [bdlBehind]), T0);
    const out = scores.mergeNoBackward(held, slate('balldontlie', [bdlBehind]), T0 + 120000);
    eq(out.games[0].provider, 'balldontlie');
    eq(out.games[0].away.score, 3);
    eq(out.switchedAt, undefined);
  });
  await check('merge: cap works from stored state alone (stateless instances), Date or ms for now', () => {
    const stored = slate('balldontlie', [espnLead], { switchedAt: new Date(T0).toISOString() });
    const out = scores.mergeNoBackward(stored, slate('balldontlie', [bdlBehind]), new Date(T0 + 130000));
    eq(out.games[0].provider, 'balldontlie');
  });
  await check('merge: a final from the new provider is taken at once', () => {
    const fin = game({ provider: 'balldontlie', state: 'post', period: null, clock: null, hs: 14, as: 13 });
    const out = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [fin]), T0);
    eq(out.games[0].state, 'post');
  });
  await check('merge: new provider with unknown period and clock is held until the cap', () => {
    const blind = game({ provider: 'balldontlie', state: 'in', period: null, clock: null, hs: 0, as: 10 });
    const first = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [blind]), T0);
    eq(first.games[0].provider, 'espn');
    const later = scores.mergeNoBackward(first, slate('balldontlie', [blind]), T0 + 121000);
    eq(later.games[0].provider, 'balldontlie');
  });
  await check('merge: held per game, not per slate', () => {
    const other = game({ providerGameId: '2', home: { abbr: 'dal', score: 0, quarters: [null, null, null, null], ot: null },
      away: { abbr: 'phi', score: 0, quarters: [null, null, null, null], ot: null }, provider: 'espn', state: 'in', period: 1, clock: '5:00' });
    const otherNew = Object.assign({}, other, { provider: 'balldontlie', period: 1, clock: '4:30' });
    const out = scores.mergeNoBackward(
      slate('espn', [espnLead, other]), slate('balldontlie', [bdlBehind, otherNew]), T0);
    eq(out.games.map(g => g.provider), ['espn', 'balldontlie']);
    eq(out.switchedAt, new Date(T0).toISOString());
  });
  await check('merge: a stored game the new provider does not list is kept inside the window only', () => {
    const inWin = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', []), T0);
    eq(inWin.games.length, 1);
    const after = scores.mergeNoBackward(inWin, slate('balldontlie', []), T0 + 121000);
    eq(after.games.length, 0);
  });
  await check('merge: switching back to the original provider is a new switch', () => {
    const a = scores.mergeNoBackward(slate('espn', [espnLead]), slate('balldontlie', [bdlBehind]), T0);
    const espnAhead = game({ provider: 'espn', state: 'in', period: 2, clock: '0:40', hs: 0, as: 10 });
    const b = scores.mergeNoBackward(a, slate('espn', [espnAhead]), T0 + 20000);
    eq(b.games[0].provider, 'espn');
    eq(b.games[0].clock, '0:40');
  });
  await check('merge: does not mutate its inputs', () => {
    const prev = slate('espn', [espnLead]);
    const next = slate('balldontlie', [bdlBehind]);
    const before = JSON.stringify([prev, next]);
    scores.mergeNoBackward(prev, next, T0);
    eq(JSON.stringify([prev, next]), before);
  });

  if (failures.length) {
    console.error(`${failures.length} failed, ${passed} passed\n`);
    failures.forEach(f => console.error(`  FAIL ${f}`));
    process.exit(1);
  }
  console.log(`${passed} passed`);
})();
