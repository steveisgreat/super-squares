// Zero-dependency tests for the money math and request validation.
// Run with:  node test.js   (or: npm test)
'use strict';

const G = require('./public/compute.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- fixtures ----------

// Identity axes keep the tests readable: digit N lives at row/col N.
const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function makeGame(claims, opts) {
  const o = opts || {};
  const squares = G.emptyGrid();
  // claims: { "row,col": name }
  Object.keys(claims || {}).forEach(k => {
    const [r, c] = k.split(',').map(Number);
    squares[r * 10 + c] = { name: claims[k] };
  });
  return {
    league: 'nfl',
    gameDate: '2026-02-08',
    teamA: 'Chiefs',
    teamB: 'Eagles',
    squarePrice: o.squarePrice === undefined ? 10 : o.squarePrice,
    payouts: o.payouts || { q1: 20, q2: 20, q3: 20, final: 40 },
    status: 'started',
    squares,
    axisX: IDENTITY.slice(),
    axisY: IDENTITY.slice(),
    results: o.results || {},
    players: {}
  };
}

// A board where every square is sold, so the pot is a round number.
function fullGame(opts) {
  const claims = {};
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) claims[`${r},${c}`] = `P${r}${c}`;
  return makeGame(claims, opts);
}

// ---------- pot ----------

check('pot counts only claimed squares', () => {
  const g = makeGame({ '0,0': 'Ann', '1,2': 'Bob' }, { squarePrice: 25 });
  eq(G.potOf(g), 50, 'pot');
});

check('pot of a full board', () => {
  eq(G.potOf(fullGame()), 1000, 'pot');
});

// ---------- winners ----------

check('team A score picks the row, team B score picks the column', () => {
  const g = makeGame({ '3,7': 'Ann' }, { results: { q1: { a: 3, b: 7 } } });
  const c = G.computeGame(g);
  eq(c.results.q1.winnerName, 'Ann', 'winner');
  eq([c.results.q1.row, c.results.q1.col], [3, 7], 'winning cell');
  assert(c.cellLabels['3-7'].some(l => l.label === 'Q1' && !l.pushed), 'Q1 badge on winning cell');
});

check('score digits are read against shuffled axes, not raw positions', () => {
  const g = makeGame({ '0,0': 'Ann' }, { results: { q1: { a: 4, b: 6 } } });
  g.axisY = [4, 0, 1, 2, 3, 5, 6, 7, 8, 9]; // digit 4 -> row 0
  g.axisX = [6, 0, 1, 2, 3, 4, 5, 7, 8, 9]; // digit 6 -> col 0
  eq(G.computeGame(g).results.q1.winnerName, 'Ann', 'winner');
});

check('a quarter with no score entered stays unresolved', () => {
  const c = G.computeGame(makeGame({ '0,0': 'Ann' }));
  G.QUARTERS.forEach(q => {
    assert(!c.results[q].resolved, `${q} should be unresolved`);
    eq(c.results[q].a, null, `${q}.a`);
  });
});

check('a score of 0 is a real score, not a missing one', () => {
  const g = makeGame({ '0,0': 'Ann' }, { results: { q1: { a: 0, b: 0 } } });
  const res = G.computeGame(g).results.q1;
  assert(res.resolved, 'Q1 should resolve on 0-0');
  eq(res.winnerName, 'Ann', 'winner');
});

// ---------- pushes and rollover ----------

check('an unclaimed square pushes and rolls into the next quarter', () => {
  const g = fullGame({ results: { q1: { a: 0, b: 0 }, q2: { a: 1, b: 1 } } });
  g.squares[0] = null; // 0,0 unsold -> Q1 pushes
  const c = G.computeGame(g);
  // pot 990: Q1 = 198, Q2 = 198 + 198 carried
  assert(c.results.q1.pushed, 'Q1 should push');
  eq(c.results.q1.amount, 198, 'Q1 amount');
  eq(c.results.q2.carryIn, 198, 'Q2 carry-in');
  eq(c.results.q2.amount, 396, 'Q2 amount');
  eq(c.results.q2.winnerName, 'P11', 'Q2 winner');
});

