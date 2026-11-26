// Postgres-backed implementation of the store interface (lib/store.js).
// Whole-document model: `doc` holds the exact same shape store-fs.js writes
// to a JSON file, so no field-by-field mapping is needed. See the top of
// store.js for the full concurrency contract this must honor.
'use strict';

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const GameLogic = require('../public/compute.js');
const JoinCode = require('./joincode.js');

const sql = neon(process.env.DATABASE_URL);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGES_KEPT = 50;
const CHANGE_TEXT_MAX = 120;

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
    GameLogic.lockGame(game, { pick: (n) => crypto.randomInt(n) }); // the server's draw (decision 026)
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
// Helpers (decision 025; migrations/010_helpers.sql)
// ---------------------------------------------------------------------------
// Accounts mode and the others are separate statements, because password mode runs without
// migration 002 (no hosts table, no games.owner_id).

const helperRow = (r) => ({ label: r.label, canScore: r.can_score, canSquares: r.can_squares });

// The per-board lock makes two host devices take turns, so the count holds. Each statement reads a
// fresh snapshot (READ COMMITTED).
async function createHelper({ gameId, hostVersion, label, canScore, canSquares, tokenHash, tokenSeconds, max }, now) {
  const n = tvIso(now);
  const v = hostVersion === undefined ? null : hostVersion;
  const results = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${'helpers:' + gameId}::text))`,
    sql`
      delete from helpers
      where (game_id = ${gameId}::uuid and host_version is distinct from ${v}::int)
         or (used_at is null and token_expires_at <= ${n}::timestamptz - interval '24 hours')
         or (used_at <= ${n}::timestamptz - interval '180 days'
             and (token_expires_at is null or token_expires_at <= ${n}::timestamptz))
    `,
    sql`
      insert into helpers (game_id, host_version, label, can_score, can_squares, token_hash, token_expires_at, created_at)
      select ${gameId}::uuid, ${v}::int, ${label}::text, ${!!canScore}::boolean, ${!!canSquares}::boolean,
             ${tokenHash}::text, ${n}::timestamptz + ${tokenSeconds}::int * interval '1 second', ${n}::timestamptz
      where (select count(*) from helpers where game_id = ${gameId}::uuid) < ${max}::int
      returning id
    `
  ], { isolationLevel: 'ReadCommitted' });
  return results[2].length ? results[2][0].id : null;
}

// One conditional update that also spends the code: of any number of phones holding it, one wins.
async function useHelperToken({ tokenHash, sessionHash, accounts }, now) {
  if (!tokenHash) return null;
  const n = tvIso(now);
  const rows = accounts ? await sql`
    update helpers p
    set token_hash = null, token_expires_at = null, used_at = ${n}::timestamptz, session_hash = ${sessionHash}::text
    from games g join hosts h on h.id = g.owner_id
    where p.token_hash = ${tokenHash} and p.token_expires_at > ${n}::timestamptz
      and g.id = p.game_id and h.session_version = p.host_version
      and not (coalesce(g.doc->>'status', '') = 'finished' and g.updated_at <= ${n}::timestamptz - interval '24 hours')
    returning p.id, p.game_id, p.label, p.can_score, p.can_squares
  ` : await sql`
    update helpers p
    set token_hash = null, token_expires_at = null, used_at = ${n}::timestamptz, session_hash = ${sessionHash}::text
    from games g
    where p.token_hash = ${tokenHash} and p.token_expires_at > ${n}::timestamptz
      and g.id = p.game_id and p.host_version is null
      and not (coalesce(g.doc->>'status', '') = 'finished' and g.updated_at <= ${n}::timestamptz - interval '24 hours')
    returning p.id, p.game_id, p.label, p.can_score, p.can_squares
  `;
  return rows.length ? Object.assign({ id: rows[0].id, gameId: rows[0].game_id }, helperRow(rows[0])) : null;
}

async function helperAccess({ gameId, sessionHash, accounts }, now) {
  if (!ID_RE.test(String(gameId)) || !sessionHash) return null;
  const n = tvIso(now);
  const rows = accounts ? await sql`
    select p.id, p.label, p.can_score, p.can_squares from helpers p
    join games g on g.id = p.game_id
    join hosts h on h.id = g.owner_id
    where p.game_id = ${gameId}::uuid and p.session_hash = ${sessionHash}
      and p.used_at > ${n}::timestamptz - interval '180 days'
      and h.session_version = p.host_version
      and not (coalesce(g.doc->>'status', '') = 'finished' and g.updated_at <= ${n}::timestamptz - interval '24 hours')
  ` : await sql`
    select p.id, p.label, p.can_score, p.can_squares from helpers p
    join games g on g.id = p.game_id
    where p.game_id = ${gameId}::uuid and p.session_hash = ${sessionHash} and p.host_version is null
      and p.used_at > ${n}::timestamptz - interval '180 days'
      and not (coalesce(g.doc->>'status', '') = 'finished' and g.updated_at <= ${n}::timestamptz - interval '24 hours')
  `;
  return rows.length ? Object.assign({ id: rows[0].id }, helperRow(rows[0])) : null;
}

async function listHelpers(gameId, hostVersion, now) {
  const n = tvIso(now);
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = await sql`
    select p.id, p.label, p.can_score, p.can_squares,
           not (coalesce(g.doc->>'status', '') = 'finished' and g.updated_at <= ${n}::timestamptz - interval '24 hours') as open,
           (p.session_hash is not null and p.used_at > ${n}::timestamptz - interval '180 days') as connected,
           (p.token_hash is not null and p.token_expires_at > ${n}::timestamptz) as waiting
    from helpers p join games g on g.id = p.game_id
    where p.game_id = ${gameId}::uuid and p.host_version is not distinct from ${v}::int
    order by p.created_at, p.id
  `;
  return rows.map(r => Object.assign({ id: r.id }, helperRow(r), {
    connected: r.open && r.connected, waiting: r.open && r.waiting
  }));
}

async function setHelperJobs({ gameId, id, hostVersion, canScore, canSquares }) {
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = await sql`
    update helpers set can_score = ${!!canScore}::boolean, can_squares = ${!!canSquares}::boolean
    where id = ${id}::uuid and game_id = ${gameId}::uuid and host_version is not distinct from ${v}::int
    returning id
  `;
  return rows.length > 0;
}

async function newHelperCode({ gameId, id, hostVersion, tokenHash, tokenSeconds }, now) {
  const n = tvIso(now);
  const v = hostVersion === undefined ? null : hostVersion;
  const rows = await sql`
    update helpers set token_hash = ${tokenHash}::text,
                       token_expires_at = ${n}::timestamptz + ${tokenSeconds}::int * interval '1 second'
    where id = ${id}::uuid and game_id = ${gameId}::uuid and host_version is not distinct from ${v}::int
    returning id
  `;
  return rows.length > 0;
}

async function removeHelper({ gameId, id }) {
  const rows = await sql`delete from helpers where id = ${id}::uuid and game_id = ${gameId}::uuid returning id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Recent changes (R39, decision 025; migrations/011_board_changes.sql)
