// Postgres-backed implementation of the store interface (lib/store.js).
// Whole-document model: `doc` holds the exact same shape store-fs.js writes
// to a JSON file, so no field-by-field mapping is needed. See the top of
// store.js for the full concurrency contract this must honor.
'use strict';

const { neon } = require('@neondatabase/serverless');
const GameLogic = require('../public/compute.js');

const sql = neon(process.env.DATABASE_URL);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same auto-cutoff-on-read behavior as store-fs.js's applyAutoCutoff, but
// the write-back is an unconditional UPDATE: this is a server-owned
// mutation (the clock passing a deadline), not a client's optimistic-
// concurrency write, so it does not go through the conditional path in
// updateGame.
async function applyAutoCutoff(game) {
  let changed = false;
  if (GameLogic.cutoffPassed(game)) {
    GameLogic.lockGame(game);
    changed = true;
  }
  const statusBefore = game.status;
  GameLogic.syncStatus(game);
  if (game.status !== statusBefore) changed = true;
  if (changed) {
    // The new stamp is computed in SQL from the stored one (see updateGame).
    const now = new Date().toISOString();
    const rows = await sql`
      update games set
        updated_at = greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond'),
        doc = jsonb_set(${JSON.stringify(game)}::jsonb, '{updatedAt}', to_jsonb(to_char(
          greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond')
            at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      where id = ${game.id}
      returning doc->>'updatedAt' as stamp
    `;
    if (rows.length > 0) game.updatedAt = rows[0].stamp;
  }
  return game;
}

// The listing needs eleven small fields, but the cutoff/status pass below has
// to run against a real document. Rather than haul every full `doc` across the
// wire for that — each one carries a 100-entry `squares` array, and a
// simulated game carries a whole `simPlan` as well — the list query strips the
// three bulky keys, and the rare row that actually needs rewriting is re-read
// in full first. Home polls this every 8 seconds, so the trimmed payload is
// the difference between a few KB and a few hundred.
//
// Only keys that `cutoffPassed` and `syncStatus` never look at may be stripped
// here; anything else would make the probe below lie.
const LIST_STRIP = ['squares', 'simPlan', 'players'];

// Would applyAutoCutoff write, if we handed it this document? Runs the same
// two checks without mutating the caller's object — `syncStatus` only ever
// touches `.status`, so a shallow clone is enough to keep the probe pure.
function cutoffOrStatusPending(game) {
  if (GameLogic.cutoffPassed(game)) return true;
  const probe = { ...game };
  GameLogic.syncStatus(probe);
  return probe.status !== game.status;
}

// null means every game. Throws on anything that isn't exactly one of the two
// scopes in the contract, including an ownerId that is missing or malformed.
function scopeOwner(scope) {
  if (scope && scope.all === true && scope.ownerId === undefined) return null;
  if (scope && scope.all === undefined && typeof scope.ownerId === 'string' && ID_RE.test(scope.ownerId)) return scope.ownerId;
  throw new Error('listGames: scope must be { all: true } or { ownerId }');
}

// Two statements, not one with an optional filter: the unscoped one must not
// mention owner_id, so password mode runs before migration 002 is applied.
async function listGames(scope) {
  const ownerId = scopeOwner(scope);
  const rows = ownerId === null
    ? await sql`
      select doc - ${LIST_STRIP}::text[] as doc
      from games
      order by updated_at desc
    `
    : await sql`
      select doc - ${LIST_STRIP}::text[] as doc
      from games
      where owner_id = ${ownerId}
      order by updated_at desc
    `;
  const games = [];
  for (const row of rows) {
    let g = row.doc;
    // Needs a real write — re-read the untrimmed document so the row we save
    // back still has its squares.
    if (cutoffOrStatusPending(g)) {
      const full = await sql`select doc from games where id = ${g.id}`;
      if (full.length > 0) g = await applyAutoCutoff(full[0].doc);
    }
    games.push({
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
    });
  }
  games.sort((a, b) => (b.gameDate || '').localeCompare(a.gameDate || ''));
  return games;
}

async function getGame(id) {
  const s = String(id).trim();
  if (!ID_RE.test(s)) return null;
  const rows = await sql`select doc from games where id = ${s}`;
  if (rows.length === 0) return null;
  return applyAutoCutoff(rows[0].doc);
}

async function createGame(game, ownerId) {
  const now = new Date().toISOString();
  const doc = { ...game, createdAt: now, updatedAt: now };
  if (ownerId !== undefined && ownerId !== null) {
    await sql`
      insert into games (id, doc, updated_at, owner_id)
      values (${doc.id}, ${JSON.stringify(doc)}::jsonb, ${now}::timestamptz, ${ownerId})
    `;
    return doc;
  }
  await sql`
    insert into games (id, doc, updated_at)
    values (${doc.id}, ${JSON.stringify(doc)}::jsonb, ${now}::timestamptz)
  `;
  return doc;
}

