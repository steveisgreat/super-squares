// Host sign-in. Three modes, read from the environment on every call:
//
//   accounts   AUTH_MODE=accounts. One account per host, signed in by an
//              emailed link or code (decision 012).
//   password   HOST_PASSWORD set. One site-wide host (decision 009), kept for
//              one release as the way back from accounts mode.
//   off        Neither. Every request is the host: the LAN build, where the
//              home network is the boundary.
//
// Anything half set up is the fourth answer, `misconfigured`: guarded routes
// return 503 and nobody is the host. On Vercel `off` is never an answer, so
// losing a variable can't open every board.
//
// In every mode a game id is a READ capability only. It is on the player QR
// code, the TV link and the score link, so every guest holds it: enough to
// fetch one game, never enough to write one.
//
// Sessions are signed cookies, not rows. In accounts mode the cookie also
// carries the account's session_version, which lib/api.js compares with the
// database on every guarded request; that is what makes "sign out everywhere"
// real without a session table.
'use strict';

const crypto = require('crypto');

const COOKIE = 'sbs_host';            // password mode
const ACCOUNT_COOKIE = 'sbs_session'; // accounts mode
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days — a season of parties.
const ACCOUNT_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const MAX_CODE_TRIES = 5;
const LOGINS_PER_EMAIL_PER_HOUR = 5;
const DEFAULT_LOGIN_EMAILS_PER_HOUR = 200;
const MIN_SECRET_LENGTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hostPassword() {
  const p = process.env.HOST_PASSWORD;
  return p ? String(p) : null;
}

// The site's own origin, for links in email. Never the Host header, which the
// caller controls: a forged one would mail the token to someone else's site.
function appOrigin() {
  let url;
  try {
    url = new URL(String(process.env.APP_ORIGIN || ''));
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' && (url.protocol !== 'http:' || process.env.VERCEL)) return null;
  return url.origin;
}

function accountsConfigured() {
  const env = process.env;
  if (!env.DATABASE_URL || !appOrigin()) return false;
  // Cookies are only as hard to forge as this is to guess.
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < MIN_SECRET_LENGTH) return false;
  // Off Vercel, no key means the link and code print to the console.
  if (env.VERCEL && !env.RESEND_API_KEY) return false;
  if (env.RESEND_API_KEY && !env.EMAIL_FROM) return false;
  return true;
}

function authMode() {
  const wanted = String(process.env.AUTH_MODE || '').trim();
  if (wanted === 'accounts') return accountsConfigured() ? 'accounts' : 'misconfigured';
  // A typo must not quietly mean some weaker mode.
  if (wanted) return 'misconfigured';
  if (hostPassword() !== null) return 'password';
  return process.env.VERCEL ? 'misconfigured' : 'off';
}

function authRequired() {
  return authMode() !== 'off';
}

// Signing key. SESSION_SECRET is honored if set, so the host can rotate the
// password without logging every device out (or vice versa); otherwise the
// password itself is the key, which means changing it invalidates every
// outstanding cookie — a reasonable default for "someone got the password".
function signingKey() {
  return process.env.SESSION_SECRET || hostPassword() || '';
}

function sign(value) {
  return crypto.createHmac('sha256', signingKey()).update(value).digest('hex');
}

// Both comparisons below go through timingSafeEqual, which throws on a length
// mismatch — so hash first and compare fixed-length digests. That also stops
// the length of the real password leaking through the comparison.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPassword(candidate) {
  const expected = hostPassword();
  if (expected === null) return false;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return safeEqual(candidate, expected);
}

// Cookie payload is `<expiry-epoch-seconds>.<hmac>`. The expiry is inside the
// signed value, so an expired cookie cannot be revived by editing it — the
// client-side Max-Age is only a housekeeping hint.
function issueToken() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS);
  return `${exp}.${sign(exp)}`;
}

function tokenValid(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/i.test(mac)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  const out = {};
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) return;
    // A value that isn't valid percent-encoding is not one of ours.
    try { out[k] = decodeURIComponent(v); } catch (e) { /* skip it */ }
  });
  return out;
}

// Password and off modes only. In accounts mode a cookie alone proves nothing
// until the database has confirmed its session version, so this is false.
function isHost(req) {
  const mode = authMode();
  if (mode === 'off') return true;
  return mode === 'password' && tokenValid(parseCookies(req)[COOKIE]);
}

// ---------- Accounts mode: the session cookie ----------

