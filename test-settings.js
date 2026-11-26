// Editing a game's settings (R40, decision 026): GameLogic.gameUnderWay, settingsStage,
// applySettingsOp (edit, lock) and guardPut, then the routes (PATCH /api/game/:id/settings and the
// guards on PUT) in every auth mode, on the fs store and, when DATABASE_URL is set, on Postgres.
// Money logic, so test-first. The clock and the draw are injected, so nothing sleeps.
//
// Run with:  node test-settings.js   (or: npm test)
'use strict';

const PG_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const crypto = require('crypto');
const GL = require('./public/compute.js');
const TeamData = require('./public/teams.js');
const auth = require('./lib/auth.js');
const store = require('./lib/store.js');
const { handleApi } = require('./lib/api.js');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2027, 1, 14, 20, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const SOON = iso(NOW + HOUR);   // kickoff still to come
const PAST = iso(NOW - HOUR);   // kickoff gone by
const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const teamKey = (name, league) => { const m = TeamData.findTeamMeta(name, league); return m ? m.abbr : null; };

// ---------- fixtures ----------

// Every square sold to Ann (50), Bob (30) and Cy (20): a $1,000 pot at $10.
function squares() {
  return Array.from({ length: 100 }, (_, i) => ({ name: i < 50 ? 'Ann' : i < 80 ? 'Bob' : 'Cy', at: 1000 + i }));
}
const FINAL = { q1: { a: 7, b: 3 }, q2: { a: 14, b: 10 }, q3: { a: 21, b: 17 }, final: { a: 24, b: 20 } };

// stage: picking | locked | underWay | line3 (under way, Q1 ended) | over
function board(stage, extra) {
  const g = {
    id: 'g', league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles', description: 'Office pool',
    teamAColor: null, teamBColor: null, squarePrice: 10, payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    scoring: 'manual', pickMode: 'both', status: 'started', squares: squares(),
    players: { Ann: { paid: false, color: '#112233' }, Bob: { paid: false, color: '#223344' }, Cy: { paid: false, color: '#334455' } },
    axisX: IDENTITY.slice(), axisY: IDENTITY.slice(), results: {}, kickoffTime: SOON,
    autoCutoffEnabled: false, autoCutoffTime: null
  };
  if (stage === 'picking') Object.assign(g, { status: 'picking', axisX: null, axisY: null });
  if (stage === 'underWay' || stage === 'line3') g.kickoffTime = PAST;
  if (stage === 'line3') g.results = { q1: clone(FINAL.q1) };
  if (stage === 'over') Object.assign(g, { status: 'finished', kickoffTime: PAST, results: clone(FINAL) });
  return Object.assign(g, extra);
}
const live = (stage, extra) => board(stage, Object.assign({ scoring: 'live' }, extra));
const STAGES = ['picking', 'locked', 'underWay', 'line3', 'over'];

const CTX = { now: NOW, feed: null, pick: () => 0, teamKey };
const run = (g, op, ctx) => {
  const before = JSON.stringify(g);
  const r = GL.applySettingsOp(g, op, Object.assign({}, CTX, ctx));
  eq(JSON.stringify(g), before, 'the input was changed');
  if (r.game) eq(GL.validateGame(r.game), null, 'valid afterwards');
  return r;
};
// The values on the host's screen were the stored ones.
const sawOf = (g, set) => {
  const saw = {};
  Object.keys(set).forEach(k => {
    if (k === 'swap') { saw.teamA = g.teamA; saw.teamB = g.teamB; } else saw[k] = k === 'scoring' ? GL.scoringMode(g) : (g[k] === undefined ? null : g[k]);
  });
  return saw;
};
const edit = (g, set, more, ctx) => run(g, Object.assign({ op: 'edit', set, saw: sawOf(g, set) }, more), ctx);
const ok = (r) => { assert(!r.error, `refused: ${r.error}`); return r; };
const no = (r, code) => { eq([!!r.error, r.code, r.game], [true, code, undefined], `→ ${r.error || 'allowed'}`); return r; };

// ---------- gameUnderWay ----------

check('gameUnderWay: a quarter result or a paid-out record means under way, in every mode', () => {
  for (const scoring of ['manual', 'live', 'simulation']) {
    eq(GL.gameUnderWay(board('locked', { scoring, results: { q1: { a: 0, b: 0 } } }), NOW, null), true, `${scoring} result`);
    eq(GL.gameUnderWay(board('locked', { scoring, paidOut: { q1: { name: 'Ann', amount: 250 } } }), NOW, null), true, `${scoring} paid out`);
  }
});

check('gameUnderWay: Simulation starts at the lock', () => {
  eq(GL.gameUnderWay(board('locked', { scoring: 'simulation', simulation: true }), NOW, null), true, 'locked');
  eq(GL.gameUnderWay(board('picking', { scoring: 'simulation', simulation: true }), NOW, null), false, 'picking');
});

check('gameUnderWay: Manual starts at a score, a later period or the kickoff time; with no kickoff, at the first score', () => {
  const m = (extra) => GL.gameUnderWay(board('locked', extra), NOW, null);
  eq(m({}), false, 'kickoff to come');
  eq(m({ kickoffTime: PAST }), true, 'kickoff gone by');
  eq(m({ kickoffTime: null }), false, 'no kickoff, no score');
  eq(m({ kickoffTime: null, liveScore: { a: 3, b: 0, period: 1, manual: true } }), true, 'a score');
  eq(m({ kickoffTime: null, liveScore: { a: 0, b: 0, period: 2, manual: true } }), true, 'a later period');
  eq(m({ kickoffTime: null, liveScore: { a: 0, b: 0, period: 1, manual: true } }), false, '0-0 in Q1');
  eq(m({ kickoffTime: '2027-02-14T12:00' }), false, 'a bare local kickoff is not read by the server');
});

