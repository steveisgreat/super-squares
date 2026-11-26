// fs-backed implementation of the store interface (lib/store.js). One JSON
// file per game in DATA_DIR, moved here unchanged from server.js.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const GameLogic = require('../public/compute.js');
const JoinCode = require('./joincode.js');

const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Clear out temp files abandoned by a hard crash, or by a rename that gave up
// before renameWithRetry existed to clean up after itself. Only ones older than
// an hour: a temp file belonging to another process's write that is happening
// right now must be left strictly alone, and no legitimate write is ever in
// flight for anything like that long.
//
// These are invisible to the rest of the module either way — listGames filters
// on ID_RE, which a `<uuid>.json.<pid>.tmp` name never matches — so this is
// tidiness, not correctness.
const TMP_SWEEP_AGE_MS = 60 * 60 * 1000;
function sweepStaleTempFiles() {
  let names;
  try {
    names = fs.readdirSync(DATA_DIR);
  } catch (e) {
    return; // Not being able to tidy up is never worth failing startup over.
  }
  const cutoff = Date.now() - TMP_SWEEP_AGE_MS;
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const full = path.join(DATA_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch (e) {
      // Raced with another sweep, or still locked. Next startup will get it.
    }
  }
}
sweepStaleTempFiles();

// Every game gets a server-generated UUID as its permanent identity — this is
// what makes multiple games (any year, any sport) coexist without collision,
// now that a game is no longer keyed by its year. Only ever accepts that exact
// shape, so a junk value can never produce a stray file such as `.json` in
// the data folder.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function gameFile(id) {
  const s = String(id).trim();
  if (!ID_RE.test(s)) return null;
  return path.join(DATA_DIR, `${s}.json`);
}

// The join code (R22) is kept beside the document, never in it, the way the
// Postgres backend keeps it in a column: `<id>.code` holds just the code. The
// name never matches ID_RE once `.code` is on it, so listings ignore it.
function codeFile(id) {
  const f = gameFile(id);
  return f ? f.replace(/\.json$/, '.code') : null;
}

function readCode(id) {
  const f = codeFile(id);
  try {
    return f ? JoinCode.normalize(fs.readFileSync(f, 'utf8')) : null;
  } catch (e) {
    return null;
  }
}

// Response-only: attached to what the caller gets back, removed before a write.
function withCode(game) {
  const code = game && readCode(game.id);
  if (code) game.joinCode = code;
  return game;
}

function findIdByCode(code) {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.code')) continue;
    try {
      if (JoinCode.normalize(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) === code) return f.slice(0, -5);
    } catch (e) { /* unreadable: not a match */ }
  }
  return null;
}

const ASSIGN_ATTEMPTS = 20;

// The rename below can fail transiently on Windows when something else holds a
// handle on either path for a moment — OneDrive's sync engine (this project
// normally lives inside a synced folder) or an antivirus scanner. The write
// itself succeeded; only the swap lost a race, and retrying a few milliseconds
// later virtually always wins.
//
// Left unretried this was silent data loss: the host claims a square, the PUT
// 500s, the change is gone and an orphaned .tmp is left in data/. It surfaced
// as a roughly 1-in-50 flake in the store tests, which is the same defect
// showing up somewhere it could be seen.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;

// Deliberately a BLOCKING sleep, not a promise. updateGame's compare-and-write
// is only safe because it runs start to finish with no await in it (see the
// comment there) — awaiting here would let another request interleave between
// the existence check and the rename, which is exactly the race the whole
// design avoids. A handful of milliseconds on a rare retry is the cheaper
// trade.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepBlocking(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function renameWithRetry(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(e.code)) {
        // Out of retries, or a failure retrying cannot fix (a bad path, a full
        // disk). Take the temp file with us rather than leaving litter behind
        // for someone to find later and wonder about.
        try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* nothing more to do */ }
        throw e;
      }
      // 10ms, 20, 40, 80 — ~150ms total in the worst case before giving up.
      sleepBlocking(RENAME_BACKOFF_MS * Math.pow(2, attempt - 1));
    }
  }
}

// Atomic save: write a temp file and rename over the target. A crash, power cut
// or OneDrive sync landing mid-write can then never leave a truncated,
// unparseable game file behind.
function writeGameFile(file, game) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(game, null, 2));
  renameWithRetry(tmp, file);
}

function readGameFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The version token must change on every write, or a save holding the old
// token would still match (issue #3). Millisecond timestamps repeat when two
// writes land in the same millisecond, so step past the stored one.
function nextStamp(prev) {
  const now = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  return new Date(Number.isFinite(p) && now <= p ? p + 1 : now).toISOString();
}

// The browser can only lock picking at the cutoff while someone has the app
// open. The server owns the clock too, so a cutoff still fires if every device
// is asleep.
function applyAutoCutoff(game, file) {
  let changed = false;
  if (GameLogic.cutoffPassed(game)) {
    GameLogic.lockGame(game, { pick: (n) => crypto.randomInt(n) }); // the server's draw (decision 026)
    changed = true;
  }
  // Also re-derives started/finished on read, so games saved before this
  // distinction existed pick up the right status without needing an edit.
  const statusBefore = game.status;
  GameLogic.syncStatus(game);
  if (game.status !== statusBefore) changed = true;
  if (changed) {
    game.updatedAt = nextStamp(game.updatedAt);
    writeGameFile(file, game);
  }
  return game;
}

// This backend has no accounts, so the only list it can give is the whole one.
async function listGames(scope) {
  if (!scope || scope.all !== true || scope.ownerId !== undefined) {
    throw new Error('listGames: the fs backend accepts only { all: true }');
  }
  const files = fs.readdirSync(DATA_DIR).filter(f => ID_RE.test(f.replace(/\.json$/, '')));
  const games = files.map(f => {
    try {
      const full = path.join(DATA_DIR, f);
      const g = applyAutoCutoff(readGameFile(full), full);
      return {
        id: g.id,
        teamA: g.teamA,
        teamB: g.teamB,
        league: g.league,
        teamAColor: g.teamAColor,
        teamBColor: g.teamBColor,
        description: g.description || '',
        gameDate: g.gameDate,
        kickoffTime: g.kickoffTime || null,
        status: g.status,
        updatedAt: g.updatedAt || null
      };
    } catch (e) {
      console.error(`Skipping unreadable game file ${f}: ${e.message}`);
      return null;
    }
  }).filter(Boolean);
  games.sort((a, b) => (b.gameDate || '').localeCompare(a.gameDate || ''));
  return games;
}

async function getGame(id) {
  const file = gameFile(id);
  if (!file || !fs.existsSync(file)) return null;
  return withCode(applyAutoCutoff(readGameFile(file), file));
}

async function createGame(game, ownerId) {
  if (ownerId !== undefined && ownerId !== null) throw new Error('createGame: the fs backend has no owners');
  const file = gameFile(game.id);
  delete game.joinCode;
  game.createdAt = new Date().toISOString();
  game.updatedAt = game.createdAt;
  writeGameFile(file, game);
  return withCode(game);
}

// Conditional write — see the concurrency contract in store.js. Everything
// from the existence check to the rename runs synchronously, with no await in
// between, so the event loop cannot interleave another request midway and
// the compare-and-write is effectively one operation. (Two separate OS
// processes sharing this folder could still interleave; that is the limit of
// what a plain file backend can promise, and why Postgres does the check as a
// single conditional statement.)
async function updateGame(id, game, expectedUpdatedAt, opts) {
  const file = gameFile(id);
  const exists = fs.existsSync(file);
  const existing = exists ? readGameFile(file) : null;
  if (!existing && opts && opts.mustExist) return { ok: false, game: null };

  // A conflict needs both sides of the comparison to exist. No token from the
  // caller means "overwrite unconditionally"; no stored timestamp means there
  // is no prior version to have lost to.
  if (existing && existing.updatedAt && expectedUpdatedAt
    && existing.updatedAt !== expectedUpdatedAt) {
    return { ok: false, game: withCode(existing) };
  }
  delete game.joinCode;

  game.createdAt = (existing && existing.createdAt) || new Date().toISOString();
  game.updatedAt = nextStamp(existing && existing.updatedAt);
  writeGameFile(file, game);
  return { ok: true, game: withCode(game) };
}