// ---------------------------------------------------------------------------

const noTable = (e) => !!e && e.code === '42P01'; // migration 011 is not applied

// The insert and the trim go in one round trip. Two writers at once can leave a row or two over
// until the next write; listChanges never returns more than 50.
async function logChange({ gameId, helperId, label, text }, now) {
  try {
    await sql.transaction([
      sql`
        insert into board_changes (game_id, at, helper_id, label, text)
        values (${gameId}::uuid, ${tvIso(now)}::timestamptz, ${helperId || null}::uuid, ${label || null}::text,
                ${Array.from(String(text)).slice(0, CHANGE_TEXT_MAX).join('')}::text)
      `,
      sql`
        delete from board_changes where id in (
          select id from board_changes where game_id = ${gameId}::uuid
          order by at desc, id desc offset ${CHANGES_KEPT}::int
        )
      `
    ]);
  } catch (e) {
    if (!noTable(e)) console.error(`Change log write failed: ${e.message}`);
  }
}

async function listChanges(gameId) {
  if (!ID_RE.test(String(gameId))) return [];
  let rows;
  try {
    rows = await sql`
      select id, at, helper_id, label, text from board_changes
      where game_id = ${gameId}::uuid order by at desc, id desc limit ${CHANGES_KEPT}::int
    `;
  } catch (e) {
    if (!noTable(e)) throw e;
    return [];
  }
  return rows.map(r => ({ id: String(r.id), at: new Date(r.at).toISOString(), helperId: r.helper_id, label: r.label, text: r.text }));
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
// One cheap query, for the status check only (GET /api/health?db=1). Wakes a suspended compute.
async function ping() {
  await sql`select 1`;
}

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
async function createLoginRequest({ id, email, tokenHash, codeHash, perEmail, perSite, ref }) {
  const results = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext('login_requests'))`,
    sql`delete from login_requests where created_at < now() - interval '24 hours'`,
    sql`
      insert into login_requests (id, email, token_hash, code_hash, expires_at, ref)
      select ${id}::uuid, ${email}::text, decode(${tokenHash}, 'hex'), decode(${codeHash}, 'hex'),
             now() + interval '15 minutes', ${ref || null}::text
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

// What a host agreed to as they signed in (decision 024), recorded by the statement that signs
// them in. An unticked box changes nothing: it never turns news off, and a host already on the list
// keeps their first date. The terms date moves only when the version does.
function saveConsent(consent) {
  const news = !!(consent && consent.news);
  const terms = (consent && consent.termsVersion) || null;
  return {
    values: sql`case when ${news}::boolean then now() end, ${terms}::text, case when ${terms}::text is not null then now() end`,
    onConflict: sql`
      on conflict (email) do update set
        last_login_at = now(),
        news_opt_in_at = coalesce(hosts.news_opt_in_at, excluded.news_opt_in_at),
        terms_version = coalesce(excluded.terms_version, hosts.terms_version),
        terms_accepted_at = case
          when excluded.terms_version is null or excluded.terms_version is not distinct from hosts.terms_version
          then hosts.terms_accepted_at else excluded.terms_accepted_at end`
  };
}

// Marking the request used and creating or finding the account are one
// statement, so a link can't be spent twice or spent without signing in.
async function useLoginToken(tokenHash, consent) {
  const save = saveConsent(consent);
  return hostRow(await sql`
    with used as (
      update login_requests set used_at = now()
      where token_hash = decode(${tokenHash}, 'hex') and used_at is null and expires_at > now()
      returning email, ref
    )
    insert into hosts (email, last_login_at, referred_by, news_opt_in_at, terms_version, terms_accepted_at)
    select email, now(), ref, ${save.values} from used
    ${save.onConflict}
    returning id, email, session_version
  `);
}

// The try is counted and the code compared in the same UPDATE. Parallel tries
// queue on the row lock and re-check `attempts` against the updated row, so the
// limit holds however many arrive at once.
async function useLoginCode(id, codeHash, maxTries, consent) {
  const save = saveConsent(consent);
  return hostRow(await sql`
    with tried as (
      update login_requests set
        attempts = attempts + 1,
        used_at = case when code_hash = decode(${codeHash}, 'hex') then now() end
      where id = ${id} and used_at is null and expires_at > now() and attempts < ${maxTries}::int
      returning email, ref, used_at
    )
    insert into hosts (email, last_login_at, referred_by, news_opt_in_at, terms_version, terms_accepted_at)
    select email, now(), ref, ${save.values} from tried where used_at is not null
    ${save.onConflict}
    returning id, email, session_version
  `);
}

// News about next season (R34). Off forgets the date; on keeps the first one.
async function getNews(hostId) {
  const rows = await sql`select news_opt_in_at is not null as opted_in from hosts where id = ${hostId}`;
  return rows.length > 0 && rows[0].opted_in;
}

async function setNews(hostId, on) {
  await sql`
    update hosts set news_opt_in_at = case when ${on}::boolean then coalesce(news_opt_in_at, now()) end
    where id = ${hostId}
  `;
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

// ---------------------------------------------------------------------------
// Admin usage page (R45a, decision 027; migrations/012_usage_counters.sql)
// ---------------------------------------------------------------------------

// One upsert per outside call. The same statement keeps the busiest minute of the (UTC) day. Never
// throws: a lost count must not fail the call it counts.
async function bumpUsage(key, opts) {
  const o = opts || {};
  const at = new Date(o.now === undefined ? Date.now() : o.now);
  const day = at.toISOString().slice(0, 10);
  const minute = new Date(Math.floor(at.getTime() / 60000) * 60000).toISOString();
  const failed = o.failed ? 1 : 0;
  try {
    await sql`
      insert into usage_counters as u (day, key, calls, failed, minute, minute_calls, peak_minute, last_at)
      values (${day}::date, ${String(key).slice(0, 40)}, 1, ${failed}::int, ${minute}::timestamptz, 1, 1, ${at.toISOString()}::timestamptz)
      on conflict (day, key) do update set
        calls = u.calls + 1,
        failed = u.failed + excluded.failed,
        -- A call from an older minute that commits late adds to the day but leaves the minute alone.
        minute_calls = case when u.minute = excluded.minute then u.minute_calls + 1
                            when u.minute > excluded.minute then u.minute_calls else 1 end,
        peak_minute = greatest(u.peak_minute, case when u.minute = excluded.minute then u.minute_calls + 1 else 1 end),
        minute = greatest(u.minute, excluded.minute),
        last_at = greatest(u.last_at, excluded.last_at)
    `;
  } catch (e) {
    if (!noTable(e)) console.error(`Usage count failed: ${e.message}`);
  }
}

// -> [{ day, key, calls, failed, peakMinute, lastAt }] from `sinceDay` (YYYY-MM-DD) on.
async function listUsage(sinceDay) {
  try {
    const rows = await sql`
      select day::text as day, key, calls, failed, peak_minute, last_at from usage_counters
      where day >= ${sinceDay}::date order by day, key
    `;
    return rows.map(r => ({ day: r.day, key: r.key, calls: r.calls, failed: r.failed, peakMinute: r.peak_minute,
      lastAt: r.last_at ? new Date(r.last_at).toISOString() : null }));
  } catch (e) {
    if (!noTable(e)) throw e;
    return [];
  }
}

// What the admin page is built from (lib/admin-stats.js does the sums): small facts per board made
// since `since`, never a whole document; every host with their all-time board counts; and what is
// true right now. `etToday` is the date a Live board plays today.
async function adminFacts({ since, now, etToday }) {
  const n = tvIso(now);
  const [boards, hosts, live, tvs, helpers] = await Promise.all([
    sql`
      select g.id::text as id, g.owner_id::text as owner_id, g.doc->>'createdAt' as created_at,
        g.doc->>'status' as status, g.doc->>'league' as league, g.doc->>'gameDate' as game_date,
        g.doc->>'teamA' as team_a, g.doc->>'teamB' as team_b, g.doc->>'scoring' as scoring,
        (g.doc->>'simulation') = 'true' as simulation, g.doc->>'pickMode' as pick_mode,
        (g.doc#>>'{guestPick,on}') = 'true' as guest_pick,
        (select count(*) from jsonb_array_elements(case when jsonb_typeof(g.doc->'squares') = 'array' then g.doc->'squares' else '[]'::jsonb end) s
          where jsonb_typeof(s) = 'object')::int as sold,
        array(select distinct lower(btrim(s->>'name')) from jsonb_array_elements(case when jsonb_typeof(g.doc->'squares') = 'array' then g.doc->'squares' else '[]'::jsonb end) s
          where jsonb_typeof(s) = 'object' and s->>'name' is not null) as names,
        (select count(distinct p.value->>'g') from jsonb_each(case when jsonb_typeof(g.doc->'players') = 'object' then g.doc->'players' else '{}'::jsonb end) p
          where jsonb_typeof(p.value) = 'object' and p.value->>'g' is not null)::int as phones
      from games g
      where g.doc->>'createdAt' >= ${since}
    `,
    sql`
      select h.id::text as id, h.email, h.created_at, h.last_login_at, h.referred_by,
        h.news_opt_in_at is not null as news, h.terms_version,
        count(g.id)::int as boards,
        count(g.id) filter (where g.doc->>'status' in ('started', 'finished'))::int as locked,
        count(g.id) filter (where g.doc->>'status' = 'finished')::int as finished
      from hosts h left join games g on g.owner_id = h.id
      group by h.id
    `,
    sql`select count(*)::int as n from games where doc->>'status' = 'started' and doc->>'gameDate' = ${etToday}`,
    sql`
      select game_id from tv_pairings
      where game_id is not null and paired_at > ${n}::timestamptz - interval '24 hours'
    `,
    sql`select distinct game_id::text as game_id from helpers`.catch(e => { if (!noTable(e)) throw e; return []; })
  ]);
  return {
    boards: boards.map(r => ({
      id: r.id, ownerId: r.owner_id, createdAt: r.created_at, status: r.status, league: r.league,
      gameDate: r.game_date, teamA: r.team_a, teamB: r.team_b,
      scoring: GameLogic.scoringMode({ scoring: r.scoring || undefined, simulation: r.simulation }),
      pickMode: r.pick_mode, guestPick: r.guest_pick, sold: r.sold, names: r.names || [], phones: r.phones
    })),
    hosts: hosts.map(r => ({
      id: r.id, email: r.email, createdAt: new Date(r.created_at).toISOString(),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
      referredBy: r.referred_by, news: r.news, termsVersion: r.terms_version,
      boards: r.boards, locked: r.locked, finished: r.finished
    })),
    liveNow: live[0].n,
    tvsPaired: tvs.length,
    tvBoards: tvs.map(r => String(r.game_id).toLowerCase()),
    helperBoards: helpers.map(r => String(r.game_id).toLowerCase())
  };
}

async function getHostEmail(hostId) {
  if (!ID_RE.test(String(hostId))) return null;
  const rows = await sql`select email from hosts where id = ${hostId}::uuid`;
  return rows.length ? rows[0].email : null;
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
  getGameAccess, getHost, createLoginRequest, useLoginToken, useLoginCode, revokeSessions,
  getNews, setNews,
  bumpUsage, listUsage, adminFacts, getHostEmail
};