check('gameUnderWay: Live follows the feed, and the kickoff when the feed says nothing useful', () => {
  const l = (extra, feed) => GL.gameUnderWay(live('locked', extra), NOW, feed);
  for (const state of ['in', 'break', 'post']) eq(l({}, { state, at: NOW - MIN }), true, `feed ${state} before kickoff`);
  eq(l({}, { state: 'pre', at: NOW - MIN }), false, 'not started, kickoff to come');
  eq(l({ kickoffTime: PAST }, { state: 'pre', at: NOW - MIN }), false, 'postponed: not started, read after kickoff');
  eq(l({ kickoffTime: PAST }, { state: 'pre', at: NOW - 2 * HOUR }), true, 'stale: read before kickoff');
  eq(l({ kickoffTime: PAST }, null), true, 'feed down or game not matched: the kickoff decides');
  eq(l({ kickoffTime: PAST }, { state: 'in', at: NOW, available: false }), true, 'an unavailable feed is ignored');
  eq(l({}, { state: 'in', at: NOW, available: false }), false, 'an unavailable feed is ignored, kickoff to come');
  eq(l({}, null), false, 'no feed, kickoff to come');
  eq(l({ liveOverride: true, liveScore: { a: 3, b: 0, period: 1, manual: true } }, null), true, 'a host-held score past 0-0');
  eq(l({ liveOverride: true, liveScore: { a: 0, b: 0, period: 1, manual: true } }, null), false, 'a host-held 0-0');
});

check('settingsStage and firstQuarterEnded', () => {
  eq(STAGES.map(s => GL.settingsStage(board(s), NOW, null)), ['picking', 'locked', 'underWay', 'underWay', 'over'], 'stages');
  eq(GL.settingsStage(board('picking', { status: 'setup' }), NOW, null), 'picking', 'setup');
  eq(STAGES.map(s => GL.firstQuarterEnded(board(s))), [false, false, false, true, true], 'line 3');
  eq(GL.firstQuarterEnded(board('underWay', { paidOut: { q1: { name: 'Ann', amount: 250 } } })), true, 'a paid-out record');
});

// ---------- applySettingsOp: edit, every row at every stage ----------

// Expected per stage [picking, locked, underWay, line3, over]: 'free', 'blocked' or a warning code.
const F = 'free';
const X = 'blocked';
const TABLE = [
  ['description', board, { description: 'Big Game party' }, [F, F, F, F, F]],
  ['colors', board, { teamAColor: '#aa0000', teamBColor: '#0000aa' }, [F, F, F, F, F]],
  ['team spelling (Manual)', board, { teamA: 'CHIEFS' }, [F, F, F, F, F]],
  ['a different team (Manual)', board, { teamA: 'Bills' }, [F, 'team', 'team', 'team', 'team']],
  ['team spelling (Live)', live, { teamA: 'Kansas City Chiefs' }, [F, F, F, F, F]],
  ['a different team (Live)', live, { teamA: 'Bills' }, [F, 'liveGame', X, X, X]],
  ['rows and columns swapped', board, { swap: true }, [F, 'swap', X, X, X]],
  ['league (Live)', live, { league: 'nba', teamA: 'Lakers', teamB: 'Celtics' }, [F, 'liveGame', X, X, X]],
  ['date (Live)', live, { gameDate: '2027-02-15' }, [F, 'liveGame', X, X, X]],
  ['kickoff (Live)', live, { kickoffTime: iso(NOW + 3 * HOUR) }, [F, 'liveGame', X, X, X]],
  ['league (Manual)', board, { league: 'other' }, [F, F, F, F, F]],
  ['date (Manual)', board, { gameDate: '2027-02-15' }, [F, F, F, F, F]],
  ['kickoff (Manual)', board, { kickoffTime: iso(NOW - 30 * MIN) }, [F, F, 'kickoff', X, F]],
  ['auto cutoff', board, { autoCutoffEnabled: true, autoCutoffTime: iso(NOW + 10 * MIN) }, [F, X, X, X, X]],
  ['square price', board, { squarePrice: 20 }, [F, 'money', 'money', X, X]],
  ['payout split', board, { payouts: { q1: 20, q2: 20, q3: 20, final: 40 } }, [F, 'money', 'money', X, X]],
  ['total pot', board, { potOverride: 1200 }, [X, 'pot', 'pot', 'pot', 'pot']],
  ['pick mode', board, { pickMode: 'manual' }, [F, X, X, X, X]],
  ['player picks', board, { guestPick: { on: true, max: 4, liftAt: null, lifted: false } }, [F, X, X, X, X]],
  ['Manual to Live', board, { scoring: 'live' }, [F, 'scoring', 'scoring', 'scoring', X]],
  ['Live to Manual', live, { scoring: 'manual' }, [F, 'scoring', X, X, X]],
  ['to Simulation', board, { scoring: 'simulation' }, [F, X, X, X, X]],
  ['from Simulation', (s) => board(s, { scoring: 'simulation', simulation: true }), { scoring: 'manual' }, [F, X, X, X, X]]
];

TABLE.forEach(([label, make, set, expected]) => {
  check(`edit: ${label} at each stage`, () => {
    STAGES.forEach((stage, i) => {
      const g = make(stage);
      const want = expected[i];
      const r = edit(g, set);
      const where = `${label} / ${stage}`;
      if (want === F) {
        assert(!r.error, `${where}: refused: ${r.error}`);
        eq(r.warnings, [], `${where}: warnings`);
      } else if (want === X) {
        eq([r.code, !!r.error], ['illegal', true], `${where}: ${r.error || 'allowed'}`);
        assert(Object.keys(set).concat('swap').indexOf(r.field) !== -1, `${where}: names the field (${r.field})`);
        no(edit(g, set, { ack: ['team', 'liveGame', 'swap', 'kickoff', 'money', 'pot', 'scoring', 'cutoffPast'] }), 'illegal');
      } else {
        const refused = no(r, 'unacked');
        eq(refused.warnings.map(w => w.code), [want], `${where}: warnings`);
        assert(refused.warnings.every(w => typeof w.text === 'string' && w.text), `${where}: words`);
        const done = ok(edit(g, set, { ack: [want] }));
        eq(done.warnings.map(w => w.code), [want], `${where}: warnings when acked`);
      }
    });
  });
});

