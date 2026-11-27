// The shared live-score slate (decision 001 sections 3 to 6): one claimed refresh per
// league and ET date, at most every 15 s, and the pure rules that merge a slate into a
// board. Runs on request only; there is no timer, cron or poller (decision 007).
//
// Two layers:
//   getSlate(...)    reads the store row, and when it is stale claims the refresh
//                    atomically and calls the provider layer. Everything it touches is
//                    injectable (store, clock, fetch function), so tests need no network.
//   applyToGame(...) is pure: a board plus a slate row in, the board with `liveScore`
//                    merged and any newly completed quarters filled in, out.
'use strict';

const GameLogic = require('../../public/compute.js');
const TeamData = require('../../public/teams.js');
const { toOurAbbr, etDateOf } = require('./abbr.js');
const scores = require('./index.js');

const REFRESH_MS = 15000;     // a slate is refreshed at most this often
const FEED_STALE_MS = 60000;  // no good fetch for this long (with errors) = feed unavailable
const ET_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function supported(league) {
  return !!(TeamData.LEAGUE_SPORT && TeamData.LEAGUE_SPORT[league]);
}

function nowOf(o) { return (o && o.now ? o.now() : Date.now()); }

// Reads the slate for a league and ET date, refreshing it first when it is stale.
// Exactly one request in a refresh window wins the claim and fetches; the rest read
// the row as it stands. Never throws on a provider failure: the failure is recorded in
// the row and the previous games are kept. Result: { row, claimed, fetched } where `row`
// is { payload, checkedAt, fetchedAt } or null.
async function getSlate(league, etDate, opts) {
  const o = opts || {};
  const store = o.store || require('../store.js');
  if (!supported(league) || !ET_DATE_RE.test(String(etDate))) return { row: null, claimed: false, fetched: null };

  const nowMs = nowOf(o);
  const row = await store.getLiveSlate(league, etDate);
  if (row) {
    const age = nowMs - Date.parse(row.checkedAt);
    // A negative age is a clock skew or a hand-edited stamp: treat it as stale.
    if (age >= 0 && age < REFRESH_MS) return { row, claimed: false, fetched: null };
  }

  const nowIso = new Date(nowMs).toISOString();
  const won = await store.claimLiveSlate(league, etDate, row ? row.checkedAt : null, nowIso);
  if (!won) return { row: row || await store.getLiveSlate(league, etDate), claimed: false, fetched: null };

  const fetchFn = o.fetchWithFailover || scores.fetchWithFailover;
  let r;
  try {
    r = await fetchFn(league, etDate, { env: o.env, fetch: o.fetch, timeoutMs: o.timeoutMs });
  } catch (e) {
    r = { ok: false, error: 'refresh failed' };
  }

  const prev = row && row.payload && Array.isArray(row.payload.games) ? row.payload : null;
  let payload;
  let fetchedAt = null;
  if (r && r.ok) {
    const next = { provider: r.provider, games: r.games };
    payload = scores.mergeNoBackward(prev ? withoutError(prev) : null, next, nowMs);
    delete payload.error;
    fetchedAt = nowIso;
  } else {
    // Keep the last good games; record that this attempt failed.
    payload = Object.assign({ provider: null, games: [] }, prev, { error: String((r && r.error) || 'unavailable').slice(0, 200) });
  }
  // The counts go alongside the save, not before it: one round trip, not two.
  await Promise.all([store.saveLiveSlate(league, etDate, payload, fetchedAt), countFeedCalls(store, r, nowMs)]);
  return {
    row: { payload, checkedAt: nowIso, fetchedAt: fetchedAt || (row && row.fetchedAt) || null },
    claimed: true,
    fetched: r || null
  };
}

