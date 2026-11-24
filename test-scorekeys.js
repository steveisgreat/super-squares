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
check('NFL: Q W E are team A +7 +3 +2', () => {
  eq(G.scoreKeyOp('nfl', 'q'), add('a', 7), 'q');
  eq(G.scoreKeyOp('nfl', 'w'), add('a', 3), 'w');
  eq(G.scoreKeyOp('nfl', 'e'), add('a', 2), 'e');
});
check('NFL: P O I are team B +7 +3 +2', () => {
  eq(G.scoreKeyOp('nfl', 'p'), add('b', 7), 'p');
  eq(G.scoreKeyOp('nfl', 'o'), add('b', 3), 'o');
  eq(G.scoreKeyOp('nfl', 'i'), add('b', 2), 'i');
});
check('NBA: the same keys give +3 +2 +1', () => {
  eq(G.scoreKeyOp('nba', 'q'), add('a', 3));
  eq(G.scoreKeyOp('nba', 'w'), add('a', 2));
  eq(G.scoreKeyOp('nba', 'e'), add('a', 1));
  eq(G.scoreKeyOp('nba', 'p'), add('b', 3));
  eq(G.scoreKeyOp('nba', 'o'), add('b', 2));
  eq(G.scoreKeyOp('nba', 'i'), add('b', 1));
});
check('other sports: Q and P are +1, the rest do nothing', () => {
  eq(G.scoreKeyOp('other', 'q'), add('a', 1));
  eq(G.scoreKeyOp('other', 'p'), add('b', 1));
  eq(G.scoreKeyOp('other', 'w'), null);
  eq(G.scoreKeyOp('other', 'i'), null);
});
check('an unknown league is treated as other', () => {
  eq(G.scoreKeyOp(undefined, 'q'), add('a', 1));
  eq(G.scoreKeyOp('hockey', 'p'), add('b', 1));
});
check('keys are case-insensitive', () => {
  eq(G.scoreKeyOp('nfl', 'Q'), add('a', 7));
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
  eq(G.scoreKeyOp('nfl', 'q'), add('a', 7));
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
  eq(G.inverseScoreOp({ op: 'end' }, b0, ended), { op: 'undo' }, 'end');
  const fin = after(ended, { op: 'final' });
  eq(G.inverseScoreOp({ op: 'final' }, ended, fin), { op: 'undo' }, 'final');
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
check('set, edit, resume, undo and junk have no inverse', () => {
  const before = started();
  const next = after(before, add('a', 1));
  eq(G.inverseScoreOp({ op: 'set', a: 1, b: 1 }, before, next), null, 'set');
  eq(G.inverseScoreOp({ op: 'edit', quarter: 'q1', a: 1, b: 1 }, before, next), null, 'edit');
  eq(G.inverseScoreOp({ op: 'resume' }, before, next), null, 'resume');
  eq(G.inverseScoreOp({ op: 'undo' }, before, next), null, 'undo');
  eq(G.inverseScoreOp(null, before, next), null, 'null');
  eq(G.inverseScoreOp(add('a', 1), null, next), null, 'no before');
});

if (failures.length) {
  console.log(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach(f => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log(`test-scorekeys.js: ${passed} passed`);
