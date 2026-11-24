// Provider selection, failover and the pure slate rules of decision 001
// (section 2 failover, section 2 no-backward switch rule, section 5 quarter completion).
//
// `mergeNoBackward` is the orchestrator's addition to section 2 and is deliberately a
// separate pure function: to drop the rule, stop calling it and store the
// fetched slate as is.
'use strict';

const providers = {
  espn: require('./espn.js'),
  balldontlie: require('./balldontlie.js')
};

const SWITCH_CAP_MS = 120000;

// --- configuration (read at call time, never cached) -------------------------

// SCORE_PRIMARY / SCORE_SECONDARY name adapters. Unset: the LAN build defaults to
// espn with no secondary; on Vercel nothing is configured (Live mode hidden).
function getConfig(env) {
  const e = env || process.env;
  const onCloud = !!e.VERCEL;
  const pick = v => (v && providers[v] ? providers[v] : null);
  const primaryName = (e.SCORE_PRIMARY || (onCloud ? '' : 'espn')).trim().toLowerCase();
  const secondaryName = (e.SCORE_SECONDARY || '').trim().toLowerCase();
  const primary = pick(primaryName);
  let secondary = pick(secondaryName);
  if (secondary === primary) secondary = null;
  return { primary, secondary };
}

// --- failover ----------------------------------------------------------------

function pairKey(a, b) { return [a, b].map(x => String(x || '').toLowerCase()).sort().join('|'); }

function missingFrom(games, expect) {
  const have = new Set((games || []).map(g => pairKey(g.home && g.home.abbr, g.away && g.away.abbr)));
  return (expect || []).filter(x => !have.has(pairKey(x.homeAbbr, x.awayAbbr)));
}

// Tries the primary; calls the secondary only if the primary errored, timed out,
// failed to parse, or lacks a game in `expect` ([{ homeAbbr, awayAbbr }]).
// Never throws. A healthy primary with every expected game never touches the secondary.
// Result: { ok, provider, games, ms, error, missing, tried: [{ provider, ok, error, ms }] }.
async function fetchWithFailover(league, etDate, opts) {
  const o = opts || {};
  const cfg = getConfig(o.env);
  const callOpts = { fetch: o.fetch, timeoutMs: o.timeoutMs };
  const tried = [];
  const started = Date.now();
  if (!cfg.primary) {
    return { ok: false, provider: null, games: [], ms: 0, error: 'no score provider configured', missing: [], tried };
  }

  const run = async p => {
    let r;
    try { r = await p.fetchSlate(league, etDate, callOpts); } catch (e) { r = { ok: false, games: [], ms: 0, error: 'adapter threw' }; }
    tried.push({ provider: p.name, ok: r.ok, error: r.error || null, ms: r.ms });
    return r;
  };
  const done = (p, r, missing) => ({
    ok: true, provider: p.name, games: r.games, ms: Date.now() - started, error: null, missing, tried
  });

  const first = await run(cfg.primary);
  const firstMissing = first.ok ? missingFrom(first.games, o.expect) : null;
  if (first.ok && firstMissing.length === 0) return done(cfg.primary, first, []);
  if (!cfg.secondary) {
    return first.ok
      ? done(cfg.primary, first, firstMissing)
      : { ok: false, provider: null, games: [], ms: Date.now() - started, error: first.error, missing: [], tried };
  }

  const second = await run(cfg.secondary);
  const secondMissing = second.ok ? missingFrom(second.games, o.expect) : null;
  if (second.ok && (!first.ok || secondMissing.length < firstMissing.length)) {
    return done(cfg.secondary, second, secondMissing);
  }
  if (first.ok) return done(cfg.primary, first, firstMissing);
  return {
    ok: false, provider: null, games: [], ms: Date.now() - started,
    error: `${cfg.primary.name}: ${first.error}; ${cfg.secondary.name}: ${second.error}`, missing: [], tried
  };
}

// --- no-backward rule on a provider switch (decision 001 section 2) ----------