// The admin page's service counts (decision 027): one per provider tried, one when the answer came
// from a provider other than the first one tried (a failover), one when no provider answered. A
// store without the counters, or a failed count, never fails the refresh.
async function countFeedCalls(store, r, nowMs) {
  if (typeof store.bumpUsage !== 'function') return;
  try {
    const tried = r && Array.isArray(r.tried) ? r.tried : null;
    const bumps = (tried || []).filter(t => t && typeof t.provider === 'string')
      .map(t => store.bumpUsage(`feed:${t.provider}`, { failed: !t.ok, now: nowMs }));
    if (r && r.ok && tried && tried.length && r.provider !== tried[0].provider) bumps.push(store.bumpUsage('feed:fallback', { now: nowMs }));
    // No provider configured tries nothing: that is not the feed being down.
    if ((!r || !r.ok) && !(tried && tried.length === 0)) bumps.push(store.bumpUsage('feed:down', { now: nowMs }));
    await Promise.all(bumps);
  } catch (e) {
    console.error(`Usage count failed: ${e.message}`);
  }
}

function withoutError(p) {
  const c = Object.assign({}, p);
  delete c.error;
  return c;
}

// --- matching a board to a game in the slate ---------------------------------

// { league, etDate, abbrA, abbrB } for a board, or null when it cannot be matched (a
// custom league, an unknown team name, no usable date). Derived on read rather than
// stored, so a board edited after lock never goes stale.
function matchOf(game) {
  if (!game || !supported(game.league)) return null;
  const metaA = TeamData.findTeamMeta(game.teamA, game.league);
  const metaB = TeamData.findTeamMeta(game.teamB, game.league);
  if (!metaA || !metaB || metaA.abbr === metaB.abbr) return null;
  const etDate = (game.kickoffTime && etDateOf(game.kickoffTime))
    || (ET_DATE_RE.test(String(game.gameDate)) ? game.gameDate : null);
  if (!etDate) return null;
  return {
    league: game.league,
    etDate,
    abbrA: toOurAbbr(metaA.abbr, game.league),
    abbrB: toOurAbbr(metaB.abbr, game.league)
  };
}

function findLiveGame(payload, m) {
  if (!payload || !Array.isArray(payload.games)) return null;
  return payload.games.find(g => g.home && g.away && (
    (g.home.abbr === m.abbrA && g.away.abbr === m.abbrB)
    || (g.home.abbr === m.abbrB && g.away.abbr === m.abbrA))) || null;
}

// The feed is unavailable when this board's game is not in the slate, or when there
// has been no good fetch for 60 s and the latest attempts failed (section 6). A row
// that is merely old, with no failure recorded, is not an outage: the next read refreshes it.
function feedStatus(row, liveGame, nowMs) {
  // A brand-new row with no fetch and no failure yet means another request is fetching
  // the first slate right now: that is pending, not an outage.
  if (row && !row.fetchedAt && !(row.payload && row.payload.error)) return { available: true, fetchedAt: null };
  if (!row || !row.fetchedAt || !liveGame) return { available: false, fetchedAt: row && row.fetchedAt || null };
  const stale = nowMs - Date.parse(row.fetchedAt) > FEED_STALE_MS;
  const failing = !!(row.payload && row.payload.error);
  return { available: !(stale && failing), fetchedAt: row.fetchedAt };
}

// A host-entered score (typed while the feed was down) wins only until the feed is back
// (decision 001 section 6, decision 025 section 6 update).
function hostHolds(game) {
  return game.liveOverride === true || !!(game.liveScore && game.liveScore.manual);
}

const SIDE_FIELDS = { q1: 1, q2: 2, q3: 3 };

