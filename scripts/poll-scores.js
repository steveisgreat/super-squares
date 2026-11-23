// Feed comparison probe: polls ESPN's scoreboard and BALLDONTLIE's games
// endpoint side by side during a live NFL game and logs what each returns, so
// we can measure update lag and see when per-quarter fields fill in.
// Not part of the app. No dependencies.
//
//   node scripts/poll-scores.js [YYYY-MM-DD] [intervalSeconds]
//
// BALLDONTLIE_API_KEY is read from .env.local on every cycle, so a key added
// mid-game is picked up without a restart. Without it only ESPN is polled.
// Output: docs/working/score-poll-<date>/{raw.jsonl,changes.log}
'use strict';

const fs = require('fs');
const path = require('path');

const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const intervalMs = (Number(process.argv[3]) || 15) * 1000;
const MAX_RUNTIME_MS = 7 * 60 * 60 * 1000;
const AFTER_FINAL_MS = 10 * 60 * 1000;

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'working', `score-poll-${date}`);
fs.mkdirSync(outDir, { recursive: true });
const rawPath = path.join(outDir, 'raw.jsonl');
const changesPath = path.join(outDir, 'changes.log');

function readKey() {
  try {
    const m = fs.readFileSync(path.join(root, '.env.local'), 'utf8').match(/^BALLDONTLIE_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

// BALLDONTLIE's `date` is ISO; a night game is the next day in UTC, so ask for both.
function nextDay(d) {
  const t = new Date(d + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

async function timedFetch(url, headers) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 300); }
    return { status: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function pollEspn() {
  const r = await timedFetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${date.replace(/-/g, '')}`);
  const games = ((r.body && r.body.events) || []).map(e => {
    const c = e.competitions[0];
    const side = (ha) => c.competitors.find(x => x.homeAway === ha) || {};
    const h = side('home'), v = side('away');
    return {
      key: `${v.team.abbreviation}@${h.team.abbreviation}`,
      score: `${v.score}-${h.score}`,
      quarters: `${(v.linescores || []).map(l => l.value).join(',')} | ${(h.linescores || []).map(l => l.value).join(',')}`,
      period: c.status.period,
      clock: c.status.displayClock,
      status: c.status.type.name,
      final: !!c.status.type.completed
    };
  });
  return { http: r.status, ms: r.ms, error: r.error, games };
}

async function pollBdl(key) {
  const url = `https://api.balldontlie.io/nfl/v1/games?dates[]=${date}&dates[]=${nextDay(date)}&per_page=100`;
  const r = await timedFetch(url, { Authorization: key });
  const q = (g, side) => ['q1', 'q2', 'q3', 'q4', 'ot'].map(p => g[`${side}_team_${p}`]).map(x => x === null || x === undefined ? '_' : x).join(',');
  const games = ((r.body && r.body.data) || []).map(g => ({
    key: `${g.visitor_team && g.visitor_team.abbreviation}@${g.home_team && g.home_team.abbreviation}`,
    score: `${g.visitor_team_score}-${g.home_team_score}`,
    quarters: `${q(g, 'visitor')} | ${q(g, 'home')}`,
    status: g.status,
    state: g.status_state,
    updatedAt: g.updated_at,
    final: g.status_state === 'final'
  }));
  return { http: r.status, ms: r.ms, error: r.error, games, sample: r.body && r.body.data ? undefined : r.body };
}

const last = {};
function logChanges(source, result) {
  const t = new Date().toISOString();
  if (result.error || result.http !== 200) {
    fs.appendFileSync(changesPath, `${t} ${source} HTTP ${result.http} ${result.error || JSON.stringify(result.sample || '')}\n`);
    return;
  }
  for (const g of result.games) {
    const sig = JSON.stringify({ ...g, updatedAt: undefined, clock: undefined });
    const id = `${source}:${g.key}`;
    if (last[id] !== sig) {
      last[id] = sig;
      const extra = source === 'espn' ? `Q${g.period} ${g.clock} ${g.status}` : `${g.status}/${g.state} upd=${g.updatedAt}`;
      fs.appendFileSync(changesPath, `${t} ${source.padEnd(4)} ${g.key} ${g.score.padEnd(6)} [${g.quarters}] ${extra} (${result.ms}ms)\n`);
    }
  }
}

const startedAt = Date.now();
let finalSince = null;
let bdlAnnounced = false;

async function cycle() {
  const key = readKey();
  if (key && !bdlAnnounced) {
    fs.appendFileSync(changesPath, `${new Date().toISOString()} BALLDONTLIE key found, polling both feeds\n`);
    bdlAnnounced = true;
  }
  const [espn, bdl] = await Promise.all([pollEspn(), key ? pollBdl(key) : Promise.resolve(null)]);
  fs.appendFileSync(rawPath, JSON.stringify({ t: new Date().toISOString(), espn, bdl }) + '\n');
  logChanges('espn', espn);
  if (bdl) logChanges('bdl', bdl);

  const allFinal = espn.games.length > 0 && espn.games.every(g => g.final);
  if (allFinal && !finalSince) finalSince = Date.now();
  if (finalSince && Date.now() - finalSince > AFTER_FINAL_MS) return done('all games final + 10 min');
  if (Date.now() - startedAt > MAX_RUNTIME_MS) return done('max runtime');
  setTimeout(cycle, intervalMs);
}

function done(reason) {
  fs.appendFileSync(changesPath, `${new Date().toISOString()} stopped: ${reason}\n`);
  console.log(`Stopped (${reason}). Log: ${changesPath}`);
}

console.log(`Polling ${date} every ${intervalMs / 1000}s. Log: ${changesPath}`);
cycle();