check('edit: only the fields asked for change', () => {
  const g = board('locked');
  const r = ok(edit(g, { description: 'New', teamBColor: '#00ff00' }));
  const strip = (x) => JSON.stringify(Object.assign({}, x, { description: 0, teamBColor: 0 }));
  eq(strip(r.game), strip(g), 'the rest');
  eq([r.game.description, r.game.teamBColor, r.changed], ['New', '#00ff00', true], 'changed');
});

check('edit: a value the board already holds is no change, and needs nothing seen', () => {
  const g = board('over');
  const r = ok(run(g, { op: 'edit', set: { squarePrice: 10, potOverride: null }, saw: {} }));
  eq([r.changed, r.warnings], [false, []], 'nothing to do');
});

check('edit: malformed operations are refused', () => {
  const g = board('locked');
  [null, [], 'edit', {}, { op: 'unlock' }, { op: 'edit' }, { op: 'edit', set: {}, saw: {} },
    { op: 'edit', set: { status: 'picking' }, saw: { status: 'started' } },
    { op: 'edit', set: { axisX: IDENTITY }, saw: { axisX: IDENTITY } },
    { op: 'edit', set: { squares: [] }, saw: { squares: [] } },
    { op: 'edit', set: { simulation: true }, saw: { simulation: false } },
    { op: 'edit', set: { changes: [] }, saw: { changes: null } },
    { op: 'edit', set: { description: 'x' } },
    { op: 'edit', set: { description: 'x' }, saw: {} },
    { op: 'edit', set: { description: 'x' }, saw: { description: 'Office pool' }, ack: 'money' },
    { op: 'edit', set: { squarePrice: 20 }, saw: { squarePrice: 10 }, marks: 'maybe' },
    { op: 'edit', set: { swap: false }, saw: { teamA: 'Chiefs', teamB: 'Eagles' } },
    { op: 'edit', set: { swap: true }, saw: {} },
    { op: 'edit', set: { swap: true, teamA: 'Bills' }, saw: { teamA: 'Chiefs', teamB: 'Eagles' } },
    { op: 'edit', set: { squarePrice: -1 }, saw: { squarePrice: 10 } },
    { op: 'edit', set: { squarePrice: '20' }, saw: { squarePrice: 10 } },
    { op: 'edit', set: { potOverride: 10.5 }, saw: { potOverride: null } },
    { op: 'edit', set: { payouts: { q1: 50, q2: 50, q3: 50, final: 50 } }, saw: { payouts: g.payouts } },
    { op: 'edit', set: { scoring: 'tv' }, saw: { scoring: 'manual' } },
    { op: 'edit', set: { teamAColor: 'red' }, saw: { teamAColor: null } }
  ].forEach(op => no(run(g, op), 'invalid'));
});

check('edit: a stored value that differs from the one seen is refused, naming the field', () => {
  const g = board('locked', { squarePrice: 15 });
  const r = no(run(g, { op: 'edit', set: { squarePrice: 20, description: 'x' }, saw: { squarePrice: 10, description: 'Office pool' }, ack: ['money'] }), 'conflict');
  eq([r.field, r.value], ['squarePrice', 15], 'which field, and what it holds now');
  const sw = no(run(board('locked', { teamB: 'Bills' }), { op: 'edit', set: { swap: true }, saw: { teamA: 'Chiefs', teamB: 'Eagles' }, ack: ['swap'] }), 'conflict');
  eq(sw.field, 'teamB', 'a swap judged on the teams seen');
});

check('edit: what was seen is judged as the board reads, also on an old Simulation board with no scoring field', () => {
  const old = board('picking', { simulation: true });
  delete old.scoring;
  eq(ok(run(old, { op: 'edit', set: { scoring: 'manual' }, saw: { scoring: 'simulation' } })).game.scoring, 'manual', 'seen right');
  eq(no(run(old, { op: 'edit', set: { scoring: 'manual' }, saw: { scoring: 'live' } }), 'conflict').field, 'scoring', 'seen wrong');
});

check('edit: a line crossed between read and write asks again, or blocks', () => {
  // The form was opened while locked; Q1 ended before the save landed.
  const acked = { ack: ['money'] };
  ok(edit(board('locked'), { squarePrice: 20 }, acked));
  no(edit(board('line3'), { squarePrice: 20 }, acked), 'illegal');
  // Acked a swap before kickoff; the game started meanwhile.
  no(edit(board('underWay'), { swap: true }, { ack: ['swap'] }), 'illegal');
  // While picking nobody had paid; someone paid before the save landed.
  ok(edit(board('picking'), { payouts: { q1: 10, q2: 10, q3: 10, final: 70 } }));
  const paid = board('picking');
  paid.players.Ann.paid = true;
  eq(no(edit(paid, { payouts: { q1: 10, q2: 10, q3: 10, final: 70 } }), 'unacked').warnings.map(w => w.code), ['money'], 'asks again');
  // Before kickoff a team change on a Live board was a warning; once the feed says in play, blocked.
  no(edit(live('locked'), { teamA: 'Bills' }, { ack: ['liveGame'] }, { feed: { state: 'in', at: NOW } }), 'illegal');
});

check('edit: auto cutoff while picking warns when the time is already past', () => {
  const r = no(edit(board('picking'), { autoCutoffEnabled: true, autoCutoffTime: iso(NOW - MIN) }), 'unacked');
  eq(r.warnings.map(w => w.code), ['cutoffPast'], 'warning');
  ok(edit(board('picking'), { autoCutoffEnabled: true, autoCutoffTime: iso(NOW - MIN) }, { ack: ['cutoffPast'] }));
});

check('edit: kickoff on a Manual board under way only while there is no score', () => {
  const scored = board('underWay', { liveScore: { a: 3, b: 0, period: 1, manual: true } });
  no(edit(scored, { kickoffTime: iso(NOW - 10 * MIN) }, { ack: ['kickoff'] }), 'illegal');
});

// ---------- money ----------

