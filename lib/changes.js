// The words of the "Recent changes" list (R39, decision 025): one short line per operation. Pure
// functions of the board before and after an operation that was accepted; nothing here decides
// anything. Names and team names are user input: the client escapes them, as everywhere.
'use strict';

const GameLogic = require('../public/compute.js');

const QUARTER = { q1: 'Q1', q2: 'Q2', q3: 'Q3', final: 'the final' };
const dash = (s) => `${s.a}–${s.b}`;
const squares = (n) => `${n} square${n === 1 ? '' : 's'}`;
const heldBy = (game, name) => game.squares.filter(s => s && s.name === name).length;
const teamName = (game, side) => Array.from(String((side === 'a' ? game.teamA : game.teamB) || `Team ${side.toUpperCase()}`)).slice(0, 40).join('');

function scoreText(before, after, op) {
  const was = GameLogic.manualState(before);
  const is = GameLogic.manualState(after);
  switch (op.op) {
    case 'add': {
      const moved = is[op.side] - was[op.side];
      // Taking a Live board over is an add of 0 (decision 025, as built R36).
      if (!moved && after.liveOverride && !before.liveOverride) return `Took over the score from the feed at ${dash(is)}`;
      return `${teamName(after, op.side)} ${moved < 0 ? '−' : '+'}${Math.abs(moved)}, now ${dash(is)}`;
    }
    case 'set': return `Set the score to ${dash(is)}`;
    case 'end':
    case 'final': {
      if (GameLogic.hasResult(after.results && after.results.final)) return `Ended the game at ${dash(was)}`;
      return was.period <= 3 ? `Ended Q${was.period} at ${dash(was)}` : `Started overtime at ${dash(was)}`;
    }
    case 'undo': return 'Undo';
    case 'edit': return op.a === null ? `Cleared the score of ${QUARTER[op.quarter]}` : `Fixed ${QUARTER[op.quarter]} to ${dash(op)}`;
    case 'draw': return 'Drew the final winner';
    case 'resume': return 'Went back to the live feed';
    default: return 'Changed the score';
  }
}

// `name` is the one the operation settled on (applySquaresOp), null for the picks settings.
function squaresText(before, after, op, name) {
  if (op.op === 'picks') {
    const parts = [];
    const old = before.guestPick || {};
    const now = after.guestPick;
    if (op.on !== undefined && now.on !== (old.on === true)) parts.push(`Turned player picks ${now.on ? 'on' : 'off'}`);
    if (op.max !== undefined && now.max !== (old.max === undefined ? GameLogic.DEFAULT_GUEST_MAX : old.max)) parts.push(`${parts.length ? 'set' : 'Set'} the pick limit to ${now.max}`);
    return parts.join(', ') || 'Changed player picks';
  }
  if (op.op === 'claim') return `Added ${squares(heldBy(after, name) - heldBy(before, name))} for ${name}`;
  if (op.op === 'removeUnpaid') return `Removed ${squares(heldBy(before, name) - heldBy(after, name))} not paid for from ${name}`;
  const paid = op.paidSquares;
  if (paid === 0) return `Marked ${name} unpaid`;
  return paid === op.have ? `Marked ${name} paid (${paid})` : `Marked ${name} part paid (${paid} of ${op.have})`;
}

const jobsText = (jobs) => [jobs.canScore && 'keep score', jobs.canSquares && 'manage squares'].filter(Boolean).join(' and ') || 'no job';

module.exports = { scoreText, squaresText, jobsText };
