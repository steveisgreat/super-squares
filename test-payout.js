// Zero-dependency tests for payout tracking (R21): the pure transitions in
// public/compute.js and the host-only PATCH /api/game/:id/payout route.
// "Paid out" is a record the host keeps; the app never holds or moves money
// (decision 004). Run with:  node test-payout.js   (or: npm test)
'use strict';

delete process.env.DATABASE_URL;
delete process.env.HOST_PASSWORD;

const G = require('./public/compute.js');
const { handleApi } = require('./lib/api.js');
const store = require('./lib/store.js');

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

const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// $10 squares, 4 claimed => $40 pot; 25% a quarter => $10 each.
function baseGame(extra) {
  const squares = G.emptyGrid();
  squares[7 * 10 + 3] = { name: 'Ann' };   // A ends 7, B ends 3
  squares[0 * 10 + 0] = { name: 'Bob' };   // 0-0
  squares[4 * 10 + 1] = { name: 'Cy' };    // 14-21
  squares[1 * 10 + 4] = { name: 'Ann' };   // 21-14 (Ann's second square)
  return Object.assign({
    league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 25, q2: 25, q3: 25, final: 25 },
    status: 'started', scoring: 'manual', squares,
    axisX: IDENTITY.slice(), axisY: IDENTITY.slice(), results: {}, players: {}
  }, extra || {});
}

// Fills in the winner and amount the host was shown, as the UI does.
function seen(game, op) {
  if (op.op === 'unpaid' || 'name' in op) return op;
  const s = G.payoutStatus(game)[op.quarter];
  return Object.assign({ name: s.name, amount: s.amount }, op);
}
function pay(game, op) {
  const r = G.applyPayoutOp(game, seen(game, op));
  if (r.error) throw new Error(`op ${JSON.stringify(op)} failed: ${r.error}`);
  return r.game;
}
const st = (game, q) => G.payoutStatus(game)[q].state;

