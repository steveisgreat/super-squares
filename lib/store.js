// Storage interface contract. Every backend (fs today, Postgres from Phase 2)
// implements these five functions with identical semantics, so callers never
// need to know which one is in use.
//
//   listGames(scope)                         -> Promise<GameSummary[]>
//   getGame(id)                              -> Promise<Game|null>
//   createGame(game, ownerId)                -> Promise<Game>
//   updateGame(id, game, expectedUpdatedAt, { mustExist })
//                                            -> Promise<UpdateResult>
//   deleteGame(id)                           -> Promise<boolean>   // false = not found
//
// `scope` is { all: true } or { ownerId }. Anything else throws, so forgetting
// it can never list everyone's boards.
//
// Host accounts (decision 012) exist only in Postgres. The fs backend accepts
// { all: true } and no owner, and every function below throws there:
//
//   getGameAccess(id, hostId)  -> { exists, ownerId, sessionVersion }
//   getHost(hostId)            -> { email, sessionVersion } | null
//   createLoginRequest({ id, email, tokenHash, codeHash, perEmail, perSite, ref })  // ref: R13, optional
//                              -> boolean   // false = over a limit, nothing stored
//   useLoginToken(tokenHash, consent)   -> Host | null
//   useLoginCode(id, codeHash, maxTries, consent)  -> Host | null
//   revokeSessions(hostId, sessionVersion)  -> boolean
//   getNews(hostId)            -> boolean   // opted in to news about next season (R34)
//   setNews(hostId, on)        -> void
//
// `consent` is { news, termsVersion }, both optional, written with the sign-in (decision 024).
// Host is { id, email, sessionVersion }. Hashes are hex strings. The limits,
// the code tries and "works once" are each decided inside one atomic write.
// The store never decides who may do what: lib/api.js does.
//
// Shared live-score slates (decision 001 section 3). One row per league and ET date.
// `checkedAt` is the throttle, `fetchedAt` the last success; both are ISO strings.
//
//   getLiveSlate(league, etDate)  -> { payload, checkedAt, fetchedAt } | null
//   claimLiveSlate(league, etDate, seenCheckedAt, nowIso)
//                                 -> boolean   // true for exactly one caller
//   saveLiveSlate(league, etDate, payload, fetchedAt)  -> void
//
// claimLiveSlate is the one atomic step: it moves checkedAt to nowIso only if it
// is still `seenCheckedAt` (null = no row yet, so the claim inserts one). Of any
// number of concurrent claimers holding the same seen value, exactly one gets true.
// saveLiveSlate writes the payload of a row its caller claimed; fetchedAt null
// keeps the old one (a failed fetch).
//
// Helpers (decision 025), in both backends. A row is one helper on one board: the host's label, two
// jobs, a one-time code, and once the code is used, one phone's session. `hostVersion` is the
// owner's session version, null in password and off modes. `accounts` says which mode is asking: a
// row made in the other kind of mode never counts. A job ends 180 days after the code was used, or
// 24 hours after a finished board was last saved; both are judged on every read.
//
//   createHelper({ gameId, hostVersion, label, canScore, canSquares, tokenHash, tokenSeconds, max })
//                         -> id | null      // null = the board already has `max` helpers
//   useHelperToken({ tokenHash, sessionHash, accounts })
//                         -> { gameId, label, canScore, canSquares } | null   // works once
//   helperAccess({ gameId, sessionHash, accounts })
//                         -> { id, label, canScore, canSquares } | null
//   listHelpers(gameId, hostVersion)
//                         -> [{ id, label, canScore, canSquares, connected, waiting }], oldest first
//   setHelperJobs({ gameId, id, hostVersion, canScore, canSquares })     -> boolean   // false = no such helper
//   newHelperCode({ gameId, id, hostVersion, tokenHash, tokenSeconds })  -> boolean   // replaces any waiting code
//   removeHelper({ gameId, id })            -> boolean   // the phone and any waiting code
//
// A new code for a connected helper leaves their phone working until the code is used; then the
// new phone replaces it.
//
// Host themes (decision 021), in both backends. `hostKey` is a host id, or 'site' where there is
// one host (password and off modes). Null means nothing chosen. The store does not judge the name.
//
//   getTheme(hostKey)                  -> string | null
//   setTheme(hostKey, theme)           -> void
//   getGameTheme(id, { accounts })     -> { theme: string | null } | null   // null = no such board
//
// getGameTheme reads the theme of the board's owner; without `accounts` it is the 'site' one.
//
// GameSummary is the trimmed shape listGames() returns: id, teamA, teamB,
// league, teamAColor, teamBColor, description, gameDate, kickoffTime,
// status, updatedAt.
//
// ---------------------------------------------------------------------------
// updateGame and optimistic concurrency
// ---------------------------------------------------------------------------
//
// Every client PUTs the whole game document, so without a concurrency check two
// devices editing at once silently overwrite each other. `expectedUpdatedAt` is
// the caller's assertion about what it last saw.
//
// The check and the write are ONE operation. Callers must never read, compare,
// and then write — that is racy the moment more than one process serves
// requests. The fs backend gets this from doing both inside a single
// synchronous run; Postgres expresses it as one conditional statement.
//
// Resolves to a tagged result, never a bare game, so the outcome can never be
// confused with a field that happens to exist on the document:
//
//   { ok: true,  game }  — written. `game` is the stored document, with a
//                          freshly stamped `updatedAt`.
//   { ok: false, game }  — NOT written, because someone else got there first.
//                          `game` is the current stored document, so the caller
//                          can show the user what it lost to.
//
// Three semantics that are easy to get subtly wrong in SQL, and are therefore
// part of the contract rather than an implementation detail:
//
//   1. `expectedUpdatedAt` null/absent means "I am not asserting anything —
//      overwrite unconditionally". It does NOT mean "expect a null column".
//      A naive `WHERE updated_at = $expected` inverts this: SQL null never
//      compares equal, so every such write would falsely report a conflict.
//      Postgres must branch to an unconditional UPDATE instead.
//
//   2. A STORED document with no `updatedAt` (written before the field existed)
//      also skips the check and is overwritten. There is no prior version to
//      compare against, so there is no conflict to detect.
//
//   3. updateGame UPSERTS. Writing an id that does not exist creates it rather
//      than failing, and stamps a fresh `createdAt`. An existing document keeps
//      its original `createdAt`. `{ mustExist: true }` turns the upsert off:
//      an unknown id is not written and resolves to { ok: false, game: null }.
//      Accounts mode always passes it, so a delete racing a save can't bring
//      a board back with no owner.
//
// `createdAt` and `updatedAt` are owned by the store: it stamps them on write
// and callers must not set them by hand.

module.exports = process.env.DATABASE_URL
  ? require('./store-pg.js')
  : require('./store-fs.js');
