// Pure game logic shared by the browser app, the server (for auto-cutoff
// locking and request validation) and test.js. No DOM, no fs — keep it that way
// so it can be require()'d from Node and loaded with a <script> tag.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QUARTERS = ['q1', 'q2', 'q3', 'final'];
  const QLABEL = { q1: 'Q1', q2: 'Q2', q3: 'Q3', final: 'FINAL' };
  const STATUSES = ['setup', 'picking', 'started', 'finished'];
  const LEAGUES = ['nfl', 'nba', 'other'];

  // Fisher-Yates. Do NOT replace with arr.sort(() => Math.random() - 0.5) —
  // that is not a uniform shuffle and visibly clusters auto-picked squares.
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function shuffledDigits() {
    return shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }

  function emptyGrid() {
    return new Array(100).fill(null);
  }

  // The pot as actually collected: squares claimed times the price per square.
  function actualPotOf(game) {
    const filled = game.squares.filter(s => s).length;
    return filled * (parseFloat(game.squarePrice) || 0);
  }

  // The pot shown as "Total Pot" and used to settle the Final payout: a
  // manually-entered whole-dollar override if one is stored, otherwise the
  // actual collected total. Blanking the override (storing null) falls back
  // to the actual amount. Overrides are always whole dollars.
  function potOf(game) {
    const override = game.potOverride;
    if (override !== null && override !== undefined && override !== '') {
      const n = Math.round(Number(override));
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return actualPotOf(game);
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Payout amounts are always displayed as whole dollars (see money() in
  // ui.js), so rounding here must match that or Q1+Q2+Q3+Final won't add up
  // to the Total Pot shown on screen.
  function roundMoney(n) {
    return Math.round(n);
  }

  function findCol(game, digit) { return game.axisX ? game.axisX.indexOf(digit) : -1; }
  function findRow(game, digit) { return game.axisY ? game.axisY.indexOf(digit) : -1; }

  // Scores are entered as the actual (possibly multi-digit) score, but a
  // square's coordinates are only ever the ones digit of each team's score.
  function lastDigit(n) {
    return ((n % 10) + 10) % 10;
  }

  // Returns computed results per quarter + cell winner map { "row-col": [labels] }.
  //
  // Carry ("push") rules: an unclaimed square in Q1-Q3 rolls its payout into the
  // next quarter that actually resolves. A quarter with no score entered yet
  // displays base + carry (that is what it will pay if it is scored next) but
  // does NOT consume the carry — otherwise backfilling quarters out of order
  // would silently lose the rolled-over money.
  function computeGame(game) {
    const pot = potOf(game);
    const actualPot = actualPotOf(game);
    const basePct = game.payouts || { q1: 25, q2: 25, q3: 25, final: 25 };
    const cellLabels = {}; // key "r-c" -> array of quarter labels
    const out = {};
    let carry = 0;

    // Q1-Q3 always come from the system-calculated (actual) pot, never from a
    // manually-edited Total Pot — a shortage or overage on the edited figure
    // should only ever change what Final pays. Final is whatever is left of
    // the (possibly overridden) Total Pot after Q1-Q3, so all four displayed
    // amounts always sum to exactly the displayed Total Pot.
    const baseAmounts = {};
    let nonFinalSum = 0;
    ['q1', 'q2', 'q3'].forEach(q => {
      const amt = roundMoney(actualPot * (parseFloat(basePct[q]) || 0) / 100);
      baseAmounts[q] = amt;
      nonFinalSum += amt;
    });
    baseAmounts.final = roundMoney(pot) - nonFinalSum;

    QUARTERS.forEach(q => {
      const entry = (game.results && game.results[q]) || {};
      const baseAmount = baseAmounts[q];
      const amount = baseAmount + carry;
      const hasA = entry.a !== null && entry.a !== undefined && entry.a !== '';
      const hasB = entry.b !== null && entry.b !== undefined && entry.b !== '';
      const res = { amount, baseAmount, carryIn: carry, a: hasA ? Number(entry.a) : null, b: hasB ? Number(entry.b) : null, resolved: false, pushed: false, needsDraw: false, winnerName: null, row: null, col: null, autoResolved: false };

      if (hasA && hasB && game.axisX && game.axisY) {
        const row = findRow(game, lastDigit(res.a));
        const col = findCol(game, lastDigit(res.b));
        let winRow = row, winCol = col;
        let autoResolved = false;

        let cell = (row >= 0 && col >= 0) ? game.squares[row * 10 + col] : null;

        if (!cell && q === 'final') {
          // Use stored resolution if it matches the current digit pair; else needs manual re-draw via button.
          const key = `${row}-${col}`;
          const stored = entry.autoResolve;
          if (stored && stored.key === key && typeof stored.row === 'number') {
            winRow = stored.row;
            winCol = stored.col;
            cell = game.squares[winRow * 10 + winCol];
            autoResolved = true;
          } else {
            winRow = null; winCol = null; cell = null;
          }
        }

        if (cell) {
          res.resolved = true;
          res.winnerName = cell.name;
          res.row = winRow;
          res.col = winCol;
          res.autoResolved = autoResolved;
          const key = `${winRow}-${winCol}`;
          if (!cellLabels[key]) cellLabels[key] = [];
          cellLabels[key].push({ label: QLABEL[q], pushed: false });
          carry = 0;
        } else if (q === 'final') {
          res.needsDraw = (row >= 0 && col >= 0);
          res.row = row;
          res.col = col;
          carry = 0; // paid out to the drawn winner; nothing left to roll
        } else {
          res.resolved = true;
          res.pushed = true;
          res.row = row;
          res.col = col;
          carry = amount;
          if (row >= 0 && col >= 0) {
            const key = `${row}-${col}`;
            if (!cellLabels[key]) cellLabels[key] = [];
            cellLabels[key].push({ label: QLABEL[q], pushed: true });
          }
        }
      }
      // Pending quarter: leave `carry` untouched so it survives to whichever
      // quarter is scored next, even if quarters are filled in out of order.

      out[q] = res;
    });

    // A still-blank quarter only advertises the rolled-over money if no later
    // quarter has already collected it. Without this, scoring Q3 while Q2 is
    // blank leaves Q2 showing a rollover that has already been paid out.
    QUARTERS.forEach((q, i) => {
      const res = out[q];
      if (res.resolved || res.needsDraw || res.carryIn === 0) return;
      const collectedLater = QUARTERS.slice(i + 1).some(later => out[later].resolved || out[later].needsDraw);
      if (collectedLater) {
        res.carryIn = 0;
        res.amount = res.baseAmount;
      }
    });

    return { pot, results: out, cellLabels, unallocated: carry };
  }

  // Deltas covering every realistic next scoring play, per league.
  // NFL: safety (2), field goal (3), touchdown without the kick (6), touchdown
  // with the kick (7), or a two-point conversion (8). Kept flat rather than
  // trying to detect the brief window between a TD landing (+6) and the PAT
  // resolving (+7/+8): the 2-point square is already highlighted before the
  // snap, and nothing needs to change when the PAT resolves either way.
  // NBA: free throw (1), field goal (2), three (3).
  // Other: the sport is unknown, so no near squares, only the current winner.
  const NEAR_SCORE_DELTAS = { nfl: [2, 3, 6, 7, 8], nba: [1, 2, 3], other: [] };

  // The square that would win right now if the live/simulated score ended
  // exactly as-is, plus every square one probable score away for either
  // team. Used only by the TV screen to show where the game is heading
  // before a quarter (or the whole game) actually locks in — returns null
  // whenever there's no live feed in progress or no axis numbers yet.
  function computeLiveHighlight(game) {
    const live = game.liveScore;
    if (!live || live.state !== 'in') return null;
    if (live.a === null || live.a === undefined || live.b === null || live.b === undefined) return null;
    if (!game.axisX || !game.axisY) return null;

    const liveRow = findRow(game, lastDigit(live.a));
    const liveCol = findCol(game, lastDigit(live.b));
    if (liveRow < 0 || liveCol < 0) return null;

    const winnerKey = `${liveRow}-${liveCol}`;
    const nearKeys = new Set();
    (NEAR_SCORE_DELTAS[game.league] || NEAR_SCORE_DELTAS.other).forEach(delta => {
      const row = findRow(game, lastDigit(live.a + delta));
      if (row >= 0) {
        const key = `${row}-${liveCol}`;
        if (key !== winnerKey) nearKeys.add(key);
      }
      const col = findCol(game, lastDigit(live.b + delta));
      if (col >= 0) {
        const key = `${liveRow}-${col}`;
        if (key !== winnerKey) nearKeys.add(key);
      }
    });

    return { winnerKey, nearKeys };
  }

  // A pushed quarter never actually pays anyone — its whole amount rolls
  // into whichever quarter is scored next (see the carry handling above), so
  // every place a quarter's payout figure is shown should read $0 for it
  // rather than the amount that's really just passing through.
  function payoutAmount(res) {
    return res.pushed ? 0 : res.amount;
  }

  // The two axis digits of the square randomly drawn to stand in for an
  // empty winning square (see "Randomly Draw Winner" on the board/phone) —
  // null unless this quarter's result was actually auto-resolved that way.
  // Distinct from the real final score, which is never touched by a draw.
  function drawnDigits(game, res) {
    if (!res || !res.autoResolved) return null;
    if (!game || !game.axisX || !game.axisY) return null;
    if (res.row === null || res.row === undefined || res.col === null || res.col === undefined) return null;
    return { y: game.axisY[res.row], x: game.axisX[res.col] };
  }

  // ---------- Payout tracking (R21) ----------
  // "Paid out" is a note the host keeps; the app never holds or moves money
  // (decision 004). game.paidOut[q] = { name, amount, at } records who the host
  // paid and how much. Whether that still holds is worked out here from the
  // current results, never stored: a score correction, a change to the pot or
  // an earlier quarter's carry that changes a paid quarter's winner or amount
  // turns it to 'needsSettling' until the host settles it (decision 015).
  //
  // States: pending (not scored), pushed (rolled forward, nothing to pay),
  // needsDraw (final on an empty square), unpaid, paid, needsSettling.
  function payoutStatus(game) {
    const results = computeGame(game).results;
    const paidOut = isRecord(game.paidOut) ? game.paidOut : {};
    const out = {};
    QUARTERS.forEach(q => {
      const r = results[q];
      const rec = isRecord(paidOut[q]) ? paidOut[q] : null;
      const payable = r.resolved && !r.pushed && !!r.winnerName;
      const s = {
        quarter: q, label: QLABEL[q],
        name: payable ? r.winnerName : null,
        amount: payable ? payoutAmount(r) : 0,
        paid: rec ? { name: rec.name, amount: rec.amount, at: rec.at || null } : null
      };
      if (payable) {
        if (!rec) s.state = 'unpaid';
        else s.state = (rec.name === s.name && rec.amount === s.amount) ? 'paid' : 'needsSettling';
      } else if (rec) s.state = 'needsSettling';
      else if (r.needsDraw) s.state = 'needsDraw';
      else if (r.pushed) s.state = 'pushed';
      else s.state = 'pending';
      out[q] = s;
    });
    return out;
  }

  // One payout operation, as a pure function like applyScoreOp: returns
  // { game } (a fresh copy) or { error, code } with code 'invalid' (HTTP 400)
  // or 'illegal' (HTTP 409).
  //   paid    unpaid -> paid: record the current winner and amount.
  //   unpaid  paid -> unpaid: undo a mark made by mistake.
  //   settle  needsSettling -> paid to the current winner, or no record when
  //           the quarter owes nothing now. The host has sorted it out off-app.
  function applyPayoutOp(game, op) {
    if (!isRecord(op)) return failure('invalid', 'Payout operation must be an object.');
    if (['paid', 'unpaid', 'settle'].indexOf(op.op) === -1) return failure('invalid', 'Unknown payout operation.');
    if (QUARTERS.indexOf(op.quarter) === -1) return failure('invalid', 'Quarter must be q1, q2, q3 or final.');
    // paid and settle carry the winner and amount the host was shown, so a
    // result that changed after the screen drew (a feed update, another
    // device) is refused instead of recorded against someone the host didn't pay.
    const marks = op.op !== 'unpaid';
    if (marks && (!(op.name === null || typeof op.name === 'string') || !isAmount(op.amount, 1e9))) {
      return failure('invalid', 'Say which winner and amount you paid.');
    }
    if (game.status !== 'started' && game.status !== 'finished') return failure('illegal', 'Payouts open once the board is locked.');

    const q = op.quarter;
    const label = QLABEL[q];
    const s = payoutStatus(game)[q];
    if (marks && (op.name !== s.name || op.amount !== s.amount)) {
      return failure('illegal', `${label} changed since your screen updated. Check it and try again.`);
    }
    const g = JSON.parse(JSON.stringify(game));
    if (!isRecord(g.paidOut)) g.paidOut = {};
    const record = () => { g.paidOut[q] = { name: s.name, amount: s.amount, at: new Date().toISOString() }; };

    if (op.op === 'paid') {
      if (s.state === 'paid') return failure('illegal', `${label} is already marked paid out.`);
      if (s.state === 'needsSettling') return failure('illegal', `${label} needs settling first.`);
      if (s.state !== 'unpaid') return failure('illegal', `${label} has no winner to pay yet.`);
      record();
    } else if (op.op === 'unpaid') {
      if (s.state !== 'paid') return failure('illegal', `${label} is not marked paid out.`);
      delete g.paidOut[q];
    } else {
      if (s.state !== 'needsSettling') return failure('illegal', `${label} does not need settling.`);
      if (s.name) record();
      else delete g.paidOut[q];
    }
    // An emptied record stays as {}: screens merge the saved game into theirs
    // with Object.assign, which would keep a stale paidOut if the key vanished.
    return { game: g };
  }

  // Labels of quarters marked paid out that `after` would turn to needs
  // settling: the UI warns with these before it saves a correction.
  function paidQuartersDisturbed(before, after) {
    const b = payoutStatus(before);
    const a = payoutStatus(after);
    return QUARTERS.filter(q => b[q].state === 'paid' && a[q].state === 'needsSettling').map(q => QLABEL[q]);
  }

  // The game-over "who to pay" list: one row per quarter with someone to pay
  // or a record to settle, totals per current winner, and what is still owed.
  function whoToPay(game) {
    const status = payoutStatus(game);
    const rows = QUARTERS.map(q => status[q]).filter(s => ['unpaid', 'paid', 'needsSettling'].indexOf(s.state) !== -1);
    const byName = new Map();
    let outstanding = 0;
    rows.forEach(r => {
      // The same winner already paid part of a changed amount owes only the
      // difference; below zero means they were paid too much.
      const samePerson = r.state === 'needsSettling' && r.paid && r.name && r.paid.name === r.name;
      const owed = r.state === 'paid' ? 0 : samePerson ? r.amount - r.paid.amount : r.amount;
      outstanding += owed;
      if (!r.name) return;
      const p = byName.get(r.name) || { name: r.name, total: 0, outstanding: 0 };
      p.total += r.amount;
      p.outstanding += owed;
      byName.set(r.name, p);
    });
    return {
      rows, people: Array.from(byName.values()), outstanding,
      needsSettling: rows.filter(r => r.state === 'needsSettling').length
    };
  }

  function invalidPaidOut(paidOut) {
    const bad = 'The paid-out record is not valid.';
    if (!isRecord(paidOut)) return bad;
    for (const q of Object.keys(paidOut)) {
      const r = paidOut[q];
      if (QUARTERS.indexOf(q) === -1 || !isRecord(r)) return bad;
      if (!isPlayerName(r.name) || !isAmount(r.amount, 1e9)) return bad;
      if (!isUnset(r.at) && !(typeof r.at === 'string' && DATETIME_RE.test(r.at))) return bad;
    }
    return null;
  }

  function isDigitPermutation(a) {
    if (!Array.isArray(a) || a.length !== 10) return false;
    const seen = new Set(a);
    if (seen.size !== 10) return false;
    return a.every(n => Number.isInteger(n) && n >= 0 && n <= 9);
  }

  // ---------- Field types ----------
  // Every guest's browser draws what a host saved, and hosts are strangers
  // (decision 012), so any field that reaches markup, a style or a lookup key
  // is held to the exact type the screens expect. The screens escape as well.
  const PICK_MODES = ['manual', 'auto', 'both'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]{4,18}(Z|[+-]\d{2}:?\d{2})?$/;
  const ZONED_RE = /(Z|[+-]\d{2}:?\d{2})$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const MAX_NAME = 40; // the form allows 10 plus a subscript
  const MAX_TEXT = 200;
  const MAX_PLAYERS = 500;
  const MAX_SIM_EVENTS = 200;

  const isUnset = v => v === undefined || v === null;
  const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const isColor = v => typeof v === 'string' && COLOR_RE.test(v);
  const isText = (v, max) => typeof v === 'string' && v.length <= max;
  const isAmount = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const isWhole = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

  // Names double as keys of game.players, so one that every object already has
  // ("__proto__", "toString") would find something that is not a player.
  function isPlayerName(name) {
    return isText(name, MAX_NAME) && !!name.trim() && !(name in {});
  }

  function invalidPlayers(players) {
    if (!isRecord(players)) return 'Players must be an object.';
    const names = Object.keys(players);
    if (names.length > MAX_PLAYERS) return 'There are too many players.';
    for (const name of names) {
      if (name in {} || name.length > MAX_NAME) return 'A player name is not allowed.';
      const p = players[name];
      if (!isRecord(p)) return 'Each player must be an object.';
      if (p.paid !== undefined && typeof p.paid !== 'boolean') return 'A player can only be paid or unpaid.';
      if (!isUnset(p.color) && !isColor(p.color)) return 'A player color must be a hex color (e.g. #336699).';
      if (p.g !== undefined && !(typeof p.g === 'string' && GUEST_TAG_RE.test(p.g))) return 'A player guest tag is not valid.';
      if (p.paidSquares !== undefined && !isWhole(p.paidSquares, 100)) return 'A player paid-squares count must be a whole number from 0 to 100.';
    }
    return null;
  }

  // The host's switch for guest picks (decision 019 section 3). Exact keys and types:
  // the picking screen of every guest reads it.
  function invalidGuestPick(gp) {
    const bad = 'The guest-pick setting is not valid.';
    if (!isRecord(gp)) return bad;
    if (Object.keys(gp).some(k => ['on', 'max', 'liftAt', 'lifted'].indexOf(k) === -1)) return bad;
    if (typeof gp.on !== 'boolean' || typeof gp.lifted !== 'boolean') return bad;
    if (!Number.isInteger(gp.max) || gp.max < 1 || gp.max > 100) return bad;
    if (!isUnset(gp.liftAt)) {
      if (typeof gp.liftAt !== 'string' || !DATETIME_RE.test(gp.liftAt) || !ZONED_RE.test(gp.liftAt) || isNaN(Date.parse(gp.liftAt))) return bad;
    }
    return null;
  }

  function invalidResults(results) {
    if (!isRecord(results)) return 'Results must be an object.';
    for (const q of QUARTERS) {
      const entry = results[q];
      if (isUnset(entry)) continue;
      if (!isRecord(entry)) return `The ${QLABEL[q]} result must be an object.`;
      for (const side of ['a', 'b']) {
        const v = entry[side];
        if (!isUnset(v) && v !== '' && !isWhole(v, 9999)) return `${QLABEL[q]} scores must be whole numbers from 0 to 9999.`;
      }
      const draw = entry.autoResolve;
      if (isUnset(draw)) continue;
      if (!isRecord(draw) || typeof draw.key !== 'string' || !/^\d-\d$/.test(draw.key)
        || !isWhole(draw.row, 9) || !isWhole(draw.col, 9)
        || (!isUnset(draw.drawnAt) && !isAmount(draw.drawnAt, Number.MAX_SAFE_INTEGER))) return `The ${QLABEL[q]} drawn winner is not valid.`;
    }
    return null;
  }

  function invalidLiveScore(live) {
    if (!isRecord(live)) return 'The live score must be an object.';
    for (const side of ['a', 'b']) {
      if (!isUnset(live[side]) && !isWhole(live[side], 9999)) return 'Live scores must be whole numbers from 0 to 9999.';
    }
    if (!isUnset(live.period) && !isWhole(live.period, 99)) return 'The live score period must be a whole number.';
    for (const key of ['clock', 'state', 'statusName', 'updatedAt']) {
      if (!isUnset(live[key]) && !isText(live[key], 40)) return `The live score ${key} must be short text.`;
    }
    return null;
  }

  // The server adds these points up into liveScore (simLiveState) with no
  // second look, so a bad plan would become a bad score.
  function invalidSimPlan(plan) {
    const bad = 'The simulation plan is not valid.';
    if (!isRecord(plan) || !isText(plan.startedAt, 40) || isNaN(Date.parse(plan.startedAt))) return bad;
    if (!isUnset(plan.quarterMs) && !isAmount(plan.quarterMs, 24 * 60 * 60 * 1000)) return bad;
    if (!Array.isArray(plan.events) || plan.events.length > MAX_SIM_EVENTS) return bad;
    for (const e of plan.events) {
      if (!isRecord(e) || (e.team !== 'a' && e.team !== 'b') || !isAmount(e.atMs, Number.MAX_SAFE_INTEGER) || !isWhole(e.points, 99)) return bad;
    }
    return null;
  }

  // Server-side guard against a malformed client persisting a corrupt game.
  // Returns an error string, or null when the shape is acceptable.
  function validateGame(game) {
    if (!game || typeof game !== 'object' || Array.isArray(game)) return 'Game must be an object.';

    if (!game.gameDate || typeof game.gameDate !== 'string') return 'Game date is required.';
    if (!DATE_RE.test(game.gameDate)) return 'Game date must look like 2026-02-08.';

    for (const [key, label] of [['teamA', 'Team A'], ['teamB', 'Team B'], ['description', 'Description']]) {
      if (!isUnset(game[key]) && !isText(game[key], MAX_TEXT)) return `${label} must be ${MAX_TEXT} characters or fewer.`;
    }

    if (LEAGUES.indexOf(game.league) === -1) return `League must be one of: ${LEAGUES.join(', ')}.`;
    // Checked in every league: the setup form shows these whatever the league.
    for (const [key, label] of [['teamAColor', 'Team A color'], ['teamBColor', 'Team B color']]) {
      if (!isUnset(game[key]) && game[key] !== '' && !isColor(game[key])) return `${label} must be a hex color (e.g. #336699).`;
    }

    if (!isAmount(game.squarePrice, 1e6)) return 'Square price must be a number from 0 to 1000000.';

    if (!isUnset(game.potOverride) && !isWhole(game.potOverride, 1e9)) return 'Total pot must be a whole number of 0 or more.';

    if (!isUnset(game.pickMode) && PICK_MODES.indexOf(game.pickMode) === -1) return `Pick mode must be one of: ${PICK_MODES.join(', ')}.`;
    for (const [key, label] of [['autoCutoffTime', 'Cutoff'], ['kickoffTime', 'Kickoff']]) {
      const v = game[key];
      if (!isUnset(v) && v !== '' && !(typeof v === 'string' && DATETIME_RE.test(v))) return `${label} must be a date and time.`;
    }

    if (!Array.isArray(game.squares) || game.squares.length !== 100) return 'Squares must be an array of exactly 100 entries.';
    for (const sq of game.squares) {
      if (sq === null) continue;
      if (typeof sq !== 'object' || Array.isArray(sq)) return 'Each square must be null or an object.';
      if (typeof sq.name !== 'string' || !sq.name.trim()) return 'Each claimed square must have a non-empty name.';
      if (!isPlayerName(sq.name)) return 'A player name is not allowed.';
      // When a guest claimed it, in whole seconds since 1970 (decision 019 section 6).
      if (sq.at !== undefined && !isWhole(sq.at, 1e11)) return 'A square claim time is not valid.';
    }

    if (!isRecord(game.payouts)) return 'Payouts are required.';
    let total = 0;
    for (const q of QUARTERS) {
      const v = game.payouts[q];
      if (!isAmount(v, 1000)) return `Payout for ${QLABEL[q]} must be a number of 0 or more.`;
      total += v;
    }
    if (Math.abs(total - 100) > 0.01) return `Quarterly payout percentages must total 100% (got ${total}%).`;

    if (game.scoring !== undefined && SCORING_MODES.indexOf(game.scoring) === -1) return `Scoring must be one of: ${SCORING_MODES.join(', ')}.`;

    if (STATUSES.indexOf(game.status) === -1) return `Status must be one of: ${STATUSES.join(', ')}.`;

    for (const axis of ['axisX', 'axisY']) {
      if (game[axis] === null || game[axis] === undefined) continue;
      if (!isDigitPermutation(game[axis])) return `${axis} must be a permutation of the digits 0-9.`;
    }
    if ((game.status === 'started' || game.status === 'finished') && (!game.axisX || !game.axisY)) return 'A started game must have both axis number rows generated.';

    return (game.results !== undefined && invalidResults(game.results))
      || (game.players !== undefined && invalidPlayers(game.players))
      || (!isUnset(game.liveScore) && invalidLiveScore(game.liveScore))
      || (!isUnset(game.simPlan) && invalidSimPlan(game.simPlan))
      || (!isUnset(game.paidOut) && invalidPaidOut(game.paidOut))
      || (!isUnset(game.guestPick) && invalidGuestPick(game.guestPick))
      || null;
  }

  // True when picking should be locked because the configured cutoff has passed.
  // autoCutoffTime is an instant with a zone (the setup form saves UTC). Boards saved
  // before that hold a bare local time; only the host's browser knows whose local time
  // it is, so the server (UTC on Vercel) must never lock from one. The picking screen
  // still does (issue #4).
  function cutoffPassed(game, now) {
    if (!game || game.status !== 'picking') return false;
    if (!game.autoCutoffEnabled || !game.autoCutoffTime) return false;
    if (!ZONED_RE.test(game.autoCutoffTime)) return false;
    const t = new Date(game.autoCutoffTime).getTime();
    if (isNaN(t)) return false;
    return (now === undefined ? Date.now() : now) >= t;
  }

  // Mutates `game` into a started game with freshly drawn axis numbers. When
  // the host has turned on Simulation Mode, this is also the moment the fake
  // "live game" begins — its whole trajectory is randomly generated right
  // here and replayed against the wall clock afterward (see simLiveState),
  // rather than re-rolled on every poll, so the score only ever moves forward.
  function lockGame(game) {
    game.axisX = shuffledDigits();
    game.axisY = shuffledDigits();
    game.status = 'started';
    if (game.simulation) {
      game.simPlan = buildSimPlan();
      game.liveScore = null;
    }
    return game;
  }

  // ---------- Simulation mode ----------
  // Emulates the shape of the ESPN live-feed polling (see server-livescore.js)
  // without any network access, for testing/demoing without a real game to
  // point at. Quarters are compressed to 2 real minutes each so a full "game"
  // plays out in 8 minutes.
  const SIM_QUARTER_MS = 2 * 60 * 1000;
  const SIM_QUARTERS = 4;
  const SIM_POINT_VALUES = [3, 6, 7, 7, 7, 8]; // FG, TD-no-XP, TD+XP (weighted), TD+2pt

  // Random scoring plays for each team, timestamped (ms offset from kickoff)
  // across the whole simulated game. Sorted so downstream cumulative sums can
  // just filter by offset.
  function buildSimPlan() {
    const totalMs = SIM_QUARTER_MS * SIM_QUARTERS;
    const events = [];
    ['a', 'b'].forEach(team => {
      const playCount = 3 + Math.floor(Math.random() * 5); // 3-7 scoring plays
      for (let i = 0; i < playCount; i++) {
        events.push({
          team,
          atMs: Math.floor(Math.random() * totalMs),
          points: SIM_POINT_VALUES[Math.floor(Math.random() * SIM_POINT_VALUES.length)]
        });
      }
    });
    events.sort((x, y) => x.atMs - y.atMs);
    return { startedAt: new Date().toISOString(), quarterMs: SIM_QUARTER_MS, events };
  }

  function simEventsThrough(plan, team, ms) {
    return plan.events
      .filter(e => e.team === team && e.atMs <= ms)
      .reduce((sum, e) => sum + e.points, 0);
  }

  // Cumulative score for `team` at the end of `quarterNum` (1-4) — used to
  // backfill results.q1/q2/q3/final once that quarter is over.
  function simCumulativeThroughQuarter(plan, team, quarterNum) {
    const quarterMs = plan.quarterMs || SIM_QUARTER_MS;
    return simEventsThrough(plan, team, quarterNum * quarterMs);
  }

  function formatClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // The simulated equivalent of an ESPN scoreboard "status" + current score,
  // computed purely from elapsed wall-clock time since kickoff so it needs no
  // stored counters and never goes backward.
  function simLiveState(plan, now) {
    const quarterMs = plan.quarterMs || SIM_QUARTER_MS;
    const totalMs = quarterMs * SIM_QUARTERS;
    const elapsed = Math.max(0, (now === undefined ? Date.now() : now) - new Date(plan.startedAt).getTime());
    const completed = elapsed >= totalMs;
    const cappedElapsed = Math.min(elapsed, totalMs);
    const q0 = completed ? SIM_QUARTERS - 1 : Math.min(SIM_QUARTERS - 1, Math.floor(elapsed / quarterMs));
    const msIntoQuarter = completed ? quarterMs : elapsed - q0 * quarterMs;
    return {
      a: simEventsThrough(plan, 'a', cappedElapsed),
      b: simEventsThrough(plan, 'b', cappedElapsed),
      period: q0 + 1,
      clock: formatClock(quarterMs - msIntoQuarter),
      state: completed ? 'post' : 'in',
      completed
    };
  }

  // Once a game is locked (started/finished), its status tracks whether the
  // final score has been entered — set automatically rather than by hand, so
  // clearing the final score puts the game back "in progress" on its own.
  function syncStatus(game) {
    if (game.status !== 'started' && game.status !== 'finished') return game;
    const f = (game.results && game.results.final) || {};
    const hasFinal = f.a !== null && f.a !== undefined && f.a !== '' && f.b !== null && f.b !== undefined && f.b !== '';
    game.status = hasFinal ? 'finished' : 'started';
    return game;
  }

  // ---------- Scoring mode and manual score entry ----------
  const SCORING_MODES = ['manual', 'live', 'simulation'];
  const MAX_SCORE = 999;
  const OT_PERIOD = 5;

  // The one place the legacy rule lives: a stored game with no `scoring`
  // reads as 'simulation' when game.simulation is set, else 'live', which is
  // what every board made before manual mode did.
  function scoringMode(game) {
    if (game && SCORING_MODES.indexOf(game.scoring) !== -1) return game.scoring;
    return game && game.simulation ? 'simulation' : 'live';
  }

  // True when the host can enter the score by hand: a Manual board, or a Live board whose
  // feed is down (the server marks the response with liveFeed.available === false) or
  // whose score the host already holds (liveOverride). The score panel shows on these.
  function manualEntry(game) {
    const mode = scoringMode(game);
    if (mode === 'manual') return true;
    return mode === 'live' && (game.liveOverride === true || !!(game.liveFeed && game.liveFeed.available === false));
  }

  function isScore(n) {
    return Number.isInteger(n) && n >= 0 && n <= MAX_SCORE;
  }

  function hasResult(entry) {
    return !!entry && entry.a !== null && entry.a !== undefined && entry.a !== ''
      && entry.b !== null && entry.b !== undefined && entry.b !== '';
  }

  function failure(code, error) { return { error, code }; }

  // The manual current score; a game nobody has tapped yet reads 0-0, Q1.
  function manualState(game) {
    const live = game.liveScore;
    // A Live board seeds the host's entry from the feed's last score. A feed numbers each
    // overtime as its own period (5, 6, ...); the host has one OT period, so cap it there.
    if (live && (live.manual || scoringMode(game) === 'live')) {
      return {
        a: Number.isFinite(live.a) ? live.a : 0, b: Number.isFinite(live.b) ? live.b : 0,
        period: Math.min(live.period || 1, OT_PERIOD)
      };
    }
    return { a: 0, b: 0, period: 1 };
  }

  // The label of the first ended quarter whose score the current score has
  // fallen below (a likely mis-tap), or null. The UI confirms before ending.
  function belowEndedQuarter(game) {
    const cur = manualState(game);
    for (const q of ['q1', 'q2', 'q3']) {
      const r = game.results && game.results[q];
      if (hasResult(r) && (cur.a < Number(r.a) || cur.b < Number(r.b))) return QLABEL[q];
    }
    return null;
  }

  // Takes a quarter's score off, keeping the final's stored draw.
  function clearScore(g, q) {
    const draw = g.results[q].autoResolve;
    if (draw) g.results[q] = { autoResolve: draw };
    else delete g.results[q];
  }

  function writeLive(g, s, extra) {
    g.liveScore = Object.assign({
      a: s.a, b: s.b, period: s.period, clock: '', state: 'in', completed: false,
      manual: true, updatedAt: new Date().toISOString()
    }, extra || {});
  }

  // What the 'undo' operation would undo right now: 'final', 'ot' (the start of overtime), the
  // newest ended quarter, or null.
  function undoTarget(game) {
    const results = (game && game.results) || {};
    if (hasResult(results.final)) return 'final';
    const s = manualState(game);
    if (s.period === OT_PERIOD) return 'ot';
    for (let n = Math.min(s.period - 1, 3); n >= 1; n--) if (hasResult(results['q' + n])) return 'q' + n;
    return null;
  }

  // `from` on an operation is what the screen was showing when it was tapped. A well-formed one
  // that no longer matches is refused, so a second device never ends the next quarter or types
  // over a score it has not seen. Optional: an operation without it is applied as it stands.
  function badFrom(op) {
    if (op.op === 'undo') return op.expect !== undefined && QUARTERS.concat('ot').indexOf(op.expect) === -1;
    if (op.from === undefined) return false;
    if (op.op === 'edit' && op.from === null) return false;
    if (!isRecord(op.from) || !isScore(op.from.a) || !isScore(op.from.b)) return true;
    return op.from.period !== undefined && !Number.isInteger(op.from.period);
  }
  const MOVED = 'The score changed on another device. Check it and try again.';

  // One manual-score operation, as a pure function: returns { game } (a fresh
  // copy; the input is never mutated) or { error, code } where code is
  // 'invalid' (malformed op, HTTP 400) or 'illegal' (not allowed in the
  // current state, HTTP 409). The server is the authority; the UI calls the
  // same function for optimistic display. Only the server passes `ctx`
  // ({ pick(n): index, now: ms }): 'draw' needs it, so no browser chooses a winner.
  function applyScoreOp(game, op, ctx) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return failure('invalid', 'Score operation must be an object.');
    const name = op.op;
    if (['add', 'set', 'end', 'final', 'undo', 'edit', 'draw', 'resume'].indexOf(name) === -1) return failure('invalid', 'Unknown score operation.');

    // Validate the body before looking at game state, so a bad request is 400
    // whatever state the game is in.
    if (name === 'add') {
      if (op.side !== 'a' && op.side !== 'b') return failure('invalid', 'Side must be "a" or "b".');
      if (!Number.isInteger(op.points) || Math.abs(op.points) > MAX_SCORE) return failure('invalid', 'Points must be a whole number.');
    }
    if (name === 'set' && (!isScore(op.a) || !isScore(op.b))) return failure('invalid', `Scores must be whole numbers from 0 to ${MAX_SCORE}.`);
    if (name === 'edit') {
      if (QUARTERS.indexOf(op.quarter) === -1) return failure('invalid', 'Quarter must be q1, q2, q3 or final.');
      // Both null clears the quarter (Live and Simulation boards only).
      const clears = op.a === null && op.b === null;
      if (!clears && (!isScore(op.a) || !isScore(op.b))) return failure('invalid', `Scores must be whole numbers from 0 to ${MAX_SCORE}.`);
    }
    if (badFrom(op)) return failure('invalid', 'The score this change was made from is not valid.');

    // Fixing a quarter and drawing the final's winner work on every board and never take a
    // Live board's score over from the feed.
    const anyBoard = name === 'edit' || name === 'draw';

    // A Live board takes the host's taps only once the host has chosen to enter the score
    // (decision 001 section 6): the op says so (override: true) or the board already
    // holds a host score (liveOverride). Resume hands the score back to the feed.
    const mode = scoringMode(game);
    const takeover = mode === 'live' && (op.override === true || game.liveOverride === true);
    if (name === 'resume') {
      if (mode !== 'live') return failure('illegal', 'This game does not use a live feed.');
    } else if (mode !== 'manual' && !takeover && !anyBoard) {
      return failure('illegal', 'This game does not use manual scoring.');
    }
    if (game.status !== 'started' && game.status !== 'finished') return failure('illegal', 'Scoring opens once the board is locked.');

    const g = JSON.parse(JSON.stringify(game));
    if (name === 'resume') {
      delete g.liveOverride;
      g.liveScore = null;
      return { game: g };
    }
    if (!g.results) g.results = {};
    const s = manualState(g);
    const finished = hasResult(g.results.final);
    const ended = (q) => hasResult(g.results[q]);

    if (name === 'edit') {
      const q = op.quarter;
      // On a Manual board the quarters and the period move together (End and Undo), so only an
      // ended one can be fixed. Anywhere else a quarter can also be filled in or cleared.
      if (mode === 'manual' && !ended(q)) return failure('illegal', `${QLABEL[q]} has not ended yet.`);
      if (mode === 'manual' && op.a === null) return failure('illegal', 'Use Undo to take back an ended quarter.');
      if (op.from !== undefined) {
        const was = ended(q) ? { a: Number(g.results[q].a), b: Number(g.results[q].b) } : null;
        if (!was !== !op.from || (was && (was.a !== op.from.a || was.b !== op.from.b))) return failure('illegal', MOVED);
      }
      // A stored draw is keyed by grid row-col, and computeGame ignores one
      // that no longer matches, so it stays, as it does for undo.
      if (op.a === null) {
        if (!g.results[q]) return failure('illegal', `${QLABEL[q]} has no score to clear.`);
        clearScore(g, q);
      } else {
        g.results[q] = Object.assign({}, g.results[q], { a: op.a, b: op.b });
      }
      syncStatus(g);
      // A score kept on the board (the host's, or a simulation's) follows the game over and back.
      const kept = g.liveScore && (g.liveScore.manual || mode === 'simulation');
      if (q === 'final' && kept && mode !== 'manual') {
        g.liveScore = Object.assign({}, g.liveScore, op.a === null ? { state: 'in', completed: false } : { state: 'post', completed: true });
      }
      return { game: g };
    }

    if (name === 'draw') {
      const fin = computeGame(g).results.final;
      if (!fin.needsDraw) return failure('illegal', 'The final does not need a draw.');
      const claimed = g.squares.map((sq, i) => (sq ? i : -1)).filter(i => i >= 0);
      if (!claimed.length) return failure('illegal', 'No squares are filled in, so there is no winner to draw.');
      if (!ctx || typeof ctx.pick !== 'function') return failure('illegal', 'The winner is drawn on the server.');
      const idx = claimed[ctx.pick(claimed.length)];
      g.results.final.autoResolve = { key: `${fin.row}-${fin.col}`, row: Math.floor(idx / 10), col: idx % 10, drawnAt: ctx.now };
      return { game: g };
    }

    if (op.from && (op.from.a !== s.a || op.from.b !== s.b || (op.from.period !== undefined && op.from.period !== s.period))) {
      return failure('illegal', MOVED);
    }

    // From here the host holds the score of a Live board: the feed no longer overwrites it.
    if (mode === 'live') g.liveOverride = true;

    if (name === 'undo') {
      const target = undoTarget(g);
      if (!target) return failure('illegal', 'Nothing has ended yet.');
      if (op.expect !== undefined && op.expect !== target) return failure('illegal', MOVED);
      if (target === 'final') {
        // A stored draw stays, so Undo then Final at the same score keeps the
        // drawn winner instead of re-rolling it.
        clearScore(g, 'final');
        syncStatus(g);
        writeLive(g, s);
      } else if (target === 'ot') {
        writeLive(g, Object.assign({}, s, { period: 4 }));
      } else {
        delete g.results[target];
        writeLive(g, Object.assign({}, s, { period: Number(target[1]) }));
      }
      return { game: g };
    }

    if (finished) return failure('illegal', 'The game is already final.');

    if (name === 'add') {
      const key = op.side;
      const next = Math.min(MAX_SCORE, Math.max(0, s[key] + op.points));
      writeLive(g, Object.assign({}, s, { [key]: next }));
      return { game: g };
    }
    if (name === 'set') {
      writeLive(g, Object.assign({}, s, { a: op.a, b: op.b }));
      return { game: g };
    }

    // end / final
    const finish = () => {
      g.results.final = Object.assign({}, g.results.final, { a: s.a, b: s.b });
      writeLive(g, s, { state: 'post', completed: true });
      syncStatus(g);
      return { game: g };
    };
    if (name === 'final') return finish();
    if (s.period <= 3) {
      g.results['q' + s.period] = Object.assign({}, g.results['q' + s.period], { a: s.a, b: s.b });
      writeLive(g, Object.assign({}, s, { period: s.period + 1 }));
      return { game: g };
    }
    if (s.period === 4 && s.a === s.b) {
      writeLive(g, Object.assign({}, s, { period: OT_PERIOD }));
      return { game: g };
    }
    return finish();
  }

  // The plays on the score pad (decision 025 section 6), in the order of its buttons.
  const SCORE_PLAYS = {
    nfl: [
      { label: 'Touchdown', word: 'touchdown', points: 6 },
      { label: 'Extra point', word: 'extra point', points: 1 },
      { label: 'Field goal', word: 'field goal', points: 3 },
      { label: '2-pt or safety', word: 'two points', points: 2 }
    ],
    nba: [
      { label: 'Free throw', word: 'free throw', points: 1 },
      { label: 'Basket', word: 'basket', points: 2 },
      { label: 'Three', word: 'three', points: 3 }
    ],
    other: [{ label: 'Point', word: 'point', points: 1 }]
  };
  const scorePlays = (league) => (hasOwn(SCORE_PLAYS, league) ? SCORE_PLAYS[league] : SCORE_PLAYS.other);

  // Keyboard scoring (Game Day, R25 part b): Q W E R score for team A and U I O P for team B, left
  // to right down the pad's buttons, without regard to case. Returns a fresh 'add' op, or null for
  // a key that scores nothing.
  const SCORE_KEYS = { a: 'qwer', b: 'uiop' };
  function scoreKeyOp(league, key) {
    if (typeof key !== 'string' || key.length !== 1) return null;
    const k = key.toLowerCase();
    const side = SCORE_KEYS.a.indexOf(k) !== -1 ? 'a' : 'b';
    const play = scorePlays(league)[SCORE_KEYS[side].indexOf(k)];
    return play ? { op: 'add', side, points: play.points } : null;
  }

  // The op that undoes `op` after it was applied to `before` and gave `after` (both whole games),
  // or null when there is nothing to undo. An add is undone by the opposite add, for what it really
  // moved (a score clamped at 0 or 999 moved less than asked), so it is safe whatever happened since.
  // A typed score and a fixed quarter put the old numbers back, and an end or a final is undone by
  // the 'undo' op: those say what they expect to find and are refused if it changed. Taking a Live
  // board over, resume, undo and draw are not undone this way.
  function inverseScoreOp(op, before, after) {
    if (!op || typeof op !== 'object' || !before || !after) return null;
    const was = manualState(before);
    const is = manualState(after);
    if (op.op === 'add') {
      if (op.side !== 'a' && op.side !== 'b') return null;
      const moved = is[op.side] - was[op.side];
      return moved === 0 ? null : { op: 'add', side: op.side, points: -moved };
    }
    if (op.op === 'set') {
      if (was.a === is.a && was.b === is.b) return null;
      if (!before.liveOverride && after.liveOverride) return null;
      return { op: 'set', a: was.a, b: was.b, from: { a: is.a, b: is.b } };
    }
    if (op.op === 'edit') {
      const at = (game) => {
        const r = game.results && game.results[op.quarter];
        return hasResult(r) ? { a: Number(r.a), b: Number(r.b) } : null;
      };
      const old = at(before);
      const now = at(after);
      if (JSON.stringify(old) === JSON.stringify(now)) return null;
      return { op: 'edit', quarter: op.quarter, a: old ? old.a : null, b: old ? old.b : null, from: now };
    }
    if (op.op === 'end' || op.op === 'final') {
      const same = JSON.stringify(before.results || {}) === JSON.stringify(after.results || {})
        && JSON.stringify(was) === JSON.stringify(is);
      return same ? null : { op: 'undo', expect: undoTarget(after) };
    }
    return null;
  }

  // ---------- Player colors ----------
  // Bright, saturated colors chosen to stay readable as text against the
  // dark grid background (--panel2 #232e38) — no dim or near-black hues,
  // and nothing too close to the red used for the unpaid-square warning.
  const PLAYER_COLORS = [
    '#feca57', '#48dbfb', '#1dd1a1', '#a29bfe', '#ff9ff3', '#54a0ff',
    '#00d2d3', '#f368e0', '#ff9f43', '#10ac84', '#c56cf0', '#7bed9f',
    '#70a1ff', '#eccc68', '#ffdd59', '#34e7e4'
  ];

  // The color for a player just added to `players` (the entry is already in the map): the
  // first one nobody uses, else a repeat by count. The browser and the server share it.
  function pickPlayerColor(players) {
    const used = new Set(Object.values(players).map(p => p && p.color).filter(Boolean));
    return PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
  }

  // ---------- Guest picks (R28, decision 019) ----------
  // A guest claims and releases their own squares from one device. The device's key lives in
  // a cookie; the board holds only its tag (players[name].g). Everything here is pure: the
  // route reads the document, applies one op and writes it conditionally (decision 008).
  const GUEST_TAG_RE = /^[A-Za-z0-9_-]{22}$/;
  // Built on first use, never as literals: an old TV browser that can't parse \p would reject
  // this whole file. Only the server and a guest's phone ever run them.
  const guestRe = {};
  const uni = (source) => guestRe[source] || (guestRe[source] = new RegExp(source, 'gu'));
  const NAME_JUNK = "[^\\p{L}\\p{Nd} .'&-]|\\p{Default_Ignorable_Code_Point}"; // some letters are invisible
  const INVISIBLE = '\\p{Cf}|\\p{Default_Ignorable_Code_Point}';
  const MAX_GUEST_NAME = 10;
  const DEFAULT_GUEST_MAX = 5;
  const SUBSCRIPT_DIGITS_RE = /[₀-₉]/g;

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const playerOf = (game, name) => (isRecord(game.players) && hasOwn(game.players, name) && isRecord(game.players[name]) ? game.players[name] : null);

  // How taken-ness is judged: ignoring case, spacing, width forms, invisible characters and
  // the host's ₁₂ suffix, so "ann", "Ann ₂" and "ＡＮＮ" are one name.
  function nameKey(name) {
    return String(name).replace(SUBSCRIPT_DIGITS_RE, '').normalize('NFKC').replace(uni(INVISIBLE), '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // R25: the host pastes "name, squares, optional unpaid|paid" lines and adds them all at once.
  // Pure: { rows: [{ line, name, count, paid }], errors: [{ line, message }], total, open }.
  // Only lines with no error are rows. `line` is 1-based over the pasted text (blank lines count);
  // an error about the whole list (does not fit) has line 0. Paid is the default.
  // A name that already has squares is refused, never merged: a merge would change what that
  // person owes. The caller re-runs this on the freshest board before saving.
  const PASTE_MAX_LINES = 100;
  function parsePlayerList(text, game) {
    const squares = (game && game.squares) || [];
    const baseKey = n => String(n).replace(/[₀-₉]+$/, '').toLowerCase();
    const held = Object.create(null);
    let open = 0;
    squares.forEach(sq => {
      if (!sq) { open++; return; }
      const k = baseKey(sq.name);
      held[k] = (held[k] || 0) + 1;
    });
    const out = { rows: [], errors: [], total: 0, open };
    const lines = String(text === undefined || text === null ? '' : text).split(/\r\n|\r|\n/);
    const seen = Object.create(null);
    let nonBlank = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      nonBlank++;
      if (nonBlank > PASTE_MAX_LINES) { out.errors.push({ line, message: `Too many lines. Paste ${PASTE_MAX_LINES} players at most.` }); break; }
      const err = message => { out.errors.push({ line, message }); };
      const tokens = trimmed.split(/[\t,\s]+/).filter(Boolean);
      let paid = true;
      const last = tokens[tokens.length - 1].toLowerCase();
      if (last === 'paid' || last === 'unpaid') { paid = last === 'paid'; tokens.pop(); }
      const countTok = tokens.length ? tokens[tokens.length - 1] : '';
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(countTok)) { err('Add the number of squares after the name.'); continue; }
      tokens.pop();
      if (!/^\d+$/.test(countTok) || Number(countTok) < 1 || Number(countTok) > 100) { err('The number of squares must be a whole number from 1 to 100.'); continue; }
      const name = tokens.join(' ');
      if (!name) { err('Add a name before the number.'); continue; }
      if (Array.from(name).length > 10) { err('Names can be 10 characters at most.'); continue; }
      if (!isPlayerName(name)) { err('That name is not allowed.'); continue; }
      const key = baseKey(name);
      if (seen[key]) { err(`${name} is already on line ${seen[key]}. List each person once.`); continue; }
      seen[key] = line;
      if (held[key]) { err(`${name} already has ${held[key]} square${held[key] === 1 ? '' : 's'}. Add more under One player.`); continue; }
      out.rows.push({ line, name, count: Number(countTok), paid });
      out.total += Number(countTok);
    }
    if (out.total > open) {
      out.errors.push({ line: 0, message: `That is ${out.total} squares and only ${open} ${open === 1 ? 'is' : 'are'} open.` });
    }
    return out;
  }

  // The typed name as it would be stored, or { error }. 1-10 code points after NFC; letters,
  // digits, space and . ' - & only (no control, invisible or subscript characters).
  function cleanGuestName(raw) {
    if (typeof raw !== 'string' || raw.length > 100) return { error: 'Type a name of 1 to 10 letters or digits.' };
    // Phones type a curly apostrophe.
    const name = raw.normalize('NFC').replace(/[‘’]/g, "'").replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ');
    const length = Array.from(name).length;
    if (!length || length > MAX_GUEST_NAME || name.replace(uni(NAME_JUNK), '') !== name
      || name.search(uni('[\\p{L}\\p{Nd}]')) === -1 || !isPlayerName(name)) {
      return { error: 'Use 1 to 10 letters, digits, spaces or . \' - & in your name.' };
    }
    return { name };
  }

  // The name this device holds on the board: the one whose players entry carries its tag and
  // that still has a square. A name with no squares left is nobody's.
  function guestNameOf(game, tag) {
    if (typeof tag !== 'string' || !GUEST_TAG_RE.test(tag) || !isRecord(game.players) || !Array.isArray(game.squares)) return null;
    const holding = new Set(game.squares.filter(Boolean).map(s => s.name));
    for (const name of Object.keys(game.players)) {
      const p = game.players[name];
      if (isRecord(p) && p.g === tag && holding.has(name)) return name;
    }
    return null;
  }

  // How many squares one guest may hold right now, or Infinity. Judged at write time from the
  // server's clock: there is no timer (decision 007).
  function guestCap(game, now) {
    const gp = isRecord(game.guestPick) ? game.guestPick : {};
    if (gp.lifted === true) return Infinity;
    if (typeof gp.liftAt === 'string' && ZONED_RE.test(gp.liftAt)) {
      const t = Date.parse(gp.liftAt);
      if (!isNaN(t) && (now === undefined ? Date.now() : now) >= t) return Infinity;
    }
    return Number.isInteger(gp.max) && gp.max >= 1 ? gp.max : DEFAULT_GUEST_MAX;
  }

  function squaresOf(game, name) {
    const out = [];
    game.squares.forEach((s, i) => { if (s && s.name === name) out.push(i); });
    return out;
  }

  // How many of a name's squares the host has been paid for. A name marked paid is paid in
  // full; otherwise players[name].paidSquares says how many (decision 019 section 5).
  function paidSquareCount(game, name) {
    const count = squaresOf(game, name).length;
    const p = playerOf(game, name);
    if (p && p.paid) return count;
    return Math.min(p && isWhole(p.paidSquares, 100) ? p.paidSquares : 0, count);
  }

  // Indexes of the squares not paid for. Per name the oldest claims count as paid first
  // (a square with no claim time is the oldest, then by index).
  function unpaidSquares(game) {
    const byName = new Map();
    game.squares.forEach((s, i) => {
      if (!s) return;
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push({ i, at: typeof s.at === 'number' ? s.at : -1 });
    });
    const out = new Set();
    byName.forEach((list, name) => {
      list.sort((a, b) => a.at - b.at || a.i - b.i);
      list.slice(paidSquareCount(game, name)).forEach(x => out.add(x.i));
    });
    return out;
  }

  // What each name holds and what is still owed for it: only the unpaid squares are charged
  // (decision 019 section 5). With no paidSquares anywhere this is count * price, as before.
  // { [name]: { count, paidCount, unpaidCount, owed, paid } }; `paid` means nothing is owed.
  function owedSummary(game) {
    const price = parseFloat(game.squarePrice) || 0;
    const out = Object.create(null);
    (game.squares || []).forEach(s => { if (s) out[s.name] = out[s.name] || { count: 0 }; if (s) out[s.name].count++; });
    Object.keys(out).forEach(name => {
      const o = out[name];
      o.paidCount = paidSquareCount(game, name);
      o.unpaidCount = o.count - o.paidCount;
      o.owed = o.unpaidCount * price;
      o.paid = o.unpaidCount === 0;
    });
    return out;
  }

  // The paid fields of a name after the host adds squares with Already paid ticked or
  // not: only the added squares become paid. { paid, paidSquares } where paidSquares is
  // undefined for none. `beforePaid` and `beforeCount` are read before the squares are added.
  function paidAfterAdd(beforePaid, beforeCount, added, ticked) {
    const total = beforeCount + added;
    const paid = Math.min(beforePaid + (ticked ? added : 0), total);
    if (paid >= total) return { paid: true, paidSquares: undefined };
    return { paid: false, paidSquares: paid > 0 ? paid : undefined };
  }

  // The color themes a host can choose (decision 021); the first is the default. The colors are in
  // styles.css, under [data-theme].
  const THEMES = ['classic', 'cyan', 'blue', 'slate', 'indigo', 'emerald'];
  const isTheme = (id) => typeof id === 'string' && THEMES.indexOf(id) >= 0;

  // The host's own word on how many of a name's squares are paid for (0 to all of them). Returns
  // false, and changes nothing, for a name with no squares or a number that does not fit.
  function setPaidCount(game, name, n) {
    const count = squaresOf(game, name).length;
    if (!count || !isWhole(n, count)) return false;
    writePaid(game, name, n, count);
    return true;
  }

  // Paid in full is `paid` alone; `paidSquares` is there only for a part-paid name.
  function writePaid(game, name, n, count) {
    const next = Object.assign({}, playerOf(game, name), { paid: n >= count });
    if (n > 0 && n < count) next.paidSquares = n; else delete next.paidSquares;
    game.players[name] = next;
  }

  // The one way the host puts squares under a name: stamps the time (`at`, epoch seconds) and
  // charges right. Already paid (`ticked`) speaks only for the squares added here, for every name
  // (decision 020). A name with no squares yet starts clean: an old phone's tag or an old paid
  // mark must not come with it. The caller gives the name its color.
  function hostAddSquares(game, name, indexes, ticked, at) {
    if (!game.players) game.players = {};
    const beforeCount = squaresOf(game, name).length;
    const beforePaid = paidSquareCount(game, name);
    const p = playerOf(game, name);
    if (!beforeCount && p) {
      const clean = Object.assign({}, p, { paid: false });
      delete clean.g;
      delete clean.paidSquares;
      game.players[name] = clean;
    }
    indexes.forEach(i => { game.squares[i] = { name, at }; });
    const count = squaresOf(game, name).length;
    const r = paidAfterAdd(beforePaid, beforeCount, count - beforeCount, !!ticked);
    writePaid(game, name, r.paid ? count : r.paidSquares || 0, count);
  }

  // A name left with no squares must not keep its players entry: its tag would give an old
  // phone the squares someone types under that name later.
  function pruneEmptyPlayers(game) {
    if (!isRecord(game.players)) return game;
    const holding = new Set((game.squares || []).filter(Boolean).map(s => s.name));
    Object.keys(game.players).forEach(n => { if (!holding.has(n)) delete game.players[n]; });
    return game;
  }

  // Squares a guest picked and has not paid for, and how many people hold them. A guest's
  // name is the one whose players entry carries a tag.
  function unpaidGuestPicks(game) {
    const unpaid = unpaidSquares(game);
    const squares = [];
    const people = new Set();
    game.squares.forEach((s, i) => {
      const p = s && playerOf(game, s.name);
      if (s && p && typeof p.g === 'string' && unpaid.has(i)) { squares.push(i); people.add(s.name); }
    });
    return { squares, people: people.size };
  }

  const validSquareList = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 100
    && v.every(n => Number.isInteger(n) && n >= 0 && n <= 99) && new Set(v).size === v.length;

  // One guest operation. Returns { game, name, changed } (a fresh copy; the input is never
  // mutated; `name` is the name the device holds afterward, null for none) or
  // { error, code } with code 'invalid' (HTTP 400) or 'illegal' (409). A refusal over taken
  // squares also carries `taken`. ctx = { tag, now (ms), random (optional, for tests) }.
  //   claim   { name, squares }       all or nothing; one already yours counts as done
  //   claim   { name, count, have }   random open squares; `have` makes a retry safe
  //   release { squares }             own squares only, never below the paid ones
  // Only `squares` and `players` ever change.
  function applyGuestOp(game, op, ctx) {
    const c = ctx || {};
    const now = typeof c.now === 'number' ? c.now : Date.now();
    const random = typeof c.random === 'function' ? c.random : Math.random;
    const refuse = (error, extra) => Object.assign(failure('illegal', error), extra);

    if (!isRecord(op)) return failure('invalid', 'Pick operation must be an object.');
    if (op.op !== 'claim' && op.op !== 'release') return failure('invalid', 'Unknown pick operation.');
    if (typeof c.tag !== 'string' || !GUEST_TAG_RE.test(c.tag)) return failure('invalid', 'This device has no pick key.');
    const release = op.op === 'release';
    const bySquares = op.squares !== undefined;
    const byCount = op.count !== undefined;
    if (release && (!bySquares || byCount || op.have !== undefined)) return failure('invalid', 'Say which squares to release.');
    if (!release && bySquares === byCount) return failure('invalid', 'Pick squares, or a count of squares.');
    if (bySquares && !validSquareList(op.squares)) return failure('invalid', 'Pick from 1 to 100 different squares of the grid.');
    if (byCount && (!Number.isInteger(op.count) || op.count < 1 || op.count > 100 || !Number.isInteger(op.have) || op.have < 0 || op.have > 100)) {
      return failure('invalid', 'The count must be a whole number from 1 to 100.');
    }

    if (!game || game.status !== 'picking' || cutoffPassed(game, now)) return refuse('Picking is closed.');
    if (!isRecord(game.guestPick) || game.guestPick.on !== true) return refuse('The host has not opened picking to players.');
    if (!release) {
      const mode = game.pickMode || 'both';
      if (byCount && mode === 'manual') return refuse('This board is Manual Only: pick your squares one by one.');
      if (bySquares && mode === 'auto') return refuse('This board is Auto Only: ask for a number of squares.');
    }

    const g = JSON.parse(JSON.stringify(game));
    if (!isRecord(g.players)) g.players = {};
    const bound = guestNameOf(g, c.tag);
    const mine = bound ? squaresOf(g, bound) : [];

    if (release) {
      if (!bound) return refuse('You have no squares on this board.');
      const own = new Set(mine);
      const drop = op.squares.filter(i => g.squares[i] !== null);
      if (drop.some(i => !own.has(i))) return refuse('You can only release your own squares.');
      if (!drop.length) return { game: g, name: bound, changed: false };
      const left = mine.length - drop.length;
      if (left < paidSquareCount(g, bound)) return refuse('Those squares are paid for. Ask the host.');
      drop.forEach(i => { g.squares[i] = null; });
      if (left === 0) {
        delete g.players[bound];
        return { game: g, name: null, changed: true };
      }
      return { game: g, name: bound, changed: true };
    }

    // A claim: a bound device keeps its name whatever the op says.
    let name = bound;
    if (!name) {
      const clean = cleanGuestName(op.name);
      if (clean.error) return failure('invalid', clean.error);
      const key = nameKey(clean.name);
      if (g.squares.some(s => s && nameKey(s.name) === key)) return refuse('That name is taken. Add a last initial, or ask the host.');
      name = clean.name;
    }

    let fresh;
    if (bySquares) {
      const taken = op.squares.filter(i => g.squares[i] && g.squares[i].name !== name);
      if (taken.length) return refuse('Some of those squares were just taken.', { taken });
      fresh = op.squares.filter(i => g.squares[i] === null);
    } else {
      if (op.have !== mine.length) return refuse('Your squares changed since your screen updated. Check them and try again.');
      const open = [];
      g.squares.forEach((s, i) => { if (!s) open.push(i); });
      if (op.count > open.length) return refuse(open.length ? `Only ${open.length} squares are open.` : 'No squares are open.');
      for (let i = 0; i < op.count; i++) {
        const j = i + Math.floor(random() * (open.length - i));
        [open[i], open[j]] = [open[j], open[i]];
      }
      fresh = open.slice(0, op.count);
    }
    if (!fresh.length) return { game: g, name, changed: false };

    const cap = guestCap(g, now);
    if (mine.length + fresh.length > cap) {
      const room = Math.max(0, cap - mine.length);
      return refuse(`You can pick up to ${cap} squares. ${room ? `You have room for ${room} more.` : 'You have all of them.'}`);
    }

    const paidBefore = bound ? paidSquareCount(g, name) : 0;
    const at = Math.floor(now / 1000);
    fresh.forEach(i => { g.squares[i] = { name, at }; });
    if (bound) {
      // More squares than were paid for: the paid ones stay paid, the new ones are owed.
      const p = g.players[name];
      p.paid = false;
      if (paidBefore > 0) p.paidSquares = paidBefore; else delete p.paidSquares;
    } else {
      // A fresh entry. Nothing a name left behind (a mark, a count, a tag) carries over.
      Object.keys(g.players).forEach(n => { if (isRecord(g.players[n]) && g.players[n].g === c.tag) delete g.players[n]; });
      g.players[name] = { paid: false, g: c.tag };
      g.players[name].color = pickPlayerColor(g.players);
    }
    return { game: g, name, changed: true };
  }

  return {
    PLAYER_COLORS, pickPlayerColor,
    applyGuestOp, guestCap, guestNameOf, paidSquareCount, unpaidSquares, cleanGuestName, nameKey,
    THEMES, isTheme, owedSummary, paidAfterAdd, hostAddSquares, setPaidCount, pruneEmptyPlayers, unpaidGuestPicks, parsePlayerList,
    QUARTERS, QLABEL, STATUSES, LEAGUES, SCORING_MODES,
    scoringMode, manualEntry, applyScoreOp, scorePlays, scoreKeyOp, inverseScoreOp, undoTarget, belowEndedQuarter, manualState, hasResult,
    shuffle, shuffledDigits, emptyGrid,
    potOf, actualPotOf, findCol, findRow, computeGame, computeLiveHighlight, payoutAmount, drawnDigits,
    payoutStatus, applyPayoutOp, paidQuartersDisturbed, whoToPay,
    validateGame, isPlayerName, isColor, isDigitPermutation, syncStatus,
    cutoffPassed, lockGame,
    SIM_QUARTER_MS, buildSimPlan, simLiveState, simCumulativeThroughQuarter
  };
});
