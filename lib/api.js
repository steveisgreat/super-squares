// Framework-free API handler shared by the local dev server (server.js) and the
// Vercel serverless entry point (api/[...path].js).
'use strict';

const crypto = require('crypto');
const GameLogic = require('../public/compute.js');
const LiveScore = require('../server-livescore.js');
const Slate = require('./scores/slate.js');
const store = require('./store.js');
const auth = require('./auth.js');
const mailer = require('./mailer.js');
const JoinCode = require('./joincode.js');
const { appVersion } = require('./version.js');

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Everything but a single game (sendGame) depends on who is asking.
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// Every polling screen re-fetches the same game every few seconds. The plain read is cached at
// Vercel's edge for everyone watching the board (decision 023): for 3 s a copy is served as is,
// for 2 s more it is served while one call replaces it, so no copy is over about 5 s old. The
// browser revalidates every time, and the edge answers its 304s. A plain read must therefore never
// depend on who is asking: no cookie read, no Set-Cookie. `?fresh=1` skips the edge (own cache
// key, never stored) for a screen that is about to act on what it reads.
const EDGE_CACHE = 'public, s-maxage=3, stale-while-revalidate=2';
const BROWSER_CACHE = 'public, max-age=0, must-revalidate';

// A live board's score is merged from the shared slate on read and is NOT written to the
// game, so updatedAt alone would answer 304 to a changed score. The merged fields join
// the tag.
function gameETag(game) {
  const l = game.liveScore;
  const live = l ? [l.a, l.b, l.period, l.clock, l.state, l.statusName, l.updatedAt].join(',') : '';
  const feed = game.liveFeed ? (game.liveFeed.available ? 'up' : 'down') : '';
  // joinCode is a column, not part of the document, so a code assigned later
  // changes the response without changing updatedAt.
  const tag = crypto.createHash('sha1')
    .update(`${game.id}:${game.updatedAt || ''}:${live}:${feed}:${game.joinCode || ''}`)
    .digest('hex');
  return `W/"${tag}"`;
}

