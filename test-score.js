// Zero-dependency tests for manual scoring (R3): the pure transitions in
// public/compute.js and the host-only PATCH /api/game/:id/score route.
// Run with:  node test-score.js   (or: npm test)
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

function baseGame(extra) {
  const squares = G.emptyGrid();
  squares[7 * 10 + 3] = { name: 'Ann' };   // A=7, B=3
  squares[0 * 10 + 0] = { name: 'Bob' };   // 0-0 (also 10-10, 20-20)
  return Object.assign({
    league: 'nfl', gameDate: '2027-02-14', teamA: 'Chiefs', teamB: 'Eagles',
    squarePrice: 10, payouts: { q1: 20, q2: 20, q3: 20, final: 40 },
    status: 'started', scoring: 'manual', squares,
    axisX: IDENTITY.slice(), axisY: IDENTITY.slice(), results: {}, players: {}
  }, extra || {});
}

// Applies a list of ops, failing the test on the first error.
function run(game, ops) {
  let g = game;
  ops.forEach(op => {
    const r = G.applyScoreOp(g, op);
    if (r.error) throw new Error(`op ${JSON.stringify(op)} failed: ${r.error}`);
    g = r.game;
  });
  return g;
}
const add = (side, points) => ({ op: 'add', side, points });

async function main() {
  // ---------- scoring mode ----------
  await check('scoringMode: explicit value wins', () => {
    eq(G.scoringMode({ scoring: 'manual', simulation: true }), 'manual');
    eq(G.scoringMode({ scoring: 'live' }), 'live');
    eq(G.scoringMode({ scoring: 'simulation' }), 'simulation');
  });
  await check('scoringMode: legacy game reads simulation or live', () => {
    eq(G.scoringMode({ simulation: true }), 'simulation');
    eq(G.scoringMode({}), 'live');
    eq(G.scoringMode({ simulation: false }), 'live');
  });
  await check('scoringMode: unknown value falls back to the legacy rule', () => {
    eq(G.scoringMode({ scoring: 'bogus', simulation: true }), 'simulation');
  });
  await check('validateGame rejects an unknown scoring value, accepts none', () => {
    assert(G.validateGame(Object.assign(baseGame(), { scoring: 'bogus' })), 'bogus accepted');
    eq(G.validateGame(baseGame()), null);
    const legacy = baseGame(); delete legacy.scoring;
    eq(G.validateGame(legacy), null);
  });

  // ---------- add / set ----------
  await check('first add creates liveScore: state in, manual, period 1', () => {
    const g = run(baseGame(), [add('a', 7)]);
    eq([g.liveScore.a, g.liveScore.b, g.liveScore.period, g.liveScore.state, g.liveScore.manual], [7, 0, 1, 'in', true]);
    assert(g.liveScore.updatedAt, 'updatedAt stamped');
  });
  await check('add does not mutate its input', () => {
    const g = baseGame();
    G.applyScoreOp(g, add('a', 7));
    eq(g.liveScore, undefined);
  });
  await check('-1 never goes below 0', () => {
    const g = run(baseGame(), [add('a', -1), add('b', -1)]);
    eq([g.liveScore.a, g.liveScore.b], [0, 0]);
  });
  await check('add caps at 999', () => {
    const g = run(baseGame(), [{ op: 'set', a: 998, b: 0 }, add('a', 7)]);
    eq(g.liveScore.a, 999);
  });
  await check('set writes both teams', () => {
    const g = run(baseGame(), [{ op: 'set', a: 17, b: 14 }]);
    eq([g.liveScore.a, g.liveScore.b], [17, 14]);
  });
  await check('invalid add/set bodies are rejected as invalid', () => {
    [add('c', 3), add('a', 1.5), add('a', 'x'), { op: 'set', a: -1, b: 0 }, { op: 'set', a: 1000, b: 0 },
      { op: 'set', a: 1.2, b: 0 }, { op: 'set', a: 3 }, { op: 'nope' }, null, 'end'].forEach(op => {
      const r = G.applyScoreOp(baseGame(), op);
      assert(r.error && r.code === 'invalid', `expected invalid for ${JSON.stringify(op)}, got ${JSON.stringify(r.code)}`);
    });
  });
  await check('ops are illegal unless the game is manual', () => {
    const r = G.applyScoreOp(baseGame({ scoring: 'live' }), add('a', 3));
    eq(r.code, 'illegal');
  });
  await check('ops are illegal before the board is locked', () => {
    const r = G.applyScoreOp(baseGame({ status: 'picking' }), add('a', 3));
    eq(r.code, 'illegal');
  });

  // ---------- end quarter ----------
  await check('End Q1 copies the score into q1 and advances to period 2', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }]);
    eq([g.results.q1.a, g.results.q1.b, g.liveScore.period], [7, 3, 2]);
    eq([g.liveScore.a, g.liveScore.b], [7, 3]);
    eq(g.status, 'started');
    const c = G.computeGame(g);
    eq(c.results.q1.winnerName, 'Ann');
  });
  await check('End Q2 and End Q3 each write their own quarter', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, add('a', 3), { op: 'end' }, add('b', 7), { op: 'end' }]);
    eq([g.results.q2.a, g.results.q2.b], [10, 3]);
    eq([g.results.q3.a, g.results.q3.b], [10, 10]);
    eq(g.liveScore.period, 4);
    eq(g.results.q1.a, 7);
  });
  await check('End Q4 not tied writes final and finishes the game', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, add('a', 7), { op: 'end' }]);
    eq([g.results.final.a, g.results.final.b], [14, 3]);
    eq(g.status, 'finished');
    eq(g.liveScore.state, 'post');
    eq(g.liveScore.completed, true);
  });
  await check('End Q4 tied goes to overtime without a result', () => {
    const g = run(baseGame(), [{ op: 'set', a: 10, b: 10 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, { op: 'end' }]);
    eq(g.liveScore.period, 5);
    eq(g.results.final, undefined);
    eq(g.status, 'started');
    eq(g.liveScore.state, 'in');
  });
  await check('End from OT writes final and finishes', () => {
    const g = run(baseGame(), [{ op: 'set', a: 10, b: 10 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, { op: 'end' }, add('b', 3), { op: 'end' }]);
    eq([g.results.final.a, g.results.final.b], [10, 13]);
    eq(g.status, 'finished');
    eq(g.liveScore.period, 5);
  });
  await check('Final op finishes from any period', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, { op: 'final' }]);
    eq([g.results.final.a, g.results.final.b], [7, 3]);
    eq(g.status, 'finished');
  });
  await check('score and end are illegal after Final', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'final' }]);
    eq(G.applyScoreOp(g, { op: 'end' }).code, 'illegal');
    eq(G.applyScoreOp(g, add('a', 3)).code, 'illegal');
    eq(G.applyScoreOp(g, { op: 'final' }).code, 'illegal');
  });

  // ---------- undo ----------
  await check('undo after End Q1 reopens Q1: result cleared, period 1, score untouched', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, add('a', 3), { op: 'undo' }]);
    eq(g.results.q1, undefined);
    eq(g.liveScore.period, 1);
    eq([g.liveScore.a, g.liveScore.b], [10, 3]);
  });
  await check('undo steps back through Q3, Q2, Q1 in order', () => {
    let g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, { op: 'end' }, { op: 'end' }]);
    g = run(g, [{ op: 'undo' }]);
    eq([g.liveScore.period, g.results.q3, g.results.q2 !== undefined], [3, undefined, true]);
    g = run(g, [{ op: 'undo' }]);
    eq([g.liveScore.period, g.results.q2, g.results.q1 !== undefined], [2, undefined, true]);
    g = run(g, [{ op: 'undo' }]);
    eq([g.liveScore.period, g.results.q1], [1, undefined]);
  });
  await check('undo with nothing ended is illegal', () => {
    eq(G.applyScoreOp(baseGame(), { op: 'undo' }).code, 'illegal');
    eq(G.applyScoreOp(run(baseGame(), [add('a', 3)]), { op: 'undo' }).code, 'illegal');
  });
  await check('undo from OT returns to Q4', () => {
    let g = run(baseGame(), [{ op: 'set', a: 10, b: 10 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, { op: 'end' }]);
    g = run(g, [{ op: 'undo' }]);
    eq(g.liveScore.period, 4);
    eq(g.results.q3 !== undefined, true);
  });
  await check('undo of Final reopens the game in the same period', () => {
    let g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, { op: 'end' }]);
    eq(g.status, 'finished');
    g = run(g, [{ op: 'undo' }]);
    eq(g.results.final, undefined);
    eq(g.status, 'started');
    eq([g.liveScore.state, g.liveScore.completed, g.liveScore.period], ['in', false, 4]);
    eq([g.liveScore.a, g.liveScore.b], [7, 3]);
  });
  await check('undo of Final from OT returns to OT', () => {
    let g = run(baseGame(), [{ op: 'set', a: 10, b: 10 }, { op: 'end' }, { op: 'end' }, { op: 'end' }, { op: 'end' }, add('a', 3), { op: 'end' }]);
    g = run(g, [{ op: 'undo' }]);
    eq([g.status, g.liveScore.period], ['started', 5]);
  });

  // ---------- edit ----------
  await check('edit changes only that quarter; current score untouched; winner recalcs', () => {
    let g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, add('a', 3)]);
    eq(G.computeGame(g).results.q1.winnerName, 'Ann');
    g = run(g, [{ op: 'edit', quarter: 'q1', a: 0, b: 0 }]);
    eq([g.results.q1.a, g.results.q1.b], [0, 0]);
    eq(G.computeGame(g).results.q1.winnerName, 'Bob');
    eq([g.liveScore.a, g.liveScore.b, g.liveScore.period], [10, 3, 2]);
  });
  await check('edit to an empty square pushes the amount into the next quarter', () => {
    let g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }, { op: 'end' }]);
    g = run(g, [{ op: 'edit', quarter: 'q1', a: 1, b: 1 }]);
    const c = G.computeGame(g);
    eq(c.results.q1.pushed, true);
    eq(c.results.q2.carryIn, c.results.q1.amount);
  });
  await check('edit of final recalcs the winner and keeps the game finished', () => {
    let g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'final' }]);
    g = run(g, [{ op: 'edit', quarter: 'final', a: 10, b: 10 }]);
    eq(G.computeGame(g).results.final.winnerName, 'Bob');
    eq(g.status, 'finished');
  });
  await check('edit of a quarter that has not ended is illegal; bad input invalid', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }, { op: 'end' }]);
    eq(G.applyScoreOp(g, { op: 'edit', quarter: 'q2', a: 1, b: 1 }).code, 'illegal');
    eq(G.applyScoreOp(g, { op: 'edit', quarter: 'q9', a: 1, b: 1 }).code, 'invalid');
    eq(G.applyScoreOp(g, { op: 'edit', quarter: 'q1', a: -1, b: 1 }).code, 'invalid');
    eq(G.applyScoreOp(g, { op: 'edit', quarter: 'q1', a: 1 }).code, 'invalid');
  });

  // ---------- warning helper ----------
  await check('belowEndedQuarter flags a current score under an ended quarter', () => {
    const g = run(baseGame(), [{ op: 'set', a: 14, b: 10 }, { op: 'end' }, { op: 'set', a: 7, b: 10 }]);
    eq(G.belowEndedQuarter(g), 'Q1');
    eq(G.belowEndedQuarter(run(g, [{ op: 'set', a: 14, b: 10 }])), null);
    eq(G.belowEndedQuarter(baseGame()), null);
  });

  // ---------- live highlight keeps working ----------
  await check('manual liveScore drives computeLiveHighlight', () => {
    const g = run(baseGame(), [{ op: 'set', a: 7, b: 3 }]);
    eq(G.computeLiveHighlight(g).winnerKey, '7-3');
  });

  // ---------- drawn winner survives edit and undo ----------
  function drawnFinalGame() {
    // 7-3 lands on an empty square (Ann is at 7,3 in baseGame, so use 1-1).
    let g = run(baseGame(), [{ op: 'set', a: 17, b: 10 }, { op: 'final' }]);
    g.results.final.autoResolve = { key: '7-0', row: 0, col: 0, drawnAt: 1 };
    return g;
  }
  await check('edit keeps a drawn winner when the digits are unchanged (17-10 to 27-10)', () => {
    const g = drawnFinalGame();
    const before = G.computeGame(g).results.final;
    eq(before.autoResolved, true);
    const after = G.computeGame(run(g, [{ op: 'edit', quarter: 'final', a: 27, b: 10 }])).results.final;
    eq([after.autoResolved, after.winnerName, after.row, after.col], [true, before.winnerName, before.row, before.col]);
  });
  await check('undo then final at the same score gives the same drawn winner', () => {
    const g = drawnFinalGame();
    const w = G.computeGame(g).results.final.winnerName;
    const undone = run(g, [{ op: 'undo' }]);
    eq(undone.status, 'started');
    eq(undone.results.final.a, undefined);
    const again = run(undone, [{ op: 'final' }]);
    eq(again.status, 'finished');
    eq(G.computeGame(again).results.final.winnerName, w);
  });
  await check('hasResult is exported and needs both scores', () => {
    eq([G.hasResult({ a: 0, b: 0 }), G.hasResult({ a: 1 }), G.hasResult(undefined), G.hasResult({ a: '', b: 2 })], [true, false, false, false]);
  });

  // ---------- live refresh gating ----------
  await check('refreshLiveScore never touches a manual game', async () => {
    const LiveScore = require('./server-livescore.js');
    const g = run(baseGame({ id: 'x', simulation: true }), [{ op: 'set', a: 7, b: 3 }]);
    const before = JSON.stringify(g);
    eq(await LiveScore.refreshLiveScore(g, async () => true), false);
    eq(JSON.stringify(g), before);
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

    await check('PATCH add updates liveScore and returns the fresh game', async () => {
      const g = await mk();
      const res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 7 });
      eq(res.statusCode, 200);
      eq(res.json.liveScore.a, 7);
      const stored = await store.getGame(g.id);
      eq(stored.liveScore.a, 7);
    });
    await check('PATCH end then undo round-trips through the store', async () => {
      const g = await mk();
      await call('PATCH', `/api/game/${g.id}/score`, { op: 'set', a: 7, b: 3 });
      let res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'end' });
      eq([res.statusCode, res.json.results.q1.a, res.json.liveScore.period], [200, 7, 2]);
      res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'undo' });
      eq([res.statusCode, res.json.results.q1, res.json.liveScore.period], [200, undefined, 1]);
    });
    await check('PATCH final finishes the game (syncStatus)', async () => {
      const g = await mk();
      await call('PATCH', `/api/game/${g.id}/score`, { op: 'set', a: 7, b: 3 });
      const res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'final' });
      eq(res.json.status, 'finished');
    });
    await check('PATCH invalid op is 400, illegal op is 409, unknown game 404, bad JSON 400', async () => {
      const g = await mk();
      eq((await call('PATCH', `/api/game/${g.id}/score`, { op: 'zap' })).statusCode, 400);
      eq((await call('PATCH', `/api/game/${g.id}/score`, { op: 'undo' })).statusCode, 409);
      eq((await call('PATCH', '/api/game/00000000-0000-4000-8000-000000000000/score', { op: 'end' })).statusCode, 404);
      eq((await call('PATCH', `/api/game/${g.id}/score`, '{nope')).statusCode, 400);
    });
    await check('PATCH on a non-manual game is 409', async () => {
      const g = await mk({ scoring: 'live' });
      eq((await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 3 })).statusCode, 409);
    });
    await check('PATCH does not disturb square picks', async () => {
      const g = await mk();
      const res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'b', points: 3 });
      eq(res.json.squares, g.squares);
    });
    await check('PATCH requires the host when a password is set', async () => {
      const g = await mk();
      process.env.HOST_PASSWORD = 'pw-for-score-test';
      try {
        const res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 3 });
        eq(res.statusCode, 401);
      } finally { delete process.env.HOST_PASSWORD; }
      eq((await store.getGame(g.id)).liveScore, undefined);
    });
    await check('PATCH retries after a conflict instead of failing', async () => {
      const g = await mk();
      const real = store.updateGame;
      let first = true;
      store.updateGame = async (id, doc, token) => {
        if (first) {
          first = false;
          // Someone else writes between our read and our write.
          const cur = await store.getGame(id);
          cur.description = 'changed elsewhere';
          await real(id, cur, cur.updatedAt);
        }
        return real(id, doc, token);
      };
      try {
        const res = await call('PATCH', `/api/game/${g.id}/score`, { op: 'add', side: 'a', points: 3 });
        eq(res.statusCode, 200);
        eq([res.json.liveScore.a, res.json.description], [3, 'changed elsewhere']);
      } finally { store.updateGame = real; }
    });
  } finally {
    for (const id of created) await store.deleteGame(id);
  }

  console.log(`test-score.js: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
}

main();