function toMs(t) {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

function clockSeconds(clock) {
  const m = /^(\d+):(\d\d)$/.exec(clock || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Elapsed game progress in seconds, or null when the game gives no usable period.
// Only used to compare two readings of the same game, so OT length is approximate.
function progressOf(g) {
  if (g.state === 'pre') return -1;
  if (g.state === 'post') return Infinity;
  if (g.period === null || g.period === undefined) return null;
  if (g.state === 'break') return g.period * 900;
  const left = clockSeconds(g.clock);
  if (left === null) return null;
  return (g.period - 1) * 900 + (900 - left);
}

function gameKey(g) { return `${g.league}|${g.etDate}|${pairKey(g.home.abbr, g.away.abbr)}`; }

// Pure. prevSlate / nextSlate: { provider, games: [LiveGame], switchedAt? }. Returns the
// slate to store. When the slate's provider changed, a game whose provider changed keeps
// its stored LiveGame until the new reading has reached the same point in the game
// (final always counts), for at most 120 s from `switchedAt`. Same-provider readings are
// taken as they come, so a real score correction goes through. `switchedAt` (ISO) lives
// in the returned slate so the cap holds across stateless instances.
function mergeNoBackward(prevSlate, nextSlate, now) {
  const nowMs = toMs(now);
  const next = nextSlate || { provider: null, games: [] };
  // A failed fetch has no provider: keep what is stored.
  if (prevSlate && !next.provider) return prevSlate;
  if (!prevSlate || !Array.isArray(prevSlate.games)) {
    const fresh = Object.assign({}, next);
    delete fresh.switchedAt;
    return fresh;
  }

  let switchedAt = prevSlate.switchedAt || null;
  if (prevSlate.provider && next.provider && prevSlate.provider !== next.provider) {
    switchedAt = new Date(nowMs).toISOString();
  }
  const inWindow = switchedAt !== null && nowMs - Date.parse(switchedAt) < SWITCH_CAP_MS;

  const prevByKey = new Map(prevSlate.games.map(g => [gameKey(g), g]));
  let held = 0;
  const games = next.games.map(g => {
    const k = gameKey(g);
    const p = prevByKey.get(k);
    prevByKey.delete(k);
    if (!p || p.provider === g.provider || !inWindow) return g;
    if (g.state === 'post') return g;
    const pp = progressOf(p);
    const gp = progressOf(g);
    if (gp !== null && pp !== null && gp >= pp) return g;
    held++;
    return p;
  });
  // A stored game the new provider does not list is kept for the same window.
  if (inWindow) {
    for (const p of prevByKey.values()) {
      if (p.provider !== next.provider) { games.push(p); held++; }
    }
  }

  const out = Object.assign({}, next, { games });
  if (held > 0 && inWindow) out.switchedAt = switchedAt; else delete out.switchedAt;
  return out;
}

// --- quarter completion (decision 001 section 5) -----------------------------

function cumulative(side, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = side.quarters && side.quarters[i];
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

// The quarter fields and OT add up to the total. When they do not, the provider is
// between updates (the total moved first), so a quarter read now could be wrong for good.
function addsUp(side) {
  if (!Number.isFinite(side.score)) return true; // nothing to compare with
  return (side.quarters || []).reduce((t, v) => t + (v || 0), side.ot || 0) === side.score;
}

// Pure. Which of q1/q2/q3/final are over, as cumulative scores the way the app stores
// results: { q1: { home, away }, ..., final: { home, away } } with only settled keys.
// A quarter needs a provider signal that it ended (state/period; or, if the provider
// has no period, the next quarter's field being filled) and a value for every quarter
// up to it, adding up to the total. Final needs state 'post' and both totals, and includes OT.
function completedQuarters(g) {
  const out = {};
  if (!g || !g.home || !g.away || g.state === 'pre') return out;

  let over = 0;
  if (g.state === 'post') over = 3;
  else if (g.period !== null && g.period !== undefined) {
    over = Math.min(g.state === 'break' ? g.period : g.period - 1, 3);
  } else {
    for (let n = 1; n <= 3; n++) {
      const nh = g.home.quarters && g.home.quarters[n];
      const na = g.away.quarters && g.away.quarters[n];
      if (nh !== null && nh !== undefined && na !== null && na !== undefined) over = n;
    }
  }

  if (!addsUp(g.home) || !addsUp(g.away)) over = 0;
  for (let n = 1; n <= over; n++) {
    const h = cumulative(g.home, n);
    const a = cumulative(g.away, n);
    if (h !== null && a !== null) out[`q${n}`] = { home: h, away: a };
  }
  if (g.state === 'post' && Number.isFinite(g.home.score) && Number.isFinite(g.away.score)) {
    out.final = { home: g.home.score, away: g.away.score };
  }
  return out;
}

module.exports = {
  providers, getConfig, fetchWithFailover, mergeNoBackward, completedQuarters, SWITCH_CAP_MS
};
