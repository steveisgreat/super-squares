// Guest picks (R28, decision 019): the pure rules in public/compute.js (applyGuestOp and
// friends), the sbs_guest cookie and the POST / PATCH /api/game/:id/guest routes in all three
// auth modes. Routes run on the fs store always, and on Postgres when DATABASE_URL points at a
// throwaway Neon branch (with migration 002 absent from the routes' queries, which is checked).
//
// Run with:  node test-guest.js   (or: npm test)
'use strict';

const PG_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

const crypto = require('crypto');
const G = require('./public/compute.js');
const auth = require('./lib/auth.js');
const store = require('./lib/store.js');
const { handleApi } = require('./lib/api.js');

let passed = 0;
const failures = [];

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

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);
const AT = Math.floor(NOW / 1000);
const GAME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_GAME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tagOf = (label, game) => auth.guestTag(game || GAME, crypto.createHash('sha256').update(label).digest('base64url'));
const T1 = tagOf('device-1');
const T2 = tagOf('device-2');
const T3 = tagOf('device-3');

function board(extra) {
  return Object.assign({
    id: crypto.randomUUID(), league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    status: 'picking', scoring: 'manual', squares: new Array(100).fill(null),
    axisX: null, axisY: null, results: {}, players: {},
    guestPick: { on: true, max: 5, liftAt: null, lifted: false }
  }, extra);
}
// A board where `holders` ({ index: name }) already hold squares.
function held(holders, players, extra) {
  const b = board(extra);
  Object.keys(holders).forEach(i => { b.squares[i] = { name: holders[i] }; });
  Object.assign(b.players, players);
  return b;
}
const apply = (game, op, tag, extra) => G.applyGuestOp(game, op, Object.assign({ tag: tag || T1, now: NOW }, extra));
const claim = (game, name, squares, tag, extra) => apply(game, { op: 'claim', name, squares }, tag, extra);
const heldBy = (game, name) => game.squares.map((s, i) => (s && s.name === name ? i : -1)).filter(i => i >= 0);
const rest = (game) => { const g = JSON.parse(JSON.stringify(game)); delete g.squares; delete g.players; return g; };