// `fresh` is the uncached read. Only it answers 304: the edge keeps only whole 200 responses, so
// a 304 from here would leave it with nothing to share and every poll would reach this function.
function sendGameResponse(req, res, game, fresh) {
  const etag = gameETag(game);
  const headers = fresh
    ? { 'ETag': etag, 'Cache-Control': 'private, no-cache' }
    : { 'ETag': etag, 'Cache-Control': BROWSER_CACHE, 'Vercel-CDN-Cache-Control': EDGE_CACHE };
  if (fresh && req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const body = JSON.stringify(game);
  res.writeHead(200, Object.assign(headers, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

// About twice a full board, with guest-pick fields too: see test-accounts.js, which measures one.
const MAX_GAME_BODY = 40 * 1024;
const MAX_OP_BODY = 4 * 1024;
const MAX_LOGIN_BODY = 4 * 1024;
// Past a limit the rest is read and thrown away, so the 413 can be delivered.
// Past this much the connection is cut.
const MAX_DRAIN = 512 * 1024;

// Always resolves to a plain object. Chunks are joined as bytes before
// decoding: a name with an accent can straddle two of them.
function readBody(req, limit = MAX_GAME_BODY) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const tooLarge = () => {
      chunks = [];
      reject(Object.assign(new Error('Payload too large'), { tooLarge: true }));
    };
    req.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        tooLarge();
        if (size > MAX_DRAIN) req.destroy();
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      if (size > limit) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
        resolve(body);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function denyBadBody(res, e) {
  if (e.tooLarge) return deny(res, 413, 'That is too much data for one request.');
  return deny(res, 400, 'Invalid JSON');
}

// Authorization lives here, at the route layer, and deliberately NOT in the
// store: GET /api/game/:id is public, and the writes it triggers on the
// server's own initiative (a newly completed quarter, and applyAutoCutoff
// inside the store) must keep working for an anonymous reader. See lib/auth.js
// for the modes.
function deny(res, status, error, extra) {
  sendJSON(res, status, Object.assign({ error }, extra));
  return true;
}

// Resolves to true once it has sent a refusal. `caller` is auth.identify(req).
async function denyUnlessSignedIn(res, caller) {
  const refused = denyUnlessClaimed(res, caller);
  if (refused || caller.all) return refused;
  const host = await store.getHost(caller.hostId);
  return denyUnlessCurrent(res, caller, host && host.sessionVersion);
}

// Like denyUnlessSignedIn, and the board must be the caller's. One query
// answers both questions. A board with no owner belongs to nobody.
async function denyUnlessOwner(res, caller, id) {
  const refused = denyUnlessClaimed(res, caller);
  if (refused || caller.all) return refused;
  const access = await store.getGameAccess(id, caller.hostId);
  if (denyUnlessCurrent(res, caller, access.sessionVersion)) return true;
  if (!access.exists) return deny(res, 404, 'Not found');
  // 403, not 401: signing in again would not help, so no prompt.
  if (!access.ownerId || access.ownerId !== caller.hostId) return deny(res, 403, 'This board belongs to another host.');
  return false;
}

function denyUnlessClaimed(res, caller) {
  if (caller) return false;
  if (auth.authMode() === 'misconfigured') return deny(res, 503, 'Sign-in is not set up on this server.');
  return deny(res, 401, 'Host sign-in required.', { authRequired: true });
}

// Like denyUnlessOwner, but answers instead of refusing. Used where a stranger
// is welcome and only the owner gets something extra.
async function isOwner(caller, id) {
  if (!caller) return false;
  if (caller.all) return true;
  const access = await store.getGameAccess(id, caller.hostId);
  return access.exists && access.sessionVersion === caller.sessionVersion
    && !!access.ownerId && access.ownerId === caller.hostId;
}

// A scorer phone may enter scores on one board and nothing else (decision 018). Costs a
// query only when the request carries the cookie. A broken sign-in setup lets nobody in.
async function isScorer(req, id) {
  const mode = auth.authMode();
  const sessionHash = auth.scorerSessionHash(req);
  if (mode === 'misconfigured' || !sessionHash) return false;
  return store.scorerAllowed({ gameId: id, sessionHash, accounts: mode === 'accounts' });
}

// For the score route only.
async function denyUnlessOwnerOrScorer(req, res, caller, id) {
  if (await isScorer(req, id)) return false;
  return denyUnlessOwner(res, caller, id);
}

function denyUnlessCurrent(res, caller, sessionVersion) {
  if (sessionVersion === caller.sessionVersion) return false;
  return deny(res, 401, 'Host sign-in required.', { authRequired: true });
}

// Ownership is a column in the store. It never travels in a document.
function dropOwnerFields(game) {
  delete game.owner_id;
  delete game.ownerId;
  return game;
}

// Sign-in and account routes. Returns false when `pathname` isn't one.
async function handleSession(req, res, pathname, caller) {
  const mode = auth.authMode();

  if (pathname === '/api/session' && req.method === 'GET') {
    const body = { authRequired: auth.authRequired(), host: !!caller, mode, version: appVersion() };
    if (mode === 'accounts' && caller) {
      const host = await store.getHost(caller.hostId);
      body.host = !!host && host.sessionVersion === caller.sessionVersion;
      if (body.host) body.email = host.email;
    }
    return sendJSON(res, 200, body);
  }

  if (pathname === '/api/session' && req.method === 'DELETE') {
    auth.clearSessionCookie(res, req);
    return sendJSON(res, 200, { authRequired: auth.authRequired(), host: !auth.authRequired() });
  }

  // Password sign-in. Off mode keeps its old answer for the LAN client.
  if (pathname === '/api/session' && req.method === 'POST') {
    if (mode === 'misconfigured') return denyUnlessClaimed(res, null);
    if (mode === 'accounts') return deny(res, 404, 'Not found');
    let body;
    try {
      body = await readBody(req, MAX_LOGIN_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    if (mode === 'off') return sendJSON(res, 200, { authRequired: false, host: true });
    if (!auth.checkPassword(body.password)) {
      // A fixed delay on failure. Serverless instances share no memory, so a
      // real attempt counter would need a table; this plus a long random
      // password is the accepted trade (decision 009; docs/archive/migration-plan.md, Phase 4.1).
      await sleep(400);
      return deny(res, 401, 'That password is not right.', { authRequired: true });
    }
    auth.setSessionCookie(res, req);
    return sendJSON(res, 200, { authRequired: true, host: true });
  }

  if (req.method !== 'POST') return false;
  if (!['/api/login', '/api/login/verify', '/api/session/revoke-all'].includes(pathname)) return false;
  if (mode === 'misconfigured') return denyUnlessClaimed(res, null);
  if (mode !== 'accounts') return deny(res, 404, 'Not found');

  if (pathname === '/api/session/revoke-all') {
    if (denyUnlessClaimed(res, caller)) return;
    if (!await store.revokeSessions(caller.hostId, caller.sessionVersion)) return denyUnlessClaimed(res, null);
    auth.clearSessionCookie(res, req);
    return sendJSON(res, 200, { authRequired: true, host: false });
  }

  let body;
  try {
    body = await readBody(req, MAX_LOGIN_BODY);
  } catch (e) {
    return denyBadBody(res, e);
  }

  if (pathname === '/api/login') {
    const email = auth.normalizeEmail(body.email);
    if (!email) return deny(res, 400, 'Enter a valid email address.');
    const login = auth.newLogin();
    // Every answer below is the same for an address with an account and one
    // without: nothing here looks at the hosts table.
    const stored = await store.createLoginRequest({
      id: login.requestId,
      email,
      tokenHash: login.tokenHash,
      codeHash: login.codeHash,
      perEmail: auth.LOGINS_PER_EMAIL_PER_HOUR,
      perSite: auth.loginEmailsPerHour(),
      ref: auth.normalizeRef(body.ref)
    });
    if (!stored) return deny(res, 429, 'Too many sign-in emails. Try again in an hour.');
    try {
      await mailer.sendLoginEmail({ to: email, link: login.link, code: login.code, requestId: login.requestId });
    } catch (e) {
      console.error(`Sign-in email failed: ${e.message}`);
      return deny(res, 502, 'The sign-in email could not be sent. Try again.');
    }
    return sendJSON(res, 200, { requestId: login.requestId });
  }

  // /api/login/verify. One answer for wrong, used, expired and out of tries.
  // Consent comes with the proof, never with the request for an email: whoever proves they own the
  // address is the one who ticked the box (decision 024).
  const proof = auth.loginProof(body);
  const consent = auth.loginConsent(body);
  const host = proof && (proof.tokenHash
    ? await store.useLoginToken(proof.tokenHash, consent)
    : await store.useLoginCode(proof.requestId, proof.codeHash, auth.MAX_CODE_TRIES, consent));
  if (!host) return deny(res, 401, 'That link or code is wrong or has expired.');
  auth.setAccountCookie(res, req, host);
  return sendJSON(res, 200, { authRequired: true, host: true, mode, email: host.email });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A started board whose score comes from a feed or a simulation: the score is merged on read, and
// the row is written only when a quarter newly completes. A write that loses to a newer document
// is dropped: the next read finds the same quarter still unfilled and tries again, and the
// response is built from the newer document.
async function readMerged(game, writeOpts) {
  let merged = await mergeScore(game);
  if (merged.filled.length) {
    const saved = await store.updateGame(game.id, withRowLiveScore(merged.game, game), game.updatedAt || null, writeOpts);
    if (saved.ok) {
      merged = Object.assign({}, merged, { game: Object.assign(saved.game, { liveScore: merged.game.liveScore }) });
    } else if (saved.game) {
      // Someone wrote first. Answer from their document (no slate refresh).
      merged = mergesScore(saved.game) ? await mergeScore(saved.game, { readOnly: true }) : { game: saved.game, feed: null };
    }
  }
  return merged.feed ? Object.assign(merged.game, { liveFeed: merged.feed }) : merged.game;
}

// Is this board's score merged on read?
function mergesScore(game) {
  return game.status === 'started' && GameLogic.scoringMode(game) !== 'manual';
}

function mergeScore(game, opts) {
  return GameLogic.scoringMode(game) === 'simulation' ? mergeSimulation(game) : mergeSlate(game, opts);
}

// A simulated score is a pure function of the clock and the plan drawn at lock time.
function mergeSimulation(game) {
  const g = JSON.parse(JSON.stringify(game));
  LiveScore.applySimulatedData(g);
  const filled = ['q1', 'q2', 'q3', 'final'].filter(q => GameLogic.hasResult((g.results || {})[q])
    && !GameLogic.hasResult((game.results || {})[q]));
  if (filled.length) GameLogic.syncStatus(g);
  return { game: g, feed: null, filled };
}

// The slate merged into a board ({ game, feed, filled }). A slate that cannot be read (for
// example migration 003 not applied yet) must not take the board down: it reads as "feed
// unavailable" and the host can still enter the score.
async function mergeSlate(game, opts) {
  try {
    return await Slate.readForGame(game, opts);
  } catch (e) {
    console.error(`Live slate read failed: ${e.message}`);
    return Object.assign({ filled: [] }, Slate.applyToGame(game, null, Date.now()));
  }
}

// The feed's score is merged on read and never stored; a host-entered (manual) one is, and so is
// a simulated one when its row is written anyway (it costs nothing and holds the final score).
// Returns `next` with the stored row's own liveScore in place of a feed one.
function withRowLiveScore(next, stored) {
  if (GameLogic.scoringMode(next) === 'simulation') return next;
  if (next.liveScore && !next.liveScore.manual) {
    return Object.assign({}, next, { liveScore: stored.liveScore === undefined ? null : stored.liveScore });
  }
  return next;
}

// A Live board's write response looks like its GET: the feed's score and status put back
// on the saved row, so the client keeps the score panel and the offline bar.
function liveResponse(saved, next, feed) {
  if (!feed) return saved;
  if (next.liveScore && !next.liveScore.manual) saved.liveScore = next.liveScore;
  saved.liveFeed = feed;
  return saved;
}

// The document a Live or Simulation board's write starts from: the stored row with its score
// merged (read only, no slate refresh), plus the feed status to hand back with the response.
async function liveBase(stored) {
  if (!mergesScore(stored)) return { game: stored, feed: null };
  const merged = await mergeScore(stored, { readOnly: true });
  return { game: merged.game, feed: merged.feed };
}

const TV_TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;
const GAME_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The pairing's owner: the caller's account id, null when auth is off (caller.all).
const tvOwner = (caller) => (caller.all ? null : caller.hostId);

// Returns false when `pathname` isn't a TV route.
async function handleTv(req, res, pathname, caller) {
  // The TV asks for a pairing. Anonymous by nature; the store caps how many wait.
  if (pathname === '/api/tv' && req.method === 'POST') {
    const token = crypto.randomBytes(32).toString('base64url');
    const code = await store.createTvPairing(auth.sha256(token));
    if (!code) return deny(res, 503, 'Too many TVs are waiting. Try again in a few minutes.');
    return sendJSON(res, 201, { code, token });
  }

  // How many TVs follow the caller's boards (Game Day uses it to decide on /follow).
  if (pathname === '/api/tv/mine' && req.method === 'GET') {
    if (await denyUnlessSignedIn(res, caller)) return;
    return sendJSON(res, 200, { count: await store.countTvs(tvOwner(caller)) });
  }

  if ((pathname === '/api/tv/pair' || pathname === '/api/tv/follow') && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, MAX_OP_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    const gameId = body && typeof body.gameId === 'string' ? body.gameId.trim().toLowerCase() : '';
    if (!GAME_ID_RE.test(gameId)) return deny(res, 400, 'That is not a board.');
    const code = pathname === '/api/tv/pair' ? JoinCode.normalize(body.code) : null;
    if (pathname === '/api/tv/pair' && !code) return deny(res, 400, 'That is not a TV code. It has six letters and numbers.');
    if (await denyUnlessOwner(res, caller, gameId)) return true;
    // denyUnlessOwner skips the lookup for the one host (password and off modes).
    if (caller.all && !await store.getGame(gameId)) return deny(res, 404, 'Not found');
    if (pathname === '/api/tv/pair') {
      // One conditional write: an unknown, expired or already-paired code changes nothing.
      if (!await store.pairTv(code, gameId, tvOwner(caller))) {
        return deny(res, 404, 'That code is not waiting. It may have expired: look at the TV for a new one.');
      }
    } else {
      await store.followTv(tvOwner(caller), gameId);
    }
    return sendJSON(res, 200, { count: await store.countTvs(tvOwner(caller)) });
  }

  // The TV reads its own pairing; the token is the only key.
  const tvMatch = pathname.match(/^\/api\/tv\/([^/]+)$/);
  if (tvMatch && req.method === 'GET') {
    if (!TV_TOKEN_RE.test(tvMatch[1])) return deny(res, 404, 'Not found');
    const row = await store.getTvPairing(auth.sha256(tvMatch[1]));
    if (!row) return deny(res, 404, 'Not found');
    return sendJSON(res, 200, row.gameId ? { state: 'paired', gameId: row.gameId } : { state: 'waiting', code: row.code });
  }

  return false;
}

const MAX_SCORERS = 5;
const SCORER_CODE_SECONDS = 5 * 60; // the stores' own limit, told to the host's screen

// Scorer-phone hand-off (decision 018). Returns false when `pathname` isn't one of its routes.
async function handleHandoff(req, res, pathname, caller) {
  // The phone spends its one-time code. One answer for wrong, used, expired and cancelled.
  if (pathname === '/api/handoff' && req.method === 'POST') {
    const mode = auth.authMode();
    if (mode === 'misconfigured') return denyUnlessClaimed(res, null);
    let body;
    try {
      body = await readBody(req, MAX_LOGIN_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    const tokenHash = auth.secretHash(body.token);
    const session = auth.newSecret();
    const gameId = tokenHash && await store.useScorerToken({
      tokenHash, sessionHash: auth.sha256(session), accounts: mode === 'accounts'
    });
    if (!gameId) return deny(res, 401, 'That code is wrong, used or expired. Ask the host for a new one.');
    auth.setScorerCookie(res, req, gameId, session);
    return sendJSON(res, 200, { gameId });
  }

  const m = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/(handoff|role)$/i);
  if (!m) return false;
  const id = m[1].toLowerCase();
  if (!GAME_ID_RE.test(id)) return deny(res, 404, 'Not found');

  // What this device may do on the board, so the phone screen shows the right controls.
  if (m[2].toLowerCase() === 'role') {
    if (req.method !== 'GET') return false;
    if (await isOwner(caller, id)) return sendJSON(res, 200, { role: 'host' });
    return sendJSON(res, 200, { role: await isScorer(req, id) ? 'scorer' : 'none' });
  }

  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return false;
  if (await denyUnlessOwner(res, caller, id)) return true;
  const hostVersion = caller.all ? null : caller.sessionVersion;

  if (req.method === 'GET') return sendJSON(res, 200, await store.scorerStatus(id, hostVersion));
  if (req.method === 'DELETE') {
    await store.removeScorers(id);
    return sendJSON(res, 200, { waiting: false, scorers: 0 });
  }
  const game = await store.getGame(id);
  if (!game) return deny(res, 404, 'Not found');
  if (game.status !== 'started' && game.status !== 'finished') return deny(res, 409, 'Scoring opens once the board is locked.');
  const token = auth.newSecret();
  const scorers = await store.createScorerGrant({ gameId: id, hostVersion, tokenHash: auth.sha256(token), max: MAX_SCORERS });
  if (scorers === null) return deny(res, 409, `${MAX_SCORERS} phones can already score this board. Remove them to add another.`);
  return sendJSON(res, 201, { token, scorers, expiresInSeconds: SCORER_CODE_SECONDS });
}

const GUEST_TRIES = 8;

// Guest picks (R28, decision 019). Anyone with the board id may ask whether they hold a
// name (POST, which also hands out their device key); a device with a key may claim and
// release its own squares (PATCH). No accounts table is read, so all three auth modes behave
// alike. Returns false when `pathname` isn't one of its routes.
async function handleGuest(req, res, pathname, writeOpts) {
  const m = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/guest$/i);
  if (!m || (req.method !== 'POST' && req.method !== 'PATCH')) return false;
  if (auth.authMode() === 'misconfigured') return deny(res, 503, 'Sign-in is not set up on this server.');
  const id = m[1].toLowerCase();
  if (!GAME_ID_RE.test(id)) return deny(res, 404, 'Not found');

  if (req.method === 'POST') {
    // getGame applies a passed cutoff first, so a board that just locked answers 409.
    const game = await store.getGame(id);
    if (!game) return deny(res, 404, 'Not found');
    if (game.status !== 'picking' || !game.guestPick || game.guestPick.on !== true) {
      return deny(res, 409, 'Player picks are not open on this board.');
    }
    let key = auth.guestKey(req);
    if (!key) {
      key = auth.newSecret();
      auth.setGuestCookie(res, req, id, key);
    }
    return sendJSON(res, 200, { name: GameLogic.guestNameOf(game, auth.guestTag(id, key)) });
  }

  // 401 without authRequired: this must never open the host sign-in prompt.
  const key = auth.guestKey(req);
  if (!key) return deny(res, 401, 'This device has no pick key. Tap Pick squares first.');
  let op;
  try {
    op = await readBody(req, MAX_OP_BODY);
  } catch (e) {
    return denyBadBody(res, e);
  }
  const tag = auth.guestTag(id, key);
  let latest = null;
  for (let attempt = 0; attempt < GUEST_TRIES; attempt++) {
    // A short random wait so a crowd on one link does not retry in step.
    if (attempt) await sleep(20 + Math.floor(Math.random() * 100));
    const stored = await store.getGame(id);
    if (!stored) return deny(res, 404, 'Not found');
    const applied = GameLogic.applyGuestOp(stored, op, { tag, now: Date.now() });
    if (applied.error) {
      if (applied.code !== 'illegal') return sendJSON(res, 400, { error: applied.error });
      return sendJSON(res, 409, { error: applied.error, taken: applied.taken, game: stored });
    }
    if (!applied.changed) return sendJSON(res, 200, { game: stored, name: applied.name });
    const next = dropOwnerFields(applied.game);
    const invalid = GameLogic.validateGame(next);
    if (invalid) return sendJSON(res, 400, { error: invalid });
    const result = await store.updateGame(id, next, stored.updatedAt || null, writeOpts);
    if (result.ok) return sendJSON(res, 200, { game: result.game, name: applied.name });
    if (!result.game) return deny(res, 404, 'Not found');
    latest = result.game;
  }
  return sendJSON(res, 409, { error: 'Many people are picking right now. Try again.', conflict: true, game: latest });
}

// The host's color theme (decision 021). Reading a board's theme needs only the board id, like the
// board itself. A host's own theme is read and changed by that host alone, under a key taken from
// the session and never from the request. The database may be behind (migration 007 not applied):
// a read then answers the default, and a change says it could not be saved.
async function handleTheme(req, res, pathname, caller) {
  const shown = (theme) => (GameLogic.isTheme(theme) ? theme : GameLogic.THEMES[0]);
  const missing = (e) => !!e && e.code === '42P01'; // undefined_table

  const m = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/theme$/i);
  if (m) {
    if (req.method !== 'GET') return deny(res, 405, 'Method not allowed');
    let row;
    try {
      row = await store.getGameTheme(m[1].toLowerCase(), { accounts: auth.authMode() === 'accounts' });
    } catch (e) {
      if (!missing(e)) throw e;
      row = { theme: null };
    }
    if (!row) return deny(res, 404, 'Not found');
    return sendJSON(res, 200, { theme: shown(row.theme) });
  }

  if (pathname !== '/api/theme') return false;
  if (req.method !== 'GET' && req.method !== 'PUT') return deny(res, 405, 'Method not allowed');
  if (await denyUnlessSignedIn(res, caller)) return;
  const key = caller.all ? 'site' : caller.hostId;

  if (req.method === 'GET') {
    let theme = null;
    try {
      theme = await store.getTheme(key);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    return sendJSON(res, 200, { theme: shown(theme) });
  }

  let body;
  try {
    body = await readBody(req, MAX_OP_BODY);
  } catch (e) {
    return denyBadBody(res, e);
  }
  if (!body || !GameLogic.isTheme(body.theme)) return deny(res, 400, 'Choose one of the themes.');
  try {
    await store.setTheme(key, body.theme);
  } catch (e) {
    if (!missing(e)) throw e;
    return deny(res, 503, 'Themes are not set up on this server yet.');
  }
  return sendJSON(res, 200, { theme: body.theme });
}

// News about next season (R34): the signed-in host's own choice, accounts mode only.
async function handleNews(req, res, pathname, caller) {
  if (pathname !== '/api/news') return false;
  if (req.method !== 'GET' && req.method !== 'PUT') return deny(res, 405, 'Method not allowed');
  if (await denyUnlessSignedIn(res, caller)) return;
  if (caller.all) return deny(res, 404, 'Not found'); // no account to keep it on
  if (req.method === 'GET') return sendJSON(res, 200, { news: await store.getNews(caller.hostId) });
  let body;
  try {
    body = await readBody(req, MAX_OP_BODY);
  } catch (e) {
    return denyBadBody(res, e);
  }
  if (typeof body.news !== 'boolean') return deny(res, 400, 'Choose on or off.');
  await store.setNews(caller.hostId, body.news);
  return sendJSON(res, 200, { news: body.news });
}

async function handleApi(req, res, pathname, query) {
  if (auth.foreignOrigin(req)) return deny(res, 403, 'Cross-site request refused.');

  // Status check (R11). Plain: the function runs, no database. `?db=1` also asks the database,
  // which wakes a suspended Neon compute: use it by hand or from an alert, never on a timer.
  if (pathname === '/api/health' && req.method === 'GET') {
    const body = { ok: true, version: appVersion() };
    if (query && query.get('db') === '1') {
      const t0 = Date.now();
      try {
        await store.ping();
        body.db = 'ok';
        body.dbMs = Date.now() - t0;
      } catch (e) {
        console.error('health: database check failed:', e && e.message);
        return sendJSON(res, 503, { ok: false, version: body.version, db: 'down' });
      }
    }
    return sendJSON(res, 200, body);
  }

  const caller = auth.identify(req);
  // Accounts mode never creates a board by saving one (see store.js).
  const writeOpts = { mustExist: auth.authMode() === 'accounts' };

  if (await handleSession(req, res, pathname, caller) !== false) return;
  if (await handleTheme(req, res, pathname, caller) !== false) return;
  if (await handleNews(req, res, pathname, caller) !== false) return;

  // Enumerating every game anyone ever created is the one endpoint that had
  // to close regardless of which access model won.
  if (pathname === '/api/games' && req.method === 'GET') {
    if (await denyUnlessSignedIn(res, caller)) return;
    return sendJSON(res, 200, await store.listGames(caller.all ? { all: true } : { ownerId: caller.hostId }));
  }

  // Feeds the "Games" picker on the New Game setup screen. It reads the shared
  // live slate (decision 001), so it costs no provider call of its own. null
  // distinctly means no feed has answered (502), vs. a real empty schedule
  // ([], 200) — the client shows different text for each.
  if (pathname === '/api/todays-games' && req.method === 'GET') {
    // Host-only: only the New Game setup screen uses it, and leaving it open
    // would publish a free score proxy on the deploy's shared IPs.
    if (await denyUnlessSignedIn(res, caller)) return;
    let games = null;
    try {
      games = await Slate.listGames(query.get('league'), query.get('date'));
    } catch (e) {
      console.error(`Live slate read failed: ${e.message}`);
    }
    if (games === null) return sendJSON(res, 502, { error: 'Score feed not available' });
    return sendJSON(res, 200, { games });
  }

  // TV pairing (R23). A TV holds a secret token and shows a short code; the host types
  // the code to point that TV at a board. Nothing here gives a TV a session, a cookie or
  // any way to write: the responses carry only `code`, `state` and `gameId`.
  if (pathname.startsWith('/api/tv')) {
    const handled = await handleTv(req, res, pathname, caller);
    if (handled !== false) return;
  }

  if (await handleHandoff(req, res, pathname, caller) !== false) return;

  if (await handleGuest(req, res, pathname, writeOpts) !== false) return;

  // A join code opens the guest view. Public, and a read capability exactly like
  // a game id (decisions 009, 012, 016): it names one board and authorizes
  // nothing but reading it.
  const joinMatch = pathname.match(/^\/api\/join\/([^/]+)$/);
  if (joinMatch && req.method === 'GET') {
    let raw = joinMatch[1];
    try { raw = decodeURIComponent(raw); } catch (e) { /* stays malformed */ }
    const code = JoinCode.normalize(raw);
    if (!code) return sendJSON(res, 400, { error: 'That is not a join code.' });
    const id = await store.getGameIdByJoinCode(code);
    if (!id) return sendJSON(res, 404, { error: 'Not found' });
    return sendJSON(res, 200, { id });
  }

  const gameMatch = pathname.match(/^\/api\/game\/([0-9a-f-]{36})$/i);
  // Public by design: the id is the read capability. It's on the player QR
  // code and the TV deep link, so every guest holds it — which is exactly
  // why it authorizes reading one game and nothing else.
  if (gameMatch && req.method === 'GET') {
    const id = gameMatch[1].toLowerCase();
    const fresh = query.get('fresh') === '1';
    let game = await store.getGame(id);
    if (!game) return sendJSON(res, 404, { error: 'Not found' });

    // Boards made before join codes get one the first time their owner opens them. On the
    // uncached read only: the cached one is the same for every caller.
    if (fresh && !game.joinCode && await isOwner(caller, id)) {
      try {
        game.joinCode = await store.assignJoinCode(id) || undefined;
      } catch (e) {
        console.error(`Join code assignment failed: ${e.message}`);
      }
    }
    // A write in here hands back a document without a just-assigned code.
    const code = game.joinCode;
    if (mergesScore(game)) game = await readMerged(game, writeOpts);
    if (code) game.joinCode = code;
    return sendGameResponse(req, res, game, fresh);
  }

  if (gameMatch && req.method === 'DELETE') {
    if (await denyUnlessOwner(res, caller, gameMatch[1].toLowerCase())) return;
    const ok = await store.deleteGame(gameMatch[1].toLowerCase());
    if (!ok) return sendJSON(res, 404, { error: 'Not found' });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/game' && req.method === 'POST') {
    if (await denyUnlessSignedIn(res, caller)) return;
    let body;
    try {
      body = await readBody(req, MAX_GAME_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    body.id = crypto.randomUUID();
    delete body.joinCode;
    const invalid = GameLogic.validateGame(body);
    if (invalid) return sendJSON(res, 400, { error: invalid });
    const game = await store.createGame(dropOwnerFields(body), caller.all ? null : caller.hostId);
    try {
      const code = await store.assignJoinCode(game.id);
      if (code) game.joinCode = code;
    } catch (e) {
      // The board exists; the first owner read assigns a code.
      console.error(`Join code assignment failed: ${e.message}`);
    }
    return sendJSON(res, 201, game);
  }

  // Host-only, and that covers phone score entry (#score-<id>) too: it is
  // the same whole-document write the picking screen uses, so a leaked score
  // link would otherwise be able to wipe the grid.
  if (gameMatch && req.method === 'PUT') {
    if (await denyUnlessOwner(res, caller, gameMatch[1].toLowerCase())) return;
    let body;
    try {
      body = await readBody(req, MAX_GAME_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    const clientUpdatedAt = body.updatedAt || null;
    // Lowercase ONCE, and use that same value as both the document's id and
    // the store key. The route regex is case-insensitive, and the two stores
    // disagree about what that means: Postgres normalizes a `uuid` column,
    // while the fs backend uses the string verbatim as a filename. Passing the
    // raw match here let an upper-case URL write `ABC….json` holding
    // `id: "abc…"` — one game with two identities, on a case-sensitive
    // filesystem two separate games.
    const id = gameMatch[1].toLowerCase();
    body.id = id;
    // Response-only and merged-on-read fields never go back into the row: the client
    // echoes the whole document it was shown. A host-entered score (manual) stays.
    delete body.liveFeed;
    delete body.joinCode;
    if (GameLogic.scoringMode(body) === 'live' && body.liveScore && !body.liveScore.manual) body.liveScore = null;
    GameLogic.syncStatus(body);

    const invalid = GameLogic.validateGame(body);
    if (invalid) return sendJSON(res, 400, { error: invalid });

    const result = await store.updateGame(id, dropOwnerFields(body), clientUpdatedAt, writeOpts);
    if (!result.ok && !result.game && writeOpts.mustExist) return deny(res, 404, 'Not found');
    if (!result.ok) {
      return sendJSON(res, 409, {
        error: 'This game was changed on another device.',
        conflict: true,
        game: result.game
      });
    }
    return sendJSON(res, 200, result.game);
  }

  // Manual score entry. The body is an operation ({op:'add'|'set'|'end'|
  // 'final'|'undo'|'edit'|'draw'|'resume', ...}), not a document, so a tap on the phone never
  // rewrites the grid or collides with a square pick. The owner, or a phone the owner
  // handed this board to (decision 018).
  // The server reads the current document, applies the op through GameLogic
  // and writes with that document's own updatedAt; if another write lands in
  // between, it re-reads and applies the op again (bounded).
  const scoreMatch = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/score$/i);
  if (scoreMatch && req.method === 'PATCH') {
    if (await denyUnlessOwnerOrScorer(req, res, caller, scoreMatch[1].toLowerCase())) return;
    let op;
    try {
      op = await readBody(req, MAX_OP_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    const id = scoreMatch[1].toLowerCase();
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await store.getGame(id);
      if (!stored) return sendJSON(res, 404, { error: 'Not found' });
      // A Live board's current score lives in the slate, so the host's tap starts from
      // that (read only: no refresh). Quarters the feed settled are filled in here and are
      // written with the tap, as the next read would have written them anyway.
      const base = await liveBase(stored);
      const current = base.game;
      // Only here is there a draw to make: the pick and its time never come from a browser.
      const applied = GameLogic.applyScoreOp(current, op, { pick: (n) => crypto.randomInt(n), now: Date.now() });
      if (applied.error) return sendJSON(res, applied.code === 'illegal' ? 409 : 400, { error: applied.error });
      const next = applied.game;
      GameLogic.syncStatus(next);
      const invalid = GameLogic.validateGame(next);
      if (invalid) return sendJSON(res, 400, { error: invalid });
      const result = await store.updateGame(id, withRowLiveScore(next, stored), current.updatedAt || null, writeOpts);
      if (result.ok) return sendJSON(res, 200, liveResponse(result.game, next, base.feed));
    }
    return sendJSON(res, 409, { error: 'This game was changed on another device. Try again.', conflict: true });
  }

  // Payout tracking (R21, decision 015): {op:'paid'|'unpaid'|'settle', quarter}.
  // A record the host keeps; no money moves (decision 004). Host-only, and
  // applied to the current document with the same bounded retry as /score.
  const payoutMatch = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/payout$/i);
  if (payoutMatch && req.method === 'PATCH') {
    if (await denyUnlessOwner(res, caller, payoutMatch[1].toLowerCase())) return;
    let op;
    try {
      op = await readBody(req, MAX_OP_BODY);
    } catch (e) {
      return denyBadBody(res, e);
    }
    const id = payoutMatch[1].toLowerCase();
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await store.getGame(id);
      if (!stored) return sendJSON(res, 404, { error: 'Not found' });
      // A Live board's settled quarters may still be only in the slate; pay against
      // what the host sees, and write those quarters with the mark (as /score does).
      const base = await liveBase(stored);
      const current = base.game;
      const applied = GameLogic.applyPayoutOp(current, op);
      if (applied.error) return sendJSON(res, applied.code === 'illegal' ? 409 : 400, { error: applied.error });
      const next = applied.game;
      GameLogic.syncStatus(next);
      const invalid = GameLogic.validateGame(next);
      if (invalid) return sendJSON(res, 400, { error: invalid });
      const result = await store.updateGame(id, withRowLiveScore(next, stored), current.updatedAt || null, writeOpts);
      if (result.ok) return sendJSON(res, 200, liveResponse(result.game, next, base.feed));
    }
    return sendJSON(res, 409, { error: 'This game was changed on another device. Try again.', conflict: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

module.exports = { handleApi, sendJSON, readBody };
