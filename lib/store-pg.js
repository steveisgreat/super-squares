// Postgres-backed implementation of the store interface (lib/store.js).
// Whole-document model: `doc` holds the exact same shape store-fs.js writes
// to a JSON file, so no field-by-field mapping is needed. See the top of
// store.js for the full concurrency contract this must honor.
'use strict';

const { neon } = require('@neondatabase/serverless');
const GameLogic = require('../public/compute.js');
const JoinCode = require('./joincode.js');

const sql = neon(process.env.DATABASE_URL);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same auto-cutoff-on-read behavior as store-fs.js's applyAutoCutoff. `ver` is the row's
// updated_at as text, read with the document. The write lands only if the row is still that
// version: otherwise a guest's pick (R28) that landed in between would be erased, and two
// readers at the cutoff would each draw numbers. A loser starts over from the winner's row.
async function applyAutoCutoff(game, ver) {
  const id = game.id;
  for (let attempt = 0; attempt < 5; attempt++) {
    const done = await tryAutoCutoff(game, ver);
    if (done) return game;
    const rows = await sql`select doc, updated_at::text as ver from games where id = ${id}`;
    if (rows.length === 0) return game;
    game = rows[0].doc;
    ver = rows[0].ver;
  }
  return game;
}

// -> true when there was nothing to write or the write landed.
async function tryAutoCutoff(game, ver) {
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
      where id = ${game.id} and updated_at = ${ver}::timestamptz
      returning doc->>'updatedAt' as stamp
    `;
    if (rows.length === 0) return false;
    game.updatedAt = rows[0].stamp;
  }
  return true;
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
      const full = await sql`select doc, updated_at::text as ver from games where id = ${g.id}`;
      if (full.length > 0) g = await applyAutoCutoff(full[0].doc, full[0].ver);
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
  const rows = await sql`select doc, join_code, updated_at::text as ver from games where id = ${s}`;
  if (rows.length === 0) return null;
  return withCode(await applyAutoCutoff(rows[0].doc, rows[0].ver), rows[0].join_code);
}

// The join code (R22) is a column, never inside `doc`. It is attached to what a
// caller gets back and removed before any write.
function withCode(game, code) {
  if (code) game.joinCode = code;
  return game;
}

async function createGame(game, ownerId) {
  const now = new Date().toISOString();
  const doc = { ...game, createdAt: now, updatedAt: now };
  delete doc.joinCode;
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
  delete incoming.joinCode;
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
    returning doc, join_code
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
    returning doc, join_code
  `;

  if (rows.length > 0) {
    return { ok: true, game: withCode(rows[0].doc, rows[0].join_code) };
  }

  // The conditional branch above lost — someone else's write already holds
  // this row's updated_at. Fetch the current document purely to report what
  // the caller lost to; the accept/reject decision itself was already made
  // atomically by the statement above, not by this read.
  const current = await sql`select doc, join_code from games where id = ${id}`;
  // Normally the row is still there — losing the conditional branch means
  // somebody else's write holds it. It can also have been deleted between the
  // two statements, in which case there is no document to show the caller.
  return { ok: false, game: current.length > 0 ? withCode(current[0].doc, current[0].join_code) : null };
}

async function deleteGame(id) {
  const s = String(id).trim();
  if (!ID_RE.test(s)) return false;
  const rows = await sql`delete from games where id = ${s} returning id`;
  return rows.length > 0;
}

// Join codes (R22, decision 016; migrations/004_join_codes.sql). The unique index
// is the arbiter: a collision is a 23505 and costs one more try.
async function getGameIdByJoinCode(code) {
  const c = JoinCode.normalize(code);
  if (!c) return null;
  const rows = await sql`select id from games where join_code = ${c}`;
  return rows.length ? rows[0].id : null;
}

// Idempotent: a board that has a code keeps it. `gen` is for tests.
async function assignJoinCode(id, gen) {
  const s = String(id).trim();
  if (!ID_RE.test(s)) return null;
  const generate = gen || JoinCode.generate;
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = JoinCode.normalize(generate());
    if (!code) continue;
    try {
      const rows = await sql`
        update games set join_code = ${code} where id = ${s} and join_code is null returning join_code
      `;
      if (rows.length) return rows[0].join_code;
    } catch (e) {
      if (e && e.code === '23505') continue;
      throw e;
    }
    // Nothing updated: it already has one, or the board is gone.
    const cur = await sql`select join_code from games where id = ${s}`;
    return cur.length ? cur[0].join_code : null;
  }
  throw new Error('Could not find a free join code');
}

