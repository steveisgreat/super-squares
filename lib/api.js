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

// Every polling screen re-fetches the same game every few seconds and the
// document is mostly a 100-entry squares array, so the overwhelmingly common
// response is one the caller already has. `no-cache` means "revalidate every
// time", not "don't store" — the browser sends If-None-Match on its own and
// turns our 304 back into a normal 200 for fetch(), so the polling screens
// need no change whatsoever. No Vary is needed: this endpoint is public and
// returns the same document to the host and to a guest alike.
//
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

function sendGameResponse(req, res, game) {
  const etag = gameETag(game);
  if (req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const body = JSON.stringify(game);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'ETag': etag,
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

// About twice a full simulated board: see test-accounts.js, which measures one.
const MAX_GAME_BODY = 28 * 1024;
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
// server's own initiative (the live-score refresh below, and applyAutoCutoff
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
      perSite: auth.loginEmailsPerHour()
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
  const proof = auth.loginProof(body);
  const host = proof && (proof.tokenHash
    ? await store.useLoginToken(proof.tokenHash)
    : await store.useLoginCode(proof.requestId, proof.codeHash, auth.MAX_CODE_TRIES));
  if (!host) return deny(res, 401, 'That link or code is wrong or has expired.');
  auth.setAccountCookie(res, req, host);
  return sendJSON(res, 200, { authRequired: true, host: true, mode, email: host.email });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Merges the slate into a live board and, when a quarter has newly completed, writes it.
// A write that loses to a newer document is dropped: the next read finds the same quarter
// still unfilled and tries again, and the response is built from the newer document.
async function readLiveGame(game, writeOpts) {
  let merged;
  try {
    merged = await Slate.readForGame(game);
  } catch (e) {
    // A slate that cannot be read (for example migration 003 not applied yet) must not
    // take the board down: it reads as "feed unavailable" and the host can enter the score.
    console.error(`Live slate read failed: ${e.message}`);
    merged = Object.assign({ filled: [] }, Slate.applyToGame(game, null, Date.now()));
  }
  if (merged.filled.length) {
    const saved = await store.updateGame(game.id, merged.game, game.updatedAt || null, writeOpts);
    if (saved.ok) {
      merged = Object.assign({}, merged, { game: saved.game });
    } else if (saved.game) {
      // Someone wrote first. Answer from their document, with the stored slate (no refresh).
      merged = await Slate.readForGame(saved.game, { readOnly: true });
    }
  }
  return Object.assign(merged.game, { liveFeed: merged.feed });
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

async function handleApi(req, res, pathname, query) {
  if (auth.foreignOrigin(req)) return deny(res, 403, 'Cross-site request refused.');

  const caller = auth.identify(req);
  // Accounts mode never creates a board by saving one (see store.js).
  const writeOpts = { mustExist: auth.authMode() === 'accounts' };

  if (await handleSession(req, res, pathname, caller) !== false) return;

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
    const game = await store.getGame(id);
    if (!game) return sendJSON(res, 404, { error: 'Not found' });

    // Boards made before join codes get one the first time their owner reads
    // them. Everyone else just sees the code if there is one (the TV needs it).
    if (!game.joinCode && await isOwner(caller, id)) {
      try {
        game.joinCode = await store.assignJoinCode(id) || undefined;
      } catch (e) {
        console.error(`Join code assignment failed: ${e.message}`);
      }
    }
    // Later writes in this handler hand back documents without the column.
    const code = game.joinCode;
    const sendGame = (rq, rs, g) => {
      if (code) g.joinCode = code;
      return sendGameResponse(rq, rs, g);
    };

    // A Live board merges the shared slate on read (decision 001 sections 3 to 5). The
    // game row is written only when a quarter newly completes, through the same
    // conditional update every other write uses.
    if (game.status === 'started' && GameLogic.scoringMode(game) === 'live') {
      return sendGame(req, res, await readLiveGame(game, writeOpts));
    }

    // Simulation and manual boards: live scores refresh here rather than on a timer, so they work on a host
    // that keeps no long-lived process. The read we just did supplies the
    // concurrency token, so a save landing between that read and this write
    // wins outright and the client is handed that newer game instead.
    let expectedUpdatedAt = game.updatedAt || null;

    // The ESPN lookup slot, claimed before the network call rather than
    // stamped after it — see refreshLiveScore for why the difference matters
    // once a roomful of phones is polling. This is just the store's ordinary
    // conditional write: every concurrent reader carries the same
    // expectedUpdatedAt, so exactly one of them can win, and that one write
    // both persists the throttle stamp and elects the single instance that
    // will talk to ESPN.
    const claimSlot = async () => {
      const claim = await store.updateGame(id, game, expectedUpdatedAt, writeOpts);
      if (claim.ok) {
        // Chain the next write from our own, so the score we are about to
        // fetch does not immediately lose to the claim we just made.
        expectedUpdatedAt = claim.game.updatedAt || null;
        return true;
      }
      // Somebody else holds the slot. Adopt their document so this request
      // still answers with the freshest thing anyone has written.
      if (claim.game) Object.assign(game, claim.game);
      return false;
    };

    if (await LiveScore.refreshLiveScore(game, claimSlot)) {
      GameLogic.syncStatus(game);
      // Either way the caller wants the winning document: our refreshed one if
      // the write landed, or the newer one that beat us to it. A null there
      // means the game was deleted from under us mid-request; our own copy is
      // still the best answer available, and the next poll will 404 cleanly.
      const saved = await store.updateGame(id, game, expectedUpdatedAt, writeOpts);
      return sendGame(req, res, saved.game || game);
    }
    return sendGame(req, res, game);
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
  // 'final'|'undo'|'edit', ...}), not a document, so a tap on the phone never
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
      const current = GameLogic.scoringMode(stored) === 'live' && stored.status === 'started'
        ? (await Slate.readForGame(stored, { readOnly: true })).game : stored;
      const applied = GameLogic.applyScoreOp(current, op);
      if (applied.error) return sendJSON(res, applied.code === 'illegal' ? 409 : 400, { error: applied.error });
      const next = applied.game;
      GameLogic.syncStatus(next);
      const invalid = GameLogic.validateGame(next);
      if (invalid) return sendJSON(res, 400, { error: invalid });
      const result = await store.updateGame(id, next, current.updatedAt || null, writeOpts);
      if (result.ok) return sendJSON(res, 200, result.game);
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
      const current = GameLogic.scoringMode(stored) === 'live' && stored.status === 'started'
        ? (await Slate.readForGame(stored, { readOnly: true })).game : stored;
      const applied = GameLogic.applyPayoutOp(current, op);
      if (applied.error) return sendJSON(res, applied.code === 'illegal' ? 409 : 400, { error: applied.error });
      const next = applied.game;
      // The feed's score is merged on read and never stored (as in PUT); keep the row's own.
      if (next.liveScore && !next.liveScore.manual) next.liveScore = stored.liveScore === undefined ? null : stored.liveScore;
      GameLogic.syncStatus(next);
      const invalid = GameLogic.validateGame(next);
      if (invalid) return sendJSON(res, 400, { error: invalid });
      const result = await store.updateGame(id, next, current.updatedAt || null, writeOpts);
      if (result.ok) return sendJSON(res, 200, result.game);
    }
    return sendJSON(res, 409, { error: 'This game was changed on another device. Try again.', conflict: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

module.exports = { handleApi, sendJSON, readBody };
