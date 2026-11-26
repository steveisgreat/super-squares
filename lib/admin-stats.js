// The admin usage page's numbers (R45a, decision 027), worked out from the store's facts. Pure:
// no store, no clock but the `now` it is given, so both stores and the tests share one set of sums.
// Counts only. A host's full email never leaves here; the page reveals one at a time through the
// route's `reveal`.
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = ['7d', '30d', 'season'];
const PEAK_TARGET = 4;           // score-feed calls a minute we aim to stay under (decision 001)
const MAIL_PER_DAY = 100;        // Resend free plan
const MAIL_PER_MONTH = 3000;
const LIVE_LEAGUES = ['nfl', 'nba'];
const STAGES = ['setup', 'picking', 'started', 'finished'];
const GUEST_BUCKETS = [[0, 0, '0'], [1, 9, '1–9'], [10, 24, '10–24'], [25, 49, '25–49'], [50, 99, '50–99'], [100, Infinity, '100+']];

const etDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// The season starts September 1 (ET): this year's from September on, else last year's.
function rangeStart(range, now) {
  if (range === '7d') return now - 7 * DAY_MS;
  if (range === '30d') return now - 30 * DAY_MS;
  const [y, m] = etDate(now).split('-').map(Number);
  return Date.parse(`${m >= 9 ? y : y - 1}-09-01T04:00:00Z`); // midnight EDT
}

// "j•••@gmail.com". Anything that is not an address is masked whole.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${Array.from(s)[0]}•••${s.slice(at)}`;
}

// One board's facts, from its document (the fs store; Postgres works the same out in SQL).
function boardFacts(doc, ownerId) {
  const squares = Array.isArray(doc.squares) ? doc.squares : [];
  const claimed = squares.filter(s => s && typeof s === 'object' && !Array.isArray(s));
  const names = Array.from(new Set(claimed.filter(s => typeof s.name === 'string').map(s => s.name.trim().toLowerCase())));
  const players = doc.players && typeof doc.players === 'object' && !Array.isArray(doc.players) ? doc.players : {};
  const tags = new Set(Object.values(players).filter(p => p && typeof p === 'object' && typeof p.g === 'string').map(p => p.g));
  const scoring = ['manual', 'live', 'simulation'].indexOf(doc.scoring) !== -1 ? doc.scoring : (doc.simulation ? 'simulation' : 'live');
  return {
    id: String(doc.id || '').toLowerCase(), ownerId: ownerId || null, createdAt: doc.createdAt || null,
    status: doc.status, league: doc.league, gameDate: doc.gameDate, teamA: doc.teamA, teamB: doc.teamB,
    scoring, pickMode: doc.pickMode || null, guestPick: !!(doc.guestPick && doc.guestPick.on === true),
    sold: claimed.length, names, phones: tags.size
  };
}

const locked = (b) => b.status === 'started' || b.status === 'finished';
const share = (part, whole) => (whole ? Math.round((part / whole) * 100) / 100 : 0);
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);