async function deleteGame(id) {
  const file = gameFile(id);
  if (!file || !fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  try { fs.unlinkSync(codeFile(id)); } catch (e) { /* none was assigned */ }
  dropHelpers(id); // the Postgres backend's on delete cascade
  try { fs.unlinkSync(changesFile(id)); } catch (e) { /* nothing logged */ }
  return true;
}

// Join codes. assignJoinCode is idempotent: a board that has one keeps it. A
// code already in use is retried with a fresh one (the Postgres backend gets
// the same from its unique index). `gen` is for tests.
async function getGameIdByJoinCode(code) {
  const c = JoinCode.normalize(code);
  return c ? findIdByCode(c) : null;
}

async function assignJoinCode(id, gen) {
  const file = gameFile(id);
  if (!file || !fs.existsSync(file)) return null;
  const have = readCode(id);
  if (have) return have;
  const generate = gen || JoinCode.generate;
  for (let attempt = 0; attempt < ASSIGN_ATTEMPTS; attempt++) {
    const code = JoinCode.normalize(generate());
    if (!code || findIdByCode(code)) continue;
    fs.writeFileSync(codeFile(id), code);
    return code;
  }
  throw new Error('Could not find a free join code');
}

// TV pairings (R23). One JSON file beside the games, same shape as the Postgres table:
// { <tokenHash>: { code, gameId, ownerId, createdAt, pairedAt } }, times in ms. Expiry is
// judged at read time against `now` (injectable for tests); expired rows are dropped when
// a new pairing is created. Every function runs with no await, so each is atomic here.
const TV_FILE = path.join(DATA_DIR, 'tv-pairings.json');
const TV_UNPAIRED_MS = 15 * 60 * 1000;
const TV_PAIRED_MS = 24 * 60 * 60 * 1000;
// A storage guard, not a rate limit: low enough to bound the table, high enough that
// flooding it to lock out real TVs costs ~100 requests a second for 15 minutes.
const TV_MAX_WAITING = 100000;

function readTv() {
  try {
    return JSON.parse(fs.readFileSync(TV_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function tvLive(row, now) {
  return row.gameId ? now - row.pairedAt < TV_PAIRED_MS : now - row.createdAt < TV_UNPAIRED_MS;
}

// -> the new code, or null when too many pairings are waiting. `gen` is for tests.
async function createTvPairing(tokenHash, gen, now) {
  now = now === undefined ? Date.now() : now;
  const all = readTv();
  for (const k of Object.keys(all)) if (!tvLive(all[k], now)) delete all[k];
  const rows = Object.values(all);
  if (rows.filter(r => !r.gameId).length >= TV_MAX_WAITING) return null;
  const generate = gen || JoinCode.generate;
  for (let attempt = 0; attempt < ASSIGN_ATTEMPTS; attempt++) {
    const code = JoinCode.normalize(generate());
    if (!code || rows.some(r => r.code === code)) continue;
    all[tokenHash] = { code, gameId: null, ownerId: null, createdAt: now, pairedAt: null };
    writeGameFile(TV_FILE, all);
    return code;
  }
  throw new Error('Could not find a free pairing code');
}

// -> { code, gameId } | null (unknown or expired). `code` is null once paired.
async function getTvPairing(tokenHash, now) {
  now = now === undefined ? Date.now() : now;
  const row = readTv()[tokenHash];
  if (!row || !tvLive(row, now)) return null;
  return { code: row.gameId ? null : row.code, gameId: row.gameId };
}

// Retires the code in the same write. -> false for an unknown, expired or already-paired code.
async function pairTv(code, gameId, ownerId, now) {
  now = now === undefined ? Date.now() : now;
  const c = JoinCode.normalize(code);
  if (!c) return false;
  const all = readTv();
  const key = Object.keys(all).find(k => !all[k].gameId && all[k].code === c && tvLive(all[k], now));
  if (!key) return false;
  Object.assign(all[key], { code: null, gameId, ownerId: ownerId || null, pairedAt: now });
  writeGameFile(TV_FILE, all);
  return true;
}

// Moves every live pairing of this owner (null = the auth-off owner) to gameId; a move
// restarts that pairing's 24 hours. -> how many follow now.
async function followTv(ownerId, gameId, now) {
  now = now === undefined ? Date.now() : now;
  const all = readTv();
  let n = 0;
  for (const row of Object.values(all)) {
    if (row.gameId && tvLive(row, now) && (row.ownerId || null) === (ownerId || null)) {
      row.gameId = gameId;
      row.pairedAt = now;
      n++;
    }
  }
  if (n) writeGameFile(TV_FILE, all);
  return n;
}

async function countTvs(ownerId, now) {
  now = now === undefined ? Date.now() : now;
  return Object.values(readTv()).filter(r => r.gameId && tvLive(r, now) && (r.ownerId || null) === (ownerId || null)).length;
}

// Helpers (decision 025): an array of rows, same shape as the Postgres table, times in ms. No await
// anywhere, so each function is atomic here. Accounts never run on this backend, so a row or a
// caller from accounts mode counts for nothing.
const HELPER_FILE = path.join(DATA_DIR, 'helpers.json');
const HELPER_JOB_MS = 180 * 24 * 60 * 60 * 1000;
const HELPER_DAY_MS = 24 * 60 * 60 * 1000;

function readHelpers() {
  try {
    const rows = JSON.parse(fs.readFileSync(HELPER_FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const helperWaiting = (r, now) => r.tokenHash !== null && now < r.tokenExpiresAt;
const helperConnected = (r, now) => r.sessionHash !== null && now - r.usedAt < HELPER_JOB_MS;

// A board that is gone, or finished and not saved for a day, has no helpers.
function helpersEnded(gameId, now) {
  const file = gameFile(String(gameId).toLowerCase());
  const game = file && fs.existsSync(file) ? readGameFile(file) : null;
  if (!game) return true;
  return game.status === 'finished' && !!game.updatedAt && now - Date.parse(game.updatedAt) >= HELPER_DAY_MS;
}

const helperJobs = (r) => ({ label: r.label, canScore: r.canScore, canSquares: r.canSquares });

async function createHelper({ gameId, hostVersion, label, canScore, canSquares, tokenHash, tokenSeconds, max }, now) {
  now = now === undefined ? Date.now() : now;
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = readHelpers().filter(r => {
    if (sameId(r.gameId, gameId) && r.hostVersion !== v) return false;
    if (r.usedAt === null) return now - r.tokenExpiresAt < HELPER_DAY_MS;
    return helperConnected(r, now) || helperWaiting(r, now);
  });
  const room = rows.filter(r => sameId(r.gameId, gameId)).length < max;
  const id = crypto.randomUUID();
  if (room) {
    rows.push({
      id, gameId, hostVersion: v, label, canScore: !!canScore, canSquares: !!canSquares,
      tokenHash, tokenExpiresAt: now + tokenSeconds * 1000, sessionHash: null, createdAt: now, usedAt: null
    });
  }
  writeGameFile(HELPER_FILE, rows);
  return room ? id : null;
}

async function useHelperToken({ tokenHash, sessionHash, accounts }, now) {
  now = now === undefined ? Date.now() : now;
  if (accounts || !tokenHash) return null;
  const rows = readHelpers();
  const row = rows.find(r => r.tokenHash === tokenHash && r.hostVersion === null && helperWaiting(r, now));
  if (!row || helpersEnded(row.gameId, now)) return null;
  Object.assign(row, { tokenHash: null, tokenExpiresAt: null, usedAt: now, sessionHash });
  writeGameFile(HELPER_FILE, rows);
  return Object.assign({ id: row.id, gameId: row.gameId }, helperJobs(row));
}

async function helperAccess({ gameId, sessionHash, accounts }, now) {
  now = now === undefined ? Date.now() : now;
  if (accounts || !sessionHash) return null;
  const row = readHelpers().find(r => sameId(r.gameId, gameId) && r.sessionHash === sessionHash
    && r.hostVersion === null && helperConnected(r, now));
  if (!row || helpersEnded(gameId, now)) return null;
  return Object.assign({ id: row.id }, helperJobs(row));
}

async function listHelpers(gameId, hostVersion, now) {
  now = now === undefined ? Date.now() : now;
  const v = hostVersion === undefined ? null : hostVersion;
  const ended = helpersEnded(gameId, now);
  return readHelpers().filter(r => sameId(r.gameId, gameId) && r.hostVersion === v)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(r => Object.assign({ id: r.id }, helperJobs(r), {
      connected: !ended && helperConnected(r, now), waiting: !ended && helperWaiting(r, now)
    }));
}

// Finds the board's helper, lets `change` edit the row, saves. False when there is no such helper.
function changeHelper({ gameId, id, hostVersion }, change) {
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = readHelpers();
  const row = rows.find(r => r.id === id && sameId(r.gameId, gameId) && r.hostVersion === v);
  if (!row) return false;
  change(row);
  writeGameFile(HELPER_FILE, rows);
  return true;
}

async function setHelperJobs({ gameId, id, hostVersion, canScore, canSquares }) {
  return changeHelper({ gameId, id, hostVersion }, r => Object.assign(r, { canScore: !!canScore, canSquares: !!canSquares }));
}

async function newHelperCode({ gameId, id, hostVersion, tokenHash, tokenSeconds }, now) {
  now = now === undefined ? Date.now() : now;
  return changeHelper({ gameId, id, hostVersion }, r => Object.assign(r, { tokenHash, tokenExpiresAt: now + tokenSeconds * 1000 }));
}

async function removeHelper({ gameId, id }) {
  const rows = readHelpers();
  const kept = rows.filter(r => !(r.id === id && sameId(r.gameId, gameId)));
  if (kept.length === rows.length) return false;
  writeGameFile(HELPER_FILE, kept);
  return true;
}

function dropHelpers(gameId) {
  const rows = readHelpers();
  const kept = rows.filter(r => !sameId(r.gameId, gameId));
  if (kept.length !== rows.length) writeGameFile(HELPER_FILE, kept);
}

// Recent changes (R39, decision 025): one file beside each board, oldest first, deleted with it.
// No await, so each write is atomic here.
const CHANGES_KEPT = 50;
const CHANGE_TEXT_MAX = 120;
const changesFile = (id) => gameFile(String(id).toLowerCase()).replace(/\.json$/, '.changes.json');

function readChanges(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

async function logChange({ gameId, helperId, label, text }, now) {
  try {
    const game = gameFile(String(gameId).toLowerCase());
    if (!game || !fs.existsSync(game)) return; // the Postgres backend's foreign key
    const file = changesFile(gameId);
    const rows = readChanges(file);
    rows.push({
      id: crypto.randomUUID(), at: new Date(now === undefined ? Date.now() : now).toISOString(),
      helperId: helperId || null, label: label || null, text: Array.from(String(text)).slice(0, CHANGE_TEXT_MAX).join('')
    });
    writeGameFile(file, rows.slice(-CHANGES_KEPT));
  } catch (e) {
    console.error(`Change log write failed: ${e.message}`);
  }
}

async function listChanges(gameId) {
  if (!gameFile(String(gameId).toLowerCase())) return [];
  return readChanges(changesFile(gameId)).reverse();
}

// Host themes (decision 021). Off and password modes only, so there is one host: 'site'.
const THEME_FILE = path.join(DATA_DIR, 'host-themes.json');
function readThemes() {
  try {
    const all = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch (e) {
    return {};
  }
}

async function ping() {}

async function getTheme(hostKey) {
  const all = readThemes();
  return Object.prototype.hasOwnProperty.call(all, hostKey) ? all[hostKey] : null;
}

async function setTheme(hostKey, theme) {
  writeGameFile(THEME_FILE, Object.assign(readThemes(), { [hostKey]: theme }));
}

async function getGameTheme(id, opts) {
  if (opts && opts.accounts) return noAccounts();
  return await getGame(id) ? { theme: await getTheme('site') } : null;
}

// Shared live-score slates (decision 001 section 3). In memory, as the decision says: the
// local dev server is one process, and a restart only costs one extra provider call. Every
// function runs start to finish with no await, so claimLiveSlate is atomic the same way
// updateGame is.
const liveSlates = new Map();
const ET_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
function slateKey(league, etDate) {
  if (!/^[a-z0-9_-]{1,20}$/i.test(String(league)) || !ET_DATE_RE.test(String(etDate))) {
    throw new Error('live slate: bad league or date');
  }
  return `${league}|${etDate}`;
}

async function getLiveSlate(league, etDate) {
  const row = liveSlates.get(slateKey(league, etDate));
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

async function claimLiveSlate(league, etDate, seenCheckedAt, nowIso) {
  const key = slateKey(league, etDate);
  const row = liveSlates.get(key);
  if (!row) {
    if (seenCheckedAt !== null && seenCheckedAt !== undefined) return false;
    liveSlates.set(key, { payload: null, checkedAt: nowIso, fetchedAt: null });
    return true;
  }
  if (row.checkedAt !== seenCheckedAt) return false;
  row.checkedAt = nowIso;
  return true;
}

async function saveLiveSlate(league, etDate, payload, fetchedAt) {
  const row = liveSlates.get(slateKey(league, etDate));
  if (!row) return;
  row.payload = JSON.parse(JSON.stringify(payload));
  if (fetchedAt) row.fetchedAt = fetchedAt;
}

// Accounts need Postgres. auth.js refuses accounts mode without DATABASE_URL,
// so these are never reached; they throw rather than answer something unsafe.
// ---------------------------------------------------------------------------
// Admin usage page (R45a, decision 027). The fs backend has no hosts, so the host parts are empty;
// the counters and board facts match Postgres.
// ---------------------------------------------------------------------------

const USAGE_FILE = path.join(DATA_DIR, 'usage-counters.json');

function readUsage() {
  try {
    const all = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch (e) {
    return {};
  }
}

async function bumpUsage(key, opts) {
  const o = opts || {};
  try {
    const at = new Date(o.now === undefined ? Date.now() : o.now);
    const day = at.toISOString().slice(0, 10);
    const minute = new Date(Math.floor(at.getTime() / 60000) * 60000).toISOString();
    const k = `${day}|${String(key).slice(0, 40)}`;
    const all = readUsage();
    const r = all[k] || { calls: 0, failed: 0, minute: null, minuteCalls: 0, peakMinute: 0, lastAt: null };
    r.calls += 1;
    if (o.failed) r.failed += 1;
    if (r.minute === minute) r.minuteCalls += 1;
    else if (!r.minute || r.minute < minute) { r.minute = minute; r.minuteCalls = 1; }
    r.peakMinute = Math.max(r.peakMinute, r.minute === minute ? r.minuteCalls : 1);
    if (!r.lastAt || r.lastAt < at.toISOString()) r.lastAt = at.toISOString();
    all[k] = r;
    writeGameFile(USAGE_FILE, all);
  } catch (e) {
    console.error(`Usage count failed: ${e.message}`);
  }
}

async function listUsage(sinceDay) {
  const all = readUsage();
  return Object.keys(all).sort().map(k => {
    const [day, key] = k.split('|');
    const r = all[k];
    return { day, key, calls: r.calls, failed: r.failed, peakMinute: r.peakMinute, lastAt: r.lastAt };
  }).filter(r => r.day >= sinceDay);
}

async function adminFacts({ since, now, etToday }) {
  now = now === undefined ? Date.now() : now;
  const AdminStats = require('./admin-stats.js');
  const docs = fs.readdirSync(DATA_DIR).filter(f => ID_RE.test(f.replace(/\.json$/, ''))).map(f => {
    try { return readGameFile(path.join(DATA_DIR, f)); } catch (e) { return null; }
  }).filter(Boolean);
  const tvs = Object.values(readTv()).filter(r => r.gameId && now - r.pairedAt < TV_PAIRED_MS);
  return {
    boards: docs.filter(g => typeof g.createdAt === 'string' && g.createdAt >= since).map(g => AdminStats.boardFacts(g, null)),
    hosts: [],
    liveNow: docs.filter(g => g.status === 'started' && g.gameDate === etToday).length,
    tvsPaired: tvs.length,
    tvBoards: tvs.map(r => String(r.gameId).toLowerCase()),
    helperBoards: Array.from(new Set(readHelpers().map(r => String(r.gameId).toLowerCase())))
  };
}

async function noAccounts() {
  throw new Error('Host accounts need DATABASE_URL');
}

module.exports = {
  ping,
  listGames, getGame, createGame, updateGame, deleteGame,
  getGameIdByJoinCode, assignJoinCode,
  createTvPairing, getTvPairing, pairTv, followTv, countTvs,
  createHelper, useHelperToken, helperAccess, listHelpers, setHelperJobs, newHelperCode, removeHelper,
  logChange, listChanges,
  getLiveSlate, claimLiveSlate, saveLiveSlate,
  getTheme, setTheme, getGameTheme,
  bumpUsage, listUsage, adminFacts,
  tableRows: async () => null,
  getHostEmail: async () => null,
  getGameAccess: noAccounts,
  getHost: noAccounts,
  createLoginRequest: noAccounts,
  useLoginToken: noAccounts,
  useLoginCode: noAccounts,
  revokeSessions: noAccounts,
  getNews: noAccounts,
  setNews: noAccounts,
  getHeardAsk: noAccounts,
  setHeard: noAccounts
};
