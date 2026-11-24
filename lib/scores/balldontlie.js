// BALLDONTLIE adapter (decision 001 §1, §5). NFL only. Period and clock exist
// only inside the `status` text ("14:54 - 1st", "End of 1st", "Halftime",
// "Final"), so this file parses it. Text we do not recognize degrades safely:
// period and clock become null and the state is 'pre' or 'in', never a guessed
// 'break' or 'post'.
'use strict';

const { toOurAbbr, etDateOf } = require('./abbr.js');
const { getJson } = require('./http.js');

const URL_BASE = 'https://api.balldontlie.io/nfl/v1/games';
const ORD = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function periodOf(label) {
  const l = String(label).toLowerCase();
  if (ORD[l]) return ORD[l];
  const m = /^(\d)?ot$/.exec(l);
  return m ? 4 + (m[1] ? Number(m[1]) : 1) : null;
}

// Pure: { state, period, clock } from the status text and `status_state`.
function parseStatus(text, statusState, hasScores) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  let m = /^(\d{1,2}:\d\d) - (1st|2nd|3rd|4th|\dOT|OT)$/i.exec(t);
  if (m) return { state: 'in', period: periodOf(m[2]), clock: m[1] };
  m = /^End of (1st|2nd|3rd|4th|\dOT|OT)$/i.exec(t);
  if (m) return { state: 'break', period: periodOf(m[1]), clock: '0:00' };
  if (/^Halftime$/i.test(t)) return { state: 'break', period: 2, clock: '0:00' };
  if (/^Final(\s*[/-]?\s*\d?OT)?$/i.test(t)) return { state: 'post', period: null, clock: null };
  if (/^(postponed|cancell?ed)/i.test(t)) return { state: 'pre', period: null, clock: null };
  // Unknown text: no period, no clock, and never 'break' or 'post' from guesswork.
  if (statusState === 'scheduled') return { state: 'pre', period: null, clock: null };
  // 'final' with text we do not know could be a canceled or postponed game, and a
  // wrong 'post' would pay out a final. The host can still end the game.
  if (statusState === 'in_progress') return { state: 'in', period: null, clock: null };
  return { state: hasScores ? 'in' : 'pre', period: null, clock: null };
}

function side(g, prefix, league, state) {
  const q = k => num(g[`${prefix}_team_${k}`]);
  const pre = state === 'pre';
  const score = num(g[`${prefix}_team_score`]);
  return {
    abbr: toOurAbbr(g[`${prefix}_team`] && g[`${prefix}_team`].abbreviation, league),
    // A missing score is 0 only while the game is on: a final never invents one.
    score: pre || (score === null && state === 'post') ? null : (score === null ? 0 : score),
    quarters: pre ? [null, null, null, null] : ['q1', 'q2', 'q3', 'q4'].map(q),
    ot: pre ? null : q('ot')
  };
}

// Pure. Returns [LiveGame] for games whose ET date is etDate (the API is asked for
// two UTC dates, so a late game from the previous ET day comes back too). Throws
// if the body is not a BALLDONTLIE games list.
function normalize(body, league, etDate, fetchedAt) {
  if (!body || !Array.isArray(body.data)) throw new Error('no data array');
  const stamp = fetchedAt || new Date().toISOString();
  const games = [];
  for (const g of body.data) {
    if (!g || !g.home_team || !g.visitor_team) continue;
    if (g.date && etDateOf(g.date) !== etDate) continue;
    const hasScores = num(g.home_team_score) !== null || num(g.visitor_team_score) !== null;
    const st = parseStatus(g.status, g.status_state, hasScores);
    games.push({
      provider: 'balldontlie',
      providerGameId: String(g.id),
      league,
      etDate,
      home: side(g, 'home', league, st.state),
      away: side(g, 'visitor', league, st.state),
      state: st.state,
      period: st.period,
      clock: st.clock,
      startsAt: g.date || null,
      providerUpdatedAt: g.updated_at || null,
      fetchedAt: stamp
    });
  }
  return games;
}

function nextDay(ymd) {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

async function fetchSlate(league, etDate, opts) {
  const o = opts || {};
  const started = Date.now();
  if (league !== 'nfl') return { ok: false, games: [], ms: 0, error: `unsupported league: ${league}` };
  const key = o.apiKey || process.env.BALLDONTLIE_API_KEY;
  if (!key) return { ok: false, games: [], ms: 0, error: 'BALLDONTLIE_API_KEY not set' };
  const url = `${URL_BASE}?dates[]=${etDate}&dates[]=${nextDay(etDate)}&per_page=100`;
  const r = await getJson(url, {
    headers: { Authorization: key }, fetchImpl: o.fetch, timeoutMs: o.timeoutMs, secrets: [key]
  });
  const ms = Date.now() - started;
  if (!r.ok) return { ok: false, games: [], ms, error: r.error };
  try {
    return { ok: true, games: normalize(r.body, league, etDate, new Date().toISOString()), ms, error: null };
  } catch (e) {
    return { ok: false, games: [], ms, error: `unexpected response: ${e.message}` };
  }
}

module.exports = {
  name: 'balldontlie', capabilities: { period: true, clock: true }, fetchSlate, normalize, parseStatus
};