check('edit: a price change with paid marks needs the host to keep or clear them', () => {
  const g = board('locked');
  g.players.Ann.paid = true;
  g.players.Bob.paidSquares = 10;
  const set = { squarePrice: 20 };
  const asked = no(edit(g, set, { ack: ['money'] }), 'marks');
  eq(asked.paidSquares, 60, 'how many squares are paid at the old price');
  const kept = ok(edit(g, set, { ack: ['money'], marks: 'keep' })).game;
  eq([kept.players.Ann.paid, kept.players.Bob.paidSquares, kept.squarePrice], [true, 10, 20], 'kept');
  const cleared = ok(edit(g, set, { ack: ['money'], marks: 'clear' })).game;
  eq([cleared.players.Ann.paid, cleared.players.Bob.paid, cleared.players.Bob.paidSquares, cleared.players.Cy.paid], [false, false, undefined, false], 'cleared');
  eq(cleared.players.Ann.color, '#112233', 'only the marks go');
  const words = no(edit(g, set), 'unacked').warnings[0].text;
  assert(words.includes('$1,000') && words.includes('$2,000') && words.includes('60'), `the warning gives the pot before and after and the paid squares: ${words}`);
  eq(ok(edit(board('locked'), set, { ack: ['money'] })).game.squarePrice, 20, 'nobody paid: no choice needed');
  ok(edit(g, { payouts: { q1: 20, q2: 20, q3: 20, final: 40 } }, { ack: ['money'] })); // the split does not change what a mark is worth
});

check('no save makes a quarter\'s amount negative', () => {
  // The bug: a $100 pot on a $1,000 board paid a Final of -$650.
  const r = no(edit(board('locked'), { potOverride: 100 }, { ack: ['pot'] }), 'illegal');
  eq(r.field, 'potOverride', 'field');
  assert(/final/i.test(r.error), `says which quarter: ${r.error}`);
  ok(edit(board('locked'), { potOverride: 750 }, { ack: ['pot'] }));
  // A price rise under an edited pot.
  no(edit(board('locked', { potOverride: 1000 }), { squarePrice: 20 }, { ack: ['money'] }), 'illegal');
  // A board that is already below zero may be put right.
  const bad = board('locked', { potOverride: 100 });
  ok(edit(bad, { potOverride: 900 }, { ack: ['pot'] }));
  ok(edit(bad, { description: 'still fixing' }));
  no(edit(bad, { potOverride: 50 }, { ack: ['pot'] }), 'illegal');
});

check('Total pot changes only the Final, and a paid Final then needs settling', () => {
  const g = board('over', { paidOut: { final: { name: 'Cy', amount: 250 } } });
  // Final 24-20: row 4, column 0 is square 40, Ann's.
  g.paidOut.final.name = 'Ann';
  const r = ok(edit(g, { potOverride: 1100 }, { ack: ['pot'] }));
  const res = GL.computeGame(r.game).results;
  eq([res.q1.amount, res.q2.amount, res.q3.amount, res.final.amount], [250, 250, 250, 350], 'amounts');
  eq(GL.payoutStatus(r.game).final.state, 'needsSettling', 'the paid Final');
});

// ---------- what an edit writes ----------

check('edit: swapping exchanges the teams and their colors', () => {
  const g = board('locked', { teamAColor: '#aa0000', teamBColor: '#0000aa' });
  const r = ok(edit(g, { swap: true }, { ack: ['swap'] })).game;
  eq([r.teamA, r.teamB, r.teamAColor, r.teamBColor], ['Eagles', 'Chiefs', '#0000aa', '#aa0000'], 'swapped');
  eq([r.axisX, r.axisY, r.squares], [g.axisX, g.axisY, g.squares], 'numbers and squares stay');
});

check('edit: changing the scoring drops the old running score; entered quarters stay', () => {
  const g = board('underWay', { liveScore: { a: 0, b: 0, period: 1, manual: true }, results: {} });
  const r = ok(edit(g, { scoring: 'live' }, { ack: ['scoring'] })).game;
  eq([r.scoring, r.simulation, r.liveScore, r.liveOverride], ['live', false, null, undefined], 'mode');
  const p = ok(edit(board('picking'), { scoring: 'simulation' })).game;
  eq([p.scoring, p.simulation], ['simulation', true], 'simulation flag follows');
});

check('edit: changes after the first lock are kept in game.changes, the last 5', () => {
  const at = iso(NOW);
  const one = (g, set, ack) => ok(edit(g, set, { ack: ack ? [ack] : [] })).game.changes;
  eq(one(board('picking'), { squarePrice: 20 }), undefined, 'nothing before the lock');
  eq(one(board('locked'), { squarePrice: 20 }, 'money'), [{ kind: 'price', from: 10, to: 20, at }], 'price');
  eq(one(board('locked'), { payouts: { q1: 20, q2: 20, q3: 20, final: 40 } }, 'money'),
    [{ kind: 'payouts', from: { q1: 25, q2: 25, q3: 25, final: 25 }, to: { q1: 20, q2: 20, q3: 20, final: 40 }, at }], 'payouts');
  eq(one(board('locked'), { potOverride: 1200 }, 'pot'), [{ kind: 'pot', from: 1000, to: 1200, at }], 'pot');
  eq(one(board('locked', { potOverride: 1200 }), { potOverride: null }, 'pot'), [{ kind: 'pot', from: 1200, to: 1000, at }], 'pot back to the squares sold');
  eq(one(board('locked'), { swap: true }, 'swap'), [{ kind: 'swap', from: ['Chiefs', 'Eagles'], to: ['Eagles', 'Chiefs'], at }], 'swap');
  eq(one(board('locked'), { teamA: 'Bills' }, 'team'), [{ kind: 'teams', from: ['Chiefs', 'Eagles'], to: ['Bills', 'Eagles'], at }], 'teams');
  eq(one(live('locked'), { teamA: 'Bills' }, 'liveGame'), [{
    kind: 'game',
    from: { teamA: 'Chiefs', teamB: 'Eagles', league: 'nfl', gameDate: '2027-02-14', kickoffTime: SOON },
    to: { teamA: 'Bills', teamB: 'Eagles', league: 'nfl', gameDate: '2027-02-14', kickoffTime: SOON }, at
  }], 'live game');
  eq(one(board('locked'), { description: 'x', teamA: 'CHIEFS', kickoffTime: iso(NOW + 2 * HOUR) }), undefined, 'nothing for free fields');
  // Two kinds in one save, then the list is cut to the newest five.
  let g = board('locked');
  const two = ok(edit(g, { squarePrice: 12, potOverride: 1300 }, { ack: ['money', 'pot'] })).game.changes;
  eq(two.map(c => c.kind), ['price', 'pot'], 'both');
  for (let p = 11; p <= 17; p++) g = ok(edit(g, { squarePrice: p }, { ack: ['money'] })).game;
  eq(g.changes.map(c => c.to), [13, 14, 15, 16, 17], 'last five');
});