check('consecutive pushes accumulate into one payout', () => {
  const g = fullGame({ results: { q1: { a: 0, b: 0 }, q2: { a: 1, b: 1 }, q3: { a: 2, b: 2 } } });
  g.squares[0] = null;
  g.squares[11] = null;
  const c = G.computeGame(g);
  eq(c.results.q3.amount, 980 * 0.6, 'Q3 collects Q1 + Q2 + its own share');
  eq(c.results.q3.winnerName, 'P22', 'Q3 winner');
});

check('rollover survives quarters being filled in out of order', () => {
  // Q1 pushed, Q2 never entered, Q3 scored: the Q1 money must still be paid out.
  const g = fullGame({ results: { q1: { a: 0, b: 0 }, q3: { a: 2, b: 2 } } });
  g.squares[0] = null;
  const c = G.computeGame(g);
  eq(c.results.q1.amount, 198, 'Q1 push amount');
  eq(c.results.q3.carryIn, 198, 'Q3 must inherit the Q1 rollover');
  eq(c.results.q3.amount, 396, 'Q3 payout');
});

check('a pending quarter shows the rollover without consuming it', () => {
  const g = fullGame({ results: { q1: { a: 0, b: 0 } } });
  g.squares[0] = null;
  const c = G.computeGame(g);
  eq(c.results.q2.carryIn, 198, 'Q2 shows the pending rollover');
  eq(c.results.final.carryIn, 198, 'final still holds it too — whichever resolves first collects');
  eq(c.unallocated, 198, 'nothing is lost while every later quarter is blank');
});

check('a blank quarter stops advertising a rollover a later quarter collected', () => {
  const g = fullGame({ results: { q1: { a: 0, b: 0 }, q3: { a: 2, b: 2 } } });
  g.squares[0] = null;
  const c = G.computeGame(g);
  eq(c.results.q2.carryIn, 0, 'Q2 must not claim money Q3 already paid out');
  eq(c.results.q2.amount, 198, 'Q2 shows its own share only');
  eq(c.results.q3.amount, 396, 'Q3 still collects the rollover');
});

check('the whole pot is paid out exactly once', () => {
  const g = fullGame({
    results: { q1: { a: 0, b: 0 }, q2: { a: 1, b: 1 }, q3: { a: 2, b: 2 }, final: { a: 3, b: 3 } }
  });
  g.squares[0] = null; // Q1 pushes into Q2
  const c = G.computeGame(g);
  const paid = G.QUARTERS
    .filter(q => c.results[q].resolved && !c.results[q].pushed)
    .reduce((sum, q) => sum + c.results[q].amount, 0);
  eq(Math.round(paid * 100) / 100, c.pot, 'total paid to winners must equal the pot');
});

// ---------- the final square ----------

check('an empty final square asks for a draw instead of paying nobody', () => {
  const g = makeGame({ '5,5': 'Ann' }, { results: { final: { a: 1, b: 2 } } });
  const res = G.computeGame(g).results.final;
  assert(!res.resolved, 'final should not resolve');
  assert(res.needsDraw, 'final should request a draw');
  assert(!res.pushed, 'the final never pushes — there is nothing after it');
});

check('a stored draw resolves the final', () => {
  const g = makeGame({ '5,5': 'Ann' }, { results: { final: { a: 1, b: 2, autoResolve: { key: '1-2', row: 5, col: 5 } } } });
  const res = G.computeGame(g).results.final;
  assert(res.resolved, 'final should resolve from the stored draw');
  eq(res.winnerName, 'Ann', 'winner');
  assert(res.autoResolved, 'flagged as auto-drawn');
});

check('a stored draw is ignored once the final score changes', () => {
  const g = makeGame({ '5,5': 'Ann' }, { results: { final: { a: 3, b: 4, autoResolve: { key: '1-2', row: 5, col: 5 } } } });
  const res = G.computeGame(g).results.final;
  assert(!res.resolved, 'stale draw must not be reused');
  assert(res.needsDraw, 'a fresh draw is required');
});

