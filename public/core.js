// Application core: the server API, the router, and the interval registry.
// Everything hangs off a single global `SBS` namespace — the app is loaded as
// plain <script> tags in dependency order (see index.html), no bundler.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};

  SBS.appEl = document.getElementById('app');
  SBS.screens = {}; // filled in by the screens-*.js files

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

  SBS.api = {
    getGames: (o) => request('/api/games', null, o),
    getSession: () => rawRequest('/api/session'),
    signIn: (message) => promptSignIn(message),
    signOut: () => rawRequest('/api/session', { method: 'DELETE' }),
    // Account sign-in. Raw on purpose: a 401 here must never open the prompt.
    requestLoginCode: (email) => rawRequest('/api/login', json('POST', { email })),
    verifyLogin: (body) => rawRequest('/api/login/verify', json('POST', body)),
    revokeAllSessions: () => rawRequest('/api/session/revoke-all', { method: 'POST' }),
    getGame: (id) => request(`/api/game/${id}`),
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
    // Scorer-phone hand-off (R24). The phone's calls are raw: it has no host session.
    createHandoff: (id) => request(`/api/game/${id}/handoff`, { method: 'POST' }),
    getHandoff: (id, o) => request(`/api/game/${id}/handoff`, null, o),
    removeScorers: (id) => request(`/api/game/${id}/handoff`, { method: 'DELETE' }),
    useHandoff: (token) => rawRequest('/api/handoff', json('POST', { token })),
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

  SBS.render = function () {
    clearManagedTimers();
    runCleanups();
    const s = SBS.screens;
    if (route.screen === 'home') return s.home();
    if (route.screen === 'setup') return s.setup();
    if (route.screen === 'editGame') return s.editGame(route.game);
    if (route.screen === 'picking') return s.picking(route.game);
    if (route.screen === 'board') return s.board(route.game);
    if (route.screen === 'tv') return s.tv(route.id, route.paired);
    if (route.screen === 'mirror') return s.mirror(route.id);
    if (route.screen === 'tv-pair') return s.tvPair();
    if (route.screen === 'phone') return s.phone(route.id, route.back);
    if (route.screen === 'player') return s.player(route.id);
    if (route.screen === 'join') return s.join(route.code);
    if (route.screen === 'login') return s.login(route.token);
    if (route.screen === 'handoff') return s.handoff(route.token);
  };

  // Deep links, so the TV and the phone can each be pointed straight at the
  // view they need: #tv-<id> (grid on the television) and #score-<id>
  // (quarter entry on a phone). The phone link always opens in its own tab
  // (a new one on the same device, or literally a different phone that
  // scanned the QR code), so there's no shared browser history to "go back"
  // through — the launching screen instead has to be baked into the link
  // itself as an optional `-home`/`-board` suffix, read back here as
  // `route.back`. Defaults to 'board', matching the Game Day screen's own
  // "Phone Score Entry" button, which doesn't bother adding the suffix.
  const ID_RE = '[0-9a-f-]{36}';
  SBS.parseInitialRoute = function () {
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
    const phone = hash.match(new RegExp(`^#score-(${ID_RE})(?:-(home|board))?$`, 'i'));
    if (phone) return { screen: 'phone', id: phone[1], back: phone[2] || 'board' };
    // Player companion view: what a grid player sees after scanning the QR
    // code printed/shown at the party — their squares, quarter winners, and
    // a live "how am I doing" readout. Strictly read-only (see screen-player.js).
    const player = hash.match(new RegExp(`^#player-(${ID_RE})$`, 'i'));
    if (player) return { screen: 'player', id: player[1] };
    // Emailed sign-in link. The token is 43 URL-safe characters; anything else
    // still gets the login screen, in its "not valid" state.
    if (/^#login-/i.test(hash)) {
      const m = hash.match(/^#login-([A-Za-z0-9_-]{43})$/);
      return { screen: 'login', token: m ? m[1] : null };
    }
    // The one-time code a host shows a scorer's phone (R24), same shape.
    if (/^#handoff-/i.test(hash)) {
      const m = hash.match(/^#handoff-([A-Za-z0-9_-]{43})$/);
      return { screen: 'handoff', token: m ? m[1] : null };
    }
    return { screen: 'home' };
  };

  // Pasting a sign-in link into a tab that is already open only changes the
  // hash. Other deep links are read at load, as before.
  window.addEventListener('hashchange', () => {
    if (!/^#(login|handoff)-/i.test(window.location.hash || '')) return;
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
