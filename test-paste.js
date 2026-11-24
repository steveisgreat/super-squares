// Paste a list of players (R25 part a): the pure parser parsePlayerList in public/compute.js.
// The `paid` flag decides what each person owes, so this is test-first money logic.
//
// Run with:  node test-paste.js   (or: npm test)
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

function board(filled) {
  const squares = new Array(100).fill(null);
  (filled || []).forEach(([name, n], k) => { for (let i = 0; i < n; i++) squares[k * 20 + i] = { name, at: 1 }; });
  return { squares, players: {} };
}
const parse = (text, g) => G.parsePlayerList(text, g || board());
const msgs = r => r.errors.map(e => `${e.line}:${e.message}`);

check('a simple list is paid by default', () => {
  const r = parse('Lee 5\nAnn 3');
  eq(r.errors, [], 'errors');
  eq(r.rows, [{ line: 1, name: 'Lee', count: 5, paid: true }, { line: 2, name: 'Ann', count: 3, paid: true }], 'rows');
  eq(r.total, 8, 'total');
  eq(r.open, 100, 'open');
});

check('unpaid and paid keywords, any case', () => {
  const r = parse('Lee 5 unpaid\nAnn 3 PAID\nBo 2 Unpaid\nCy 1 paid');
  eq(r.errors, [], 'errors');
  eq(r.rows.map(x => x.paid), [false, true, false, true], 'paid flags');
});

check('spaces, tabs and commas all separate the parts', () => {
  const r = parse('Lee\t5\nAnn,3\nBo , 2 ,unpaid\nCy   4   paid');
  eq(r.errors, [], 'errors');
  eq(r.rows.map(x => [x.name, x.count, x.paid]), [['Lee', 5, true], ['Ann', 3, true], ['Bo', 2, false], ['Cy', 4, true]], 'rows');
});

check('a name with inner spaces; a digit in the name stays in the name', () => {
  const r = parse('Player 2 5\nMary Ann 3 unpaid');
  eq(r.errors, [], 'errors');
  eq(r.rows.map(x => [x.name, x.count, x.paid]), [['Player 2', 5, true], ['Mary Ann', 3, false]], 'rows');
});

check('blank lines are ignored but line numbers count them', () => {
  const r = parse('\nLee 5\n\n   \nAnn x\n');
  eq(r.rows.map(x => x.line), [2], 'row lines');
  eq(r.errors.map(e => e.line), [5], 'error lines');
});

check('windows line endings', () => {
  const r = parse('Lee 5\r\nAnn 3\r\n');
  eq(r.errors, [], 'errors');
  eq(r.rows.length, 2, 'rows');
});

check('a missing number is an error', () => {
  const r = parse('Lee\nAnn unpaid');
  eq(r.rows, [], 'rows');
  eq(r.errors.map(e => e.line), [1, 2], 'lines');
  if (!/number/i.test(r.errors[0].message)) throw new Error('message should mention the number: ' + r.errors[0].message);
});

check('a count outside 1-100, decimal, signed or exponent is an error', () => {
  ['Lee 0', 'Lee 101', 'Lee 2.5', 'Lee -3', 'Lee +3', 'Lee 1e1', 'Lee 1,5 5x', 'Lee 007x'].forEach(line => {
    const r = parse(line);
    eq(r.rows, [], line + ' rows');
    eq(r.errors.length, 1, line + ' errors');
  });
  eq(parse('Lee 100').errors, [], '100 is fine');
  eq(parse('Lee 1').errors, [], '1 is fine');
});

check('a count with a leading zero reads as that number', () => {
  eq(parse('Lee 007').rows.map(x => x.count), [7], 'rows');
});

check('a number alone has no name', () => {
  const r = parse('5');
  eq(r.rows, [], 'rows');
  eq(r.errors.length, 1, 'errors');
});

check('a name over 10 characters or a disallowed name is an error', () => {
  eq(parse('Abcdefghijk 3').errors.length, 1, '11 chars');
  eq(parse('Abcdefghij 3').errors, [], '10 chars');
  eq(parse('__proto__ 3').errors.length, 1, '__proto__');
  eq(parse('toString 3').errors.length, 1, 'toString');
});

check('the same name twice is an error on the second line, case and subscripts ignored', () => {
  const r = parse('Lee 2\nlee 3\nAnn 1\nLEE₂ 1');
  eq(r.rows.map(x => x.line), [1, 3], 'rows');
  eq(r.errors.map(e => e.line), [2, 4], 'error lines');
});

check('a name already on the board is an error that says how many', () => {
  const g = board([['Lee', 3], ['Ann', 1]]);
  const r = parse('Lee 2\nann 1\nBo 4', g);
  eq(r.rows.map(x => x.name), ['Bo'], 'rows');
  eq(msgs(r), ['1:Lee already has 3 squares. Add more under One player.', '2:ann already has 1 square. Add more under One player.'], 'messages');
});

check('a board name with a subscript still blocks the bare name', () => {
  const g = board([['Lee₁', 2], ['Lee₂', 2]]);
  const r = parse('Lee 1', g);
  eq(r.errors.length, 1, 'errors');
  eq(r.errors[0].message, 'Lee already has 4 squares. Add more under One player.', 'message');
});

check('more squares than are open is an error', () => {
  const g = board([['Zed', 20]]);
  const r = parse('Lee 50\nAnn 40', g);
  eq(r.open, 80, 'open');
  eq(r.total, 90, 'total');
  eq(r.errors.length, 1, 'errors');
  eq(r.errors[0].line, 0, 'whole-list error has line 0');
});

check('exactly filling the board fits', () => {
  const r = parse('Lee 60\nAnn 40');
  eq(r.errors, [], 'errors');
  eq(r.total, 100, 'total');
});

check('over 100 lines is an error', () => {
  const lines = [];
  for (let i = 0; i < 101; i++) lines.push('P' + i + ' 1');
  const r = parse(lines.join('\n'), board());
  if (!r.errors.some(e => /100/.test(e.message))) throw new Error('no too-many-lines error: ' + JSON.stringify(r.errors.slice(0, 2)));
  eq(r.rows.length <= 100, true, 'rows capped');
});

check('empty text is nothing, not an error', () => {
  const r = parse('  \n\n');
  eq(r.rows, [], 'rows');
  eq(r.errors, [], 'errors');
  eq(r.total, 0, 'total');
});

check('a hostile name stays plain text in the row', () => {
  const r = parse('<b>x</b> 3');
  eq(r.rows[0].name, '<b>x</b>', 'name kept verbatim for the caller to escape');
});

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} failed, ${passed} passed`);
  failures.forEach(f => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log(`  paste list: ${passed} passed`);