// Pure. Returns { game, feed, filled }:
//   game    a copy of `game` with `liveScore` set from the slate (unless the host holds the
//           score) and the quarters the provider has settled filled in where the board has
//           no result yet. Contains nothing response-only, so it is safe to store.
//   feed    { available, fetchedAt } for the response (never stored).
//   filled  the result keys this call newly filled; non-empty means the caller should write.
//   resumed true when a good reading took the score back from the host; the caller writes then too.
function applyToGame(game, row, now) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const g = JSON.parse(JSON.stringify(game));
  const m = matchOf(g);
  const lg = m && row ? findLiveGame(row.payload, m) : null;
  const feed = feedStatus(row, lg, nowMs);
  if (!lg) return { game: g, feed, filled: [], resumed: false };

  const homeIsA = lg.home.abbr === m.abbrA;
  const mine = homeIsA ? lg.home : lg.away;
  const theirs = homeIsA ? lg.away : lg.home;
  // The feed is the source of truth: a real reading (fetched, and not down) hands a held score
  // back to it. Quarters the host entered meanwhile stay; the feed fills only the empty ones.
  const resumed = hostHolds(g) && feed.available && !!feed.fetchedAt;
  if (resumed) {
    delete g.liveOverride;
    g.liveScore = null;
  }
  const held = hostHolds(g);

  if (!held) {
    const brk = lg.state === 'break';
    g.liveScore = {
      a: mine.score, b: theirs.score,
      period: lg.period, clock: lg.clock || '',
      state: brk ? 'in' : lg.state,
      statusName: brk ? (lg.period === 2 ? 'STATUS_HALFTIME' : 'STATUS_END_PERIOD') : '',
      completed: lg.state === 'post',
      provider: lg.provider,
      updatedAt: lg.providerUpdatedAt || lg.fetchedAt || null
    };
  }

  const filled = [];
  if (!held && (g.status === 'started')) {
    const done = scores.completedQuarters(lg);
    if (!g.results) g.results = {};
    const put = (key, c) => {
      if (!c || GameLogic.hasResult(g.results[key])) return; // the host's entry (or an earlier fill) stays
      const side = (x, y) => (homeIsA ? { a: x, b: y } : { a: y, b: x });
      g.results[key] = Object.assign({}, g.results[key], side(c.home, c.away));
      filled.push(key);
    };
    for (const q of Object.keys(SIDE_FIELDS)) put(q, done[q]);
    put('final', done.final);
    if (filled.length) GameLogic.syncStatus(g);
  }
  return { game: g, feed, filled, resumed };
}

// The slate rows a board with `scoring` = live depends on: refresh (when stale) and merge.
// `readOnly` skips the refresh (used when the caller only needs the stored row).
async function readForGame(game, opts) {
  const o = opts || {};
  const m = matchOf(game);
  const nowMs = nowOf(o);
  if (!m) return Object.assign({ matched: false }, applyToGame(game, null, nowMs));
  const { row } = o.readOnly
    ? { row: await (o.store || require('../store.js')).getLiveSlate(m.league, m.etDate) }
    : await getSlate(m.league, m.etDate, o);
  return Object.assign({ matched: true }, applyToGame(game, row, nowMs));
}

// "Cincinnati Bengals" from 'cin', or the abbreviation itself when the team is unknown.
function displayName(abbr, league) {
  const set = { nfl: TeamData.NFL_TEAMS, nba: TeamData.NBA_TEAMS }[league] || [];
  const t = set.find(x => x.abbr === abbr);
  return t ? t.names[0].replace(/\b\w/g, c => c.toUpperCase()) : String(abbr || '').toUpperCase();
}

// The setup screen's "Games" picker (GET /api/todays-games), read from the shared slate so
// it costs no provider call of its own. Returns null when there is no good fetch to show
// (the client says the feed is unavailable), [] for a real empty schedule. teamA is the
// away team, teamB the home team, as the picker has always done.
async function listGames(league, etDate, opts) {
  if (!supported(league)) return [];
  const date = etDate && ET_DATE_RE.test(etDate) ? etDate : etDateOf(new Date(nowOf(opts)).toISOString());
  const { row } = await getSlate(league, date, opts);
  if (!row || !row.fetchedAt || !row.payload || !Array.isArray(row.payload.games)) return null;
  return row.payload.games.map(g => ({
    teamA: displayName(g.away.abbr, league),
    teamB: displayName(g.home.abbr, league),
    date: g.startsAt || null,
    raw: g
  }));
}

module.exports = { getSlate, applyToGame, readForGame, listGames, matchOf, REFRESH_MS, FEED_STALE_MS };