// Conditional write — see the concurrency contract in store.js. This is ONE
// statement: an upsert whose UPDATE branch is gated by a WHERE clause, never
// a read followed by a separate write. A null/absent expectedUpdatedAt makes
// the WHERE clause unconditionally true (never a `= null` comparison, which
// SQL would always evaluate false). On conflict, `createdAt` is pulled back
// out of the row already on disk so it survives the update; `updatedAt` is
// always re-stamped.
//
// The new stamp must differ from the stored one, or a save still holding the
// old token would match (issue #3): two writes in one millisecond, or a
// Vercel instance whose clock runs behind, would repeat it. So an update
// stamps greatest(this instance's now, stored + 1 ms), computed in the same
// statement, and writes that value both to updated_at and to doc.updatedAt
// (the client's token), formatted the way toISOString() would.
async function updateGame(id, game, expectedUpdatedAt, opts) {
  const now = new Date().toISOString();
  const incoming = { ...game, id, createdAt: now, updatedAt: now };
  const expected = expectedUpdatedAt || null;

  // mustExist drops the insert branch and nothing else.
  const rows = opts && opts.mustExist ? await sql`
    update games set
      doc = jsonb_set(
        jsonb_set(
          ${JSON.stringify(incoming)}::jsonb,
          '{createdAt}',
          coalesce(doc->'createdAt', ${JSON.stringify(now)}::jsonb)
        ),
        '{updatedAt}',
        to_jsonb(to_char(
          greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond')
            at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ),
      updated_at = greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond')
    where id = ${id}
      and (${expected}::timestamptz is null or updated_at = ${expected}::timestamptz)
    returning doc
  ` : await sql`
    insert into games (id, doc, updated_at)
    values (${id}, ${JSON.stringify(incoming)}::jsonb, ${now}::timestamptz)
    on conflict (id) do update set
      doc = jsonb_set(
        jsonb_set(
          ${JSON.stringify(incoming)}::jsonb,
          '{createdAt}',
          -- jsonb_set is STRICT: a stored document with no createdAt key makes
          -- games.doc->'createdAt' SQL NULL, which turns the whole expression
          -- NULL and trips the column's not-null constraint. Documents written
          -- before these timestamps existed are explicitly in scope (see the
          -- contract in store.js), so fall back to the incoming stamp.
          coalesce(games.doc->'createdAt', ${JSON.stringify(now)}::jsonb)
        ),
        '{updatedAt}',
        to_jsonb(to_char(
          greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond')
            at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ),
      updated_at = greatest(${now}::timestamptz, date_trunc('milliseconds', games.updated_at) + interval '1 millisecond')
    where ${expected}::timestamptz is null
       or games.updated_at = ${expected}::timestamptz
    returning doc
  `;

  if (rows.length > 0) {
    return { ok: true, game: rows[0].doc };
  }

  // The conditional branch above lost — someone else's write already holds
  // this row's updated_at. Fetch the current document purely to report what
  // the caller lost to; the accept/reject decision itself was already made
  // atomically by the statement above, not by this read.
  const current = await sql`select doc from games where id = ${id}`;
  // Normally the row is still there — losing the conditional branch means
  // somebody else's write holds it. It can also have been deleted between the
  // two statements, in which case there is no document to show the caller.
  return { ok: false, game: current.length > 0 ? current[0].doc : null };
}

async function deleteGame(id) {
  const s = String(id).trim();
  if (!ID_RE.test(s)) return false;
  const rows = await sql`delete from games where id = ${s} returning id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Host accounts (decision 012)
// ---------------------------------------------------------------------------

// One row always comes back, so an ended session on an unknown id is still
// seen as an ended session.
async function getGameAccess(id, hostId) {
  const gameId = ID_RE.test(id) ? id : null;
  const rows = await sql`
    select g.id is not null as found,
           g.owner_id,
           (select session_version from hosts where id = ${hostId}) as session_version
    from (select 1) one
    left join games g on g.id = ${gameId}::uuid
  `;
  return {
    exists: rows[0].found,
    ownerId: rows[0].owner_id,
    sessionVersion: rows[0].session_version
  };
}

async function getHost(hostId) {
  const rows = await sql`select email, session_version from hosts where id = ${hostId}`;
  return rows.length ? { email: rows[0].email, sessionVersion: rows[0].session_version } : null;
}

// Counting and inserting must not interleave with another request, or parallel
// requests would each see room under the limit. The transaction-scoped lock
// makes sign-in requests take turns; each statement reads a fresh snapshot
// (READ COMMITTED), so the count sees everything committed before the lock.
// The same transaction clears rows over a day old, so there is no cron.
async function createLoginRequest({ id, email, tokenHash, codeHash, perEmail, perSite }) {
  const results = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext('login_requests'))`,
    sql`delete from login_requests where created_at < now() - interval '24 hours'`,
    sql`
      insert into login_requests (id, email, token_hash, code_hash, expires_at)
      select ${id}::uuid, ${email}::text, decode(${tokenHash}, 'hex'), decode(${codeHash}, 'hex'),
             now() + interval '15 minutes'
      where (select count(*) from login_requests
             where email = ${email}::text and created_at > now() - interval '1 hour') < ${perEmail}::int
        and (select count(*) from login_requests
             where created_at > now() - interval '1 hour') < ${perSite}::int
      returning id
    `
  ], { isolationLevel: 'ReadCommitted' });
  return results[2].length > 0;
}