function pure() {
  const t = (name, fn) => check(`rules: ${name}`, async () => fn());

  t('a claim by squares: names them, stamps the time, makes a fresh unpaid entry with the tag', () => {
    const before = board();
    const snapshot = JSON.stringify(before);
    const r = claim(before, 'Ann', [3, 4]);
    assert(!r.error, r.error);
    eq(snapshot, JSON.stringify(before), 'the input changed');
    eq([r.game.squares[3], r.game.squares[4], r.name, r.changed], [{ name: 'Ann', at: AT }, { name: 'Ann', at: AT }, 'Ann', true], 'squares');
    const p = r.game.players.Ann;
    eq([p.paid, p.g, /^#[0-9a-f]{6}$/.test(p.color)], [false, T1, true], 'player');
    eq(rest(r.game), rest(before), 'nothing but squares and players changes');
    assert(!G.validateGame(r.game), `valid: ${G.validateGame(r.game)}`);
  });

  t('a retry is safe: squares already yours count as done, and nothing is written', () => {
    const first = claim(board(), 'Ann', [3, 4]);
    const again = claim(first.game, 'Ann', [3, 4]);
    eq([again.changed, again.name, JSON.stringify(again.game)], [false, 'Ann', JSON.stringify(first.game)], 'retry');
    const more = claim(first.game, 'Ann', [4, 5]);
    eq([more.changed, heldBy(more.game, 'Ann')], [true, [3, 4, 5]], 'partly new');
    eq(more.game.squares[3].at, AT, 'the old claim keeps its time');
  });

  t('a taken square refuses the whole claim and says which', () => {
    const g = held({ 7: 'Bob', 9: 'Cy' }, { Bob: { paid: false }, Cy: { paid: false } });
    const r = claim(g, 'Ann', [1, 7, 2, 9]);
    eq([r.code, r.taken], ['illegal', [7, 9]], 'refused');
    eq(JSON.stringify(g), JSON.stringify(held({ 7: 'Bob', 9: 'Cy' }, { Bob: { paid: false }, Cy: { paid: false } }, { id: g.id })), 'input');
    assert(r.error, 'message');
  });

  t('the cap counts every square under the name, across claims', () => {
    let g = board({ guestPick: { on: true, max: 3, liftAt: null, lifted: false } });
    const a = claim(g, 'Ann', [0, 1]);
    eq(heldBy(a.game, 'Ann').length, 2, 'two');
    const over = claim(a.game, 'Ann', [2, 3]);
    eq(over.code, 'illegal', 'one over');
    assert(/up to 3/.test(over.error), over.error);
    eq(heldBy(a.game, 'Ann').length, 2, 'nothing claimed');
    eq(claim(a.game, 'Ann', [2]).changed, true, 'exactly at the cap');
    eq(claim(board({ guestPick: { on: true, max: 3, liftAt: null, lifted: false } }), 'Ann', [0, 1, 2, 3]).code, 'illegal', 'first claim too big');
    eq(G.guestCap(board({ guestPick: { on: true, max: 3, liftAt: null, lifted: false } }), NOW), 3, 'cap');
  });

  t('the cap ends at liftAt (judged at write time) or when lifted', () => {
    const lift = new Date(NOW + 1000).toISOString();
    const g = board({ guestPick: { on: true, max: 2, liftAt: lift, lifted: false } });
    eq(G.guestCap(g, NOW), 2, 'before');
    eq(G.guestCap(g, NOW + 999), 2, 'just before');
    eq(G.guestCap(g, NOW + 1000), Infinity, 'at liftAt');
    eq(claim(g, 'Ann', [0, 1, 2]).code, 'illegal', 'capped before liftAt');
    const later = G.applyGuestOp(g, { op: 'claim', name: 'Ann', squares: [0, 1, 2, 3, 4, 5, 6, 7] }, { tag: T1, now: NOW + 5000 });
    eq(heldBy(later.game, 'Ann').length, 8, 'lifted by the clock');
    const sw = board({ guestPick: { on: true, max: 2, liftAt: null, lifted: true } });
    eq(G.guestCap(sw, NOW), Infinity, 'the switch');
    eq(claim(sw, 'Ann', [0, 1, 2, 3]).changed, true, 'claims past max');
    eq(G.guestCap(board({ guestPick: { on: true, max: 2, liftAt: '2027-01-20T10:00', lifted: false } }), NOW), 2, 'a time with no zone never lifts');
    eq(G.guestCap(board({ guestPick: undefined }), NOW), 5, 'default');
  });

  t('guest picks work only while picking, and only when the host turned them on', () => {
    ['setup', 'started', 'finished'].forEach(status => {
      const r = claim(board({ status }), 'Ann', [0]);
      eq(r.code, 'illegal', status);
    });
    const started = held({ 0: 'Ann' }, { Ann: { paid: false, g: T1 } }, { status: 'started' });
    eq(apply(started, { op: 'release', squares: [0] }).code, 'illegal', 'release on a started board');
    eq(claim(board({ guestPick: undefined }), 'Ann', [0]).code, 'illegal', 'unset');
    eq(claim(board({ guestPick: { on: false, max: 5, liftAt: null, lifted: false } }), 'Ann', [0]).code, 'illegal', 'off');
    const past = board({ autoCutoffEnabled: true, autoCutoffTime: new Date(NOW - 1000).toISOString() });
    eq(claim(past, 'Ann', [0]).code, 'illegal', 'cutoff passed');
    eq(claim(board({ autoCutoffEnabled: true, autoCutoffTime: new Date(NOW + 1000).toISOString() }), 'Ann', [0]).changed, true, 'before cutoff');
    // A malformed op is a 400 whatever the state.
    eq(claim(board({ status: 'started' }), 'Ann', [-1]).code, 'invalid', 'bad op on a started board');
  });

  t('pick mode applies: Manual Only refuses a count, Auto Only refuses squares', () => {
    const count = { op: 'claim', name: 'Ann', count: 2, have: 0 };
    eq(apply(board({ pickMode: 'manual' }), count).code, 'illegal', 'manual refuses count');
    eq(claim(board({ pickMode: 'manual' }), 'Ann', [0]).changed, true, 'manual allows squares');
    eq(claim(board({ pickMode: 'auto' }), 'Ann', [0]).code, 'illegal', 'auto refuses squares');
    eq(apply(board({ pickMode: 'auto' }), count).changed, true, 'auto allows count');
    eq([apply(board({ pickMode: 'both' }), count).changed, apply(board(), count).changed], [true, true], 'both and unset');
    const h = held({ 0: 'Ann' }, { Ann: { paid: false, g: T1 } }, { pickMode: 'auto' });
    eq(apply(h, { op: 'release', squares: [0] }).changed, true, 'release in auto mode');
  });

  t('a claim by count: random open squares, have makes a retry safe', () => {
    const fixed = (seq) => { let i = 0; return () => seq[i++ % seq.length]; };
    const g = held({ 0: 'Bob', 1: 'Bob' }, { Bob: { paid: false } });
    const a = apply(g, { op: 'claim', name: 'Ann', count: 3, have: 0 }, T1, { random: fixed([0, 0.5, 0.99]) });
    const mine = heldBy(a.game, 'Ann');
    eq([mine.length, new Set(mine).size, mine.every(i => i > 1)], [3, 3, true], 'three distinct open squares');
    const b = apply(g, { op: 'claim', name: 'Ann', count: 3, have: 0 }, T1, { random: fixed([0, 0.5, 0.99]) });
    eq(heldBy(b.game, 'Ann'), mine, 'same random, same squares');
    const retry = apply(a.game, { op: 'claim', count: 3, have: 0 }, T1);
    eq([retry.code, /changed/.test(retry.error)], ['illegal', true], 'a retry with a stale have claims nothing');
    eq(apply(a.game, { op: 'claim', count: 2, have: 3 }, T1).changed, true, 'with the right have');
    eq(apply(g, { op: 'claim', name: 'Ann', count: 1, have: 1 }, T1).code, 'illegal', 'have too high');
    const full = held({}, {});
    full.squares = full.squares.map((s, i) => (i < 98 ? { name: 'Bob' } : null));
    full.players.Bob = { paid: false };
    eq(apply(full, { op: 'claim', name: 'Ann', count: 3, have: 0 }).code, 'illegal', 'more than the empty squares');
    eq(apply(full, { op: 'claim', name: 'Ann', count: 2, have: 0 }).changed, true, 'exactly the empty squares');
    const lots = board({ guestPick: { on: true, max: 100, liftAt: null, lifted: false } });
    eq(heldBy(apply(lots, { op: 'claim', name: 'Ann', count: 100, have: 0 }).game, 'Ann').length, 100, 'all hundred');
  });

  t('a malformed op is a 400', () => {
    const bad = [
      null, [], 'claim', { op: 'steal', name: 'Ann', squares: [0] }, { name: 'Ann', squares: [0] },
      { op: 'claim', name: 'Ann' }, { op: 'claim', name: 'Ann', squares: [0], count: 1, have: 0 },
      { op: 'claim', name: 'Ann', squares: [] }, { op: 'claim', name: 'Ann', squares: 5 }, { op: 'claim', name: 'Ann', squares: '1' },
      { op: 'claim', name: 'Ann', squares: [1, 1] }, { op: 'claim', name: 'Ann', squares: [-1] }, { op: 'claim', name: 'Ann', squares: [100] },
      { op: 'claim', name: 'Ann', squares: [1.5] }, { op: 'claim', name: 'Ann', squares: ['1'] }, { op: 'claim', name: 'Ann', squares: [null] },
      { op: 'claim', name: 'Ann', squares: Array.from({ length: 101 }, (_, i) => i % 100) },
      { op: 'claim', name: 'Ann', count: 0, have: 0 }, { op: 'claim', name: 'Ann', count: -1, have: 0 }, { op: 'claim', name: 'Ann', count: 1.5, have: 0 },
      { op: 'claim', name: 'Ann', count: 101, have: 0 }, { op: 'claim', name: 'Ann', count: 1 }, { op: 'claim', name: 'Ann', count: 1, have: -1 },
      { op: 'claim', name: 'Ann', count: 1, have: '0' }, { op: 'claim', name: 'Ann', count: '1', have: 0 },
      { op: 'release' }, { op: 'release', squares: [] }, { op: 'release', squares: [1, 1] }, { op: 'release', squares: [0], count: 1 }, { op: 'release', count: 1, have: 0 }
    ];
    bad.forEach((op, i) => {
      const r = apply(held({ 0: 'Ann' }, { Ann: { paid: false, g: T1 } }), op);
      eq([i, r.code], [i, 'invalid'], JSON.stringify(op));
    });
    eq(G.applyGuestOp(board(), { op: 'claim', name: 'Ann', squares: [0] }, { now: NOW }).code, 'invalid', 'no tag');
    eq(G.applyGuestOp(board(), { op: 'claim', name: 'Ann', squares: [0] }, { tag: 'short', now: NOW }).code, 'invalid', 'bad tag');
  });

  t('name rules: 1 to 10 letters, digits, space and . \' - & only', () => {
    const ok = ['Ann', 'O\'Neil', 'J. Doe', 'A&B', 'Mary-Jo', 'Zoë', 'Zoë', '李雷', 'Anna 2', 'A', 'abcdefghij', '  Ann  ', 'A    B'];
    ok.forEach(n => assert(!claim(board(), n, [0]).error, `${JSON.stringify(n)} should be allowed`));
    eq(claim(board(), '  Ann  ', [0]).name, 'Ann', 'trimmed');
    eq(claim(board(), 'A    B', [0]).name, 'A B', 'inner spaces collapsed');
    eq(claim(board(), 'Zoë', [0]).name, 'Zoë', 'stored in NFC');
    const bad = {
      empty: '', blank: '   ', tooLong: 'abcdefghijk', manyCodePoints: '😀'.repeat(3), control: 'An\u0007n', newline: 'An\nn', tab: 'An\tn',
      bidi: '‮Ann', isolate: 'An⁦n', zeroWidth: 'An​n', joiner: 'A‍B', bom: '﻿Ann', nbsp: 'An n', ideographicSpace: 'An　n',
      proto: '__proto__', toString: 'toString', constructor: 'valueOf', subscript: 'Ann₁', subscriptMiddle: 'A₂B', html: '<b>', quote: 'Ann"', backslash: 'A\\B', at: 'a@b', emoji: 'Ann😀',
      huge: 'a'.repeat(5000), number: 5, nil: null, object: { a: 1 }, array: ['Ann'], missing: undefined,
      hangulFiller: '\u3164', filler: 'Ann\u115F', halfFiller: '\uFFA0\uFFA0', dots: '...', dash: '-'
    };
    Object.keys(bad).forEach(k => {
      const r = claim(board(), bad[k], [0]);
      eq([k, r.code], [k, 'invalid'], `${k} ${JSON.stringify(bad[k])}`);
    });
    eq(claim(board(), 'Anna Maria', [0]).changed, true, '10 characters counts the space');
    eq(claim(board(), 'Anna Maria!', [0]).code, 'invalid', '11 characters');
    eq(claim(board(), 'O\u2019Brien', [0]).name, "O'Brien", 'a phone types a curly apostrophe');
    // An old TV browser that can't parse \p{..} in a literal would reject the whole file.
    assert(!/(^|[^\\])\\p\{/m.test(require('fs').readFileSync(require('path').join(__dirname, 'public', 'compute.js'), 'utf8')), 'no unicode-property literal in compute.js');
  });

  t('a taken name is refused: case, spaces, width, invisible characters and the host\'s subscript suffix', () => {
    const g = held({ 0: 'Ann', 1: 'Bo​b', 2: 'Cy₂', 3: 'Dee Dee' }, { Ann: { paid: true }, 'Bo​b': { paid: false }, 'Cy₂': { paid: false }, 'Dee Dee': { paid: false } });
    ['Ann', 'ann', 'ANN', ' ann ', 'Bob', 'bOb', 'Cy', 'cy', 'Dee  Dee', 'dee dee'].forEach(n => {
      const r = claim(g, n, [10]);
      eq([n, r.code], [n, 'illegal'], `${n} should be taken`);
      assert(/taken/.test(r.error), r.error);
    });
    eq(claim(g, 'Anne', [10]).changed, true, 'a different name is fine');
    // Another guest's name.
    const other = claim(board(), 'Sam', [0], T2);
    eq(claim(other.game, 'sam', [1], T1).code, 'illegal', 'another guest');
    // Taken stays taken even in the typed form: the full-width spelling is the same name.
    eq(G.nameKey('ＡＮＮ'), 'ann', 'width form');
    eq(G.nameKey('Ann₂'), 'ann', 'subscript digits');
  });

  t('a name with no squares is free, carries nothing over, and its tag is dropped', () => {
    const stale = { Bob: { paid: true, paidSquares: 3, g: T2, color: '#feca57' } };
    const g = held({ 50: 'Zed' }, Object.assign({ Zed: { paid: false } }, stale));
    const r = claim(g, 'Bob', [1], T3);
    assert(!r.error, r.error);
    eq([r.game.players.Bob.paid, 'paidSquares' in r.game.players.Bob, r.game.players.Bob.g], [false, false, T3], 'a fresh entry for the next person');
    // The tag's own leftover entries go when it takes a new name.
    const left = held({ 50: 'Zed' }, { Zed: { paid: false }, Old: { paid: true, g: T1, color: '#48dbfb' }, Older: { paid: false, g: T1 } });
    const n = claim(left, 'New', [1], T1);
    eq(Object.keys(n.game.players).sort(), ['New', 'Zed'], 'leftovers dropped');
    eq(n.game.players.New.paid, false, 'not paid');
    assert(n.game.players.Zed, 'someone else\'s entry stays');
  });

  t('a device keeps its name: op.name is ignored once bound; the binding follows a rename and ends with the squares', () => {
    const a = claim(board(), 'Ann', [0]);
    const b = claim(a.game, 'Mallory', [1]);
    eq([b.name, heldBy(b.game, 'Ann'), heldBy(b.game, 'Mallory')], ['Ann', [0, 1], []], 'bound');
    eq(G.guestNameOf(b.game, T1), 'Ann', 'guestNameOf');
    eq(G.guestNameOf(b.game, T2), null, 'another device');
    const badName = claim(a.game, '<script>', [1]);
    eq(badName.name, 'Ann', 'a bad name is ignored when bound');
    // The host renames the squares and the player entry.
    const renamed = JSON.parse(JSON.stringify(b.game));
    renamed.squares = renamed.squares.map(s => (s ? Object.assign({}, s, { name: 'Annie' }) : s));
    renamed.players.Annie = renamed.players.Ann;
    delete renamed.players.Ann;
    eq(G.guestNameOf(renamed, T1), 'Annie', 'follows the rename');
    eq(claim(renamed, 'Zed', [2]).name, 'Annie', 'still bound after the rename');
    // The host removes everything.
    const gone = JSON.parse(JSON.stringify(b.game));
    gone.squares = gone.squares.map(() => null);
    eq(G.guestNameOf(gone, T1), null, 'a name with no squares is nobody\'s');
    eq(claim(gone, 'Zed', [2]).name, 'Zed', 'may choose a new name');
    // Removed player entry and squares both gone: same.
    delete gone.players.Ann;
    eq(G.guestNameOf(gone, T1), null, 'no entry');
    eq(G.guestNameOf({ squares: [{ name: 'toString' }], players: {} }, T1), null, 'no entry, inherited name');
    eq(G.guestNameOf({ squares: [{ name: 'x' }], players: { x: { g: T1 } } }, 'nope'), null, 'bad tag');
    eq(G.guestNameOf({ squares: [{ name: 'x' }], players: { x: { g: T1 } } }, T1), 'x', 'plain');
  });

  t('release: own squares only; the last one removes the entry and frees the name choice', () => {
    const a = claim(board(), 'Ann', [0, 1, 2]);
    const r = apply(a.game, { op: 'release', squares: [1] });
    eq([r.changed, r.name, heldBy(r.game, 'Ann'), r.game.squares[1]], [true, 'Ann', [0, 2], null], 'one released');
    const again = apply(r.game, { op: 'release', squares: [1] });
    eq([again.changed, again.error], [false, undefined], 'releasing an empty square is a no-op (retry safe)');
    const all = apply(r.game, { op: 'release', squares: [0, 2] });
    eq([all.name, 'Ann' in all.game.players, heldBy(all.game, 'Ann')], [null, false, []], 'all released');
    assert(!G.validateGame(all.game), 'valid');
    // Another device holds squares of its own: it can't release the first one's.
    const both = claim(a.game, 'Bea', [10], T2);
    eq(apply(both.game, { op: 'release', squares: [0] }, T2).code, 'illegal', 'T2 releasing Ann');
    eq(apply(both.game, { op: 'release', squares: [10, 0] }, T2).code, 'illegal', 'mixed with its own');
    eq(heldBy(both.game, 'Ann'), [0, 1, 2], 'untouched');
    eq(apply(both.game, { op: 'release', squares: [0] }, T3).code, 'illegal', 'a device that holds nothing');
    eq(apply(board(), { op: 'release', squares: [0] }).code, 'illegal', 'an unbound device on an empty board');
    // A host-typed square is not a guest's.
    const hostSq = held({ 5: 'Hal' }, { Hal: { paid: false } });
    eq(apply(hostSq, { op: 'release', squares: [5] }).code, 'illegal', 'host square');
  });

  t('paid: counts, order of the paid squares, and what a claim or release does', () => {
    const g = board();
    g.squares[5] = { name: 'Ann', at: 300 }; g.squares[6] = { name: 'Ann', at: 100 }; g.squares[7] = { name: 'Ann' }; g.squares[8] = { name: 'Bob', at: 1 };
    g.players = { Ann: { paid: false, paidSquares: 1 }, Bob: { paid: false } };
    eq([G.paidSquareCount(g, 'Ann'), G.paidSquareCount(g, 'Bob'), G.paidSquareCount(g, 'Nobody')], [1, 0, 0], 'counts');
    eq(Array.from(G.unpaidSquares(g)).sort((a, b) => a - b), [5, 6, 8], 'a square with no time is the oldest, so it is the paid one');
    g.players.Ann.paidSquares = 2;
    eq(Array.from(G.unpaidSquares(g)).sort((a, b) => a - b), [5, 8], 'two paid: the oldest two');
    g.players.Ann.paidSquares = 99;
    eq(G.paidSquareCount(g, 'Ann'), 3, 'never more than held');
    g.players.Ann = { paid: true, paidSquares: 1 };
    eq(G.paidSquareCount(g, 'Ann'), 3, 'paid means all');
    eq(Array.from(G.unpaidSquares(g)), [8], 'paid in full');
    g.players.Ann = { paid: false };
    g.squares[5] = { name: 'Ann', at: 100 }; // a tie on time falls to the index
    eq(Array.from(G.unpaidSquares(g)).sort((a, b) => a - b), [5, 6, 7, 8], 'nothing paid');

    // A paid guest claims more: the old ones stay paid, only the new are owed.
    const a = claim(board(), 'Ann', [0, 1]);
    a.game.players.Ann.paid = true;
    const more = apply(a.game, { op: 'claim', squares: [2, 3] }, T1, { now: NOW + 60000 });
    eq([more.game.players.Ann.paid, more.game.players.Ann.paidSquares], [false, 2], 'paid becomes the count');
    eq(Array.from(G.unpaidSquares(more.game)).sort(), [2, 3], 'only the new are owed');
    const again = apply(more.game, { op: 'claim', squares: [4] }, T1, { now: NOW + 120000 });
    eq(again.game.players.Ann.paidSquares, 2, 'still two paid');
    eq(Array.from(G.unpaidSquares(again.game)).sort(), [2, 3, 4], 'three owed');
    // Release: never below the paid count.
    eq(apply(again.game, { op: 'release', squares: [0] }).changed, true, 'five held, two paid: one can go');
    eq(apply(again.game, { op: 'release', squares: [0, 1, 2, 3] }).code, 'illegal', 'one left, two paid');
    eq(apply(again.game, { op: 'release', squares: [4, 3, 2] }).changed, true, 'the owed ones');
    eq(apply(again.game, { op: 'release', squares: [3, 4, 2, 1] }).code, 'illegal', 'one too many');
    // The squares released are the ones asked for, whichever are "paid": the count is what counts.
    eq(apply(again.game, { op: 'release', squares: [0, 2, 3, 4] }).code, 'illegal', 'count below paid');
    eq(apply(again.game, { op: 'release', squares: [0, 2, 3] }).changed, true, 'count stays at paid');
    // A name marked paid by the host cannot release anything.
    const paid = claim(board(), 'Pat', [0, 1]);
    paid.game.players.Pat.paid = true;
    eq(apply(paid.game, { op: 'release', squares: [1] }).code, 'illegal', 'paid in full');
    // Part-paid with the count already claimed unpaid.
    const unpaid = claim(board(), 'Una', [0, 1]);
    eq(['paidSquares' in unpaid.game.players.Una, unpaid.game.players.Una.paid], [false, false], 'an unpaid guest has no count');
    eq(apply(unpaid.game, { op: 'release', squares: [0, 1] }).name, null, 'unpaid release everything');
  });

  t('validateGame: the new fields have exact types, and every old board still passes', () => {
    const ok = (g) => assert(!G.validateGame(g), `should pass: ${G.validateGame(g)} ${JSON.stringify(g.guestPick)}`);
    const no = (g, what) => assert(G.validateGame(g), `should fail: ${what}`);
    ok(board());
    ok(board({ guestPick: undefined }));
    ok(Object.assign(board(), { squares: board().squares.map((s, i) => (i < 3 ? { name: 'Ann' } : null)), players: { Ann: { paid: true, color: '#feca57' } } }));
    const withSquare = (sq) => Object.assign(board(), { squares: board().squares.map((s, i) => (i === 0 ? sq : null)) });
    ok(withSquare({ name: 'Ann', at: 0 }));
    ok(withSquare({ name: 'Ann', at: 1e11 }));
    [-1, 1e11 + 1, 1.5, '5', null, NaN, true, [], {}].forEach(at => no(withSquare({ name: 'Ann', at }), `at ${JSON.stringify(at)}`));
    const withPlayer = (p) => board({ players: { Ann: p } });
    ok(withPlayer({ paid: false, g: T1, paidSquares: 100 }));
    ok(withPlayer({ paid: false, g: T1, paidSquares: 0 }));
    ['x', 'a'.repeat(21), 'a'.repeat(23), 'abc+/='.padEnd(22, 'a'), 5, null, {}, 'a'.repeat(21) + '!'].forEach(g => no(withPlayer({ paid: false, g }), `g ${JSON.stringify(g)}`));
    [-1, 101, 1.5, '3', null, NaN].forEach(p => no(withPlayer({ paid: false, paidSquares: p }), `paidSquares ${JSON.stringify(p)}`));
    const gp = (v) => board({ guestPick: v });
    ok(gp({ on: true, max: 1, liftAt: null, lifted: false }));
    ok(gp({ on: false, max: 100, lifted: true }));
    ok(gp({ on: true, max: 5, liftAt: '2027-02-14T18:45:00.000Z', lifted: false }));
    ok(gp({ on: true, max: 5, liftAt: '2027-02-14T13:45:00-05:00', lifted: false }));
    ok(gp(null));
    [
      {}, { on: true, max: 5 }, { on: 'true', max: 5, lifted: false }, { on: true, max: 0, lifted: false }, { on: true, max: 101, lifted: false },
      { on: true, max: 2.5, lifted: false }, { on: true, max: '5', lifted: false }, { on: true, max: 5, lifted: 0 },
      { on: true, max: 5, lifted: false, extra: 1 }, { on: true, max: 5, lifted: false, liftAt: '2027-02-14T18:45' },
      { on: true, max: 5, lifted: false, liftAt: 'tomorrow' }, { on: true, max: 5, lifted: false, liftAt: 5 },
      { on: true, max: 5, lifted: false, liftAt: '2027-13-14T18:45:00Z' }, [], 'on', 5, true
    ].forEach((v, i) => no(gp(v), `guestPick #${i} ${JSON.stringify(v)}`));
  });

  t('the player color pick is one rule in compute.js, and the host screen uses it', () => {
    eq(G.PLAYER_COLORS.length, 16, 'palette');
    const players = { A: { color: G.PLAYER_COLORS[0] }, B: {} };
    eq(G.pickPlayerColor(players), G.PLAYER_COLORS[1], 'first unused');
    const all = {};
    G.PLAYER_COLORS.forEach((c, i) => { all['p' + i] = { color: c }; });
    all.extra = {};
    eq(G.pickPlayerColor(all), G.PLAYER_COLORS[17 % 16], 'repeat by count');
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'public', 'players.js'), 'utf8');
    assert(!src.includes('#feca57') && src.includes('pickPlayerColor'), 'players.js uses the shared rule');
  });
}

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
const MODES = {
  off: {},
  password: { HOST_PASSWORD: 'correct horse' },
  accounts: ACCOUNTS_ENV
};

async function call(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({ host: 'app.example.com', 'x-forwarded-proto': 'https' }, o.headers);
  if (o.cookie) headers.cookie = o.cookie;
  const raw = o.raw !== undefined ? o.raw : (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  const req = {
    method, url: p, headers, socket: {}, destroy() {},
    on(event, cb) {
      if (event === 'data' && raw !== undefined) cb(Buffer.from(raw));
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
const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];

const created = [];
async function newBoard(extra) {
  const b = board(extra);
  await store.createGame(b, null);
  created.push(b.id);
  return b.id;
}
const readBoard = (id) => store.getGame(id);
// A phone that has tapped Pick squares: it holds a key.
async function device(id) {
  const r = await call('POST', `/api/game/${id}/guest`);
  assert(r.statusCode === 200, `device: ${r.statusCode} ${r.body}`);
  return { cookie: cookieOf(r), key: cookieOf(r).split('=')[1] };
}
const patch = (id, dev, body, extra) => call('PATCH', `/api/game/${id}/guest`, Object.assign({ cookie: dev && dev.cookie, body }, extra));
const holders = (game) => game.squares.map((s, i) => (s ? `${i}:${s.name}` : null)).filter(Boolean);

async function routes(label, mode, env) {
  const test = (name, fn) => check(`${label} ${mode}: ${name}`, async () => { setEnv(env); await fn(); });
  const names = (n) => Array.from({ length: n }, (_, i) => `G${i}`);

  await test('POST hands out a key once, scoped to the board, and answers with no name', async () => {
    const id = await newBoard();
    const r = await call('POST', `/api/game/${id}/guest`);
    eq([r.statusCode, r.json], [200, { name: null }], 'answer');
    const set = r.headers['set-cookie'];
    assert(/^sbs_guest=[A-Za-z0-9_-]{43};/.test(set), `cookie: ${set}`);
    [`Path=/api/game/${id};`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${180 * 24 * 60 * 60}`, '; Secure'].forEach(x => assert(set.includes(x), `${x} missing: ${set}`));
    const key = cookieOf(r).split('=')[1];
    assert(!r.body.includes(key), 'the key is in the body');
    const again = await call('POST', `/api/game/${id}/guest`, { cookie: cookieOf(r) });
    eq([again.statusCode, again.headers['set-cookie'], again.json], [200, undefined, { name: null }], 'a device with a key gets no new one');
    // The board shows only the tag.
    await patch(id, { cookie: cookieOf(r) }, { op: 'claim', name: 'Ann', squares: [1] });
    const doc = await readBoard(id);
    const text = JSON.stringify(doc);
    assert(!text.includes(key), 'the key is in the document');
    eq(doc.players.Ann.g, auth.guestTag(id, key), 'the tag');
    eq((await call('POST', `/api/game/${id}/guest`, { cookie: cookieOf(r) })).json, { name: 'Ann' }, 'the name comes back');
    eq((await call('GET', `/api/game/${id}`)).body.includes(key), false, 'GET never shows the key');
  });

  await test('POST sets no cookie when picks are off, not picking, locked or unknown', async () => {
    const off = await newBoard({ guestPick: { on: false, max: 5, liftAt: null, lifted: false } });
    const unset = await newBoard({ guestPick: undefined });
    const started = await newBoard({ status: 'started', axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const setup = await newBoard({ status: 'setup' });
    for (const id of [off, unset, started, setup]) {
      const r = await call('POST', `/api/game/${id}/guest`);
      eq([r.statusCode, r.headers['set-cookie']], [409, undefined], id);
      assert(!r.json.authRequired, 'must not open the sign-in prompt');
    }
    eq((await call('POST', `/api/game/${crypto.randomUUID()}/guest`)).statusCode, 404, 'unknown board');
    eq((await call('POST', `/api/game/${crypto.randomUUID()}/guest`)).headers['set-cookie'], undefined, 'no cookie for an unknown board');
  });

  await test('a passed cutoff locks first, so the board answers 409 and nothing is claimed', async () => {
    const id = await newBoard({ autoCutoffEnabled: true, autoCutoffTime: new Date(Date.now() - 60000).toISOString() });
    eq((await call('POST', `/api/game/${id}/guest`)).statusCode, 409, 'POST');
    eq((await patch(id, { cookie: `sbs_guest=${crypto.randomBytes(32).toString('base64url')}` }, { op: 'claim', name: 'Ann', squares: [1] })).statusCode, 409, 'PATCH');
    eq(holders(await readBoard(id)), [], 'claimed');
  });

  await test('PATCH without a valid key is 401 and never opens the host sign-in', async () => {
    const id = await newBoard();
    const op = { op: 'claim', name: 'Ann', squares: [1] };
    for (const cookie of [undefined, '', 'sbs_guest=', 'sbs_guest=x', `sbs_guest=${'a'.repeat(42)}`, `sbs_guest=${'a'.repeat(44)}`, 'sbs_guest=%E0%A4%A', `sbs_host=${'a'.repeat(43)}`, `sbs_scorer=${'a'.repeat(43)}`]) {
      const r = await call('PATCH', `/api/game/${id}/guest`, { cookie, body: op });
      eq(r.statusCode, 401, String(cookie));
      assert(!('authRequired' in r.json), `authRequired for ${cookie}`);
    }
    eq(holders(await readBoard(id)), [], 'nothing claimed');
  });

  await test('another board\'s key does nothing here', async () => {
    const a = await newBoard();
    const b = await newBoard();
    const devA = await device(a);
    await patch(a, devA, { op: 'claim', name: 'Ann', squares: [1, 2] });
    // The same key sent to board b is a different tag: it holds nothing there.
    const onB = await patch(b, devA, { op: 'release', squares: [1] });
    eq(onB.statusCode, 409, 'release on b');
    eq((await call('POST', `/api/game/${b}/guest`, { cookie: devA.cookie })).json, { name: null }, 'no name on b');
    // A square on b with a's tag copied in is not this key's either.
    const doc = await readBoard(b);
    doc.squares[7] = { name: 'Mal', at: 1 };
    doc.players.Mal = { paid: false, g: auth.guestTag(a, devA.key) };
    await store.updateGame(b, doc, doc.updatedAt, {});
    eq((await patch(b, devA, { op: 'release', squares: [7] })).statusCode, 409, 'a tag made for another board');
    eq(holders(await readBoard(a)), ['1:Ann', '2:Ann'], 'a untouched');
  });

  await test('a claim by squares and a release: the response, the stored board, and nothing else changed', async () => {
    const id = await newBoard({ description: 'Watch party', potOverride: 500 });
    const code = await store.assignJoinCode(id);
    const before = await readBoard(id);
    const dev = await device(id);
    const r = await patch(id, dev, { op: 'claim', name: 'Ann', squares: [3, 4] });
    eq(r.statusCode, 200, r.body);
    eq(r.json.name, 'Ann', 'name');
    eq(holders(r.json.game), ['3:Ann', '4:Ann'], 'squares');
    if (code) eq(r.json.game.joinCode, code, 'joinCode kept in the response');
    assert(r.json.game.updatedAt !== before.updatedAt, 'stamp moved');
    const stored = await readBoard(id);
    eq(holders(stored), ['3:Ann', '4:Ann'], 'stored');
    assert(Number.isInteger(stored.squares[3].at) && Math.abs(stored.squares[3].at - Date.now() / 1000) < 60, 'claim time in seconds');
    const strip = (g) => { const c = JSON.parse(JSON.stringify(g)); ['squares', 'players', 'updatedAt'].forEach(k => delete c[k]); return c; };
    eq(strip(stored), strip(before), 'every other field is as it was');
    assert(!('owner_id' in stored) && !('ownerId' in stored), 'owner never in the document');
    const rel = await patch(id, dev, { op: 'release', squares: [4] });
    eq([rel.statusCode, rel.json.name, holders(rel.json.game)], [200, 'Ann', ['3:Ann']], 'release');
    const last = await patch(id, dev, { op: 'release', squares: [3] });
    eq([last.json.name, 'Ann' in (await readBoard(id)).players], [null, false], 'the last release removes the player');
    eq((await call('POST', `/api/game/${id}/guest`, { cookie: dev.cookie })).json, { name: null }, 'free to choose a new name');
  });

  await test('a claim by count: random squares, and a retry with a stale have claims nothing', async () => {
    const id = await newBoard();
    const dev = await device(id);
    const r = await patch(id, dev, { op: 'claim', name: 'Ann', count: 3, have: 0 });
    eq(r.statusCode, 200, r.body);
    eq(holders(r.json.game).length, 3, 'three');
    const retry = await patch(id, dev, { op: 'claim', name: 'Ann', count: 3, have: 0 });
    eq([retry.statusCode, holders(retry.json.game).length], [409, 3], 'stale have');
    eq((await patch(id, dev, { op: 'claim', count: 2, have: 3 })).statusCode, 200, 'right have');
    eq(holders(await readBoard(id)).length, 5, 'five');
    eq((await patch(id, dev, { op: 'claim', count: 1, have: 5 })).statusCode, 409, 'cap of five');
  });

  await test('the rules answer 400 for a bad op and 409 with the current board for a rule', async () => {
    const id = await newBoard({ pickMode: 'manual' });
    const dev = await device(id);
    const other = await device(id);
    await patch(id, other, { op: 'claim', name: 'Bea', squares: [7, 8] });
    for (const body of [{ op: 'claim', name: 'Ann', squares: [100] }, { op: 'claim', name: 'Ann', squares: [1, 1] }, { op: 'claim', name: '<b>', squares: [1] }, { op: 'nope' }, {}]) {
      const r = await patch(id, dev, body);
      eq([r.statusCode, typeof r.json.error], [400, 'string'], JSON.stringify(body));
      assert(!r.json.game, 'a 400 carries no board');
    }
    const taken = await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1, 7, 8] });
    eq([taken.statusCode, taken.json.taken, holders(taken.json.game)], [409, [7, 8], ['7:Bea', '8:Bea']], 'taken squares');
    const name = await patch(id, dev, { op: 'claim', name: 'bea', squares: [1] });
    eq([name.statusCode, /taken/.test(name.json.error), !!name.json.game], [409, true, true], 'taken name');
    const mode = await patch(id, dev, { op: 'claim', name: 'Ann', count: 2, have: 0 });
    eq([mode.statusCode, !!mode.json.game], [409, true], 'Manual Only');
    const none = await patch(id, dev, { op: 'release', squares: [7] });
    eq([none.statusCode, !!none.json.game], [409, true], 'a device that holds nothing');
    const bad = await call('PATCH', `/api/game/${id}/guest`, { cookie: dev.cookie, raw: '{nope' });
    eq(bad.statusCode, 400, 'bad JSON');
    eq(holders(await readBoard(id)), ['7:Bea', '8:Bea'], 'nothing else claimed');
  });

  await test('a body over 4 KB is a 413 and writes nothing', async () => {
    const id = await newBoard();
    const dev = await device(id);
    const before = (await readBoard(id)).updatedAt;
    const r = await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1], padding: 'x'.repeat(4096) });
    eq(r.statusCode, 413, 'status');
    eq((await readBoard(id)).updatedAt, before, 'written');
  });

  await test('a second device can\'t release the first one\'s squares, and a name can\'t be taken', async () => {
    const id = await newBoard();
    const one = await device(id);
    const two = await device(id);
    await patch(id, one, { op: 'claim', name: 'Ann', squares: [1, 2] });
    eq((await patch(id, two, { op: 'release', squares: [1] })).statusCode, 409, 'release as a stranger');
    eq((await patch(id, two, { op: 'claim', name: 'Ann', squares: [3] })).statusCode, 409, 'same name');
    eq((await patch(id, two, { op: 'claim', name: 'ann', squares: [3] })).statusCode, 409, 'same name, other case');
    await patch(id, two, { op: 'claim', name: 'Bea', squares: [3] });
    eq((await patch(id, two, { op: 'release', squares: [1, 3] })).statusCode, 409, 'mixed');
    eq(holders(await readBoard(id)), ['1:Ann', '2:Ann', '3:Bea'], 'untouched');
  });

  await test('the cap holds across requests, and the host lifts it by switch or time', async () => {
    const id = await newBoard({ guestPick: { on: true, max: 2, liftAt: null, lifted: false } });
    const dev = await device(id);
    eq((await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1, 2] })).statusCode, 200, 'two');
    const over = await patch(id, dev, { op: 'claim', squares: [3] });
    eq([over.statusCode, /up to 2/.test(over.json.error)], [409, true], 'third');
    const doc = await readBoard(id);
    doc.guestPick.lifted = true;
    await store.updateGame(id, doc, doc.updatedAt, {});
    eq((await patch(id, dev, { op: 'claim', squares: [3, 4, 5, 6] })).statusCode, 200, 'lifted');
    const timed = await newBoard({ guestPick: { on: true, max: 1, liftAt: new Date(Date.now() - 1000).toISOString(), lifted: false } });
    eq((await patch(timed, await device(timed), { op: 'claim', name: 'Zed', squares: [1, 2, 3] })).statusCode, 200, 'past liftAt');
    const future = await newBoard({ guestPick: { on: true, max: 1, liftAt: new Date(Date.now() + 3600000).toISOString(), lifted: false } });
    eq((await patch(future, await device(future), { op: 'claim', name: 'Zed', squares: [1, 2] })).statusCode, 409, 'before liftAt');
  });

  await test('paid: a paid guest claiming more owes only the new squares; paid squares can\'t be released', async () => {
    const id = await newBoard();
    const dev = await device(id);
    await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1, 2] });
    const doc = await readBoard(id);
    doc.players.Ann.paid = true;
    await store.updateGame(id, doc, doc.updatedAt, {});
    eq((await patch(id, dev, { op: 'release', squares: [1] })).statusCode, 409, 'release a paid square');
    const more = await patch(id, dev, { op: 'claim', squares: [3] });
    eq([more.json.game.players.Ann.paid, more.json.game.players.Ann.paidSquares], [false, 2], 'two paid');
    eq(Array.from(G.unpaidSquares(more.json.game)), [3], 'only the new one owed');
    eq((await patch(id, dev, { op: 'release', squares: [3] })).statusCode, 200, 'the owed one can go');
  });

  await test('a stale paid entry of a name with no squares does not make a new guest paid', async () => {
    const id = await newBoard({ players: { Bob: { paid: true, paidSquares: 4, g: 'a'.repeat(22), color: '#feca57' } } });
    const dev = await device(id);
    const r = await patch(id, dev, { op: 'claim', name: 'Bob', squares: [5] });
    eq(r.statusCode, 200, r.body);
    const p = (await readBoard(id)).players.Bob;
    eq([p.paid, 'paidSquares' in p, p.g === 'a'.repeat(22)], [false, false, false], 'fresh');
    eq(Array.from(G.unpaidSquares(r.json.game)), [5], 'owes it');
  });

  await test('a host save holding a pre-pick updatedAt gets 409, and the guest\'s pick survives', async () => {
    if (mode === 'accounts') return; // a host PUT needs an account's board; the rule is the same store write
    const id = await newBoard();
    const host = mode === 'password' ? cookieOf(await call('POST', '/api/session', { body: { password: 'correct horse' } })) : undefined;
    const stale = (await call('GET', `/api/game/${id}`)).json;
    const dev = await device(id);
    eq((await patch(id, dev, { op: 'claim', name: 'Ann', squares: [9] })).statusCode, 200, 'pick');
    const put = await call('PUT', `/api/game/${id}`, { cookie: host, body: Object.assign({}, stale, { description: 'Edited by the host' }) });
    eq(put.statusCode, 409, `PUT: ${put.body}`);
    eq(holders(put.json.game), ['9:Ann'], 'the 409 shows the pick');
    const now = await readBoard(id);
    eq([holders(now), now.description], [['9:Ann'], undefined], 'stored: pick kept, host edit not applied');
    // Re-applied to the newer document, the host's edit goes through and keeps the pick.
    const fresh = (await call('GET', `/api/game/${id}`)).json;
    const again = await call('PUT', `/api/game/${id}`, { cookie: host, body: Object.assign({}, fresh, { description: 'Edited by the host' }) });
    eq([again.statusCode, holders(again.json)], [200, ['9:Ann']], 'a fresh save');
  });

  await test('a lock that lands between the read and the write refuses the pick', async () => {
    const id = await newBoard();
    const dev = await device(id);
    const realGet = store.getGame;
    let first = true;
    store.getGame = async (gid) => {
      const g = await realGet(gid);
      if (first && g) {
        first = false;
        const locked = JSON.parse(JSON.stringify(g));
        locked.status = 'started';
        locked.axisX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        locked.axisY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        await store.updateGame(gid, locked, g.updatedAt, {});
      }
      return g;
    };
    let r;
    try {
      r = await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1] });
    } finally {
      store.getGame = realGet;
    }
    eq([r.statusCode, r.json.game.status], [409, 'started'], 'refused with the locked board');
    eq(holders(await readBoard(id)), [], 'nothing claimed');
  });

  await test('a claim on a started board is refused', async () => {
    const id = await newBoard();
    const dev = await device(id);
    await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1] });
    const doc = await readBoard(id);
    Object.assign(doc, { status: 'started', axisX: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], axisY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    await store.updateGame(id, doc, doc.updatedAt, {});
    eq((await patch(id, dev, { op: 'claim', squares: [2] })).statusCode, 409, 'claim');
    eq((await patch(id, dev, { op: 'release', squares: [1] })).statusCode, 409, 'release');
    eq(holders(await readBoard(id)), ['1:Ann'], 'unchanged');
  });

  await test('a foreign Origin is refused on both routes', async () => {
    const id = await newBoard();
    const headers = { origin: 'https://evil.example' };
    eq((await call('POST', `/api/game/${id}/guest`, { headers })).statusCode, 403, 'POST');
    const dev = await device(id);
    eq((await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1] }, { headers })).statusCode, 403, 'PATCH');
    eq((await patch(id, dev, { op: 'claim', name: 'Ann', squares: [1] }, { headers: { origin: 'https://app.example.com' } })).statusCode, 200, 'own origin');
    eq(holders(await readBoard(id)), ['1:Ann'], 'only the same-origin claim');
  });

  await test('other methods are not found, and the id is checked', async () => {
    const id = await newBoard();
    eq((await call('GET', `/api/game/${id}/guest`)).statusCode, 404, 'GET');
    eq((await call('DELETE', `/api/game/${id}/guest`)).statusCode, 404, 'DELETE');
    eq((await call('PUT', `/api/game/${id}/guest`, { body: {} })).statusCode, 404, 'PUT');
    eq((await call('POST', `/api/game/${'z'.repeat(36)}/guest`)).statusCode, 404, 'not an id');
    eq((await call('POST', `/api/game/${id.toUpperCase()}/guest`)).statusCode, 200, 'upper-case id is lowercased');
    const dev = await device(id);
    eq((await patch(id.toUpperCase(), dev, { op: 'claim', name: 'Ann', squares: [1] })).statusCode, 200, 'PATCH with an upper-case id');
    eq(holders(await readBoard(id)), ['1:Ann'], 'one board');
    eq((await call('POST', `/api/game/${id.toUpperCase()}/guest`, { cookie: dev.cookie })).json, { name: 'Ann' }, 'tag made from the lowercase id');
  });

  // ---- concurrency ----

  await test('20 devices claiming different squares together: each pick is won or cleanly refused, none lost', async () => {
    const id = await newBoard({ guestPick: { on: true, max: 5, liftAt: null, lifted: false } });
    const devs = [];
    for (let i = 0; i < 20; i++) devs.push(await device(id));
    const res = await Promise.all(devs.map((d, i) => patch(id, d, { op: 'claim', name: names(20)[i], squares: [i] })));
    const final = await readBoard(id);
    res.forEach((r, i) => {
      assert([200, 409].includes(r.statusCode), `device ${i}: ${r.statusCode} ${r.body}`);
      const has = !!(final.squares[i] && final.squares[i].name === names(20)[i]);
      eq([i, has], [i, r.statusCode === 200], 'the answer matches the board');
      if (r.statusCode === 409) eq([i, r.json.conflict], [i, true], 'a lost race says so');
    });
    const won = res.filter(r => r.statusCode === 200).length;
    eq(holders(final).length, won, 'squares held = picks answered 200');
    assert(won >= 1, 'at least one pick lands');
    assert(!G.validateGame(final), 'valid board');
  });

  await test('10 claims from one device at the cap never go past it', async () => {
    const id = await newBoard({ guestPick: { on: true, max: 3, liftAt: null, lifted: false } });
    const dev = await device(id);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => patch(id, dev, { op: 'claim', name: 'Ann', squares: [i] })));
    const final = await readBoard(id);
    res.forEach((r, i) => assert([200, 409].includes(r.statusCode), `${i}: ${r.statusCode} ${r.body}`));
    const mine = holders(final);
    assert(mine.length <= 3, `held ${mine.length} past the cap of 3`);
    eq(mine.length, res.filter(r => r.statusCode === 200).length, 'held = answered 200');
    assert(mine.length >= 1, 'something landed');
  });

  await test('10 devices on one square: one winner', async () => {
    const id = await newBoard();
    const devs = [];
    for (let i = 0; i < 10; i++) devs.push(await device(id));
    const res = await Promise.all(devs.map((d, i) => patch(id, d, { op: 'claim', name: `D${i}`, squares: [42] })));
    const winners = res.map((r, i) => (r.statusCode === 200 ? i : -1)).filter(i => i >= 0);
    eq(winners.length, 1, `winners ${winners} (${res.map(r => r.statusCode)})`);
    eq(holders(await readBoard(id)), [`42:D${winners[0]}`], 'the board');
    res.forEach((r, i) => { if (i !== winners[0]) assert(r.statusCode === 409, `loser ${i}: ${r.statusCode}`); });
  });

  await test('5 devices claiming one name: one winner', async () => {
    const id = await newBoard();
    const devs = [];
    for (let i = 0; i < 5; i++) devs.push(await device(id));
    const res = await Promise.all(devs.map((d, i) => patch(id, d, { op: 'claim', name: i % 2 ? 'sam' : 'Sam', squares: [10 + i] })));
    const winners = res.filter(r => r.statusCode === 200);
    eq(winners.length, 1, `winners (${res.map(r => r.statusCode)})`);
    eq(holders(await readBoard(id)).length, 1, 'one square held');
    const doc = await readBoard(id);
    eq(Object.keys(doc.players).length, 1, 'one player');
  });
}

async function misconfigured(label) {
  await check(`${label} misconfigured: 503 before anything else, and no key is handed out`, async () => {
    setEnv(MODES.off);
    const id = await newBoard();
    const dev = await device(id);
    for (const broken of [{ AUTH_MODE: 'acounts' }, { VERCEL: '1' }, { ...ACCOUNTS_ENV, SESSION_SECRET: 'short' }]) {
      setEnv(broken);
      eq(auth.authMode(), 'misconfigured', 'mode');
      const post = await call('POST', `/api/game/${id}/guest`);
      eq([post.statusCode, post.headers['set-cookie']], [503, undefined], 'POST');
      eq((await call('PATCH', `/api/game/${id}/guest`, { cookie: dev.cookie, body: { op: 'claim', name: 'Ann', squares: [1] } })).statusCode, 503, 'PATCH');
      eq((await call('PATCH', `/api/game/${id}/guest`, { body: {} })).statusCode, 503, 'PATCH without a key');
      eq((await call('POST', `/api/game/${'z'.repeat(36)}/guest`)).statusCode, 404, 'not an id is not this route');
      eq((await call('POST', `/api/game/${crypto.randomUUID()}/guest`)).statusCode, 503, 'unknown board');
    }
    setEnv(MODES.off);
    eq(holders(await readBoard(id)), [], 'nothing claimed');
  });
}

async function cleanup() {
  setEnv({});
  for (const id of created.splice(0)) { try { await store.deleteGame(id); } catch (e) { /* best effort */ } }
}

async function main() {
  pure();
  setEnv({});
  for (const mode of Object.keys(MODES)) await routes('fs', mode, MODES[mode]);
  await misconfigured('fs');
  await cleanup();

  if (PG_URL) {
    process.env.DATABASE_URL = PG_URL;
    // Record every statement the Postgres store sends, to prove the guest routes never touch
    // owner_id or hosts (migration 002 is not on production yet).
    const queries = [];
    const modPath = require.resolve('@neondatabase/serverless');
    const real = require('@neondatabase/serverless');
    require.cache[modPath].exports = Object.assign({}, real, {
      neon: (...args) => new Proxy(real.neon(...args), {
        apply(target, self, a) {
          queries.push(Array.isArray(a[0]) ? a[0].join('?') : String(a[0]));
          return Reflect.apply(target, self, a);
        }
      })
    });
    const pg = require('./lib/store-pg.js');
    const saved = {};
    Object.keys(pg).forEach(k => { if (typeof pg[k] === 'function') { saved[k] = store[k]; store[k] = pg[k]; } });
    try {
      for (const mode of Object.keys(MODES)) await routes('pg', mode, MODES[mode]);
      await misconfigured('pg');
      await check('pg: the guest routes never mention owner_id or hosts', async () => {
        assert(queries.length > 20, `only ${queries.length} statements seen`);
        const bad = queries.filter(q => /owner_id|hosts/i.test(q));
        eq(bad.length, 0, `statements mention owner_id or hosts: ${bad[0]}`);
      });
      await cleanup();
    } finally {
      Object.assign(store, saved);
      setEnv({});
    }
  } else {
    console.log('  (Postgres guest tests skipped: no DATABASE_URL)');
  }
}

main()
  .catch(e => failures.push(`crashed\n      ${e.stack}`))
  .then(async () => {
    try { await cleanup(); } catch (e) { /* best effort */ }
    console.log('');
    if (failures.length) {
      console.log(`  ${failures.length} failed, ${passed} passed`);
      failures.forEach(f => console.log('  FAIL ' + f));
      process.exit(1);
    }
    console.log(`  guest picks: ${passed} passed`);
  });
