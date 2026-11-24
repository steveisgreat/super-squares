// Home (saved games list) and Step 1 (new game setup).
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, topbar, statusLabel, leagueBadge, showAlert, showConfirm, teamMeta, teamLogoTag, teamBadge, resetTeamColors, fitTeamBadges, isTvBrowser, TV_ICON, PHONE_ICON, PEOPLE_ICON } = SBS.ui;
  const { emptyGrid } = window.GameLogic;
  const { openManagePlayersModal } = SBS.players;

  const EDIT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M13 6l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const X_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;

  function todayValue() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // A finished game drops into the archive once its game day has passed —
  // games finishing earlier the same day (e.g. an early window game) stay up
  // top alongside whatever's still in progress, so the room can see the
  // whole day's slate together.
  function isArchived(g) {
    return g.status === 'finished' && g.gameDate !== todayValue();
  }
  SBS.isArchivedGame = isArchived;

  // "2026-02-08" -> "Feb 8, 2026", parsed as a local date so it never shifts
  // a day off from what the host actually picked.
  function formatGameDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function openGame(id) {
    try {
      const game = await SBS.api.getGame(id);
      if (game.status === 'setup' || game.status === 'picking') {
        SBS.go({ screen: 'picking', game });
      } else {
        SBS.go({ screen: 'board', game });
      }
    } catch (e) {
      showAlert('Failed to load game: ' + e.message);
    }
  }

  // Vibrant accent colors used to flash individual letters of the
  // "Picking Squares" status while a game is in the picking phase.
  const PICKING_FX_COLORS = ['#FF3366', '#00FFCC', '#FFD700', '#FF6600', '#9D00FF', '#00FF66', '#FF0055', '#00E5FF'];

  // The grid is routinely locked (status -> 'started') well ahead of the
  // real kickoff once squares fill up — while that's true, the card should
  // read "Kickoff <time>", not "In Progress", since nothing is actually
  // live yet.
  function kickoffPending(g) {
    if (g.status !== 'started' || !g.kickoffTime) return false;
    const ms = Date.parse(g.kickoffTime);
    return !isNaN(ms) && ms > Date.now();
  }

  function statusMarkup(g) {
    if (kickoffPending(g)) {
      const timeTxt = new Date(g.kickoffTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `<span class="status status-kickoff-pending">Kickoff ${escapeHtml(timeTxt)}</span>`;
    }
    if (g.status !== 'picking') {
      return `<span class="status status-${escapeHtml(g.status)}">${escapeHtml(statusLabel(g.status))}</span>`;
    }
    const letters = [...statusLabel(g.status)].map(ch => ch === ' '
      ? `<span class="letter space"> </span>`
      : `<span class="letter">${escapeHtml(ch)}</span>`).join('');
    return `<span class="status status-picking status-picking-fx">${letters}</span>`;
  }

  // Periodically wiggles and color-fills a random letter of the "Picking
  // Squares" status pill so an idle-looking card still reads as "in
  // progress" from across the room.
  function attachPickingFx(container) {
    const letters = Array.from(container.querySelectorAll('.letter:not(.space)'));
    if (letters.length === 0) return;
    let lastIndex = -1;
    function trigger() {
      let idx;
      do {
        idx = Math.floor(Math.random() * letters.length);
      } while (idx === lastIndex && letters.length > 1);
      lastIndex = idx;
      const box = letters[idx];
      const color = PICKING_FX_COLORS[Math.floor(Math.random() * PICKING_FX_COLORS.length)];
      box.classList.add('wiggling');
      box.style.borderColor = color;
      box.style.color = color;
      box.style.boxShadow = `0 0 6px ${color}`;
      setTimeout(() => {
        box.style.backgroundColor = color;
        box.style.color = '#0d1117';
        box.style.boxShadow = `0 0 10px ${color}`;
      }, 500);
      setTimeout(() => box.classList.remove('wiggling'), 900);
      setTimeout(() => {
        box.style.backgroundColor = '';
        box.style.borderColor = '';
        box.style.color = '';
        box.style.boxShadow = '';
      }, 1300);
    }
    trigger();
    SBS.setManagedInterval(trigger, 1800);
  }

  function buildGameCard(g) {
    const isTv = isTvBrowser();
    const c = el('div', 'game-card');
    const numbersPicked = g.status === 'started' || g.status === 'finished';
    c.innerHTML = `
      ${isTv ? '' : `<button class="icon-btn game-card-delete" type="button" aria-label="Delete Game" title="Delete Game">${X_ICON}</button>`}
      <span class="game-date">${escapeHtml(formatGameDate(g.gameDate))}</span>
      <div class="game-card-meta">
        <div class="game-card-league">${leagueBadge(g.league)}</div>
      </div>
      ${g.description ? `<div class="game-card-desc">${escapeHtml(g.description)}</div>`
        : `<div class="game-card-desc">${escapeHtml(g.teamA || '')} @ ${escapeHtml(g.teamB || '')}</div>`}
      <div class="teams">${teamBadge(g, 'A', { logoSize: 18, cls: 'team-badge-sm mode-abbr' })}<span class="vs-sep">vs</span>${teamBadge(g, 'B', { logoSize: 18, cls: 'team-badge-sm mode-abbr' })}</div>
      <div class="game-card-kickoff">${g.kickoffTime ? `Kickoff: ${escapeHtml(SBS.ui.formatKickoffTime(g.kickoffTime))}` : ''}</div>
      ${statusMarkup(g)}
      ${isTv ? '' : `
      <div class="game-card-actions">
        <button class="icon-btn game-card-edit" type="button" aria-label="Edit Game" title="Edit Game"${numbersPicked ? ' disabled' : ''}>${EDIT_ICON}</button>
        <button class="icon-btn game-card-tv" type="button" aria-label="Open TV Grid View" title="TV Grid View">${TV_ICON}</button>
        <button class="icon-btn game-card-phone" type="button" aria-label="Open Phone Score Entry" title="Phone Score Entry">${PHONE_ICON}</button>
        <button class="icon-btn game-card-people" type="button" aria-label="Manage Players" title="Manage Players">${PEOPLE_ICON}</button>
      </div>`}
    `;
    if (g.status === 'picking') {
      attachPickingFx(c.querySelector('.status-picking-fx'));
    }
    if (isTv) {
      // On a TV browser there's nothing to manage — the panel is just a
      // launcher straight into the grid view for that game.
      c.addEventListener('click', () => SBS.go({ screen: 'tv', id: g.id }));
      return c;
    }
    c.addEventListener('click', () => openGame(g.id));
    c.querySelector('.game-card-edit').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (numbersPicked) return;
      try {
        const game = await SBS.api.getGame(g.id);
        SBS.go({ screen: 'editGame', game });
      } catch (err) {
        showAlert('Failed to load game: ' + err.message);
      }
    });
    c.querySelector('.game-card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirm(`Delete this game (${g.teamA || '?'} vs ${g.teamB || '?'})? This cannot be undone.`);
      if (!ok) return;
      try {
        await SBS.api.deleteGame(g.id);
        renderHome();
      } catch (err) {
        showAlert('Failed to delete game: ' + err.message);
      }
    });
    c.querySelector('.game-card-tv').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`${location.origin}${location.pathname}#tv-${g.id}`, '_blank');
    });
    c.querySelector('.game-card-phone').addEventListener('click', (e) => {
      e.stopPropagation();
      // Launched straight from Home rather than Game Day, so the phone
      // screen's Back button should return here, not to the board.
      window.open(`${location.origin}${location.pathname}#score-${g.id}-home`, '_blank');
    });
    c.querySelector('.game-card-people').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const game = await SBS.api.getGame(g.id);
        openManagePlayersModal(game, null);
      } catch (err) {
        showAlert('Failed to load game: ' + err.message);
      }
    });
    return c;
  }

  function buildGameGrid(games) {
    const grid = el('div', 'grid-cards');
    games.forEach(g => grid.appendChild(buildGameCard(g)));
    return grid;
  }

  // Revokes every session for this account, this device included. Another
  // device (a scorekeeper's phone) needs a new code afterward.
  async function signOutEverywhere(email, btn) {
    const ok = await showConfirm(`Sign out everywhere for ${email}? This includes this device. Any other device, such as a scorekeeper's phone, will need a new code to sign in again.`);
    if (!ok) return;
    btn.disabled = true;
    try {
      await SBS.api.revokeAllSessions();
    } catch (e) {
      // 401: already signed out, which is what was asked for.
      if (e.status !== 401) {
        btn.disabled = false;
        showAlert('Could not sign out everywhere: ' + e.message);
        return;
      }
    }
    SBS.go({ screen: 'home' });
  }

  // The page an emailed link opens (#login-<token>). It draws with no network
  // call and signs in only on the click: mail scanners that open links must not
  // use the token up. The token leaves the address bar at once and lives only in
  // this closure.
  function renderLogin(token) {
    const app = SBS.appEl;
    resetTeamColors();
    app.innerHTML = '';
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* address bar left as is */ }
    app.appendChild(topbar('<span><span class="brand-dollar">S</span>uper <span class="brand-dollar">S</span>quares</span>', [], { hideHome: true, pill: true }));
    const main = el('div', 'main');
    app.appendChild(main);
    const card = el('div', 'card');
    main.appendChild(card);
    main.appendChild(SBS.ui.legalLinks());

    const stale = () => !card.isConnected || SBS.currentScreen() !== 'login';
    const goHome = () => SBS.go({ screen: 'home' });

    function show(heading, text, buttons, isError) {
      card.innerHTML = '';
      const h = el('h2', '', escapeHtml(heading));
      h.style.marginTop = '0';
      card.appendChild(h);
      if (text) {
        const p = el('p', isError ? 'error-msg' : '', escapeHtml(text));
        if (isError) p.setAttribute('role', 'alert');
        card.appendChild(p);
      }
      const actions = el('div', 'actions');
      buttons.forEach(b => actions.appendChild(b));
      card.appendChild(actions);
      buttons[0].focus();
    }
    const homeBtn = () => {
      const b = el('button', 'secondary', 'Home');
      b.type = 'button';
      b.addEventListener('click', goHome);
      return b;
    };
    const newCodeBtn = () => {
      const b = el('button', '', 'Get a new code');
      b.type = 'button';
      b.addEventListener('click', async () => {
        if (await SBS.api.signIn()) goHome();
      });
      return b;
    };

    if (!token) {
      show('This link is not valid', 'Sign-in links are long. Copy the whole link from the email, or ask for a new code.', [newCodeBtn(), homeBtn()]);
      return;
    }

    function showReady(errText) {
      const btn = el('button', '', 'Sign in');
      btn.type = 'button';
      show('Sign in to Super Squares', 'Tap Sign in to finish signing in on this device.', [btn, homeBtn()]);
      if (errText) {
        const errBox = el('div', 'error-msg', escapeHtml(errText));
        errBox.setAttribute('role', 'alert');
        card.insertBefore(errBox, card.querySelector('.actions'));
      }
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await SBS.api.verifyLogin({ token });
        } catch (e) {
          if (stale()) return;
          if (e.status === 401) {
            show('Link not accepted', 'That link is wrong, expired or already used.', [newCodeBtn(), homeBtn()], true);
          } else if (e.status === 404) {
            show('Sign-in links are not used here', 'This server does not use sign-in links.', [homeBtn()], true);
          } else {
            showReady(e.message);
          }
          return;
        }
        SBS.ui.clearPendingLogin();
        if (!stale()) goHome();
      });
    }
    showReady();
  }
  SBS.screens.login = renderLogin;

  async function renderHome() {
    const app = SBS.appEl;
    resetTeamColors();
    app.innerHTML = '';
    app.appendChild(topbar('<span><span class="brand-dollar">S</span>uper <span class="brand-dollar">S</span>quares</span>', [], { hideHome: true, pill: true }));
    const main = el('div', 'main');
    app.appendChild(main);

    main.appendChild(el('h2', '', 'Saved Games'));
    const card = el('div', 'card');
    main.appendChild(card);

    let games = [];
    let needsSignIn = false;
    try {
      // A TV browser has no keyboard worth the name, so it never gets the
      // sign-in prompt — it falls through to the read-only state below and
      // is opened at a game with a #tv-<id> link instead.
      games = await SBS.api.getGames(isTvBrowser() ? { prompt: false } : undefined);
    } catch (e) {
      if (e.authRequired) {
        needsSignIn = true;
      } else {
        card.appendChild(el('div', 'error-msg', 'Could not load saved games: ' + escapeHtml(e.message)));
      }
    }

    // The saved-games list is host-only in the cloud (it used to enumerate
    // every game anyone had ever created). Anyone who isn't signed in still
    // reaches their own game through the link or QR code they were given.
    if (needsSignIn) {
      card.appendChild(el('p', '', 'Sign in as the host to see and manage saved games. If you were sent a link or scanned a QR code, open that instead — it needs no sign-in.'));
      const signInActions = el('div', 'actions');
      const signInBtn = el('button', '', 'Host sign-in');
      signInBtn.addEventListener('click', async () => {
        if (await SBS.api.signIn()) SBS.go({ screen: 'home' });
      });
      signInActions.appendChild(signInBtn);
      card.appendChild(signInActions);
      main.appendChild(SBS.ui.legalLinks());
      return;
    }

    const active = games.filter(g => !isArchived(g));
    const archived = games.filter(isArchived);

    if (games.length === 0) {
      card.appendChild(el('p', '', 'No games yet. Start a new one below!'));
    } else if (active.length === 0) {
      card.appendChild(el('p', '', 'No active games right now — see the Game Archive below.'));
    } else {
      const grid = buildGameGrid(active);
      card.appendChild(grid);
      fitTeamBadges(grid);
    }

    if (archived.length > 0) {
      const archiveWrap = el('div', 'archive-wrap');
      const toggle = el('button', 'archive-toggle', `<span class="archive-arrow">&#9656;</span> Game Archive (${archived.length})`);
      toggle.type = 'button';
      const archiveCard = el('div', 'card archive-panel collapsed');
      const archiveGrid = buildGameGrid(archived);
      archiveCard.appendChild(archiveGrid);
      toggle.addEventListener('click', () => {
        const collapsed = archiveCard.classList.toggle('collapsed');
        toggle.classList.toggle('open', !collapsed);
        if (!collapsed) fitTeamBadges(archiveGrid);
      });
      archiveWrap.appendChild(toggle);
      archiveWrap.appendChild(archiveCard);
      main.appendChild(archiveWrap);
    }

    const actions = el('div', 'actions');
    const newBtn = el('button', '', '+ New Game');
    newBtn.addEventListener('click', () => SBS.go({ screen: 'setup' }));
    actions.appendChild(newBtn);
    main.appendChild(actions);

    // Build version and the account line, from one session call that Home never
    // waits on (the shell above is already drawn). Sign-out lives here and only
    // here: Home is the host console, and it's the one screen a host is on when
    // they want to hand the laptop over. Absent entirely on the LAN, where
    // there is no sign-in to undo.
    const versionNote = el('div', 'footer-note');
    versionNote.id = 'app-version';
    const accountLine = el('div', 'footer-note account-line hidden');
    accountLine.style.cssText = 'margin-top:12px; overflow-wrap:anywhere; display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; justify-content:center;';
    main.appendChild(versionNote);
    main.appendChild(accountLine);
    main.appendChild(SBS.ui.legalLinks());
    const nav = app.querySelector('.topbar .nav');
    SBS.api.getSession().then(s => {
      // The answer can arrive after the host left, or after Home was drawn
      // again: then these nodes are detached and there is nothing to update.
      if (!s || !main.isConnected || SBS.currentScreen() !== 'home') return;
      if (s.version) versionNote.textContent = 'Super Squares v' + s.version;
      if (!(s.authRequired && s.host)) return;
      const outBtn = el('button', 'ghost', 'Sign out');
      outBtn.type = 'button';
      outBtn.addEventListener('click', async () => {
        outBtn.disabled = true;
        try {
          await SBS.api.signOut();
        } catch (e) {
          outBtn.disabled = false;
          showAlert('Could not sign out: ' + e.message);
          return;
        }
        SBS.go({ screen: 'home' });
      });
      nav.appendChild(outBtn);
      if (s.mode === 'accounts' && s.email) {
        accountLine.appendChild(document.createTextNode('Signed in as ' + s.email + ' '));
        const allBtn = el('button', 'ghost small', 'Sign out everywhere');
        allBtn.type = 'button';
        allBtn.addEventListener('click', () => signOutEverywhere(s.email, allBtn));
        accountLine.appendChild(allBtn);
        accountLine.classList.remove('hidden');
      }
    }).catch(() => { /* never block Home on the session probe */ });

    // Games are created/edited/deleted from other devices in the room (a
    // phone setting up a new pool while the TV sits on Home), and there's no
    // push channel — so poll and re-render Home if the saved-games list has
    // changed since we last drew it.
    const fingerprint = games.map(g => g.id + ':' + g.status + ':' + kickoffPending(g)).sort().join('|');
    SBS.setManagedInterval(async () => {
      let latest;
      try {
        // Silent: a session expiring under an 8-second poll must not throw a
        // password modal over whatever the host is looking at.
        latest = await SBS.api.getGames({ prompt: false });
      } catch (e) {
        return;
      }
      const latestFingerprint = latest.map(g => g.id + ':' + g.status + ':' + kickoffPending(g)).sort().join('|');
      if (latestFingerprint !== fingerprint && SBS.currentScreen() === 'home') {
        SBS.go({ screen: 'home' });
      }
    }, 8000);
  }

  function defaultCutoffValue() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}T18:45`;
  }

  const DEFAULT_OTHER_COLORS = { A: '#ff6b6b', B: '#4dabf7' };

  function renderSetup(editGame) {
    const app = SBS.appEl;
    resetTeamColors();
    app.innerHTML = '';
    app.appendChild(topbar(editGame ? `Edit Game — ${escapeHtml(editGame.description || editGame.gameDate || '')}` : 'New Game — Setup'));
    const main = el('div', 'main');
    app.appendChild(main);

    const card = el('div', 'card');
    main.appendChild(card);
    card.appendChild(el('h2', '', 'Game Setup'));

    const errBox = el('div', 'error-msg hidden');
    card.appendChild(errBox);
    function showErr(msg) {
      errBox.textContent = msg;
      errBox.classList.remove('hidden');
    }

    const form = el('div');
    // Simulation builds its plan when the numbers are generated, so it can't be
    // switched on for a board that is already locked.
    const simLocked = !!editGame && (editGame.status === 'started' || editGame.status === 'finished') && window.GameLogic.scoringMode(editGame) !== 'simulation';
    const scoringStart = editGame ? window.GameLogic.scoringMode(editGame) : 'manual';
    card.appendChild(form);

    form.innerHTML = `
      <label>League</label>
      <div class="radio-group" id="league-group">
        <div class="pill${!editGame || editGame.league === 'nfl' ? ' active' : ''}" data-val="nfl">NFL</div>
        <div class="pill${editGame && editGame.league === 'nba' ? ' active' : ''}" data-val="nba">NBA</div>
        <div class="pill${editGame && editGame.league === 'other' ? ' active' : ''}" data-val="other">Other</div>
      </div>

      <label for="f-gamedate">Game Date</label>
      <input type="date" id="f-gamedate" value="${editGame && editGame.gameDate ? escapeHtml(editGame.gameDate) : todayValue()}">

      <div id="games-picker" class="games-picker"></div>

      <label for="f-price">Square Price ($)</label>
      <input type="number" id="f-price" value="${editGame ? escapeHtml(editGame.squarePrice) : 10}" min="0" step="0.01">

      <label>Description</label>
      <input type="text" id="f-description" placeholder="e.g. Super Bowl LX, Office Pool" maxlength="80" value="${editGame ? escapeHtml(editGame.description || '') : ''}">

      <div class="row">
        <div>
          <label>Team A (rows, left side)</label>
          <input type="text" id="f-teamA" placeholder="e.g. Chiefs" value="${editGame ? escapeHtml(editGame.teamA || '') : ''}">
          <div id="preview-teamA" class="team-preview"></div>
        </div>
        <div>
          <label>Team B (columns, top)</label>
          <input type="text" id="f-teamB" placeholder="e.g. Eagles" value="${editGame ? escapeHtml(editGame.teamB || '') : ''}">
          <div id="preview-teamB" class="team-preview"></div>
        </div>
      </div>

      <div class="row hidden" id="other-color-row">
        <div>
          <label>Team A Color</label>
          <input type="color" id="f-teamA-color" value="${editGame && editGame.teamAColor ? escapeHtml(editGame.teamAColor) : DEFAULT_OTHER_COLORS.A}">
        </div>
        <div>
          <label>Team B Color</label>
          <input type="color" id="f-teamB-color" value="${editGame && editGame.teamBColor ? escapeHtml(editGame.teamBColor) : DEFAULT_OTHER_COLORS.B}">
        </div>
      </div>

      <label>Quarterly Payout — % of Pot</label>
      <div class="row">
        <div><label style="margin-top:0">Q1</label><input type="number" id="f-pq1" value="${editGame ? escapeHtml(editGame.payouts.q1) : 20}" min="0" max="100"></div>
        <div><label style="margin-top:0">Q2</label><input type="number" id="f-pq2" value="${editGame ? escapeHtml(editGame.payouts.q2) : 20}" min="0" max="100"></div>
        <div><label style="margin-top:0">Q3</label><input type="number" id="f-pq3" value="${editGame ? escapeHtml(editGame.payouts.q3) : 20}" min="0" max="100"></div>
        <div><label style="margin-top:0">Final</label><input type="number" id="f-pfinal" value="${editGame ? escapeHtml(editGame.payouts.final) : 40}" min="0" max="100"></div>
      </div>
      <div id="pct-total" class="pct-total"></div>

      <label>Square Pick Mode</label>
      <div class="radio-group" id="pick-mode-group">
        <div class="pill${editGame && editGame.pickMode === 'manual' ? ' active' : ''}" data-val="manual">Manual Only</div>
        <div class="pill${editGame && editGame.pickMode === 'auto' ? ' active' : ''}" data-val="auto">Auto Only</div>
        <div class="pill${!editGame || editGame.pickMode === 'both' ? ' active' : ''}" data-val="both">Both (player's choice)</div>
      </div>

      <label>Auto Cutoff Time?</label>
      <div class="toggle-group" id="cutoff-toggle">
        <div class="pill${editGame && editGame.autoCutoffEnabled ? ' active' : ''}" data-val="yes">Yes</div>
        <div class="pill${!editGame || !editGame.autoCutoffEnabled ? ' active' : ''}" data-val="no">No</div>
      </div>
      <div id="cutoff-time-wrap" class="${editGame && editGame.autoCutoffEnabled ? '' : 'hidden'}">
        <label>Cutoff Date &amp; Time</label>
        <input type="datetime-local" id="f-cutoff" step="60" value="${editGame && editGame.autoCutoffTime ? escapeHtml(toLocalInput(editGame.autoCutoffTime)) : defaultCutoffValue()}">
        <p style="color:var(--muted); font-size:0.9rem;">At this time, the app will automatically lock square picking and generate the grid numbers.</p>
      </div>

      <label>Scoring</label>
      <div class="radio-group" id="scoring-group" role="radiogroup" aria-label="Scoring">
        <div class="pill${scoringStart === 'manual' ? ' active' : ''}" data-val="manual" role="radio" tabindex="0" aria-checked="${scoringStart === 'manual'}">Manual</div>
        <div class="pill${scoringStart === 'live' ? ' active' : ''}" data-val="live" role="radio" tabindex="0" aria-checked="${scoringStart === 'live'}">Live</div>
        <div class="pill${scoringStart === 'simulation' ? ' active' : ''}${simLocked ? ' disabled' : ''}" data-val="simulation" role="radio" tabindex="${simLocked ? -1 : 0}" aria-checked="${scoringStart === 'simulation'}"${simLocked ? ' aria-disabled="true" title="Simulation has to be chosen before the grid numbers are generated."' : ''}>Simulation</div>
      </div>
      <p style="color:var(--muted); font-size:0.9rem;">Manual: you enter the score yourself on the phone or Game Day screen, and the app never contacts a score feed. Live: pick a game above and the score comes from a live score feed while the game is on; you can enter it yourself if the feed drops. Simulation: for testing or demos, the app invents a random game and plays it out (2-minute quarters) starting the moment you generate the grid numbers.</p>
    `;

    let league = editGame && window.GameLogic.LEAGUES.includes(editGame.league) ? editGame.league : 'nfl';
    let selectedKickoff = editGame ? (editGame.kickoffTime || null) : null;

    function currentPreviewGame() {
      return {
        teamA: form.querySelector('#f-teamA').value.trim(),
        teamB: form.querySelector('#f-teamB').value.trim(),
        league,
        teamAColor: form.querySelector('#f-teamA-color') ? form.querySelector('#f-teamA-color').value : DEFAULT_OTHER_COLORS.A,
        teamBColor: form.querySelector('#f-teamB-color') ? form.querySelector('#f-teamB-color').value : DEFAULT_OTHER_COLORS.B
      };
    }

    function updateTeamPreview(inputId, previewId, side) {
      const name = form.querySelector('#' + inputId).value.trim();
      const box = form.querySelector('#' + previewId);
      if (league === 'other') {
        box.innerHTML = `<span class="match-txt muted">Using your chosen color below.</span>`;
        return;
      }
      if (!name) { box.innerHTML = ''; return; }
      const meta = teamMeta(name, league);
      if (meta) {
        const pgame = currentPreviewGame();
        const logo = teamLogoTag(pgame, side, 24);
        box.innerHTML = `${logo}<span class="swatch" style="background:${meta.primary}"></span><span class="swatch" style="background:${meta.secondary}"></span><span class="match-txt">Matched: ${meta.names[0].replace(/\b\w/g, c => c.toUpperCase())}</span>`;
      } else {
        box.innerHTML = `<span class="match-txt muted">No ${league.toUpperCase()} team matched — using default colors.</span>`;
      }
    }
    function refreshPreviews() {
      updateTeamPreview('f-teamA', 'preview-teamA', 'A');
      updateTeamPreview('f-teamB', 'preview-teamB', 'B');
    }
    form.querySelector('#f-teamA').addEventListener('input', refreshPreviews);
    form.querySelector('#f-teamB').addEventListener('input', refreshPreviews);

    const otherColorRow = form.querySelector('#other-color-row');
    form.querySelector('#f-teamA-color').addEventListener('input', refreshPreviews);
    form.querySelector('#f-teamB-color').addEventListener('input', refreshPreviews);

    let pickMode = editGame ? editGame.pickMode : 'both';
    let cutoffEnabled = editGame ? !!editGame.autoCutoffEnabled : false;
    let scoring = scoringStart;

    function setScoring(val) {
      scoring = val;
      form.querySelectorAll('#scoring-group .pill').forEach(x => {
        const on = x.dataset.val === val;
        x.classList.toggle('active', on);
        x.setAttribute('aria-checked', String(on));
      });
    }
    function setCutoffEnabled(on) {
      cutoffEnabled = on;
      form.querySelectorAll('#cutoff-toggle .pill').forEach(x => x.classList.toggle('active', (x.dataset.val === 'yes') === on));
      form.querySelector('#cutoff-time-wrap').classList.toggle('hidden', !on);
    }
    // ISO instant -> the local "YYYY-MM-DDTHH:MM" a datetime-local input takes.
    function toLocalInput(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // Live-first: the host picks that date's game and the form fills itself
    // (teams, description, kickoff, cutoff) with Scoring on Live. Manual is the
    // fallback: no pick, league "Other", feed down, or no games that day.
    // Best-effort against ESPN's unofficial endpoint, never blocking setup.
    const pickerBox = form.querySelector('#games-picker');
    const MSG_MANUAL = 'Pick a game for live scores, or leave it and enter scores yourself.';
    let loadSeq = 0;
    async function loadGamesForDate(dateVal, initial) {
      const seq = ++loadSeq;
      pickerBox.innerHTML = '';
      selectedKickoff = null;
      if (!initial && scoring === 'live') setScoring('manual');
      if (initial && editGame) selectedKickoff = editGame.kickoffTime || null;
      if (league === 'other') return;
      const note = (msg) => {
        pickerBox.innerHTML = `<p class="games-picker-msg" role="status">${escapeHtml(msg)}</p>`;
      };
      let games;
      try {
        const data = await SBS.api.getTodaysGames(dateVal, league);
        games = data.games || [];
      } catch (e) {
        if (seq === loadSeq) note('The score feed is not available, so scoring stays Manual. Enter the teams yourself.');
        return;
      }
      if (seq !== loadSeq) return;
      if (games.length === 0) {
        note(`There are no ${league.toUpperCase()} games on this date, so scoring stays Manual. Enter the teams yourself.`);
        return;
      }
      pickerBox.innerHTML = `
        <label for="f-games-picker">Game</label>
        <select id="f-games-picker">
          <option value="">No game / enter manually</option>
          ${games.map((g, i) => `<option value="${i}">${escapeHtml(g.teamA)} @ ${escapeHtml(g.teamB)}${g.date ? ' — ' + escapeHtml(SBS.ui.formatKickoffTime(g.date)) : ''}</option>`).join('')}
        </select>
        <p class="games-picker-msg" id="games-picker-msg" role="status"></p>
      `;
      const select = pickerBox.querySelector('#f-games-picker');
      const msg = pickerBox.querySelector('#games-picker-msg');
      msg.textContent = MSG_MANUAL;
      // An existing board shows its picked game; its Scoring stays as saved.
      if (initial && editGame) {
        const matchIdx = games.findIndex(g => g.teamA === editGame.teamA && g.teamB === editGame.teamB);
        if (matchIdx !== -1) {
          select.value = String(matchIdx);
          selectedKickoff = games[matchIdx].date || editGame.kickoffTime || null;
          if (scoring === 'live') msg.textContent = 'Live scores on';
        }
      }
      select.addEventListener('change', (e) => {
        const g = games[e.target.value];
        if (!g) {
          // Cleared: back to Manual, keep whatever the host typed.
          selectedKickoff = null;
          if (scoring === 'live') setScoring('manual');
          msg.textContent = MSG_MANUAL;
          return;
        }
        selectedKickoff = g.date || null;
        form.querySelector('#f-teamA').value = g.teamA;
        form.querySelector('#f-teamB').value = g.teamB;
        form.querySelector('#f-description').value = `${g.teamA} @ ${g.teamB}`;
        const v = g.date ? toLocalInput(g.date) : '';
        if (v) { form.querySelector('#f-cutoff').value = v; setCutoffEnabled(true); }
        setScoring('live');
        msg.textContent = 'Live scores on';
        refreshPreviews();
      });
    }
    form.querySelector('#f-gamedate').addEventListener('change', (e) => loadGamesForDate(e.target.value, false));

    function applyLeagueUI(initial) {
      otherColorRow.classList.toggle('hidden', league !== 'other');
      if (league === 'other' && scoring === 'live') setScoring('manual');
      refreshPreviews();
      loadGamesForDate(form.querySelector('#f-gamedate').value, !!initial);
    }
    form.querySelectorAll('#league-group .pill').forEach(p => {
      p.addEventListener('click', () => {
        form.querySelectorAll('#league-group .pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        league = p.dataset.val;
        applyLeagueUI(false);
      });
    });

    form.querySelectorAll('#scoring-group .pill').forEach(p => {
      const choose = () => {
        if (p.getAttribute('aria-disabled') === 'true') return;
        setScoring(p.dataset.val);
      };
      p.addEventListener('click', choose);
      p.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      });
    });

    form.querySelectorAll('#pick-mode-group .pill').forEach(p => {
      p.addEventListener('click', () => {
        form.querySelectorAll('#pick-mode-group .pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        pickMode = p.dataset.val;
      });
    });

    form.querySelectorAll('#cutoff-toggle .pill').forEach(p => {
      p.addEventListener('click', () => setCutoffEnabled(p.dataset.val === 'yes'));
    });
    applyLeagueUI(true);

    function updatePctTotal() {
      const total = ['f-pq1', 'f-pq2', 'f-pq3', 'f-pfinal'].reduce((s, id) => s + (parseFloat(form.querySelector('#' + id).value) || 0), 0);
      const box = form.querySelector('#pct-total');
      box.textContent = `Total: ${total}%`;
      box.className = 'pct-total ' + (total === 100 ? 'ok' : 'bad');
      return total;
    }
    form.querySelectorAll('#f-pq1,#f-pq2,#f-pq3,#f-pfinal').forEach(inp => inp.addEventListener('input', updatePctTotal));
    updatePctTotal();

    const submitLabel = editGame ? 'Save Changes' : 'Continue to Square Picking';
    const actions = el('div', 'actions');
    const submitBtn = el('button', '', submitLabel);
    const cancelBtn = el('button', 'secondary', 'Cancel');
    cancelBtn.addEventListener('click', () => SBS.go({ screen: 'home' }));
    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    submitBtn.addEventListener('click', async () => {
      errBox.classList.add('hidden');
      const teamA = form.querySelector('#f-teamA').value.trim() || 'Team A';
      const teamB = form.querySelector('#f-teamB').value.trim() || 'Team B';
      const description = form.querySelector('#f-description').value.trim();
      const gameDate = form.querySelector('#f-gamedate').value || todayValue();
      const squarePrice = parseFloat(form.querySelector('#f-price').value) || 0;
      const pq1 = parseFloat(form.querySelector('#f-pq1').value) || 0;
      const pq2 = parseFloat(form.querySelector('#f-pq2').value) || 0;
      const pq3 = parseFloat(form.querySelector('#f-pq3').value) || 0;
      const pfinal = parseFloat(form.querySelector('#f-pfinal').value) || 0;
      const total = pq1 + pq2 + pq3 + pfinal;

      if (total !== 100) {
        return showErr(`Quarterly payout percentages must add up to 100% (currently ${total}%).`);
      }
      if (cutoffEnabled && !form.querySelector('#f-cutoff').value) {
        return showErr('Please choose a cutoff date & time, or turn off the auto-cutoff option.');
      }

      // Editing only ever touches setup fields (teams, price, payouts, pick
      // mode, cutoff, simulation) — everything else about the game (squares,
      // axis numbers, results, players, status) carries over untouched.
      const game = Object.assign({}, editGame, {
        teamA, teamB, description, gameDate, squarePrice, league,
        payouts: { q1: pq1, q2: pq2, q3: pq3, final: pfinal },
        pickMode,
        autoCutoffEnabled: cutoffEnabled,
        // With its zone, so the server's clock agrees with the host's (issue #4).
        autoCutoffTime: cutoffEnabled ? new Date(form.querySelector('#f-cutoff').value).toISOString() : null,
        scoring,
        simulation: scoring === 'simulation',
        kickoffTime: selectedKickoff
      });
      if (league === 'other') {
        game.teamAColor = form.querySelector('#f-teamA-color').value;
        game.teamBColor = form.querySelector('#f-teamB-color').value;
      } else {
        game.teamAColor = null;
        game.teamBColor = null;
      }
      // Switching mode on an existing board drops the old running score so a
      // stale feed value never poses as the manual one (or the reverse).
      if (editGame && scoring !== window.GameLogic.scoringMode(editGame)) { game.liveScore = null; delete game.liveOverride; }
      if (!editGame) {
        game.status = 'picking';
        game.squares = emptyGrid();
        game.axisX = null;
        game.axisY = null;
        game.results = {};
        game.players = {};
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        if (editGame) {
          const saved = await SBS.api.saveGame(game);
          SBS.go({ screen: 'picking', game: saved });
        } else {
          const saved = await SBS.api.createGame(game);
          SBS.go({ screen: 'picking', game: saved });
        }
      } catch (e) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
        if (editGame && await SBS.handleConflict(e, editGame.id)) return;
        showErr(e.message);
      }
    });
  }

  SBS.screens.home = renderHome;
  SBS.screens.setup = renderSetup;
  SBS.screens.editGame = renderSetup;
})();