check('validateGame holds game.changes to exact types', () => {
  const g = board('locked');
  const at = iso(NOW);
  const good = [{ kind: 'price', from: 10, to: 20, at }, { kind: 'numbers', from: { axisX: IDENTITY, axisY: IDENTITY }, to: { axisX: IDENTITY, axisY: IDENTITY }, at }];
  eq(GL.validateGame(Object.assign({}, g, { changes: good })), null, 'good');
  [{}, 'x', [{ kind: 'price', from: 10, to: 20 }], [{ kind: 'price', from: '10', to: 20, at }], [{ kind: 'nope', from: 1, to: 2, at }],
    [{ kind: 'price', from: 10, to: 20, at, extra: 1 }], [{ kind: 'teams', from: ['a'], to: ['a', 'b'], at }],
    [{ kind: 'pot', from: -1, to: 2, at }], [{ kind: 'price', from: 10, to: 20, at: 'yesterday' }],
    [{ kind: 'game', from: { teamA: 'a' }, to: { teamA: 'b' }, at }],
    Array.from({ length: 6 }, () => good[0])
  ].forEach(changes => assert(GL.validateGame(Object.assign({}, g, { changes })), `accepted ${JSON.stringify(changes)}`));
});

// ---------- applySettingsOp: lock ----------

check('lock: the server draws the numbers; nothing else of the board changes', () => {
  const g = board('picking');
  const r = ok(run(g, { op: 'lock' }, { pick: () => 0 }));
  // pick(n) = 0 always swaps with the first slot: Fisher-Yates from the top.
  const drawn = (() => { const a = IDENTITY.slice(); for (let i = 9; i > 0; i--) [a[i], a[0]] = [a[0], a[i]]; return a; })();
  eq([r.game.status, r.game.axisX, r.game.axisY], ['started', drawn, drawn], 'locked');
  const strip = (x) => JSON.stringify(Object.assign({}, x, { status: 0, axisX: 0, axisY: 0 }));
  eq(strip(r.game), strip(g), 'the rest');
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(JSON.stringify(ok(run(g, { op: 'lock' }, { pick: (n) => crypto.randomInt(n) })).game.axisX));
  assert(seen.size > 15, 'the draw is random');
});

check('lock: a Simulation board gets its plan from the server clock', () => {
  const r = ok(run(board('picking', { scoring: 'simulation', simulation: true }), { op: 'lock' }));
  eq(r.game.simPlan.startedAt, iso(NOW), 'starts now');
  eq(r.game.liveScore, null, 'no score yet');
});

check('lock: only a board that is picking', () => {
  for (const s of ['locked', 'underWay', 'over']) no(run(board(s), { op: 'lock' }), 'illegal');
  no(run(board('picking'), { op: 'lock', axisX: IDENTITY }), 'invalid');
});

// ---------- guardPut ----------

const put = (stored, body, ctx) => GL.guardPut(stored, body, Object.assign({}, CTX, ctx));
const putOk = (stored, body, ctx) => { const r = put(stored, body, ctx); assert(!r.error, `refused: ${r.error}`); return r.game; };

check('PUT: a lock keeps none of the client\'s numbers', () => {
  const stored = board('picking');
  const body = Object.assign(clone(stored), { status: 'started', axisX: IDENTITY.slice(), axisY: IDENTITY.slice().reverse() });
  const g = putOk(stored, body, { pick: () => 0 });
  eq(g.status, 'started', 'locked');
  assert(JSON.stringify(g.axisX) !== JSON.stringify(IDENTITY) && JSON.stringify(g.axisY) !== JSON.stringify(body.axisY), 'drawn by the server');
  const sim = putOk(board('picking', { scoring: 'simulation', simulation: true }),
    Object.assign(board('picking', { scoring: 'simulation', simulation: true }), { status: 'started', axisX: IDENTITY, axisY: IDENTITY, simPlan: { startedAt: iso(0), events: [] } }));
  eq(sim.simPlan.startedAt, iso(NOW), 'and the server plans the simulation');
  const open = putOk(stored, Object.assign(clone(stored), { axisX: IDENTITY, axisY: IDENTITY }));
  eq([open.axisX, open.axisY], [null, null], 'no numbers on a board that is picking');
});

check('PUT: on a locked board the numbers, the status and every settings field stay', () => {
  for (const stage of ['locked', 'underWay', 'over']) {
    const stored = board(stage);
    putOk(stored, clone(stored));
    const try_ = (change, what) => {
      const body = clone(stored);
      change(body);
      const r = put(stored, body);
      eq([r.code, !!r.error], ['illegal', true], `${stage}: ${what}: ${r.error || 'allowed'}`);
    };
    try_(b => { b.status = 'picking'; b.axisX = null; b.axisY = null; }, 'back to picking');
    try_(b => { b.axisX = IDENTITY.slice().reverse(); }, 'other numbers');
    try_(b => { b.simPlan = { startedAt: iso(NOW), events: [] }; }, 'a new plan');
    [['squarePrice', 20], ['payouts', { q1: 10, q2: 10, q3: 10, final: 70 }], ['potOverride', 900], ['teamA', 'Bills'], ['teamB', 'Bills'],
      ['league', 'other'], ['gameDate', '2027-02-15'], ['kickoffTime', iso(NOW)], ['pickMode', 'auto'], ['scoring', 'live'], ['simulation', true],
      ['guestPick', { on: true, max: 3, liftAt: null, lifted: false }], ['autoCutoffEnabled', true], ['description', 'x'], ['teamAColor', '#123456']
    ].forEach(([k, v]) => try_(b => { b[k] = v; }, k));
  }
});

