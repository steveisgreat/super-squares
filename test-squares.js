// GameLogic.applySquaresOp (R38, decision 025 section 5): what a squares manager may do to a board.
// Pure and test-first: paid marks are money records.
//
// Run with:  node test-squares.js   (or: npm test)
'use strict';

const GL = require('./public/compute.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const NOW = Date.UTC(2027, 1, 14, 18, 0, 0);
const TAG = 'abcdefghijklmnopqrstuv';

// held: { name: [indexes] }, players: the paid records.
function board(held, players, extra) {
  const squares = new Array(100).fill(null);
  const all = {};
  Object.keys(held || {}).forEach(n => {
    held[n].forEach((i, k) => { squares[i] = { name: n, at: 1000 + k }; });
    all[n] = Object.assign({ paid: false, color: '#336699' }, (players || {})[n]);
  });
  return Object.assign({
    id: 'x', league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles', squarePrice: 10,
    payouts: { q1: 25, q2: 25, q3: 25, final: 25 }, status: 'picking', scoring: 'manual', pickMode: 'both',
    squares, players: all, axisX: null, axisY: null, results: {}
  }, extra);
}
const lock = (g) => Object.assign(g, { status: 'started', axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
const run = (g, op, ctx) => {
  const before = JSON.stringify(g);
  const r = GL.applySquaresOp(g, op, Object.assign({ now: NOW, random: () => 0 }, ctx));
  eq(JSON.stringify(g), before, 'the input was changed');
  if (r.game) {
    eq(GL.validateGame(r.game), null, 'valid afterwards');
    const strip = (x) => JSON.stringify(Object.assign({}, x, { squares: 0, players: 0, guestPick: 0 }));
    eq(strip(r.game), strip(g), 'only squares, players and guestPick may change');
  }
  return r;
};
const ok = (g, op, ctx) => { const r = run(g, op, ctx); assert(!r.error, `refused: ${r.error}`); return r; };
const no = (g, op, code, ctx) => { const r = run(g, op, ctx); eq([!!r.error, r.code, r.game], [true, code, undefined], `${JSON.stringify(op)} → ${r.error || 'allowed'}`); return r; };
const of = (g, n) => g.squares.map((s, i) => (s && s.name === n ? i : -1)).filter(i => i >= 0);
const paidOf = (g, n) => GL.paidSquareCount(g, n);

// ---------- shape ----------
check('malformed operations are refused', () => {
  const g = board({ Gus: [1, 2] });
  [null, [], 'claim', {}, { op: 'lock' }, { op: 'release', squares: [1] }, { op: 'claim', name: 'Gus' },
    { op: 'claim', name: 'Gus', squares: [3] }, { op: 'claim', name: 'Gus', count: 1 },
    { op: 'claim', name: 'Gus', squares: [3], count: 1, have: 2 }, { op: 'claim', name: 'Gus', squares: [], have: 2 },
    { op: 'claim', name: 'Gus', squares: [3, 3], have: 2 }, { op: 'claim', name: 'Gus', squares: [100], have: 2 },
    { op: 'claim', name: 'Gus', squares: ['3'], have: 2 }, { op: 'claim', name: 'Gus', count: 0, have: 2 },
    { op: 'claim', name: 'Gus', count: 1.5, have: 2 }, { op: 'claim', name: 'Gus', count: 1, have: -1 },
    { op: 'claim', count: 1, have: 0 }, { op: 'claim', name: 7, count: 1, have: 0 },
    { op: 'claim', name: '__proto__', count: 1, have: 0 }, { op: 'claim', name: 'a name too long', count: 1, have: 0 },
    { op: 'claim', name: '  ', count: 1, have: 0 },
    { op: 'removeUnpaid', name: 'Gus' }, { op: 'removeUnpaid', name: 'Gus', have: 2 }, { op: 'removeUnpaid', have: 2, unpaid: 2 },
    { op: 'removeUnpaid', name: 'Gus', have: 2, unpaid: 0 }, { op: 'removeUnpaid', name: 'Gus', have: '2', unpaid: 2 },
    { op: 'paid', name: 'Gus' }, { op: 'paid', name: 'Gus', paidSquares: 1 }, { op: 'paid', name: 'Gus', paidSquares: 1, have: 2 },
    { op: 'paid', name: 'Gus', paidSquares: -1, have: 2, was: 0 }, { op: 'paid', name: 'Gus', paidSquares: '2', have: 2, was: 0 },
    { op: 'paid', name: 'Gus', paidSquares: 101, have: 2, was: 0 }, { op: 'paid', name: {}, paidSquares: 1, have: 2, was: 0 },
    { op: 'picks' }, { op: 'picks', on: 'yes' }, { op: 'picks', on: true, max: 0 }, { op: 'picks', max: 101 }, { op: 'picks', max: 2.5 }, { op: 'picks', max: null }
  ].forEach(op => no(g, op, 'invalid'));
});

check('an operation carries nothing but its own fields', () => {
  const g = board({ Gus: [1] });
  const r = ok(g, { op: 'paid', name: 'Gus', paidSquares: 1, have: 1, was: 0, squares: [], squarePrice: 0, status: 'started', players: {}, guestPick: {} });
  eq([r.game.squarePrice, r.game.status, of(r.game, 'Gus')], [10, 'picking', [1]], 'untouched');
});

// ---------- claim ----------
check('adds chosen squares for someone new: unpaid, colored, stamped by the server', () => {
  const r = ok(board({}), { op: 'claim', name: ' Gus ', squares: [5, 7], have: 0 });
  eq(of(r.game, 'Gus'), [5, 7], 'squares');
  eq(r.game.squares[5], { name: 'Gus', at: NOW / 1000 }, 'stamp');
  eq([r.game.players.Gus.paid, paidOf(r.game, 'Gus'), GL.isColor(r.game.players.Gus.color)], [false, 0, true], 'record');
  eq([r.name, r.changed], ['Gus', true], 'answer');
});

check('adds random open squares, never a taken one', () => {
  const g = board({ Ann: Array.from({ length: 97 }, (_, i) => i) });
  const r = ok(g, { op: 'claim', name: 'Gus', count: 3, have: 0 });
  eq([of(r.game, 'Gus'), of(r.game, 'Ann').length], [[97, 98, 99], 97], 'squares');
  no(g, { op: 'claim', name: 'Gus', count: 4, have: 0 }, 'illegal');
  no(board({ Ann: Array.from({ length: 100 }, (_, i) => i) }), { op: 'claim', name: 'Gus', count: 1, have: 0 }, 'illegal');
});

check('adding never pays for, or un-pays, what a name already had', () => {
  const paid = ok(board({ Gus: [1, 2] }, { Gus: { paid: true } }), { op: 'claim', name: 'Gus', count: 3, have: 2 }).game;
  eq([of(paid, 'Gus').length, paidOf(paid, 'Gus'), paid.players.Gus.paid, paid.players.Gus.paidSquares], [5, 2, false, 2], 'was paid');
  const part = ok(board({ Gus: [1, 2, 3] }, { Gus: { paidSquares: 1 } }), { op: 'claim', name: 'Gus', squares: [9], have: 3 }).game;
  eq([of(part, 'Gus').length, paidOf(part, 'Gus')], [4, 1], 'was part paid');
  const none = ok(board({ Gus: [1] }), { op: 'claim', name: 'Gus', squares: [9], have: 1 }).game;
  eq(paidOf(none, 'Gus'), 0, 'was unpaid');
});

check('a taken square refuses the lot and names which', () => {
  const r = no(board({ Ann: [5] }), { op: 'claim', name: 'Gus', squares: [4, 5], have: 0 }, 'illegal');
  eq(r.taken, [5], 'taken');
});

check('a retry or a stale screen never claims twice', () => {
  const chosen = { op: 'claim', name: 'Gus', squares: [5, 7], have: 0 };
  const a = ok(board({}), chosen).game;
  const again = ok(a, chosen);
  eq([again.changed, of(again.game, 'Gus')], [false, [5, 7]], 'chosen again');
  const some = JSON.parse(JSON.stringify(a));
  some.squares[7] = null; // the host took one back meanwhile
  no(some, chosen, 'illegal');
  const count = { op: 'claim', name: 'Gus', count: 2, have: 0 };
  no(ok(board({}), count).game, count, 'illegal');
  no(board({ Gus: [1, 2, 3] }), { op: 'claim', name: 'Gus', squares: [9], have: 2 }, 'illegal');
});

check('a name already on the board is never merged by a near-match, or by surprise', () => {
  const g = board({ Gus: [1], 'Ann₂': [2] });
  no(g, { op: 'claim', name: 'gus', count: 1, have: 0 }, 'illegal');
  no(g, { op: 'claim', name: 'GUS ', squares: [9], have: 0 }, 'illegal');
  no(g, { op: 'claim', name: 'Ann', count: 1, have: 0 }, 'illegal');
  no(g, { op: 'claim', name: 'Gus', count: 1, have: 0 }, 'illegal'); // the screen thought this was a new person
  eq(of(ok(g, { op: 'claim', name: 'Ann₂', count: 1, have: 1 }).game, 'Ann₂').length, 2, 'the exact name, picked from the list');
});

check('a name whose squares are gone starts clean: no old paid mark or phone tag', () => {
  const g = board({});
  g.players.Gus = { paid: true, paidSquares: 4, g: TAG, color: '#112233' };
  const r = ok(g, { op: 'claim', name: 'Gus', count: 2, have: 0 });
  eq([paidOf(r.game, 'Gus'), r.game.players.Gus.g, r.game.players.Gus.paid], [0, undefined, false], 'clean');
});

check('adding for someone who picks on their own phone keeps their phone, and is not held to their limit', () => {
  const g = board({ Gus: [1] }, { Gus: { g: TAG } }, { guestPick: { on: true, max: 1, liftAt: null, lifted: false } });
  const r = ok(g, { op: 'claim', name: 'Gus', count: 2, have: 1 });
  eq([r.game.players.Gus.g, of(r.game, 'Gus').length], [TAG, 3], 'tag and squares');
});

check('the board\'s pick mode holds for a helper too', () => {
  no(board({}, {}, { pickMode: 'manual' }), { op: 'claim', name: 'Gus', count: 1, have: 0 }, 'illegal');
  no(board({}, {}, { pickMode: 'auto' }), { op: 'claim', name: 'Gus', squares: [1], have: 0 }, 'illegal');
  ok(board({}, {}, { pickMode: 'manual' }), { op: 'claim', name: 'Gus', squares: [1], have: 0 });
  ok(board({}, {}, { pickMode: 'auto' }), { op: 'claim', name: 'Gus', count: 1, have: 0 });
});

check('works on a board with no squares, no players record and no helper name', () => {
  const g = board({});
  delete g.players;
  const r = ok(g, { op: 'claim', name: 'Pat', count: 1, have: 0 });
  eq(of(r.game, 'Pat').length, 1, 'claimed');
  eq(ok(g, { op: 'picks', on: true, max: 4 }).game.guestPick, { on: true, max: 4, liftAt: null, lifted: false }, 'picks');
});

// ---------- removeUnpaid ----------
check('removes exactly the unpaid squares; the paid ones stay and read as paid', () => {
  const g = board({ Gus: [1, 2, 3, 4], Ann: [9] }, { Gus: { paidSquares: 1, g: TAG } });
  const r = ok(g, { op: 'removeUnpaid', name: 'Gus', have: 4, unpaid: 3 });
  eq([of(r.game, 'Gus'), of(r.game, 'Ann')], [[1], [9]], 'squares');
  eq([r.game.players.Gus.paid, r.game.players.Gus.paidSquares, r.game.players.Gus.g, paidOf(r.game, 'Gus')], [true, undefined, TAG, 1], 'record');
  eq(r.removed, [2, 3, 4], 'which');
});

check('someone who paid for nothing goes, with their record', () => {
  const r = ok(board({ Gus: [1, 2], Ann: [9] }, { Gus: { g: TAG } }), { op: 'removeUnpaid', name: 'Gus', have: 2, unpaid: 2 });
  eq([of(r.game, 'Gus'), 'Gus' in r.game.players, 'Ann' in r.game.players], [[], false, true], 'gone');
});

check('a paid square is never removed, whatever the operation says', () => {
  no(board({ Gus: [1, 2] }, { Gus: { paid: true } }), { op: 'removeUnpaid', name: 'Gus', have: 2, unpaid: 2 }, 'illegal');
  no(board({ Gus: [1, 2] }, { Gus: { paidSquares: 2 } }), { op: 'removeUnpaid', name: 'Gus', have: 2, unpaid: 2 }, 'illegal');
  for (let paid = 0; paid <= 6; paid++) {
    const g = board({ Gus: [1, 2, 3, 4, 5, 6] }, { Gus: paid === 6 ? { paid: true } : { paidSquares: paid } });
    const keep = new Set(of(g, 'Gus').filter(i => !GL.unpaidSquares(g).has(i)));
    for (let said = 1; said <= 6; said++) {
      const r = run(g, { op: 'removeUnpaid', name: 'Gus', have: 6, unpaid: said });
      eq(!!r.game, said === 6 - paid, `paid ${paid}, said ${said}`);
      if (r.game) keep.forEach(i => assert(r.game.squares[i] && r.game.squares[i].name === 'Gus', `paid square ${i} removed`));
      if (r.game) eq(paidOf(r.game, 'Gus'), paid, 'paid count');
    }
  }
});

check('a retry or a stale screen never removes twice', () => {
  const op = { op: 'removeUnpaid', name: 'Gus', have: 4, unpaid: 3 };
  const a = ok(board({ Gus: [1, 2, 3, 4] }, { Gus: { paidSquares: 1 } }), op).game;
  no(a, op, 'illegal');
  no(board({ Gus: [1, 2, 3, 4] }, { Gus: { paidSquares: 2 } }), op, 'illegal'); // one more was marked paid
  no(board({ Gus: [1, 2, 3, 4, 5] }, { Gus: { paidSquares: 1 } }), op, 'illegal'); // they picked another
  no(board({ Ann: [1] }), op, 'illegal');
  no(board({ Gus: [1] }), { op: 'removeUnpaid', name: 'gus', have: 1, unpaid: 1 }, 'illegal');
});

// ---------- paid ----------
check('marks all, some and none of a name paid', () => {
  const g = board({ Gus: [1, 2, 3], Ann: [9] }, { Gus: { g: TAG } });
  const all = ok(g, { op: 'paid', name: 'Gus', paidSquares: 3, have: 3, was: 0 }).game;
  eq([all.players.Gus.paid, all.players.Gus.paidSquares, all.players.Gus.g, paidOf(all, 'Ann')], [true, undefined, TAG, 0], 'all');
  const some = ok(all, { op: 'paid', name: 'Gus', paidSquares: 1, have: 3, was: 3 }).game;
  eq([some.players.Gus.paid, some.players.Gus.paidSquares], [false, 1], 'some');
  const none = ok(some, { op: 'paid', name: 'Gus', paidSquares: 0, have: 3, was: 1 }).game;
  eq([none.players.Gus.paid, none.players.Gus.paidSquares], [false, undefined], 'none');
});

check('never more squares than the name has, and never a name with none', () => {
  no(board({ Gus: [1] }), { op: 'paid', name: 'Gus', paidSquares: 2, have: 1, was: 0 }, 'illegal');
  no(board({ Gus: [1] }), { op: 'paid', name: 'Eve', paidSquares: 1, have: 1, was: 0 }, 'illegal');
  no(board({ Gus: [1] }), { op: 'paid', name: '__proto__', paidSquares: 0, have: 0, was: 0 }, 'illegal');
});

check('a stale screen never settles squares nobody paid for, or overwrites another mark', () => {
  no(board({ Gus: [1, 2, 3] }), { op: 'paid', name: 'Gus', paidSquares: 2, have: 2, was: 0 }, 'illegal');
  no(board({ Gus: [1, 2, 3] }, { Gus: { paidSquares: 2 } }), { op: 'paid', name: 'Gus', paidSquares: 1, have: 3, was: 0 }, 'illegal');
  const op = { op: 'paid', name: 'Gus', paidSquares: 2, have: 3, was: 0 };
  const again = ok(ok(board({ Gus: [1, 2, 3] }), op).game, op);
  eq([again.changed, paidOf(again.game, 'Gus')], [false, 2], 'a retry');
});

// ---------- picks ----------
check('player picks on or off and the limit, each alone or together; the rest stays', () => {
  const gp = { on: false, max: 5, liftAt: '2027-02-14T20:00:00Z', lifted: false };
  const g = board({}, {}, { guestPick: gp });
  eq(ok(g, { op: 'picks', on: true }).game.guestPick, Object.assign({}, gp, { on: true }), 'on');
  eq(ok(g, { op: 'picks', max: 9 }).game.guestPick, Object.assign({}, gp, { max: 9 }), 'limit');
  eq(ok(g, { op: 'picks', on: true, max: 9 }).game.guestPick, Object.assign({}, gp, { on: true, max: 9 }), 'both');
  eq(ok(g, { op: 'picks', on: false, max: 5 }).changed, false, 'nothing to do');
});

check('turning picks off keeps the squares people picked', () => {
  const g = board({ Gus: [1, 2] }, { Gus: { g: TAG } }, { guestPick: { on: true, max: 5, liftAt: null, lifted: false } });
  eq(of(ok(g, { op: 'picks', on: false }).game, 'Gus'), [1, 2], 'squares');
});

// ---------- before lock ----------
check('after lock only paid works, and so after the final', () => {
  for (const make of [g => lock(g), g => Object.assign(lock(g), { status: 'finished' }), g => Object.assign(g, { status: 'setup' }),
    g => Object.assign(g, { autoCutoffEnabled: true, autoCutoffTime: new Date(NOW - 1).toISOString() })]) {
    const g = make(board({ Gus: [1, 2] }));
    no(g, { op: 'claim', name: 'Ann', count: 1, have: 0 }, 'illegal');
    no(g, { op: 'claim', name: 'Ann', squares: [9], have: 0 }, 'illegal');
    no(g, { op: 'removeUnpaid', name: 'Gus', have: 2, unpaid: 2 }, 'illegal');
    no(g, { op: 'picks', on: true, max: 5 }, 'illegal');
    eq(paidOf(ok(g, { op: 'paid', name: 'Gus', paidSquares: 1, have: 2, was: 0 }).game, 'Gus'), 1, 'paid');
  }
  ok(board({}, {}, { autoCutoffEnabled: true, autoCutoffTime: new Date(NOW + 1).toISOString() }), { op: 'claim', name: 'Ann', count: 1, have: 0 });
});

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} failed, ${passed} passed`);
  failures.forEach(f => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log(`  squares: ${passed} passed`);