// TV pairings (R23; migrations/005_tv_pairings.sql). Only the sha256 of the token is stored.
// Expiry is judged at read time against `now` (ms, injectable for tests): an unpaired row
// lives 15 minutes from created_at, a paired one 24 hours from paired_at. Expired rows are
// deleted when a new pairing is created. The partial unique index on `code` arbitrates
// collisions; pairing nulls the code, which retires it.
// A storage guard, not a rate limit: low enough to bound the table, high enough that
// flooding it to lock out real TVs costs ~100 requests a second for 15 minutes.
const TV_MAX_WAITING = 100000;
const tvIso = (now) => new Date(now === undefined ? Date.now() : now).toISOString();

// -> the new code, or null when too many pairings are waiting. `gen` is for tests.
async function createTvPairing(tokenHash, gen, now) {
  const n = tvIso(now);
  await sql`
    delete from tv_pairings
    where not ((game_id is null and created_at > ${n}::timestamptz - interval '15 minutes')
            or (game_id is not null and paired_at > ${n}::timestamptz - interval '24 hours'))
  `;
  const waiting = await sql`select count(*)::int as c from tv_pairings where game_id is null`;
  if (waiting[0].c >= TV_MAX_WAITING) return null;
  const generate = gen || JoinCode.generate;
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = JoinCode.normalize(generate());
    if (!code) continue;
    try {
      await sql`insert into tv_pairings (token_hash, code, created_at) values (${tokenHash}, ${code}, ${n}::timestamptz)`;
      return code;
    } catch (e) {
      if (e && e.code === '23505') continue;
      throw e;
    }
  }
  throw new Error('Could not find a free pairing code');
}

// -> { code, gameId } | null (unknown or expired). `code` is null once paired.
async function getTvPairing(tokenHash, now) {
  const n = tvIso(now);
  const rows = await sql`
    select code, game_id from tv_pairings
    where token_hash = ${tokenHash}
      and ((game_id is null and created_at > ${n}::timestamptz - interval '15 minutes')
        or (game_id is not null and paired_at > ${n}::timestamptz - interval '24 hours'))
  `;
  return rows.length ? { code: rows[0].game_id ? null : rows[0].code, gameId: rows[0].game_id } : null;
}

// One conditional statement: an unknown, expired or already-paired code updates nothing.
async function pairTv(code, gameId, ownerId, now) {
  const c = JoinCode.normalize(code);
  if (!c || !ID_RE.test(String(gameId))) return false;
  const n = tvIso(now);
  const rows = await sql`
    update tv_pairings
    set game_id = ${gameId}, owner_id = ${ownerId || null}, code = null, paired_at = ${n}::timestamptz
    where code = ${c} and game_id is null and created_at > ${n}::timestamptz - interval '15 minutes'
    returning token_hash
  `;
  return rows.length > 0;
}

// Moves every live pairing of this owner (null = the auth-off owner) to gameId; a move
// restarts that pairing's 24 hours. -> how many follow now.
async function followTv(ownerId, gameId, now) {
  if (!ID_RE.test(String(gameId))) return 0;
  const n = tvIso(now);
  const rows = await sql`
    update tv_pairings set game_id = ${gameId}, paired_at = ${n}::timestamptz
    where game_id is not null and owner_id is not distinct from ${ownerId || null}::uuid
      and paired_at > ${n}::timestamptz - interval '24 hours'
    returning token_hash
  `;
  return rows.length;
}

async function countTvs(ownerId, now) {
  const n = tvIso(now);
  const rows = await sql`
    select count(*)::int as c from tv_pairings
    where game_id is not null and owner_id is not distinct from ${ownerId || null}::uuid
      and paired_at > ${n}::timestamptz - interval '24 hours'
  `;
  return rows[0].c;
}

// ---------------------------------------------------------------------------
// Scorer-phone hand-off (decision 018; migrations/006_scorer_grants.sql)
// ---------------------------------------------------------------------------