function median(values) {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// A real game is a Live board in a feed league with a date and two teams; the rest are "Other".
function gameKey(b) {
  if (b.scoring !== 'live' || LIVE_LEAGUES.indexOf(b.league) === -1 || !b.gameDate || !b.teamA || !b.teamB) return 'other';
  const teams = [b.teamA, b.teamB].map(t => String(t).trim().toLowerCase()).sort().join('|');
  return `${b.league}|${b.gameDate}|${teams}`;
}

function byGame(boards) {
  const groups = new Map();
  for (const b of boards) {
    const key = gameKey(b);
    if (!groups.has(key)) {
      groups.set(key, key === 'other'
        ? { key, label: 'Other or no game picked', league: null, gameDate: null, teamA: null, teamB: null, boards: [] }
        : { key, label: `${b.teamA} vs ${b.teamB}`, league: b.league, gameDate: b.gameDate, teamA: b.teamA, teamB: b.teamB, boards: [] });
    }
    groups.get(key).boards.push(b);
  }
  const rows = Array.from(groups.values()).map(g => {
    const stages = {};
    STAGES.forEach(s => { stages[s] = g.boards.filter(b => b.status === s).length; });
    return {
      key: g.key, label: g.label, league: g.league, gameDate: g.gameDate, teamA: g.teamA, teamB: g.teamB,
      hosts: new Set(g.boards.map(b => b.ownerId).filter(Boolean)).size,
      boards: g.boards.length,
      guests: sum(g.boards, b => b.names.length),
      lockedShare: share(g.boards.filter(locked).length, g.boards.length),
      stages
    };
  });
  // Biggest games first; "Other" always last.
  return rows.sort((a, b) => (a.key === 'other') - (b.key === 'other') || b.boards - a.boards || String(a.gameDate).localeCompare(String(b.gameDate)));
}

function guestsPerHost(boards, hostsById) {
  const perHost = new Map();
  for (const b of boards) {
    if (!b.ownerId) continue;
    const h = perHost.get(b.ownerId) || { names: new Set(), boards: 0 };
    b.names.forEach(n => h.names.add(n));
    h.boards += 1;
    perHost.set(b.ownerId, h);
  }
  const rows = Array.from(perHost.entries()).map(([id, h]) => ({ id, guests: h.names.size, boards: h.boards }));
  const counts = rows.map(r => r.guests);
  return {
    hosts: rows.length,
    median: median(counts),
    average: rows.length ? Math.round((sum(counts, c => c) / rows.length) * 10) / 10 : 0,
    most: counts.length ? Math.max.apply(null, counts) : 0,
    buckets: GUEST_BUCKETS.map(([lo, hi, label]) => ({ label, hosts: counts.filter(c => c >= lo && c <= hi).length })),
    top: rows.sort((a, b) => b.guests - a.guests || b.boards - a.boards).slice(0, 5).map(r => ({
      id: r.id, email: maskEmail(hostsById.get(r.id) && hostsById.get(r.id).email), guests: r.guests, boards: r.boards
    })),
    // Phones are distinct pick-device tags, so only boards where players pick count.
    phones: sum(boards.filter(b => b.guestPick), b => b.phones)
  };
}

function howRun(boards, facts) {
  const tv = new Set(facts.tvBoards || []);
  const helper = new Set(facts.helperBoards || []);
  const count = (f) => boards.filter(f).length;
  return {
    boards: boards.length,
    scoring: { manual: count(b => b.scoring === 'manual'), live: count(b => b.scoring === 'live'), simulation: count(b => b.scoring === 'simulation') },
    league: { nfl: count(b => b.league === 'nfl'), nba: count(b => b.league === 'nba'), other: count(b => LIVE_LEAGUES.indexOf(b.league) === -1) },
    playerPicks: count(b => b.guestPick),
    helper: count(b => helper.has(b.id)),
    onTv: count(b => tv.has(b.id)),
    averageSold: boards.length ? Math.round((sum(boards, b => b.sold) / boards.length) * 10) / 10 : 0
  };
}

// Counter rows are per UTC day and key (see migrations/012_usage_counters.sql).
function services(usage, now, refreshMs, sinceDay) {
  const total = (key, f) => sum(usage.filter(r => r.key === key), f);
  const latest = (key) => usage.filter(r => r.key === key && r.lastAt).map(r => r.lastAt).sort().pop() || null;
  const providers = Array.from(new Set(usage.map(r => r.key).filter(k => /^feed:/.test(k) && k !== 'feed:fallback' && k !== 'feed:down')));
  const today = new Date(now).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const mail = usage.filter(r => r.key === 'mail:sent');
  return {
    feeds: providers.sort().map(k => ({
      provider: k.slice(5), calls: total(k, r => r.calls), failed: total(k, r => r.failed),
      peakMinute: Math.max.apply(null, [0].concat(usage.filter(r => r.key === k).map(r => r.peakMinute))), lastAt: latest(k)
    })),
    peakTarget: PEAK_TARGET,
    // Each refresh is one slate check, made at most every `refreshMs` while someone is watching.
    fallback: { times: total('feed:fallback', r => r.calls), minutes: Math.round(total('feed:fallback', r => r.calls) * refreshMs / 60000), lastAt: latest('feed:fallback') },
    down: { times: total('feed:down', r => r.calls), lastAt: latest('feed:down') },
    mail: {
      today: sum(mail.filter(r => r.day === today), r => r.calls - r.failed), perDay: MAIL_PER_DAY,
      month: sum(mail.filter(r => r.day.slice(0, 7) === month), r => r.calls - r.failed), perMonth: MAIL_PER_MONTH,
      failed: sum(mail.filter(r => r.day >= sinceDay), r => r.failed), refused: total('mail:refused', r => r.calls)
    },
    logins: { code: total('login:code', r => r.calls), link: total('login:link', r => r.calls) }
  };
}

function stageOf(h) {
  if (h.finished) return 'finished';
  if (h.locked) return 'locked';
  if (h.boards) return 'created';
  return 'none';
}

// `facts` from store.adminFacts, `usage` from store.listUsage (both already cut to the range, except
// the hosts, which are all of them). -> the route's answer.
function build(facts, usage, { range, now, since, refreshMs }) {
  const boards = facts.boards;
  const hosts = facts.hosts;
  const hostsById = new Map(hosts.map(h => [h.id, h]));
  const sinceIso = new Date(since).toISOString();
  const weekIso = new Date(now - 7 * DAY_MS).toISOString();
  const joined = hosts.filter(h => h.createdAt >= sinceIso);

  const days = [];
  // Calendar days stepped as dates (noon UTC), so a daylight-saving change can't skip one.
  for (let d = etDate(since), end = etDate(now); d <= end; d = new Date(Date.parse(`${d}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
    days.push({ day: d, signups: 0, boards: 0 });
  }
  const dayRow = new Map(days.map(r => [r.day, r]));
  joined.forEach(h => { const r = dayRow.get(etDate(Date.parse(h.createdAt))); if (r) r.signups += 1; });
  boards.forEach(b => { const r = dayRow.get(etDate(Date.parse(b.createdAt))); if (r) r.boards += 1; });

  const referrers = new Map();
  joined.filter(h => h.referredBy).forEach(h => referrers.set(h.referredBy, (referrers.get(h.referredBy) || 0) + 1));
  const terms = new Map();
  hosts.filter(h => h.termsVersion).forEach(h => terms.set(h.termsVersion, (terms.get(h.termsVersion) || 0) + 1));

  return {
    range, since: sinceIso, generatedAt: new Date(now).toISOString(),
    headline: {
      hosts: hosts.length,
      hostsNew: joined.length,
      hostsNewWeek: hosts.filter(h => h.createdAt >= weekIso).length,
      boardsCreated: boards.length,
      boardsLocked: boards.filter(locked).length,
      players: sum(boards, b => b.names.length),
      liveNow: facts.liveNow,
      tvsPaired: facts.tvsPaired
    },
    perDay: days,
    // Of the hosts who joined in the range, how far each has got, counting all their boards.
    funnel: {
      signedUp: joined.length,
      createdBoard: joined.filter(h => h.boards > 0).length,
      locked: joined.filter(h => h.locked > 0).length,
      finished: joined.filter(h => h.finished > 0).length,
      secondBoard: joined.filter(h => h.boards > 1).length
    },
    growth: {
      fromBoards: joined.filter(h => h.referredBy).length,
      newsOptIns: hosts.filter(h => h.news).length,
      terms: Array.from(terms.entries()).map(([version, hostsCount]) => ({ version, hosts: hostsCount })).sort((a, b) => b.hosts - a.hosts),
      topReferrers: Array.from(referrers.entries()).map(([code, n]) => ({ code, hosts: n })).sort((a, b) => b.hosts - a.hosts).slice(0, 5)
    },
    byGame: byGame(boards),
    guestsPerHost: guestsPerHost(boards, hostsById),
    howRun: howRun(boards, facts),
    services: services(usage, now, refreshMs, sinceIso.slice(0, 10)),
    recentHosts: hosts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(h => ({
      id: h.id, email: maskEmail(h.email), joined: h.createdAt, boards: h.boards, stage: stageOf(h),
      lastSignIn: h.lastLoginAt, from: h.referredBy ? 'board' : null
    }))
  };
}

module.exports = { build, boardFacts, rangeStart, maskEmail, etDate, RANGES };
