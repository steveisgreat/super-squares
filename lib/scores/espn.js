// ESPN scoreboard adapter (decision 001 §1). Unofficial, keyless endpoint; one
// request returns every game of an ET date.
'use strict';

const TeamData = require('../../public/teams.js');
const { toOurAbbr } = require('./abbr.js');
const { getJson } = require('./http.js');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const BREAK_NAMES = new Set(['STATUS_END_PERIOD', 'STATUS_HALFTIME']);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapState(type) {
  const name = type.name || '';
  if (BREAK_NAMES.has(name)) return 'break';
  if (type.state === 'post') {
    // Postponed and canceled games also report state 'post'; only a FINAL status pays.
    return type.completed && name.startsWith('STATUS_FINAL') ? 'post' : 'pre';
  }
  if (type.state === 'in') return 'in';
  return 'pre';
}

function side(competitor, league, state) {
  const lines = Array.isArray(competitor.linescores) ? competitor.linescores : [];
  const byPeriod = n => {
    const l = lines.find(x => x && x.period === n);
    return l ? num(l.value) : null;
  };
  const quarters = [1, 2, 3, 4].map(byPeriod);
  const otLines = lines.filter(x => x && x.period > 4 && num(x.value) !== null);
  const ot = otLines.length ? otLines.reduce((s, x) => s + num(x.value), 0) : null;
  const raw = num(competitor.score);
  // A missing score is 0 only while the game is on: a final never invents one.
  const score = state === 'pre' || (raw === null && state === 'post') ? null : (raw === null ? 0 : raw);
  return {
    abbr: toOurAbbr(competitor.team && competitor.team.abbreviation, league),
    score,
    quarters: state === 'pre' ? [null, null, null, null] : quarters,
    ot: state === 'pre' ? null : ot
  };
}

// Pure. Returns [LiveGame]; throws if the body is not an ESPN scoreboard.
function normalize(body, league, etDate, fetchedAt) {
  if (!body || !Array.isArray(body.events)) throw new Error('no events array');
  const stamp = fetchedAt || new Date().toISOString();
  const games = [];
  for (const ev of body.events) {
    const comp = ev && ev.competitions && ev.competitions[0];
    const status = comp && (comp.status || ev.status);
    if (!comp || !status || !status.type || !Array.isArray(comp.competitors)) continue;
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const state = mapState(status.type);
    const period = num(status.period);
    games.push({
      provider: 'espn',
      providerGameId: String(ev.id),
      league,
      etDate,
      home: side(home, league, state),
      away: side(away, league, state),
      state,
      period: state === 'pre' || !period ? null : period,
      clock: state === 'pre' ? null : (status.displayClock || null),
      providerUpdatedAt: null,
      fetchedAt: stamp
    });
  }
  return games;
}

async function fetchSlate(league, etDate, opts) {
  const o = opts || {};
  const started = Date.now();
  const sport = TeamData.LEAGUE_SPORT[league];
  if (!sport) return { ok: false, games: [], ms: 0, error: `unsupported league: ${league}` };
  const url = `${BASE}/${sport}/${league}/scoreboard?dates=${String(etDate).replace(/-/g, '')}`;
  const r = await getJson(url, { fetchImpl: o.fetch, timeoutMs: o.timeoutMs });
  const ms = Date.now() - started;
  if (!r.ok) return { ok: false, games: [], ms, error: r.error };
  try {
    return { ok: true, games: normalize(r.body, league, etDate, new Date().toISOString()), ms, error: null };
  } catch (e) {
    return { ok: false, games: [], ms, error: `unexpected response: ${e.message}` };
  }
}

module.exports = { name: 'espn', capabilities: { period: true, clock: true }, fetchSlate, normalize };
