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
  const tag = crypto.createHash('sha1')
    .update(`${game.id}:${game.updatedAt || ''}:${live}:${feed}`)
    .digest('hex');
  return `W/"${tag}"`;
}

function sendGame(req, res, game) {
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

  const gameMatch = pathname.match(/^\/api\/game\/([0-9a-f-]{36})$/i);
  // Public by design: the id is the read capability. It's on the player QR
  // code and the TV deep link, so every guest holds it — which is exactly
  // why it authorizes reading one game and nothing else.
  if (gameMatch && req.method === 'GET') {
    const id = gameMatch[1].toLowerCase();
    const game = await store.getGame(id);
    if (!game) return sendJSON(res, 404, { error: 'Not found' });

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
    const invalid = GameLogic.validateGame(body);
    if (invalid) return sendJSON(res, 400, { error: invalid });
    const game = await store.createGame(dropOwnerFields(body), caller.all ? null : caller.hostId);
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
  // rewrites the grid or collides with a square pick. Host-only, like PUT.
  // The server reads the current document, applies the op through GameLogic
  // and writes with that document's own updatedAt; if another write lands in
  // between, it re-reads and applies the op again (bounded).
  const scoreMatch = pathname.match(/^\/api\/game\/([0-9a-f-]{36})\/score$/i);
  if (scoreMatch && req.method === 'PATCH') {
    if (await denyUnlessOwner(res, caller, scoreMatch[1].toLowerCase())) return;
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

  sendJSON(res, 404, { error: 'Not found' });
}

module.exports = { handleApi, sendJSON, readBody };