check('PUT: an echoed document passes whatever empty value a field had', () => {
  const stored = board('locked');
  delete stored.description; delete stored.teamAColor; delete stored.autoCutoffEnabled; delete stored.pickMode; delete stored.scoring;
  const body = Object.assign(clone(stored), { description: null, teamAColor: '', autoCutoffEnabled: false, pickMode: 'both', scoring: 'live', kickoffTime: SOON });
  putOk(stored, body);
});

check('PUT: game.changes is the server\'s', () => {
  const at = iso(NOW);
  const stored = board('locked', { changes: [{ kind: 'price', from: 5, to: 10, at }] });
  eq(putOk(stored, Object.assign(clone(stored), { changes: [] })).changes, stored.changes, 'kept');
  eq(putOk(board('locked'), Object.assign(board('locked'), { changes: [{ kind: 'price', from: 5, to: 10, at }] })).changes, undefined, 'never added');
});

check('PUT: squares on a locked board follow the table', () => {
  const tryIt = (stage, change) => { const s = board(stage); const b = clone(s); change(b); return put(s, b); };
  const empty = (stage) => { const s = board(stage); s.squares[99] = null; const b = clone(s); b.squares[99] = { name: 'Ann' }; return put(s, b); };
  const move = (b) => { b.squares[0] = { name: 'Bob', at: 1000 }; };
  const remove = (b) => { for (let i = 80; i < 100; i++) b.squares[i] = null; delete b.players.Cy; };
  const rename = (b) => {
    b.squares.forEach(s => { if (s && s.name === 'Cy') s.name = 'Cyd'; });
    b.players.Cyd = b.players.Cy; delete b.players.Cy;
  };
  const merge = (b) => { b.squares.forEach(s => { if (s && s.name === 'Cy') s.name = 'Bob'; }); delete b.players.Cy; };
  const verdict = (r) => (r.error ? r.code : 'ok');
  eq(['locked', 'underWay', 'line3', 'over'].map(s => verdict(empty(s))), ['illegal', 'illegal', 'illegal', 'illegal'], 'an empty square stays empty');
  eq(['locked', 'underWay', 'line3', 'over'].map(s => verdict(tryIt(s, move))), ['ok', 'illegal', 'illegal', 'illegal'], 'move to someone else');
  eq(['locked', 'underWay', 'line3', 'over'].map(s => verdict(tryIt(s, remove))), ['ok', 'ok', 'illegal', 'illegal'], 'remove a person');
  eq(['locked', 'underWay', 'line3', 'over'].map(s => verdict(tryIt(s, rename))), ['ok', 'ok', 'ok', 'ok'], 'rename');
  eq(['locked', 'underWay', 'line3', 'over'].map(s => verdict(tryIt(s, merge))), ['ok', 'illegal', 'illegal', 'illegal'], 'a rename onto someone else is a move');
  // Players' paid marks are free at every stage.
  eq(verdict(tryIt('over', b => { b.players.Ann.paid = true; b.players.Bob.paidSquares = 3; })), 'ok', 'paid marks');
});

check('PUT: a rename takes only the matching paid-out names with it', () => {
  const s = board('over', { paidOut: { q1: { name: 'Ann', amount: 250, at: iso(NOW) }, q2: { name: 'Bob', amount: 250, at: iso(NOW) } } });
  const renamed = clone(s);
  renamed.squares.forEach(q => { if (q.name === 'Ann') q.name = 'Annie'; });
  renamed.players.Annie = renamed.players.Ann; delete renamed.players.Ann;
  renamed.paidOut.q1.name = 'Annie';
  putOk(s, renamed);
  const stray = clone(renamed);
  stray.paidOut.q2.name = 'Annie';
  eq(put(s, stray).code, 'illegal', 'another quarter\'s record');
  const amount = clone(s);
  amount.paidOut.q1.amount = 1;
  eq(put(s, amount).code, 'illegal', 'an amount');
  const gone = clone(s);
  delete gone.paidOut.q2;
  eq(put(s, gone).code, 'illegal', 'a record removed');
  const unrenamed = clone(s);
  unrenamed.paidOut.q1.name = 'Zed';
  eq(put(s, unrenamed).code, 'illegal', 'a name with no rename');
});