// Regression: issue #2. The phone keypad compared the draw's row-col key with
// the scores and deleted the drawn winner on almost any tap.
check('typing over the final keeps the stored draw', () => {
  let g = makeGame({ '5,5': 'Ann' }, {
    status: 'finished', scoring: 'live', results: { final: { a: 17, b: 2, autoResolve: { key: '7-2', row: 5, col: 5, drawnAt: 1 } } }
  });
  const result = () => G.computeGame(g).results.final;
  const type = (a, b) => {
    const r = G.applyScoreOp(g, { op: 'edit', quarter: 'final', a, b });
    if (r.error) throw new Error(r.error);
    g = r.game;
  };
  eq(result().winnerName, 'Ann', 'drawn winner before any change');
  type(17, 2);
  eq(result().winnerName, 'Ann', 'same score typed again');
  type(null, null);
  assert(!result().resolved, 'no winner while the score is cleared');
  type(18, 2);
  assert(result().needsDraw, 'a different empty square still needs its own draw');
  type(17, 2);
  eq([result().winnerName, result().autoResolved], ['Ann', true], 'score corrected back');
});

check('typing a missing quarter creates it and touches no other', () => {
  const g = makeGame({}, { status: 'started', scoring: 'live', results: {} });
  eq(G.applyScoreOp(g, { op: 'edit', quarter: 'q1', a: 7, b: 0 }).game.results, { q1: { a: 7, b: 0 } }, 'results');
});

// ---------- shuffle ----------

check('shuffledDigits returns each digit exactly once', () => {
  for (let i = 0; i < 200; i++) {
    eq(G.shuffledDigits().slice().sort((a, b) => a - b), IDENTITY, 'digits');
  }
});

check('shuffle does not mutate its input', () => {
  const src = [1, 2, 3, 4, 5];
  G.shuffle(src);
  eq(src, [1, 2, 3, 4, 5], 'source array');
});

check('shuffle spreads values across every position', () => {
  // The old `sort(() => Math.random() - 0.5)` failed this: element 0 stayed
  // near the front far more often than chance, clustering auto-picked squares.
  const N = 10;
  const RUNS = 4000;
  const firstElementPositions = new Array(N).fill(0);
  for (let i = 0; i < RUNS; i++) {
    const out = G.shuffle(IDENTITY.slice(0, N));
    firstElementPositions[out.indexOf(0)]++;
  }
  const expected = RUNS / N;
  firstElementPositions.forEach((count, pos) => {
    const drift = Math.abs(count - expected) / expected;
    assert(drift < 0.25, `position ${pos} saw ${count} hits, expected ~${expected}`);
  });
});

// ---------- validation ----------

check('a well-formed game validates', () => {
  eq(G.validateGame(fullGame()), null, 'validation error');
});

check('validation rejects a bad league', () => {
  const g = fullGame(); g.league = 'mlb';
  assert(G.validateGame(g), 'expected an error for an unsupported league');
});

check('validation rejects a missing game date', () => {
  const g = fullGame(); g.gameDate = '';
  assert(G.validateGame(g), 'expected an error for a missing game date');
});

check('validation rejects a malformed custom team color', () => {
  const g = fullGame(); g.league = 'other'; g.teamAColor = 'not-a-color';
  assert(G.validateGame(g), 'expected an error for a bad hex color');
});

check('validation accepts the other league with valid custom colors', () => {
  const g = fullGame(); g.league = 'other'; g.teamAColor = '#336699'; g.teamBColor = '#ff0000';
  eq(G.validateGame(g), null, 'validation error');
});

check('validation rejects a grid that is not 100 squares', () => {
  const g = fullGame(); g.squares = g.squares.slice(0, 99);
  assert(G.validateGame(g), 'expected an error for a short grid');
});

check('validation rejects payouts that do not total 100%', () => {
  const g = fullGame(); g.payouts = { q1: 10, q2: 10, q3: 10, final: 10 };
  assert(G.validateGame(g), 'expected an error for payouts totalling 40%');
});