// `v1.<hostId>.<sessionVersion>.<expiry>.<hmac>`. Everything before the hmac is
// signed. The key is SESSION_SECRET with no fallback: accountsConfigured()
// already refused to run without it.
function issueAccountToken(host) {
  const exp = Math.floor(Date.now() / 1000) + ACCOUNT_MAX_AGE_SECONDS;
  const payload = `v1.${host.id}.${host.sessionVersion}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

function hmac(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('hex');
}

function accountClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, hostId, version, exp, mac] = parts;
  if (!UUID_RE.test(hostId) || !/^\d{1,9}$/.test(version) || !/^\d{1,12}$/.test(exp)) return null;
  if (!safeEqual(mac, hmac(`v1.${hostId}.${version}.${exp}`))) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  return { hostId, sessionVersion: Number(version) };
}

// Who is asking, as far as the request alone can say:
//   null                       nobody
//   { all: true }              the one host (password and off modes)
//   { hostId, sessionVersion } an account, NOT yet checked against the database
function identify(req) {
  if (authMode() !== 'accounts') return isHost(req) ? { all: true } : null;
  return accountClaims(parseCookies(req)[ACCOUNT_COOKIE]);
}

// ---------- Accounts mode: sign-in requests ----------

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Lowercased and ASCII only, so two spellings can't be two accounts and nothing
// in the address can break out of a mail header. Returns null if it isn't one.
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
function normalizeEmail(input) {
  if (typeof input !== 'string' || input.length > 320) return null;
  const email = input.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function loginEmailsPerHour() {
  const n = Number(process.env.LOGIN_EMAILS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LOGIN_EMAILS_PER_HOUR;
}

// Bound to its request id, so a code is useless under any other request. The
// prefix keeps these apart from session signatures made with the same key.
function codeHash(requestId, code) {
  return hmac(`login-code:${requestId}:${code}`);
}

function newLogin() {
  const requestId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  return {
    requestId,
    token,
    code,
    // A fragment, so it never reaches a server log or a referrer.
    link: `${appOrigin()}/#login-${token}`,
    tokenHash: sha256(token),
    codeHash: codeHash(requestId, code)
  };
}

// What the browser sent to prove itself, hashed for the store, or null if it
// can't be either kind. People type codes with spaces and dashes.
function loginProof(body) {
  if (typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token)) {
    return { tokenHash: sha256(body.token) };
  }
  if (typeof body.requestId !== 'string' || typeof body.code !== 'string') return null;
  const requestId = body.requestId.toLowerCase();
  const code = body.code.replace(/[\s-]/g, '');
  if (!UUID_RE.test(requestId) || !/^\d{8}$/.test(code)) return null;
  return { requestId, codeHash: codeHash(requestId, code) };
}

// ---------- Cross-site requests ----------

// SameSite treats app.<domain> and the apex as one site, so the cookie setting
// alone would let a page on the marketing site write as the host. A browser
// always sends Origin on these methods; a caller without one carries no
// visitor's cookie.
function foreignOrigin(req) {
  if (!/^(POST|PUT|PATCH|DELETE)$/.test(req.method)) return false;
  const origin = req.headers && req.headers.origin;
  if (origin === undefined) return false;
  try {
    const from = new URL(origin);
    return new URL(`${from.protocol}//${req.headers.host}`).host !== from.host || !from.host;
  } catch (e) {
    return true; // "null", or nonsense
  }
}

// HttpOnly so page scripts can't read it; SameSite=Lax so it still rides
// along when a phone opens a #score-<id> link the host texted over. Secure is
// omitted on plain HTTP so the LAN server (and http://localhost) can still
// set it — in the cloud everything is HTTPS, and Vercel terminates TLS
// upstream, so x-forwarded-proto is the honest signal there.
function cookieHeader(name, value, maxAge) {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ].join('; ');
}

function isSecureRequest(req) {
  const fwd = req.headers && req.headers['x-forwarded-proto'];
  if (fwd) return String(fwd).split(',')[0].trim() === 'https';
  return !!(req.socket && req.socket.encrypted);
}

function sendCookie(res, req, name, value, maxAge) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieHeader(name, value, maxAge)}${secure}`);
}

function setSessionCookie(res, req) {
  sendCookie(res, req, COOKIE, issueToken(), MAX_AGE_SECONDS);
}

function setAccountCookie(res, req, host) {
  sendCookie(res, req, ACCOUNT_COOKIE, issueAccountToken(host), ACCOUNT_MAX_AGE_SECONDS);
}

function clearSessionCookie(res, req) {
  sendCookie(res, req, authMode() === 'accounts' ? ACCOUNT_COOKIE : COOKIE, '', 0);
}

module.exports = {
  COOKIE,
  ACCOUNT_COOKIE,
  MAX_CODE_TRIES,
  LOGINS_PER_EMAIL_PER_HOUR,
  authMode,
  authRequired,
  checkPassword,
  isHost,
  identify,
  normalizeEmail,
  loginEmailsPerHour,
  newLogin,
  loginProof,
  foreignOrigin,
  setSessionCookie,
  setAccountCookie,
  clearSessionCookie
};