function hostRow(rows) {
  return rows.length
    ? { id: rows[0].id, email: rows[0].email, sessionVersion: rows[0].session_version }
    : null;
}

// Marking the request used and creating or finding the account are one
// statement, so a link can't be spent twice or spent without signing in.
async function useLoginToken(tokenHash) {
  return hostRow(await sql`
    with used as (
      update login_requests set used_at = now()
      where token_hash = decode(${tokenHash}, 'hex') and used_at is null and expires_at > now()
      returning email
    )
    insert into hosts (email, last_login_at)
    select email, now() from used
    on conflict (email) do update set last_login_at = now()
    returning id, email, session_version
  `);
}

// The try is counted and the code compared in the same UPDATE. Parallel tries
// queue on the row lock and re-check `attempts` against the updated row, so the
// limit holds however many arrive at once.
async function useLoginCode(id, codeHash, maxTries) {
  return hostRow(await sql`
    with tried as (
      update login_requests set
        attempts = attempts + 1,
        used_at = case when code_hash = decode(${codeHash}, 'hex') then now() end
      where id = ${id} and used_at is null and expires_at > now() and attempts < ${maxTries}::int
      returning email, used_at
    )
    insert into hosts (email, last_login_at)
    select email, now() from tried where used_at is not null
    on conflict (email) do update set last_login_at = now()
    returning id, email, session_version
  `);
}

// Only a session that is itself current can end the others.
async function revokeSessions(hostId, sessionVersion) {
  const rows = await sql`
    update hosts set session_version = session_version + 1
    where id = ${hostId} and session_version = ${sessionVersion}::int
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Shared live-score slates (decision 001 section 3; migrations/003_live_slates.sql)
// ---------------------------------------------------------------------------

const ET_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
function checkSlateKey(league, etDate) {
  if (!/^[a-z0-9_-]{1,20}$/i.test(String(league)) || !ET_DATE_RE.test(String(etDate))) {
    throw new Error('live slate: bad league or date');
  }
}
const iso = t => (t === null || t === undefined ? null : new Date(t).toISOString());

async function getLiveSlate(league, etDate) {
  checkSlateKey(league, etDate);
  const rows = await sql`
    select payload, checked_at, fetched_at from live_slates
    where league = ${league} and et_date = ${etDate}::date
  `;
  if (!rows.length) return null;
  return { payload: rows[0].payload, checkedAt: iso(rows[0].checked_at), fetchedAt: iso(rows[0].fetched_at) };
}

// One statement decides the winner. With no row yet the insert wins and a concurrent
// insert hits the conflict; with a row, only the caller whose `seen` still matches
// the column updates it (READ COMMITTED re-checks the WHERE after waiting on a lock).
async function claimLiveSlate(league, etDate, seenCheckedAt, nowIso) {
  checkSlateKey(league, etDate);
  const rows = seenCheckedAt === null || seenCheckedAt === undefined ? await sql`
    insert into live_slates (league, et_date, checked_at)
    values (${league}, ${etDate}::date, ${nowIso}::timestamptz)
    on conflict (league, et_date) do nothing
    returning league
  ` : await sql`
    update live_slates set checked_at = ${nowIso}::timestamptz
    where league = ${league} and et_date = ${etDate}::date
      and checked_at = ${seenCheckedAt}::timestamptz
    returning league
  `;
  return rows.length > 0;
}

async function saveLiveSlate(league, etDate, payload, fetchedAt) {
  checkSlateKey(league, etDate);
  await sql`
    update live_slates set
      payload = ${JSON.stringify(payload)}::jsonb,
      fetched_at = coalesce(${fetchedAt || null}::timestamptz, fetched_at)
    where league = ${league} and et_date = ${etDate}::date
  `;
}

module.exports = {
  listGames, getGame, createGame, updateGame, deleteGame,
  getLiveSlate, claimLiveSlate, saveLiveSlate,
  getGameAccess, getHost, createLoginRequest, useLoginToken, useLoginCode, revokeSessions
};