async function main() {
  // ---------- status, derived from results ----------
  await check('payoutStatus: unscored quarter is pending', () => {
    const s = G.payoutStatus(baseGame());
    eq(G.QUARTERS.map(q => s[q].state), ['pending', 'pending', 'pending', 'pending']);
  });
  await check('payoutStatus: a won quarter is unpaid with the winner and amount', () => {
    const s = G.payoutStatus(baseGame({ results: { q1: { a: 7, b: 3 } } }));
    eq([s.q1.state, s.q1.name, s.q1.amount, s.q1.paid], ['unpaid', 'Ann', 10, null]);
  });
  await check('payoutStatus: a pushed quarter has nothing to pay', () => {
    const s = G.payoutStatus(baseGame({ results: { q1: { a: 9, b: 9 } } }));
    eq([s.q1.state, s.q1.amount], ['pushed', 0]);
  });
  await check('payoutStatus: a final on an empty square waits for the draw', () => {
    const s = G.payoutStatus(baseGame({ status: 'finished', results: { final: { a: 9, b: 9 } } }));
    eq(s.final.state, 'needsDraw');
  });
  await check('payoutStatus: carry shows in the amount owed', () => {
    const s = G.payoutStatus(baseGame({ results: { q1: { a: 9, b: 9 }, q2: { a: 0, b: 0 } } }));
    eq([s.q2.state, s.q2.name, s.q2.amount], ['unpaid', 'Bob', 20]);
  });

  // ---------- mark paid out ----------
  await check('paid: records who was paid and how much, without mutating the input', () => {
    const g0 = baseGame({ results: { q1: { a: 7, b: 3 } } });
    const g1 = pay(g0, { op: 'paid', quarter: 'q1' });
    eq(g0.paidOut, undefined, 'input untouched');
    eq([g1.paidOut.q1.name, g1.paidOut.q1.amount], ['Ann', 10]);
    assert(typeof g1.paidOut.q1.at === 'string' && !isNaN(Date.parse(g1.paidOut.q1.at)), 'at is a timestamp');
    eq(st(g1, 'q1'), 'paid');
  });
  await check('paid: refused for pending, pushed, undrawn and already-paid quarters', () => {
    const g = baseGame({ status: 'finished', results: { q1: { a: 9, b: 9 }, q2: { a: 7, b: 3 }, final: { a: 9, b: 9 } } });
    eq(G.applyPayoutOp(g, seen(g, { op: 'paid', quarter: 'q3' })).code, 'illegal', 'pending');
    eq(G.applyPayoutOp(g, seen(g, { op: 'paid', quarter: 'q1' })).code, 'illegal', 'pushed');
    eq(G.applyPayoutOp(g, seen(g, { op: 'paid', quarter: 'final' })).code, 'illegal', 'needs draw');
    const paid = pay(g, { op: 'paid', quarter: 'q2' });
    eq(G.applyPayoutOp(paid, seen(paid, { op: 'paid', quarter: 'q2' })).code, 'illegal', 'twice');
  });
  await check('paid: a drawn final can be paid to the drawn square', () => {
    const g = baseGame({ status: 'finished', results: { final: { a: 9, b: 9, autoResolve: { key: '9-9', row: 1, col: 4 } } } });
    const s = G.payoutStatus(g);
    eq([s.final.state, s.final.name], ['unpaid', 'Ann']);
    eq(pay(g, { op: 'paid', quarter: 'final' }).paidOut.final.name, 'Ann');
  });
  await check('unpaid: undoes a mark, only from paid', () => {
    const g = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    const back = pay(g, { op: 'unpaid', quarter: 'q1' });
    eq([(back.paidOut || {}).q1, st(back, 'q1')], [undefined, 'unpaid']);
    eq(G.applyPayoutOp(back, seen(back, { op: 'unpaid', quarter: 'q1' })).code, 'illegal');
  });
  await check('ops: malformed input is invalid, not illegal', () => {
    const g = baseGame({ results: { q1: { a: 7, b: 3 } } });
    eq(G.applyPayoutOp(g, null).code, 'invalid');
    eq(G.applyPayoutOp(g, { op: 'zap', quarter: 'q1' }).code, 'invalid');
    eq(G.applyPayoutOp(g, { op: 'paid', quarter: 'q5' }).code, 'invalid');
    eq(G.applyPayoutOp(g, { op: 'paid', quarter: '__proto__' }).code, 'invalid');
  });
  await check('ops: refused before the board is locked', () => {
    eq(G.applyPayoutOp(baseGame({ status: 'picking' }), { op: 'paid', quarter: 'q1', name: null, amount: 0 }).code, 'illegal');
  });

  // ---------- correcting a paid quarter ----------
  await check('correction: a new winner on a paid quarter needs settling', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    const fixed = G.applyScoreOp(paid, { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game;
    const s = G.payoutStatus(fixed).q1;
    eq([s.state, s.name, s.amount, s.paid.name, s.paid.amount], ['needsSettling', 'Bob', 10, 'Ann', 10]);
  });
  await check('correction: the same winner on another square stays paid', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    const fixed = G.applyScoreOp(paid, { op: 'edit', quarter: 'q1', a: 21, b: 14 }).game;
    eq(st(fixed, 'q1'), 'paid');
  });
  await check('correction: an earlier quarter changing the carry unsettles a later paid one', () => {
    let g = baseGame({ results: { q1: { a: 9, b: 9 }, q2: { a: 7, b: 3 } } });
    eq(G.payoutStatus(g).q2.amount, 20);
    g = pay(g, { op: 'paid', quarter: 'q2' });
    g.results.q1 = { a: 0, b: 0 }; // Q1 now had a winner, so nothing carried
    const s = G.payoutStatus(g);
    eq([s.q1.state, s.q2.state, s.q2.amount, s.q2.paid.amount], ['unpaid', 'needsSettling', 10, 20]);
  });
  await check('correction: clearing a paid quarter needs settling', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    paid.results = {};
    eq(st(paid, 'q1'), 'needsSettling');
  });
  await check('correction: a paid quarter that becomes a push needs settling', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    paid.results.q1 = { a: 9, b: 9 };
    eq(st(paid, 'q1'), 'needsSettling');
  });
  await check('correction: changing the pot after the final was paid needs settling', () => {
    const paid = pay(baseGame({ status: 'finished', results: { final: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'final' });
    paid.potOverride = 100;
    eq(st(paid, 'final'), 'needsSettling');
  });
  await check('paidQuartersDisturbed: names paid quarters a change would unsettle', () => {
    const paid = pay(pay(baseGame({ results: { q1: { a: 7, b: 3 }, q2: { a: 0, b: 0 } } }), { op: 'paid', quarter: 'q1' }), { op: 'paid', quarter: 'q2' });
    const after = G.applyScoreOp(paid, { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game;
    eq(G.paidQuartersDisturbed(paid, after), ['Q1']);
    eq(G.paidQuartersDisturbed(paid, paid), []);
    const unpaid = baseGame({ results: { q1: { a: 7, b: 3 } } });
    eq(G.paidQuartersDisturbed(unpaid, G.applyScoreOp(unpaid, { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game), []);
  });

  // ---------- settle ----------
  await check('settle: records the current winner as paid', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    const fixed = G.applyScoreOp(paid, { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game;
    const settled = pay(fixed, { op: 'settle', quarter: 'q1' });
    eq([st(settled, 'q1'), settled.paidOut.q1.name, settled.paidOut.q1.amount], ['paid', 'Bob', 10]);
  });
  await check('settle: a quarter with nothing owed now drops its record', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    paid.results.q1 = { a: 9, b: 9 };
    const settled = pay(paid, { op: 'settle', quarter: 'q1' });
    eq([(settled.paidOut || {}).q1, st(settled, 'q1')], [undefined, 'pushed']);
  });
  await check('settle: only from needs settling; unpaid and paid refuse it', () => {
    const g = baseGame({ results: { q1: { a: 7, b: 3 } } });
    eq(G.applyPayoutOp(g, seen(g, { op: 'settle', quarter: 'q1' })).code, 'illegal');
    const paidG = pay(g, { op: 'paid', quarter: 'q1' });
    eq(G.applyPayoutOp(paidG, seen(paidG, { op: 'settle', quarter: 'q1' })).code, 'illegal');
    const fixed = G.applyScoreOp(pay(g, { op: 'paid', quarter: 'q1' }), { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game;
    eq(G.applyPayoutOp(fixed, seen(fixed, { op: 'paid', quarter: 'q1' })).code, 'illegal', 'paid is not a way out of needs settling');
    eq(G.applyPayoutOp(fixed, seen(fixed, { op: 'unpaid', quarter: 'q1' })).code, 'illegal', 'unpaid is not a way out of needs settling');
  });

  // ---------- who to pay ----------
  await check('whoToPay: one row per payable quarter and totals per person', () => {
    let g = baseGame({ status: 'finished', results: { q1: { a: 7, b: 3 }, q2: { a: 9, b: 9 }, q3: { a: 21, b: 14 }, final: { a: 0, b: 0 } } });
    g = pay(g, { op: 'paid', quarter: 'q1' });
    const w = G.whoToPay(g);
    eq(w.rows.map(r => [r.label, r.name, r.amount, r.state]), [
      ['Q1', 'Ann', 10, 'paid'], ['Q3', 'Ann', 20, 'unpaid'], ['FINAL', 'Bob', 10, 'unpaid']
    ]);
    eq(w.people, [{ name: 'Ann', total: 30, outstanding: 20 }, { name: 'Bob', total: 10, outstanding: 10 }]);
    eq([w.outstanding, w.needsSettling], [30, 0]);
  });
  await check('whoToPay: a needs-settling quarter is counted and flagged', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    const w = G.whoToPay(G.applyScoreOp(paid, { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game);
    eq([w.rows[0].state, w.rows[0].name, w.rows[0].paid.name, w.needsSettling, w.outstanding], ['needsSettling', 'Bob', 'Ann', 1, 10]);
  });
  await check('whoToPay: a cleared paid quarter still lists its record so the host can settle', () => {
    const paid = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    paid.results = {};
    const w = G.whoToPay(paid);
    eq([w.rows.length, w.rows[0].state, w.rows[0].name, w.rows[0].amount, w.outstanding], [1, 'needsSettling', null, 0, 0]);
  });

  await check('paid/settle: refused when the winner or amount differs from what the host saw', () => {
    const g = baseGame({ results: { q1: { a: 7, b: 3 } } });
    eq(G.applyPayoutOp(g, { op: 'paid', quarter: 'q1', name: 'Bob', amount: 10 }).code, 'illegal', 'other name');
    eq(G.applyPayoutOp(g, { op: 'paid', quarter: 'q1', name: 'Ann', amount: 20 }).code, 'illegal', 'other amount');
    eq(G.applyPayoutOp(g, { op: 'paid', quarter: 'q1' }).code, 'invalid', 'missing');
    const fixed = G.applyScoreOp(pay(g, { op: 'paid', quarter: 'q1' }), { op: 'edit', quarter: 'q1', a: 10, b: 0 }).game;
    eq(G.applyPayoutOp(fixed, { op: 'settle', quarter: 'q1', name: 'Ann', amount: 10 }).code, 'illegal', 'settle to the old winner');
    eq(st(pay(fixed, { op: 'settle', quarter: 'q1', name: 'Bob', amount: 10 }), 'q1'), 'paid');
  });
  await check('whoToPay: the same winner paid part of a changed amount owes only the difference', () => {
    let g = pay(baseGame({ status: 'finished', results: { final: { a: 0, b: 0 } } }), { op: 'paid', quarter: 'final' });
    g.potOverride = 100; // Final 10 -> 70
    let w = G.whoToPay(g);
    eq([w.rows[0].state, w.outstanding, w.people[0].outstanding], ['needsSettling', 60, 60]);
    g.potOverride = 35; // Final 10 -> 5: Bob was paid 5 too much
    w = G.whoToPay(g);
    eq([w.outstanding, w.people[0].outstanding], [-5, -5]);
  });

  // ---------- validation ----------
  await check('validateGame: accepts a good paidOut and rejects bad shapes', () => {
    const g = pay(baseGame({ results: { q1: { a: 7, b: 3 } } }), { op: 'paid', quarter: 'q1' });
    eq(G.validateGame(g), null);
    const bad = [
      [], { q5: { name: 'Ann', amount: 1 } }, { q1: 'Ann' }, { q1: { name: '', amount: 1 } },
      { q1: { name: 'Ann', amount: -1 } }, { q1: { name: 'Ann', amount: '10' } },
      { q1: { name: 'Ann', amount: 1, at: 'yesterday' } }, { q1: { name: '__proto__', amount: 1 } }
    ];
    bad.forEach(p => assert(G.validateGame(Object.assign({}, g, { paidOut: p })), 'should reject ' + JSON.stringify(p)));
  });

  // ---------- PATCH route ----------
  function fakeReq(method, url, body) {
    const req = {
      method, url, headers: { host: 'localhost:3000' }, socket: {},
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
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      writeHead(s, h) { this.statusCode = s; return this; },
      end(b) { this.body = b === undefined ? '' : String(b); return this; },
      get json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    };
  }
  async function call(method, path, body) {
    const res = fakeRes();
    const url = new URL(path, 'http://localhost:3000');
    await handleApi(fakeReq(method, path, body), res, url.pathname, url.searchParams);
    return res;
  }

  const created = [];
  try {
    const mk = async (extra) => {
      const g = baseGame(extra);
      g.pickMode = 'both';
      const res = await call('POST', '/api/game', g);
      assert(res.statusCode === 201, 'create failed: ' + res.body);
      created.push(res.json.id);
      return res.json;
    };

    await check('PATCH payout marks paid and stores it', async () => {
      const g = await mk({ results: { q1: { a: 7, b: 3 } } });
      const res = await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'q1', name: 'Ann', amount: 10 });
      eq(res.statusCode, 200);
      eq(res.json.paidOut.q1.name, 'Ann');
      eq((await store.getGame(g.id)).paidOut.q1.amount, 10);
    });
    await check('PATCH payout: invalid 400, illegal 409, unknown game 404', async () => {
      const g = await mk({ results: { q1: { a: 7, b: 3 } } });
      eq((await call('PATCH', `/api/game/${g.id}/payout`, { op: 'zap', quarter: 'q1' })).statusCode, 400);
      eq((await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'q2', name: 'Ann', amount: 10 })).statusCode, 409);
      eq((await call('PATCH', '/api/game/00000000-0000-4000-8000-000000000000/payout', { op: 'paid', quarter: 'q1' })).statusCode, 404);
      eq((await call('PATCH', `/api/game/${g.id}/payout`, '{nope')).statusCode, 400);
    });
    await check('PATCH payout works on a live board too', async () => {
      const g = await mk({ scoring: 'live', status: 'finished', results: { q1: { a: 7, b: 3 }, final: { a: 7, b: 3 } } });
      const res = await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'final', name: 'Ann', amount: 10 });
      eq([res.statusCode, res.json.paidOut && res.json.paidOut.final.name], [200, 'Ann']);
    });
    await check('PATCH payout on an in-progress live board keeps the feed score out of the row', async () => {
      const g = await mk({ scoring: 'live', results: { q1: { a: 7, b: 3 } } });
      const Slate = require('./lib/scores/slate.js');
      const real = Slate.readForGame;
      // The slate merges the feed's current score into the board on read.
      Slate.readForGame = async (game) => ({ matched: true, game: Object.assign(JSON.parse(JSON.stringify(game)), { liveScore: { a: 14, b: 10, period: 3, state: 'in' } }) });
      try {
        const res = await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'q1', name: 'Ann', amount: 10 });
        eq(res.statusCode, 200);
      } finally { Slate.readForGame = real; }
      const row = await store.getGame(g.id);
      assert(!row.liveScore || row.liveScore.manual, 'stored liveScore must be absent or host-entered, got ' + JSON.stringify(row.liveScore));
    });
    await check('PATCH payout requires the host when a password is set', async () => {
      const g = await mk({ results: { q1: { a: 7, b: 3 } } });
      process.env.HOST_PASSWORD = 'pw-for-payout-test';
      try {
        eq((await call('PATCH', `/api/game/${g.id}/payout`, { op: 'paid', quarter: 'q1' })).statusCode, 401);
      } finally { delete process.env.HOST_PASSWORD; }
      eq((await store.getGame(g.id)).paidOut, undefined);
    });
  } finally {
    for (const id of created) await store.deleteGame(id);
  }

  console.log(`test-payout.js: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