check('PUT: no negative quarter on a board that is picking either', () => {
  const s = board('picking');
  eq(put(s, Object.assign(clone(s), { potOverride: 100 })).code, 'illegal', 'negative');
  eq(put(board('picking', { potOverride: 1000 }), Object.assign(board('picking', { potOverride: 1000 }), { squarePrice: 20 })).field, 'squarePrice', 'names the field that did it');
  putOk(s, Object.assign(clone(s), { potOverride: 900 }));
});

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
      if (event === 'data' && o.body !== undefined) cb(Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)));
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
const hostCookie = (hostId) => {
  const payload = `v1.${hostId}.1.${Math.floor(Date.now() / 1000) + 600}`;
  return `sbs_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
};
const passwordCookie = async () => String((await call('POST', '/api/session', { body: { password: 'correct horse' } })).headers['set-cookie']).split(';')[0];
const LOCK = { op: 'lock' };
const potEdit = (from, to, ack) => ({ op: 'edit', set: { potOverride: to }, saw: { potOverride: from }, ack: ack || [] });

const created = [];
// The helpers file is put back afterwards, as test-helpers.js does.
const fs = require('fs');
const path = require('path');
const HELPER_FILE = path.join(__dirname, 'data', 'helpers.json');
const hadHelpers = fs.existsSync(HELPER_FILE);
const helpersBackup = hadHelpers ? fs.readFileSync(HELPER_FILE) : null;
function restoreHelpers() {
  try { if (hadHelpers) fs.writeFileSync(HELPER_FILE, helpersBackup); else fs.unlinkSync(HELPER_FILE); } catch (e) { /* none */ }
}
// A board made through the API in off mode, then left in `stage` straight in the store.
async function makeBoard(stage, extra) {
  setEnv({});
  const r = await call('POST', '/api/game', { body: board('picking') });
  assert(r.statusCode === 201, `create: ${r.body}`);
  created.push(r.json.id);
  if (stage === 'picking' && !extra) return r.json;
  const doc = Object.assign(board(stage === 'picking' ? 'picking' : stage), { id: r.json.id, kickoffTime: stage === 'locked' ? iso(Date.now() + HOUR) : iso(Date.now() - HOUR) }, extra);
  const w = await store.updateGame(r.json.id, doc, null);
  return w.game;
}

async function routes() {
  await check('route: off mode locks with the server\'s numbers, once', async () => {
    const g = await makeBoard('picking');
    const r = await call('PATCH', `/api/game/${g.id}/settings`, { body: LOCK });
    eq(r.statusCode, 200, r.body);
    eq(r.json.status, 'started', 'locked');
    assert(GL.isDigitPermutation(r.json.axisX) && GL.isDigitPermutation(r.json.axisY), 'numbers');
    eq((await store.getGame(g.id)).axisX, r.json.axisX, 'stored');
    const again = await call('PATCH', `/api/game/${g.id}/settings`, { body: LOCK });
    eq([again.statusCode, again.json.game && again.json.game.status], [409, 'started'], 'already locked, with the board');
  });

  await check('route: an edit on a locked board asks for the warning, then saves it with the change line', async () => {
    const g = await makeBoard('locked');
    const p = `/api/game/${g.id}/settings`;
    const asked = await call('PATCH', p, { body: potEdit(null, 1200) });
    eq([asked.statusCode, asked.json.code, asked.json.warnings.map(w => w.code)], [409, 'unacked', ['pot']], asked.body);
    eq((await store.getGame(g.id)).potOverride, undefined, 'not written');
    const done = await call('PATCH', p, { body: potEdit(null, 1200, ['pot']) });
    eq(done.statusCode, 200, done.body);
    eq([done.json.potOverride, done.json.changes.map(c => [c.kind, c.from, c.to])], [1200, [['pot', 1000, 1200]]], 'saved');
    const stale = await call('PATCH', p, { body: potEdit(null, 1300, ['pot']) });
    eq([stale.statusCode, stale.json.code, stale.json.field, stale.json.game.potOverride], [409, 'conflict', 'potOverride', 1200], 'seen value moved');
    const negative = await call('PATCH', p, { body: potEdit(1200, 100, ['pot']) });
    eq([negative.statusCode, negative.json.code], [409, 'illegal'], negative.body);
    const blocked = await call('PATCH', p, { body: { op: 'edit', set: { pickMode: 'auto' }, saw: { pickMode: 'both' } } });
    eq([blocked.statusCode, blocked.json.field], [409, 'pickMode'], blocked.body);
    for (const bad of [{ op: 'unlock' }, { op: 'edit', set: { status: 'picking' }, saw: {} }, 'not json']) {
      eq((await call('PATCH', p, { body: bad })).statusCode, 400, JSON.stringify(bad));
    }
    eq((await call('PATCH', `/api/game/${crypto.randomUUID()}/settings`, { body: LOCK })).statusCode, 404, 'unknown board');
    eq((await call('GET', p)).statusCode, 404, 'GET');
  });

  await check('route: a line crossed between the read and the write is judged again', async () => {
    const g = await makeBoard('underWay');
    const real = store.updateGame;
    let raced = false;
    store.updateGame = async (id, doc, expected, opts) => {
      if (!raced) {
        raced = true;
        const now = await store.getGame(id);
        await real(id, Object.assign(now, { results: { q1: { a: 7, b: 3 } } }), null);
      }
      return real(id, doc, expected, opts);
    };
    try {
      const r = await call('PATCH', `/api/game/${g.id}/settings`, { body: { op: 'edit', set: { squarePrice: 20 }, saw: { squarePrice: 10 }, ack: ['money'] } });
      eq([r.statusCode, r.json.code, r.json.field], [409, 'illegal', 'squarePrice'], r.body);
    } finally { store.updateGame = real; }
    eq((await store.getGame(g.id)).squarePrice, 10, 'price stays');
  });

  await check('route: PUT needs the stored updatedAt, and a lock from an old page gets the server\'s numbers', async () => {
    const g = await makeBoard('picking');
    const p = `/api/game/${g.id}`;
    const body = Object.assign(clone(g), { status: 'started', axisX: IDENTITY, axisY: IDENTITY });
    delete body.updatedAt;
    const missing = await call('PUT', p, { body });
    eq([missing.statusCode, missing.json.conflict, !!missing.json.game], [409, true, true], `no updatedAt: ${missing.body}`);
    const stale = await call('PUT', p, { body: Object.assign(clone(body), { updatedAt: '2020-01-01T00:00:00.000Z' }) });
    eq(stale.statusCode, 409, 'stale updatedAt');
    const r = await call('PUT', p, { body: Object.assign(clone(body), { updatedAt: g.updatedAt }) });
    eq([r.statusCode, r.json.status], [200, 'started'], r.body);
    assert(JSON.stringify([r.json.axisX, r.json.axisY]) !== JSON.stringify([IDENTITY, IDENTITY]), 'the server drew');
    const back = await call('PUT', p, { body: Object.assign(clone(r.json), { status: 'picking', axisX: null, axisY: null }) });
    eq([back.statusCode, back.json.error && /lock/i.test(back.json.error)], [409, true], back.body);
    const price = await call('PUT', p, { body: Object.assign(clone(r.json), { squarePrice: 1 }) });
    eq([price.statusCode, price.json.field], [409, 'squarePrice'], price.body);
    const paid = Object.assign(clone(r.json));
    paid.players.Ann.paid = true;
    eq((await call('PUT', p, { body: paid })).statusCode, 200, 'paid marks still save');
  });

  await check('route: a PUT that creates a locked board gets the server\'s numbers too', async () => {
    setEnv({});
    const id = crypto.randomUUID();
    created.push(id);
    const r = await call('PUT', `/api/game/${id}`, { body: Object.assign(board('locked'), { id, axisX: IDENTITY, axisY: IDENTITY, changes: [] }) });
    eq([r.statusCode, r.json.status, r.json.changes], [200, 'started', undefined], r.body);
    assert(JSON.stringify([r.json.axisX, r.json.axisY]) !== JSON.stringify([IDENTITY, IDENTITY]), 'the server drew');
  });

  await check('route: password mode — owner only; helpers and strangers are refused', async () => {
    const g = await makeBoard('picking');
    setEnv({ HOST_PASSWORD: 'correct horse' });
    const host = await passwordCookie();
    const p = `/api/game/${g.id}/settings`;
    eq((await call('PATCH', p, { body: LOCK })).statusCode, 401, 'anonymous');
    const made = await call('POST', `/api/game/${g.id}/helpers`, { cookie: host, body: { label: 'Dana', canScore: true, canSquares: true } });
    eq(made.statusCode, 201, made.body);
    const helper = String((await call('POST', '/api/helper', { body: { token: made.json.token } })).headers['set-cookie']).split(';')[0];
    eq((await call('PATCH', p, { cookie: helper, body: LOCK })).statusCode, 401, 'a helper with both jobs');
    eq((await call('PATCH', p, { cookie: host, body: LOCK, headers: { origin: 'https://evil.example' } })).statusCode, 403, 'foreign Origin');
    eq((await call('PATCH', p, { cookie: host, body: LOCK })).statusCode, 200, 'the host');
    setEnv({ AUTH_MODE: 'acounts' });
    eq((await call('PATCH', p, { cookie: host, body: LOCK })).statusCode, 503, 'sign-in misconfigured');
  });

  await check('route: accounts mode — the owner only', async () => {
    setEnv(ACCOUNTS_ENV);
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let doc = Object.assign(board('picking'), { id, updatedAt: iso(NOW) });
    const fakes = {
      async getGame() { return clone(doc); },
      async updateGame(gid, game) { doc = Object.assign(clone(game), { updatedAt: iso(Date.now()) }); return { ok: true, game: clone(doc) }; },
      async getGameAccess(gid, hostId) { return { exists: gid === id, ownerId: A, sessionVersion: 1 }; },
      async getHost() { return { email: 'x@example.com', sessionVersion: 1 }; }
    };
    const real = {};
    Object.keys(fakes).forEach(k => { real[k] = store[k]; store[k] = fakes[k]; });
    try {
      const p = `/api/game/${id}/settings`;
      eq((await call('PATCH', p, { body: LOCK })).statusCode, 401, 'anonymous');
      eq((await call('PATCH', p, { cookie: hostCookie(B), body: LOCK })).statusCode, 403, 'another host');
      eq((await call('PATCH', p, { cookie: hostCookie(B), body: LOCK, headers: { origin: 'https://evil.example' } })).statusCode, 403, 'foreign Origin');
      eq(doc.status, 'picking', 'untouched');
      const r = await call('PATCH', p, { cookie: hostCookie(A), body: LOCK });
      eq([r.statusCode, doc.status], [200, 'started'], r.body);
      eq((await call('PUT', `/api/game/${id}`, { cookie: hostCookie(A), body: Object.assign(clone(doc), { axisX: IDENTITY.slice().reverse() }) })).statusCode, 409, 'PUT guard');
    } finally { Object.assign(store, real); }
  });
}

// Both stores: the same flow on Postgres, through the routes, when DATABASE_URL is set.
async function pgRoutes() {
  process.env.DATABASE_URL = PG_URL;
  const pg = require('./lib/store-pg.js');
  const keys = ['getGame', 'updateGame', 'createGame', 'deleteGame', 'assignJoinCode'];
  const real = {};
  keys.forEach(k => { real[k] = store[k]; store[k] = pg[k]; });
  delete process.env.DATABASE_URL;
  const ids = [];
  try {
    await check('pg: lock, an acked pot edit and the PUT guards', async () => {
      setEnv({});
      const g = await pg.createGame(board('picking', { id: crypto.randomUUID() }), null);
      ids.push(g.id);
      const p = `/api/game/${g.id}/settings`;
      const locked = await call('PATCH', p, { body: LOCK });
      eq([locked.statusCode, locked.json.status], [200, 'started'], locked.body);
      Object.assign(locked.json, { kickoffTime: iso(Date.now() + HOUR) });
      const kicked = await pg.updateGame(g.id, locked.json, locked.json.updatedAt);
      const pot = await call('PATCH', p, { body: potEdit(null, 1200, ['pot']) });
      eq([pot.statusCode, pot.json.potOverride, pot.json.changes.length], [200, 1200, 1], pot.body);
      const old = await call('PUT', `/api/game/${g.id}`, { body: kicked.game });
      eq(old.statusCode, 409, 'a stale page');
      const back = await call('PUT', `/api/game/${g.id}`, { body: Object.assign(clone(pot.json), { status: 'picking', axisX: null, axisY: null }) });
      eq(back.statusCode, 409, 'back to picking');
      eq((await pg.getGame(g.id)).axisX, locked.json.axisX, 'numbers stay');
    });
  } finally {
    for (const id of ids) { try { await pg.deleteGame(id); } catch (e) { /* best effort */ } }
    Object.assign(store, real);
  }
}

async function main() {
  await routes();
  if (PG_URL) await pgRoutes();
  else console.log('  (Postgres route checks skipped: no DATABASE_URL)');
}

main()
  .catch(e => failures.push(`crashed\n      ${e.stack}`))
  .then(async () => {
    setEnv({});
    for (const id of created) { try { await store.deleteGame(id); } catch (e) { /* best effort */ } }
    restoreHelpers();
    console.log('');
    if (failures.length) {
      console.log(`  ${failures.length} failed, ${passed} passed`);
      failures.forEach(f => console.log('  FAIL ' + f));
      process.exit(1);
    }
    console.log(`  settings: ${passed} passed`);
  });