check('validation accepts fractional payouts that total 100%', () => {
  const g = fullGame(); g.payouts = { q1: 12.5, q2: 12.5, q3: 25, final: 50 };
  eq(G.validateGame(g), null, 'validation error');
});

check('validation rejects a duplicated axis digit', () => {
  const g = fullGame(); g.axisX = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  assert(G.validateGame(g), 'expected an error for a non-permutation axis');
});

check('validation rejects a started game with no axis numbers', () => {
  const g = fullGame(); g.axisX = null; g.axisY = null;
  assert(G.validateGame(g), 'expected an error for a started game without axes');
});

check('validation rejects an unnamed claimed square', () => {
  const g = fullGame(); g.squares[0] = { name: '   ' };
  assert(G.validateGame(g), 'expected an error for a blank name');
});

// Fields that reach markup. A stranger can PUT any JSON, so each one is held to
// the type the screens expect (decision 012, part 3).
const HOSTILE = '"><img src=x onerror=alert(1)>';
const show = v => String(JSON.stringify(v)).slice(0, 40);

function rejects(label, change) {
  check('validation rejects ' + label, () => {
    const g = fullGame();
    change(g);
    const msg = G.validateGame(g);
    assert(typeof msg === 'string' && msg, 'expected an error');
    assert(!/[<>]/.test(msg), 'the error must not repeat the hostile value: ' + msg);
  });
}
function accepts(label, change) {
  check('validation accepts ' + label, () => {
    const g = fullGame();
    change(g);
    eq(G.validateGame(g), null, 'validation error');
  });
}

[HOSTILE, 20260208, ['2026-02-08'], '2026-2-8', '2026-02-08' + HOSTILE, '2026-02-08\n'].forEach(v =>
  rejects('a game date of ' + show(v), g => { g.gameDate = v; }));
['teamA', 'teamB', 'description'].forEach(key => {
  rejects(key + ' that is an object', g => { g[key] = { a: 'x' }; });
  rejects(key + ' that is an array', g => { g[key] = [HOSTILE]; });
  rejects('a very long ' + key, g => { g[key] = 'x'.repeat(201); });
  accepts(key + ' with markup characters (escaped on screen)', g => { g[key] = 'A & B <3'; });
});
rejects('a league sent as an array', g => { g.league = ['nfl']; });
rejects('a custom color on an NFL game that is not a color', g => { g.teamAColor = HOSTILE; });
rejects('a custom color sent as an array', g => { g.league = 'other'; g.teamBColor = ['#336699']; });
accepts('cleared custom colors', g => { g.teamAColor = null; g.teamBColor = null; });

[HOSTILE, '10', [10], true, -1, null, 1e9].forEach(v =>
  rejects('a square price of ' + show(v), g => { g.squarePrice = v; }));
accepts('a price in cents', g => { g.squarePrice = 0.5; });
['25', [25], true].forEach(v =>
  rejects('a payout of ' + show(v), g => { g.payouts.q1 = v; }));
rejects('payouts sent as an array', g => { g.payouts = [25, 25, 25, 25]; });
['100', [100], true, '', 1e12].forEach(v =>
  rejects('a pot override of ' + show(v), g => { g.potOverride = v; }));
accepts('a pot override of 0', g => { g.potOverride = 0; });

rejects('an unknown pick mode', g => { g.pickMode = HOSTILE; });
['manual', 'auto', 'both'].forEach(v => accepts('pick mode ' + v, g => { g.pickMode = v; }));
rejects('a status sent as an array', g => { g.status = ['started']; });
rejects('a scoring mode sent as an array', g => { g.scoring = ['live']; });
[HOSTILE, 5, {}, 'tomorrow', '2026-02-08T18:45' + HOSTILE].forEach(v => {
  rejects('a cutoff time of ' + show(v), g => { g.autoCutoffTime = v; });
  rejects('a kickoff time of ' + show(v), g => { g.kickoffTime = v; });
});
accepts('a cutoff and a kickoff time', g => { g.autoCutoffTime = '2026-02-08T18:45'; g.kickoffTime = '2026-01-26T18:00Z'; });
accepts('a full ISO kickoff time', g => { g.kickoffTime = '2026-01-26T18:00:00.000+05:00'; });
accepts('no cutoff and no kickoff', g => { g.autoCutoffTime = null; g.kickoffTime = null; });