// The per-board lock makes two host devices take turns, so a new code always cancels the
// earlier unused one. Each statement reads a fresh snapshot (READ COMMITTED).
async function createScorerGrant({ gameId, hostVersion, tokenHash, max }, now) {
  const n = tvIso(now);
  const v = hostVersion === undefined ? null : hostVersion;
  const results = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${'scorer_grants:' + gameId}::text))`,
    sql`
      delete from scorer_grants
      where (used_at is null and (game_id = ${gameId}::uuid or created_at <= ${n}::timestamptz - interval '5 minutes'))
         or used_at <= ${n}::timestamptz - interval '24 hours'
    `,
    sql`
      select count(*)::int as c from scorer_grants
      where game_id = ${gameId}::uuid and used_at is not null and host_version is not distinct from ${v}::int
    `,
    sql`
      insert into scorer_grants (game_id, host_version, token_hash, created_at)
      select ${gameId}::uuid, ${v}::int, ${tokenHash}::text, ${n}::timestamptz
      where (select count(*) from scorer_grants
             where game_id = ${gameId}::uuid and used_at is not null
               and host_version is not distinct from ${v}::int) < ${max}::int
      returning id
    `
  ], { isolationLevel: 'ReadCommitted' });
  return results[3].length ? results[2][0].c : null;
}

// One conditional update: of any number of phones holding the same code, one wins.
// Two statements by mode, because password mode runs without migration 002.
async function useScorerToken({ tokenHash, sessionHash, accounts }, now) {
  const n = tvIso(now);
  const rows = accounts ? await sql`
    update scorer_grants s set used_at = ${n}::timestamptz, session_hash = ${sessionHash}::text
    from games g join hosts h on h.id = g.owner_id
    where s.token_hash = ${tokenHash} and s.used_at is null
      and s.created_at > ${n}::timestamptz - interval '5 minutes'
      and g.id = s.game_id and h.session_version = s.host_version
    returning s.game_id
  ` : await sql`
    update scorer_grants set used_at = ${n}::timestamptz, session_hash = ${sessionHash}::text
    where token_hash = ${tokenHash} and used_at is null and host_version is null
      and created_at > ${n}::timestamptz - interval '5 minutes'
    returning game_id
  `;
  return rows.length ? rows[0].game_id : null;
}

async function scorerAllowed({ gameId, sessionHash, accounts }, now) {
  if (!ID_RE.test(String(gameId)) || !sessionHash) return false;
  const n = tvIso(now);
  const rows = accounts ? await sql`
    select 1 from scorer_grants s
    join games g on g.id = s.game_id
    join hosts h on h.id = g.owner_id
    where s.game_id = ${gameId}::uuid and s.session_hash = ${sessionHash}
      and s.used_at > ${n}::timestamptz - interval '24 hours'
      and h.session_version = s.host_version
  ` : await sql`
    select 1 from scorer_grants
    where game_id = ${gameId}::uuid and session_hash = ${sessionHash} and host_version is null
      and used_at > ${n}::timestamptz - interval '24 hours'
  `;
  return rows.length > 0;
}

async function scorerStatus(gameId, hostVersion, now) {
  const n = tvIso(now);
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = await sql`
    select count(*) filter (where used_at is null and created_at > ${n}::timestamptz - interval '5 minutes')::int as w,
           count(*) filter (where used_at > ${n}::timestamptz - interval '24 hours')::int as c
    from scorer_grants
    where game_id = ${gameId}::uuid and host_version is not distinct from ${v}::int
  `;
  return { waiting: rows[0].w > 0, scorers: rows[0].c };
}

async function removeScorers(gameId) {
  await sql`delete from scorer_grants where game_id = ${gameId}::uuid`;
}

// ---------------------------------------------------------------------------
// Host themes (decision 021)
// ---------------------------------------------------------------------------

async function getTheme(hostKey) {
  const rows = await sql`select theme from host_themes where host_key = ${hostKey}`;
  return rows.length ? rows[0].theme : null;
}

async function setTheme(hostKey, theme) {
  await sql`
    insert into host_themes (host_key, theme) values (${hostKey}, ${theme})
    on conflict (host_key) do update set theme = excluded.theme, updated_at = now()
  `;
}

// A board with no owner has no host whose theme it could wear, except where there is one host.
async function getGameTheme(id, opts) {
  if (!ID_RE.test(id)) return null;
  const rows = opts && opts.accounts
    ? await sql`select t.theme from games g left join host_themes t on t.host_key = g.owner_id::text where g.id = ${id}::uuid`
    : await sql`select t.theme from games g left join host_themes t on t.host_key = 'site' where g.id = ${id}::uuid`;
  return rows.length ? { theme: rows[0].theme } : null;
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
  getGameIdByJoinCode, assignJoinCode,
  createTvPairing, getTvPairing, pairTv, followTv, countTvs,
  createScorerGrant, useScorerToken, scorerAllowed, scorerStatus, removeScorers,
  getLiveSlate, claimLiveSlate, saveLiveSlate,
  getTheme, setTheme, getGameTheme,
  getGameAccess, getHost, createLoginRequest, useLoginToken, useLoginCode, revokeSessions
};
