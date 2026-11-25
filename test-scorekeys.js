// Keyboard scoring on Game Day (R25 part b): the pure parts in public/compute.js.
// scoreKeyOp maps a key to a score op for a league; inverseScoreOp says how to undo an op
// that was just applied, given the board before and after. Test-first because a wrong undo
// moves a score that decides who wins money.
//
// Run with:  node test-scorekeys.js   (or: npm test)
'use strict';

const G = require('./public/compute.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}\n      ${e.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const add = (side, points) => ({ op: 'add', side, points });

// ---- key to op ----
check('NFL: Q W E R and U I O P run left to right down the buttons', () => {
  [6, 1, 3, 2].forEach((points, i) => {
    eq(G.scoreKeyOp('nfl', 'qwer'[i]), add('a', points));
    eq(G.scoreKeyOp('nfl', 'uiop'[i]), add('b', points));
  });
});
check('NBA: three plays, so the fourth key does nothing', () => {
  [1, 2, 3].forEach((points, i) => {
    eq(G.scoreKeyOp('nba', 'qwe'[i]), add('a', points));
    eq(G.scoreKeyOp('nba', 'uio'[i]), add('b', points));
  });
  eq([G.scoreKeyOp('nba', 'r'), G.scoreKeyOp('nba', 'p')], [null, null]);
});
check('other sports: Q and U are +1, the rest do nothing', () => {
  eq(G.scoreKeyOp('other', 'q'), add('a', 1));
  eq(G.scoreKeyOp('other', 'u'), add('b', 1));
  eq(G.scoreKeyOp('other', 'w'), null);
  eq(G.scoreKeyOp('other', 'p'), null);
});
check('the pad lists the same plays in the same order', () => {
  eq(G.scorePlays('nfl').map(p => p.points), [6, 1, 3, 2]);
  eq(G.scorePlays('nba').map(p => p.points), [1, 2, 3]);
  eq(G.scorePlays('hockey').map(p => p.points), [1]);
});
check('an unknown league is treated as other', () => {
  eq(G.scoreKeyOp(undefined, 'q'), add('a', 1));
  eq(G.scoreKeyOp('hockey', 'u'), add('b', 1));
});
check('keys are case-insensitive', () => {
  eq(G.scoreKeyOp('nfl', 'Q'), add('a', 6));
  eq(G.scoreKeyOp('nfl', 'O'), add('b', 3));
});
check('other keys, empty and non-string input give null', () => {
  eq(G.scoreKeyOp('nfl', 'z'), null);
  eq(G.scoreKeyOp('nfl', 'Enter'), null);
  eq(G.scoreKeyOp('nfl', ''), null);
  eq(G.scoreKeyOp('nfl', undefined), null);
  eq(G.scoreKeyOp('nfl', 7), null);
  eq(G.scoreKeyOp('nfl', 'qq'), null);
});
check('each call returns a fresh op', () => {
  const a = G.scoreKeyOp('nfl', 'q');
  a.points = 99;
  eq(G.scoreKeyOp('nfl', 'q'), add('a', 6));
});

// ---- inverse of an op ----
function started(extra) {
  return Object.assign({ id: 'g', status: 'started', scoring: 'manual', league: 'nfl', squares: new Array(100).fill(null), results: {} }, extra || {});
}
function after(game, op) {
  const r = G.applyScoreOp(game, op);
  if (r.error) throw new Error('setup failed: ' + r.error);
  return r.game;
}

check('an add is undone by the opposite add', () => {
  const before = started();
  const next = after(before, add('a', 7));
  eq(G.inverseScoreOp(add('a', 7), before, next), add('a', -7));
  const next2 = after(next, add('b', 3));
  eq(G.inverseScoreOp(add('b', 3), next, next2), add('b', -3));
});
check('undoing an add really returns the score', () => {
  const before = after(started(), add('b', 3));
  const next = after(before, add('a', 7));
  const inv = G.inverseScoreOp(add('a', 7), before, next);
  const back = after(next, inv);
  eq(G.manualState(back), G.manualState(before), 'score');
});
check('an add clamped at 999 undoes only what it moved', () => {
  const before = after(started(), { op: 'set', a: 995, b: 0 });
  const next = after(before, add('a', 7));
  eq(G.manualState(next).a, 999, 'clamped');
  eq(G.inverseScoreOp(add('a', 7), before, next), add('a', -4));
});
check('a subtraction clamped at 0 undoes only what it moved', () => {
  const before = after(started(), { op: 'set', a: 2, b: 0 });
  const next = after(before, add('a', -7));
  eq(G.manualState(next).a, 0, 'clamped');
  eq(G.inverseScoreOp(add('a', -7), before, next), add('a', 2));
});
check('an add that moved nothing has nothing to undo', () => {
  const before = after(started(), { op: 'set', a: 999, b: 0 });
  const next = after(before, add('a', 7));
  eq(G.inverseScoreOp(add('a', 7), before, next), null);
  const zero = started();
  eq(G.inverseScoreOp(add('a', -1), zero, after(zero, add('a', -1))), null);
});
check('end and final are undone by the undo op', () => {
  const b0 = after(started(), add('a', 7));
  const ended = after(b0, { op: 'end' });
  eq(G.inverseScoreOp({ op: 'end' }, b0, ended), { op: 'undo', expect: 'q1' }, 'end');
  const fin = after(ended, { op: 'final' });
  eq(G.inverseScoreOp({ op: 'final' }, ended, fin), { op: 'undo', expect: 'final' }, 'final');
});
check('the undo op really reverses an end', () => {
  const b0 = after(started(), add('a', 7));
  const ended = after(b0, { op: 'end' });
  const back = after(ended, G.inverseScoreOp({ op: 'end' }, b0, ended));
  eq(back.results, b0.results, 'results');
  eq(G.manualState(back), G.manualState(b0), 'score');
});
check('an end that changed nothing has nothing to undo', () => {
  const finished = after(after(started(), add('a', 7)), { op: 'final' });
  eq(G.inverseScoreOp({ op: 'end' }, finished, finished), null);
});
check('a typed score is undone by typing the old one, guarded by what it showed', () => {
  const before = after(started(), add('a', 7));
  const op = { op: 'set', a: 14, b: 3 };
  const next = after(before, op);
  const inv = G.inverseScoreOp(op, before, next);
  eq(inv, { op: 'set', a: 7, b: 0, from: { a: 14, b: 3 } });
  eq(G.manualState(after(next, inv)), G.manualState(before));
  eq(G.applyScoreOp(after(next, add('b', 3)), inv).code, 'illegal', 'someone else scored since');
  eq(G.inverseScoreOp({ op: 'set', a: 7, b: 0 }, before, before), null, 'nothing moved');
});
check('a fix is undone by the old quarter score, guarded by what it showed', () => {
  const b0 = after(after(started(), add('a', 7)), { op: 'end' });
  const op = { op: 'edit', quarter: 'q1', a: 10, b: 3 };
  const next = after(b0, op);
  const inv = G.inverseScoreOp(op, b0, next);
  eq(inv, { op: 'edit', quarter: 'q1', a: 7, b: 0, from: { a: 10, b: 3 } });
  eq(after(next, inv).results, b0.results);
  eq(G.applyScoreOp(after(next, { op: 'edit', quarter: 'q1', a: 9, b: 9 }), inv).code, 'illegal');
  eq(G.inverseScoreOp(op, next, next), null, 'nothing changed');
});
check('a filled-in or cleared quarter is undone on a Live board', () => {
  const live = started({ scoring: 'live', liveScore: { a: 7, b: 0, period: 2, state: 'in' } });
  const fill = { op: 'edit', quarter: 'q1', a: 7, b: 0 };
  const filled = after(live, fill);
  const inv = G.inverseScoreOp(fill, live, filled);
  eq(inv, { op: 'edit', quarter: 'q1', a: null, b: null, from: { a: 7, b: 0 } });
  eq(after(filled, inv).results, {});
  const clear = { op: 'edit', quarter: 'q1', a: null, b: null };
  const cleared = after(filled, clear);
  const back = G.inverseScoreOp(clear, filled, cleared);
  eq(back, { op: 'edit', quarter: 'q1', a: 7, b: 0, from: null });
  eq(after(cleared, back).results, filled.results);
});
check('taking a Live board over is not undone by a score (Back to live does that)', () => {
  const live = started({ scoring: 'live', liveScore: { a: 7, b: 0, period: 2, state: 'in' } });
  const op = { op: 'set', a: 7, b: 0, override: true };
  eq(G.inverseScoreOp(op, live, after(live, op)), null);
});
check('end in a tied fourth quarter is undone as overtime', () => {
  let g = started();
  for (let i = 0; i < 3; i++) g = after(g, { op: 'end' });
  const ot = after(g, { op: 'end' });
  eq(G.inverseScoreOp({ op: 'end' }, g, ot), { op: 'undo', expect: 'ot' });
});
check('resume, undo, draw and junk have no inverse', () => {
  const before = started();
  const next = after(before, add('a', 1));
  eq(G.inverseScoreOp({ op: 'resume' }, before, next), null, 'resume');
  eq(G.inverseScoreOp({ op: 'undo' }, before, next), null, 'undo');
  eq(G.inverseScoreOp({ op: 'draw' }, before, next), null, 'draw');
  eq(G.inverseScoreOp(null, before, next), null, 'null');
  eq(G.inverseScoreOp(add('a', 1), null, next), null, 'no before');
});

if (failures.length) {
  console.log(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach(f => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log(`test-scorekeys.js: ${passed} passed`);