rejects('a name that is too long', g => { g.squares[0] = { name: 'x'.repeat(41) }; });
rejects('a square sent as text', g => { g.squares[0] = HOSTILE; });
['__proto__', 'constructor', 'toString', 'hasOwnProperty'].forEach(n => {
  rejects('the name ' + n + ', which every object already has', g => { g.squares[0] = { name: n }; });
  rejects('a player record named ' + n, g => { g.players = JSON.parse('{"' + n + '":{"paid":true}}'); });
  check('isPlayerName refuses ' + n, () => eq(G.isPlayerName(n), false));
});
accepts('a subscripted and an accented name', g => { g.squares[0] = { name: "Zoë O'Neil₁₂" }; });

[HOSTILE, 'red', '#fff', '#12345', 123456, ['#336699'], '#336699;background:url(//x)', '#336699\n'].forEach(v =>
  rejects('a player color of ' + show(v), g => { g.players = { Ann: { paid: false, color: v } }; }));
rejects('a player that is text', g => { g.players = { Ann: HOSTILE }; });
rejects('a player that is null', g => { g.players = { Ann: null }; });
rejects('a paid flag that is not a boolean', g => { g.players = { Ann: { paid: HOSTILE } }; });
rejects('too many player records', g => { for (let i = 0; i < 501; i++) g.players['p' + i] = { paid: false }; });
accepts('a player with no color yet', g => { g.players = { Ann: { paid: true }, Bob: { paid: false, color: '#Feca57' } }; });

[HOSTILE, '7', [7], {}, true, -1, 7.5, 10000].forEach(v => {
  rejects('a quarter score of ' + show(v), g => { g.results = { q1: { a: v, b: 0 } }; });
  rejects('a live score of ' + show(v), g => { g.liveScore = { a: 0, b: v }; });
});
rejects('a result that is not an object', g => { g.results = { q1: HOSTILE }; });
accepts('a blank, half-entered and cleared result', g => { g.results = { q1: { a: 7 }, q2: { a: '', b: null }, q3: {}, final: { a: 999, b: 0 } }; });

const draw = { key: '5-6', row: 4, col: 7, drawnAt: 1787441568511 };
accepts('a stored draw', g => { g.results = { final: { a: 1, b: 1, autoResolve: draw } }; });
[['row', '4'], ['row', 10], ['row', -1], ['col', HOSTILE], ['col', 1.5], ['key', HOSTILE], ['key', ['5-6']], ['drawnAt', HOSTILE]].forEach(([k, v]) =>
  rejects('a draw with ' + k + ' ' + show(v), g => { g.results = { final: { a: 1, b: 1, autoResolve: Object.assign({}, draw, { [k]: v }) } }; }));
rejects('a draw that is an array', g => { g.results = { final: { a: 1, b: 1, autoResolve: [] } }; });

accepts('a live score', g => { g.liveScore = { a: 7, b: 3, period: 2, clock: '8:41', state: 'in', statusName: 'STATUS_IN_PROGRESS', completed: false, updatedAt: '2026-10-11T20:05:00.000Z' }; });
accepts('no live score', g => { g.liveScore = null; });
[['period', HOSTILE], ['period', '2'], ['clock', [HOSTILE]], ['clock', 5], ['clock', 'x'.repeat(41)], ['state', {}], ['statusName', 4], ['updatedAt', 5], ['updatedAt', 'x'.repeat(41)]].forEach(([k, v]) =>
  rejects('a live score with ' + k + ' ' + show(v), g => { g.liveScore = { a: 7, b: 3, [k]: v }; }));
