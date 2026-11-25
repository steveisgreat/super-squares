// Application core: the server API, the router, and the interval registry.
// Everything hangs off a single global `SBS` namespace — the app is loaded as
// plain <script> tags in dependency order (see index.html), no bundler.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};

  SBS.appEl = document.getElementById('app');
  SBS.screens = {}; // filled in by the screens-*.js files

  // ---------- Board copies ----------
  // A poll reads the edge's shared copy of a board, up to about 5 s old (decision 023). A screen
  // that has just been handed something newer (its own save, say) must not be put back by it, so
  // the newest version this tab has seen of each board is remembered for a short while. Past that
  // an older board is real (the database was restored) and is shown.
  const SEEN_MS = 12000;
  const seen = new Map(); // board id -> { updatedAt, asOf, at }

  // When the merged score was read: it moves without updatedAt.
  function asOf(g) {
    if (g.liveFeed) return Date.parse(g.liveFeed.fetchedAt);
    return g.liveScore && g.liveScore.simulation ? Date.parse(g.liveScore.updatedAt) : NaN;
  }

  function seenNewer(g) {
    const s = seen.get(String(g.id).toLowerCase());
    if (!s || Date.now() - s.at >= SEEN_MS) return false;
    const u = Date.parse(g.updatedAt);
    if (u !== s.updatedAt) return u < s.updatedAt; // NaN compares false: never called old
    return asOf(g) < s.asOf;
  }

  function noteBoard(g) {
    if (!g || !g.id || !Array.isArray(g.squares) || seenNewer(g)) return;
    seen.set(String(g.id).toLowerCase(), { updatedAt: Date.parse(g.updatedAt), asOf: asOf(g), at: Date.now() });
  }

  // What a poll compares to decide whether to redraw. A Live or Simulation score moves without a
  // save, so updatedAt alone would miss it.
  SBS.boardKey = function (g) {
    const l = g.liveScore || {};
    return JSON.stringify([g.updatedAt, g.status, l.a, l.b, l.period, l.clock, l.state, l.statusName,
      g.liveFeed ? g.liveFeed.available : null]);
  };

  // Merge a polled board into the one on screen. The fields a board can lose go when they are gone.
  SBS.takeBoard = function (game, fresh) {
    ['liveOverride', 'liveFeed', 'liveScore'].forEach(k => { if (!(k in fresh)) delete game[k]; });
    return Object.assign(game, fresh);
  };

  // ---------- API ----------
  async function rawRequest(path, opts) {
    let res;
    try {
      res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
    } catch (e) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    noteBoard(data);
    if (data) noteBoard(data.game);
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && data && data.authRequired) err.authRequired = true;
      // Signed in, but not allowed (someone else's board). Signing in again
      // would not help, so this never opens the prompt.
      if (res.status === 403) err.forbidden = true;
      if (res.status === 409 && data) {
        if (data.conflict) err.conflict = true;
        // A guest's refused pick carries the board as it is now and which squares were taken.
        if (data.game && data.game.squares) err.game = data.game;
        if (data.taken) err.taken = data.taken;
      }
      throw err;
    }
    return data;
  }

  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // ---------- Host sign-in ----------
  // In the cloud, managing games needs the host password; reading one game by
  // its id (the player view, the TV grid) never does — see lib/auth.js for why
  // the id alone can't gate a write.
  //
  // Only ever one prompt on screen at a time: several screens poll at once, so
  // a session expiring mid-game would otherwise stack a modal per in-flight
  // request.
  let signInPending = null;

  async function passwordSignIn(message) {
    let msg = message;
    // Loops so a typo costs one more try, not the whole action.
    for (;;) {
      const password = await SBS.ui.showPasswordPrompt(msg);
      // Dismissing is a real answer ("I'm just watching"), not an error.
      if (password === null) return false;
      try {
        await rawRequest('/api/session', json('POST', { password }));
        return true;
      } catch (e) {
        if (e.status !== 401) {
          await SBS.ui.showAlert('Could not sign in: ' + e.message);
          return false;
        }
        msg = 'That password is not right. Try again?';
      }
    }
  }

  // Which prompt to open depends on how the server signs hosts in, so ask it
  // first (cheap when signed out: no database). The guard covers this lookup.
  function promptSignIn(message) {
    if (signInPending) return signInPending;
    signInPending = (async () => {
      let session;
      try {
        session = await rawRequest('/api/session');
      } catch (e) {
        await SBS.ui.showAlert('Could not sign in: ' + e.message);
        return false;
      }
      // Signed in from another tab since the 401.
      if (session && session.host) return true;
      if (session && session.mode === 'accounts') return SBS.ui.showEmailPrompt();
      return passwordSignIn(message);
    })().finally(() => { signInPending = null; });
    return signInPending;
  }

  // A 401 means this device isn't signed in as the host — prompt once, then
  // replay the request, so every existing call site keeps its shape. Callers
  // that must stay silent (a background poll, a TV with no keyboard) pass
  // { prompt: false } and handle the 401 themselves.
  async function request(path, opts, o) {
    try {
      return await rawRequest(path, opts);
    } catch (e) {
      if (!e.authRequired || (o && o.prompt === false)) throw e;
      const signedIn = await promptSignIn();
      if (!signedIn) throw e;
      return rawRequest(path, opts);
    }
  }

  function forgetHostTheme() {
    if (window.SBSTheme) window.SBSTheme.forgetHost();
  }

  SBS.api = {
    getGames: (o) => request('/api/games', null, o),
    getSession: () => rawRequest('/api/session'),
    signIn: (message) => promptSignIn(message),
    // Signing out also makes this device forget the host's theme (R33).
    signOut: () => rawRequest('/api/session', { method: 'DELETE' }).then((r) => { forgetHostTheme(); return r; }),
    // The host's color theme (R33). getGameTheme is raw on purpose: the board id is all it needs,
    // so it never opens the sign-in prompt.
    getTheme: (o) => request('/api/theme', null, o),
    setTheme: (theme) => request('/api/theme', json('PUT', { theme })),
    getGameTheme: (id) => rawRequest(`/api/game/${id}/theme`),
    // Account sign-in. Raw on purpose: a 401 here must never open the prompt.
    requestLoginCode: (email) => rawRequest('/api/login', json('POST', { email, ref: SBS.referral.get() })),
    verifyLogin: (body) => rawRequest('/api/login/verify', json('POST', body)),
    // News about next season (R34): the signed-in host's own choice. Raw on purpose: a prompt here
    // could sign in someone else and replay the choice on their account.
    getNews: () => rawRequest('/api/news'),
    setNews: (news) => rawRequest('/api/news', json('PUT', { news })),
    revokeAllSessions: () => rawRequest('/api/session/revoke-all', { method: 'POST' }).then((r) => { forgetHostTheme(); return r; }),
    // The board as it is now, straight from the server: for opening a board, acting on it, or
    // recovering from a refused save.
    getGame: (id) => request(`/api/game/${id}?fresh=1`),
    // The edge's copy, for screens that poll. Null when this tab already holds something newer;
    // with { must: true } (a first load) it asks the server instead.
    pollGame: async (id, o) => {
      const g = await request(`/api/game/${id}`);
      if (!seenNewer(g)) return g;
      return o && o.must ? SBS.api.getGame(id) : null;
    },
    getJoin: (code) => rawRequest(`/api/join/${encodeURIComponent(code)}`),
    // TV pairing (R23). The TV's calls are raw: it has no host session and must never prompt.
    createTv: () => rawRequest('/api/tv', { method: 'POST' }),
    getTv: (token) => rawRequest(`/api/tv/${encodeURIComponent(token)}`),
    getMyTvs: () => request('/api/tv/mine'),
    pairTv: (code, gameId) => request('/api/tv/pair', json('POST', { code, gameId })),
    followTv: (gameId, o) => request('/api/tv/follow', json('POST', { gameId }), o),
    createGame: (game) => request('/api/game', json('POST', game)),
    saveGame: (game) => request(`/api/game/${game.id}`, json('PUT', game)),
    patchScore: (id, op, o) => request(`/api/game/${id}/score`, json('PATCH', op), o),
    // Squares manager (R38). Raw: a helper's phone must never be asked to sign in as the host.
    patchSquares: (id, op) => rawRequest(`/api/game/${id}/squares`, json('PATCH', op)),
    // Helpers (R37). The phone's calls are raw: it has no host session.
    getHelpers: (id, o) => request(`/api/game/${id}/helpers`, null, o),
    addHelper: (id, body) => request(`/api/game/${id}/helpers`, json('POST', body)),
    setHelperJobs: (id, helperId, jobs) => request(`/api/game/${id}/helpers/${helperId}`, json('PATCH', jobs)),
    newHelperCode: (id, helperId, link) => request(`/api/game/${id}/helpers/${helperId}/code`, json('POST', { link })),
    removeHelper: (id, helperId) => request(`/api/game/${id}/helpers/${helperId}`, { method: 'DELETE' }),
    useHelperCode: (token) => rawRequest('/api/helper', json('POST', { token })),
    getRole: (id) => rawRequest(`/api/game/${id}/role`),
    patchPayout: (id, op) => request(`/api/game/${id}/payout`, json('PATCH', op)),
    // Guest picks (R28). Raw on purpose: a 401 here means "no cookie kept" and must never
    // open the host sign-in prompt, in any auth mode.
    guestStart: (id) => rawRequest(`/api/game/${id}/guest`, { method: 'POST' }),
    guestOp: (id, op) => rawRequest(`/api/game/${id}/guest`, json('PATCH', op)),
    deleteGame: (id) => request(`/api/game/${id}`, { method: 'DELETE' }),
    getTodaysGames: (date, league) => request(`/api/todays-games?${new URLSearchParams({ date: date || '', league: league || '' })}`)
  };

  // The host's screen for a game: the board once it has started.
  SBS.openGame = function (game) {
    SBS.go({ screen: (game.status === 'started' || game.status === 'finished') ? 'board' : 'picking', game });
  };

  // Another device saved between our last load and this save. Rather than
  // clobber their changes (the server refuses that now), take theirs and
  // re-render so the host can see the real state.
  SBS.handleConflict = async function (e, id) {
    if (!e || !e.conflict) return false;
    await SBS.ui.showAlert('This game was just changed on another device, so your last change was not saved. Loading the latest version…');
    try {
      const fresh = e.game && e.game.squares ? e.game : await SBS.api.getGame(id);
      SBS.openGame(fresh);
    } catch (err) {
      SBS.go({ screen: 'home' });
    }
    return true;
  };

  // Save one host change onto a board that guests may be changing (decision 019 section 6).
  // `change(doc)` edits a copy of the board and returns a string to refuse (a rule it checks
  // again on every document, such as "a square was just taken"). On a 409 the same change is
  // applied to the newer board from the error and saved again, up to 3 more times. Resolves
  // { game } on success or { refused, game } (game = the board the refusal was judged on).
  // Anything else rethrows, and so does a lost race when the board was picking and no longer
  // is, so the caller's handleConflict runs as it always did.
  SBS.saveWith = async function (game, change) {
    const clone = (d) => JSON.parse(JSON.stringify(d));
    let base = clone(game);
    for (let attempt = 0; ; attempt++) {
      const work = clone(base);
      const refused = change(work);
      if (typeof refused === 'string' && refused) return { refused, game: base };
      try {
        return { game: await SBS.api.saveGame(work) };
      } catch (e) {
        if (!e || !e.conflict || attempt >= 3) throw e;
        let fresh = e.game && e.game.squares ? e.game : null;
        if (!fresh) {
          try { fresh = await SBS.api.getGame(game.id); } catch (err) { throw e; }
        }
        if (game.status === 'picking' && fresh.status !== 'picking') {
          e.game = fresh;
          throw e;
        }
        base = clone(fresh);
      }
    }
  };

  // 403: signed in, but the board is someone else's. Tell the host once, say
  // the change was not saved, and hand back the server's copy so the caller can
  // drop its unsaved edit. Returns null when `e` is not a 403, else
  // { fresh } (fresh is null if the reload failed too).
  SBS.handleForbidden = async function (e, id) {
    if (!e || !e.forbidden) return null;
    await SBS.ui.showAlert(e.message + ' Your change was not saved.');
    let fresh = null;
    try { fresh = await SBS.api.getGame(id); } catch (err) { /* keep what is on screen */ }
    return { fresh };
  };

  // ---------- Router ----------
  let route = { screen: 'home' };

  SBS.getRoute = () => route;
  SBS.currentScreen = () => route.screen;

  SBS.go = function (newRoute) {
    route = newRoute;
    SBS.render();
    window.scrollTo(0, 0);
  };

  // ---------- Theme (R33) ----------
  // The host's theme, one per host. The screens that show one board by id to anyone (the TV, Party
  // View, Player View) wear that board's host's theme, cached per board for this
  // tab and asked of the server once per id per page load; everything else wears this device's
  // host theme. Nothing here polls, and a failed lookup is silent.
  const BOARD_THEME_SCREENS = { tv: true, mirror: true, player: true };
  const themeAsked = new Set();
  const boardThemeKey = (id) => 'sbs-theme-' + String(id).toLowerCase();

  function applyRouteTheme() {
    const T = window.SBSTheme;
    if (!T) return;
    if (!BOARD_THEME_SCREENS[route.screen] || !route.id) { T.apply(T.host()); return; }
    const id = route.id;
    let cached = null;
    try { cached = window.sessionStorage.getItem(boardThemeKey(id)); } catch (e) { /* no cache */ }
    T.apply(T.known(cached) ? cached : T.host());
    if (themeAsked.has(id)) return;
    themeAsked.add(id);
    SBS.api.getGameTheme(id).then((r) => {
      if (!r || !T.known(r.theme)) return;
      try { window.sessionStorage.setItem(boardThemeKey(id), r.theme); } catch (e) { /* no cache */ }
      // Only while that board is still the one on screen. Colors alone: drawing the screen again could
      // throw away a score or a name being typed.
      if (BOARD_THEME_SCREENS[route.screen] && route.id === id) T.apply(r.theme);
    }).catch(() => { /* the screen keeps the theme it has */ });
  }

  SBS.render = function () {
    clearManagedTimers();
    runCleanups();
    applyRouteTheme();
    const s = SBS.screens;
    if (route.screen === 'home') return s.home();
    if (route.screen === 'setup') return s.setup();
    if (route.screen === 'theme') return s.theme();
    if (route.screen === 'editGame') return s.editGame(route.game);
    if (route.screen === 'picking') return s.picking(route.game);
    if (route.screen === 'board') return s.board(route.game);
    if (route.screen === 'tv') return s.tv(route.id, route.paired, route.from);
    if (route.screen === 'mirror') return s.mirror(route.id, route.from);
    if (route.screen === 'tv-pair') return s.tvPair();
    if (route.screen === 'scoreLink') return s.scoreLink(route.id);
    if (route.screen === 'player') return s.player(route.id, route);
    if (route.screen === 'join') return s.join(route.code);
    if (route.screen === 'login') return s.login(route.token);
    if (route.screen === 'helper') return s.helper(route.token, route.old);
  };

  // Deep links, so a TV or a phone can be pointed straight at the view it needs.
  const ID_RE = '[0-9a-f-]{36}';

  // Referral (R13): "Host your own board" opens /?ref=<join code>. The code is kept in this
  // browser (localStorage, since the emailed link may open in another tab) and sent with the
  // next sign-in request. The server ignores it unless the account is new.
  const REF_KEY = 'sbs-ref';
  const REF_RE = /^[2-9A-HJKMNP-Z]{6}$/;
  SBS.referral = {
    get() {
      try { return window.localStorage.getItem(REF_KEY) || undefined; } catch (e) { return undefined; }
    },
    // Reads ?ref= from the address bar and drops it from the URL.
    capture() {
      let ref;
      try { ref = new URLSearchParams(window.location.search).get('ref'); } catch (e) { return; }
      if (ref === null) return;
      ref = ref.trim().toUpperCase();
      if (REF_RE.test(ref)) { try { window.localStorage.setItem(REF_KEY, ref); } catch (e) { /* optional */ } }
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('ref');
        window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
      } catch (e) { /* the parameter just stays in the address bar */ }
    },
    url(code) { return `${window.location.origin}/?ref=${encodeURIComponent(code)}`; }
  };

  SBS.parseInitialRoute = function () {
    SBS.referral.capture();
    const hash = window.location.hash || '';
    // /<join code>: the guest link (R22). The server serves this same page for
    // it; the code is resolved to a board id, then the player view opens.
    // /tv: a TV asking to be paired with a board (R23).
    if (/^\/tv\/?$/i.test(window.location.pathname) && !hash) return { screen: 'tv-pair' };
    const joinPath = window.location.pathname.match(/^\/([2-9A-HJKMNP-Za-hjkmnp-z]{6})\/?$/);
    if (joinPath && !hash) return { screen: 'join', code: joinPath[1].toUpperCase() };
    const tv = hash.match(new RegExp(`^#tv-(${ID_RE})$`, 'i'));
    if (tv) return { screen: 'tv', id: tv[1] };
    const mirror = hash.match(new RegExp(`^#mirror-(${ID_RE})$`, 'i'));
    if (mirror) return { screen: 'mirror', id: mirror[1] };
    // Score entry lived here before R37; links people kept still open something (screen-helpers.js).
    const score = hash.match(new RegExp(`^#score-(${ID_RE})(?:-(?:home|board))?$`, 'i'));
    if (score) return { screen: 'scoreLink', id: score[1].toLowerCase() };
    // Player companion view: what a grid player sees after scanning the QR
    // code printed/shown at the party — their squares, quarter winners, and
    // a live "how am I doing" readout. A helper's jobs are tabs on it (see screen-player.js).
    const player = hash.match(new RegExp(`^#player-(${ID_RE})$`, 'i'));
    if (player) return { screen: 'player', id: player[1] };
    // Emailed sign-in link. The token is 43 URL-safe characters; anything else
    // still gets the login screen, in its "not valid" state.
    if (/^#login-/i.test(hash)) {
      const m = hash.match(/^#login-([A-Za-z0-9_-]{43})$/);
      return { screen: 'login', token: m ? m[1] : null };
    }
    // The one-time code a host gives a helper's phone (R37), same shape. #handoff- is its
    // predecessor (R24), which no longer works.
    if (/^#helper-/i.test(hash)) {
      const m = hash.match(/^#helper-([A-Za-z0-9_-]{43})$/);
      return { screen: 'helper', token: m ? m[1] : null };
    }
    if (/^#handoff-/i.test(hash)) return { screen: 'helper', token: null, old: true };
    return { screen: 'home' };
  };

  // Pasting a sign-in link into a tab that is already open only changes the
  // hash. Other deep links are read at load, as before.
  window.addEventListener('hashchange', () => {
    if (!/^#(login|helper|handoff)-/i.test(window.location.hash || '')) return;
    // The prompt asking for this very link would otherwise cover the page.
    SBS.ui.closeEmailPrompt();
    SBS.go(SBS.parseInitialRoute());
  });

  // ---------- Timers ----------
  // Screens used to leave their intervals running after a re-render; on the
  // picking screen that meant a fresh auto-cutoff watcher per claim, all firing
  // at once. Every interval registers here and is cleared on each render.
  let activeTimers = [];

  function clearManagedTimers() {
    activeTimers.forEach(clearInterval);
    activeTimers = [];
  }

  SBS.setManagedInterval = function (fn, ms) {
    const t = setInterval(fn, ms);
    activeTimers.push(t);
    return t;
  };
  SBS.clearManagedTimers = clearManagedTimers;

  // Same idea for anything else a screen leaves behind — body classes, document
  // listeners. Registered callbacks run once, on the next render.
  let cleanups = [];

  function runCleanups() {
    const pending = cleanups;
    cleanups = [];
    pending.forEach(fn => {
      try { fn(); } catch (e) { console.error('Screen cleanup failed', e); }
    });
  }

  SBS.onLeaveScreen = function (fn) {
    cleanups.push(fn);
  };
})();
