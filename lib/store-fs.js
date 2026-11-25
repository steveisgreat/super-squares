// fs-backed implementation of the store interface (lib/store.js). One JSON
// file per game in DATA_DIR, moved here unchanged from server.js.
'use strict';

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
    GameLogic.lockGame(game);
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
  await removeScorers(id); // the Postgres backend's on delete cascade
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

// Scorer-phone hand-off (decision 018): an array of rows, same shape as the Postgres table,
// times in ms. No await anywhere, so each function is atomic here. Accounts never run on this
// backend, so a row or a caller from accounts mode counts for nothing.
const SCORER_FILE = path.join(DATA_DIR, 'scorer-grants.json');
const SCORER_TOKEN_MS = 5 * 60 * 1000;
const SCORER_GRANT_MS = 24 * 60 * 60 * 1000;

function readScorers() {
  try {
    const rows = JSON.parse(fs.readFileSync(SCORER_FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const scorerWaiting = (r, now) => r.usedAt === null && now - r.createdAt < SCORER_TOKEN_MS;
const scorerActive = (r, now) => r.usedAt !== null && now - r.usedAt < SCORER_GRANT_MS;

async function createScorerGrant({ gameId, hostVersion, tokenHash, max }, now) {
  now = now === undefined ? Date.now() : now;
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = readScorers().filter(r => (r.usedAt === null ? scorerWaiting(r, now) && !sameId(r.gameId, gameId) : scorerActive(r, now)));
  const scorers = rows.filter(r => sameId(r.gameId, gameId) && r.usedAt !== null && r.hostVersion === v).length;
  const room = scorers < max;
  if (room) rows.push({ gameId, hostVersion: v, tokenHash, sessionHash: null, createdAt: now, usedAt: null });
  writeGameFile(SCORER_FILE, rows);
  return room ? scorers : null;
}

async function useScorerToken({ tokenHash, sessionHash, accounts }, now) {
  now = now === undefined ? Date.now() : now;
  if (accounts) return null;
  const rows = readScorers();
  const row = rows.find(r => r.tokenHash === tokenHash && r.hostVersion === null && scorerWaiting(r, now));
  if (!row) return null;
  row.usedAt = now;
  row.sessionHash = sessionHash;
  writeGameFile(SCORER_FILE, rows);
  return row.gameId;
}

async function scorerAllowed({ gameId, sessionHash, accounts }, now) {
  now = now === undefined ? Date.now() : now;
  if (accounts || !sessionHash) return false;
  return readScorers().some(r => sameId(r.gameId, gameId) && r.sessionHash === sessionHash && r.hostVersion === null && scorerActive(r, now));
}

async function scorerStatus(gameId, hostVersion, now) {
  now = now === undefined ? Date.now() : now;
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = readScorers().filter(r => sameId(r.gameId, gameId) && r.hostVersion === v);
  return { waiting: rows.some(r => scorerWaiting(r, now)), scorers: rows.filter(r => scorerActive(r, now)).length };
}

async function removeScorers(gameId) {
  const rows = readScorers();
  const kept = rows.filter(r => !sameId(r.gameId, gameId));
  if (kept.length !== rows.length) writeGameFile(SCORER_FILE, kept);
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
async function noAccounts() {
  throw new Error('Host accounts need DATABASE_URL');
}

module.exports = {
  ping,
  listGames, getGame, createGame, updateGame, deleteGame,
  getGameIdByJoinCode, assignJoinCode,
  createTvPairing, getTvPairing, pairTv, followTv, countTvs,
  createScorerGrant, useScorerToken, scorerAllowed, scorerStatus, removeScorers,
  getLiveSlate, claimLiveSlate, saveLiveSlate,
  getTheme, setTheme, getGameTheme,
  getGameAccess: noAccounts,
  getHost: noAccounts,
  createLoginRequest: noAccounts,
  useLoginToken: noAccounts,
  useLoginCode: noAccounts,
  revokeSessions: noAccounts,
  getNews: noAccounts,
  setNews: noAccounts
};