rejects('a live score that is text', g => { g.liveScore = HOSTILE; });

accepts('a generated simulation plan', g => { g.simPlan = G.buildSimPlan(); });
// The server adds these points up into a live score without validating again.
[['points', HOSTILE], ['points', '7'], ['points', -7], ['atMs', '5'], ['team', 'c']].forEach(([k, v]) =>
  rejects('a simulated play with ' + k + ' ' + show(v), g => {
    g.simPlan = G.buildSimPlan();
    g.simPlan.events[0][k] = v;
  }));
rejects('a simulation plan whose plays are not a list', g => { g.simPlan = Object.assign(G.buildSimPlan(), { events: 'x' }); });
rejects('a simulation plan with a bad quarter length', g => { g.simPlan = Object.assign(G.buildSimPlan(), { quarterMs: '1' }); });
rejects('a simulation plan with a bad start', g => { g.simPlan = Object.assign(G.buildSimPlan(), { startedAt: HOSTILE }); });
rejects('a simulation plan with a thousand plays', g => { g.simPlan = G.buildSimPlan(); while (g.simPlan.events.length < 1000) g.simPlan.events.push({ team: 'a', atMs: 1, points: 1 }); });

check('validation never throws, whatever the shape', () => {
  const values = [null, undefined, 0, 1, '', 'x', true, [], {}, [null], [[]], { a: null }, { q1: 5 }, JSON.parse('{"__proto__":1}')];
  Object.keys(fullGame()).concat('liveScore', 'simPlan', 'potOverride', 'autoCutoffTime', 'kickoffTime', 'scoring').forEach(key => {
    values.forEach(v => {
      const g = fullGame();
      g[key] = v;
      const msg = G.validateGame(g);
      assert(msg === null || typeof msg === 'string', key + ' gave ' + typeof msg);
    });
  });
});

check('what the app itself writes still validates', () => {
  const manual = Object.assign(fullGame(), { scoring: 'manual', results: {} });
  ['add', 'set', 'end', 'final'].forEach(op => {
    const r = G.applyScoreOp(manual, { op, side: 'a', points: 7, a: 7, b: 3 });
    eq(G.validateGame(r.game), null, op);
  });
  const sim = Object.assign(fullGame(), { simulation: true, scoring: 'simulation', results: {} });
  eq(G.validateGame(G.lockGame(sim)), null, 'a locked simulation');
});

// ---------- auto cutoff ----------

check('cutoff fires only after the configured time', () => {
  const g = fullGame();
  g.status = 'picking';
  g.autoCutoffEnabled = true;
  for (const time of ['2026-02-08T23:30:00.000Z', '2026-02-08T18:30-05:00']) {
    g.autoCutoffTime = time;
    const cutoff = Date.UTC(2026, 1, 8, 23, 30);
    assert(!G.cutoffPassed(g, cutoff - 1000), 'must not fire before the cutoff');
    assert(G.cutoffPassed(g, cutoff), 'must fire at the cutoff');
  }
});

// Issue #4: a bare local time is a different instant on the server (UTC) than on the
// host's device, and locked boards hours early.
check('a cutoff with no time zone never locks the board', () => {
  const g = fullGame();
  g.status = 'picking';
  g.autoCutoffEnabled = true;
  g.autoCutoffTime = '2026-02-08T18:30';
  assert(!G.cutoffPassed(g, Date.UTC(2030, 0, 1)), 'no zone, no lock');
});

check('cutoff never re-fires on an already started game', () => {
  const g = fullGame();
  g.status = 'started';
  g.autoCutoffEnabled = true;
  g.autoCutoffTime = '2020-01-01T00:00:00Z';
  assert(!G.cutoffPassed(g), 'a started game must not be locked again');
});

check('locking draws both axes and starts the game', () => {
  const g = fullGame();
  g.status = 'picking';
  G.lockGame(g);
  eq(g.status, 'started', 'status');
  assert(G.isDigitPermutation(g.axisX) && G.isDigitPermutation(g.axisY), 'both axes must be 0-9 permutations');
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
