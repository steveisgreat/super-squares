// Home (saved games list) and Step 1 (new game setup).
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, topbar, showAlert, showConfirm, teamMeta, teamLogoTag, teamBadge, resetTeamColors, fitTeamBadges, isTvBrowser } = SBS.ui;
  const { emptyGrid } = window.GameLogic;
  const { openManagePlayersModal } = SBS.players;


  // Tabler outline icons (MIT, 24 px, pinned 3.19.0), path data copied inline.
  const ic = (d, size) => `<svg width="${size || 20}" height="${size || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PLUS_ICON = ic('<path d="M12 5l0 14"/><path d="M5 12l14 0"/>', 18);
  const USER_ICON = ic('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855"/>', 24);
  const DOWN_ICON = ic('<path d="M6 9l6 6l6 -6"/>', 16);
  const DOTS_ICON = ic('<path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>', 22);
  const PENCIL_ICON = ic('<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>');
  const LOCK_ICON = ic('<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>');
  const USERS_ICON = ic('<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>');
  const MOBILE_ICON = ic('<path d="M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14z"/><path d="M11 4h2"/><path d="M12 17v.01"/>');
  const TRASH_ICON = ic('<path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>');
  const { MAXIMIZE_ICON, CHEVRON_ICON } = SBS.ui;

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

  // "2026-12-05" -> "Sat, Dec 5" ("Today" for today), parsed as a local date so
  // it never shifts a day off from what the host actually picked. A year is
  // added only when it is not this year.
  function whenLabel(dateStr) {
    if (!dateStr) return '';
    if (dateStr === todayValue()) return 'Today';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
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

  // The grid is routinely locked (status -> 'started') well ahead of the
  // real kickoff once squares fill up — while that's true, the card should
  // read "Kickoff <time>", not "Live", since nothing is actually live yet.
  function kickoffPending(g) {
    if (g.status !== 'started' || !g.kickoffTime) return false;
    const ms = Date.parse(g.kickoffTime);
    return !isNaN(ms) && ms > Date.now();
  }

  // Status chip from the fields the games list already carries.
  function chipFor(g) {
    if (g.status === 'finished') return { text: 'Final', cls: 'chip-final' };
    if (g.status === 'started') {
      if (kickoffPending(g)) {
        const t = new Date(g.kickoffTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return { text: 'Kickoff ' + t, cls: 'chip-soon' };
      }
      return { text: 'Live', cls: 'chip-live' };
    }
    return { text: 'Picking squares', cls: 'chip-pick' };
  }

  function primaryLabel(g) {
    if (g.status === 'started') return 'Open Game Day';
    if (g.status === 'finished') return 'See results';
    return 'Pick squares';
  }

  function matchName(g) {
    return `${g.teamA || 'Team A'} vs ${g.teamB || 'Team B'}`;
  }

  function descLine(g) {
    return g.description || `${g.teamA || ''} @ ${g.teamB || ''}`;
  }

  function chipHtml(g) {
    const c = chipFor(g);
    return `<span class="home-chip ${c.cls}"><span class="home-chip-dot" aria-hidden="true"></span>${escapeHtml(c.text)}</span>`;
  }

  // Party View opens in this tab (like Game Day): the mirror screen on a phone,
  // the TV board elsewhere. Its Exit comes back to Home.
  function openPartyView(g) {
    SBS.go(SBS.ui.isPhone() ? { screen: 'mirror', id: g.id, from: 'home' } : { screen: 'tv', id: g.id, from: 'home' });
  }

  // ---------- The ⋯ menu and the account menu ----------
  // A bottom sheet on a phone, a popover anchored under the opener on a wide
  // screen. Same dialog behavior as Connect: focus moves in and stays in, Escape
  // or a click outside closes, focus goes back to the opener.
  let openMenu = null;

  function useSheet() {
    return SBS.ui.isPhone() || window.innerWidth < 600;
  }

  // items: { label, icon, sub, danger, disabled, divider, onSelect }
  function showMenu(opener, o) {
    if (openMenu) openMenu(true);
    const sheet = useSheet();
    const layer = el('div', 'connect-layer ' + (sheet ? 'connect-layer-sheet' : 'connect-layer-pop'));
    const box = el('div', 'card connect-card home-menu ' + (sheet ? 'connect-sheet' : 'connect-pop home-menu-pop'));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', o.label);
    const head = (sheet && o.headerTitle) || o.alwaysHeader
      ? `<div class="home-menu-head"><div class="home-menu-title">${escapeHtml(o.headerTitle)}</div>${o.headerSub ? `<div class="home-menu-subtitle">${escapeHtml(o.headerSub)}</div>` : ''}</div>`
      : '';
    box.innerHTML = (sheet ? '<div class="connect-grab" aria-hidden="true"></div>' : '') + head;
    const list = el('div', 'home-menu-list');
    list.setAttribute('role', 'group');
    o.items.forEach(it => {
      if (it.divider) { const hr = el('div', 'home-menu-sep'); hr.setAttribute('role', 'separator'); list.appendChild(hr); return; }
      const b = el('button', 'home-menu-item' + (it.danger ? ' danger-item' : ''),
        `${it.icon || ''}<span class="home-menu-text"><span>${escapeHtml(it.label)}</span>${it.sub ? `<span class="home-menu-sub">${escapeHtml(it.sub)}</span>` : ''}</span>`);
      b.type = 'button';
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        close(true);
        it.onSelect();
      });
      list.appendChild(b);
    });
    box.appendChild(list);
    layer.appendChild(box);
    document.body.appendChild(layer);
    opener.setAttribute('aria-expanded', 'true');

    function place() {
      if (sheet) return;
      const r = opener.getBoundingClientRect();
      const top = Math.round(r.bottom + 6);
      box.style.top = top + 'px';
      box.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
      box.style.maxHeight = `calc(100vh - ${top + 12}px)`;
    }
    place();
    window.addEventListener('resize', place);

    function close(leaving) {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      layer.remove();
      openMenu = null;
      opener.setAttribute('aria-expanded', 'false');
      if (leaving !== true && opener.isConnected) opener.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(box.querySelectorAll('button'));
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
    openMenu = close;
    SBS.onLeaveScreen(() => { if (openMenu === close) close(true); });
    const firstEnabled = Array.from(box.querySelectorAll('button')).find(b => b.getAttribute('aria-disabled') !== 'true') || box.querySelector('button');
    if (firstEnabled) firstEnabled.focus();
  }

  async function loadFull(id) {
    try {
      return await SBS.api.getGame(id);
    } catch (err) {
      showAlert('Failed to load game: ' + err.message);
      return null;
    }
  }

  function openCardMenu(g, opener) {
    const locked = g.status === 'started' || g.status === 'finished';
    const items = [
      {
        label: 'Edit game', icon: locked ? LOCK_ICON : PENCIL_ICON, disabled: locked,
        sub: locked ? 'Locked once the numbers are drawn' : '',
        onSelect: async () => {
          const game = await loadFull(g.id);
          if (game) SBS.go({ screen: 'editGame', game });
        }
      },
      {
        label: 'Players', icon: USERS_ICON,
        onSelect: async () => {
          const game = await loadFull(g.id);
          if (game) openManagePlayersModal(game, null);
        }
      }
    ];
    if (g.status === 'started') {
      items.push({
        label: 'Score from another phone', icon: MOBILE_ICON,
        onSelect: async () => {
          const game = await loadFull(g.id);
          if (game) SBS.handoff.open(game, opener);
        }
      });
    }
    items.push({ divider: true });
    items.push({
      label: 'Delete game…', icon: TRASH_ICON, danger: true,
      onSelect: async () => {
        const ok = await showConfirm(`Delete this game (${g.teamA || '?'} vs ${g.teamB || '?'})? This cannot be undone.`);
        if (!ok) { if (opener.isConnected) opener.focus(); return; }
        try {
          await SBS.api.deleteGame(g.id);
          renderHome();
        } catch (err) {
          showAlert('Failed to delete game: ' + err.message);
        }
      }
    });
    showMenu(opener, {
      label: 'More for ' + matchName(g),
      headerTitle: matchName(g),
      headerSub: `${descLine(g)} · ${chipFor(g).text}`,
      items
    });
  }

  // ---------- Cards ----------
  function buildGameCard(g) {
    const name = matchName(g);
    const c = el('article', 'home-card');
    c.setAttribute('aria-label', `${name}, ${chipFor(g).text}`);
    c.innerHTML = `
      <div class="home-card-top">${chipHtml(g)}<span class="home-when">${escapeHtml(whenLabel(g.gameDate))}</span></div>
      <button class="home-more" type="button" aria-label="${escapeHtml('More for ' + name)}" aria-haspopup="dialog" aria-expanded="false">${DOTS_ICON}</button>
      <div class="home-match badge-fit">${teamBadge(g, 'A', { logoSize: 22, cls: 'home-badge' })}<span class="vs-sep">vs</span>${teamBadge(g, 'B', { logoSize: 22, cls: 'home-badge' })}</div>
      <div class="home-desc">${escapeHtml(descLine(g))}</div>
      <div class="home-actions">
        <button class="home-primary" type="button" aria-label="${escapeHtml(primaryLabel(g) + ': ' + name)}"><span>${escapeHtml(primaryLabel(g))}</span>${CHEVRON_ICON}</button>
        <button class="home-party" type="button" aria-label="${escapeHtml('Party View for ' + name)}" title="Party View">${MAXIMIZE_ICON}<span class="home-party-text">Party View</span></button>
      </div>`;
    // The card body is a mouse convenience; the primary button is the keyboard target.
    c.addEventListener('click', () => openGame(g.id));
    const more = c.querySelector('.home-more');
    more.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(g, more); });
    c.querySelector('.home-primary').addEventListener('click', (e) => { e.stopPropagation(); openGame(g.id); });
    c.querySelector('.home-party').addEventListener('click', (e) => { e.stopPropagation(); openPartyView(g); });
    return c;
  }

  function buildGameGrid(games) {
    const grid = el('div', 'home-grid');
    games.forEach(g => grid.appendChild(buildGameCard(g)));
    return grid;
  }

  // ---------- Sections and order (client side; the store sort is untouched) ----------
  function kickoffMs(g) {
    const ms = g.kickoffTime ? Date.parse(g.kickoffTime) : NaN;
    return isNaN(ms) ? Infinity : ms;
  }

  // Today: live first, then by kickoff time, then the rest (store order).
  function sortToday(list) {
    const rank = g => (g.status === 'started' && !kickoffPending(g) ? 0 : (kickoffMs(g) !== Infinity ? 1 : 2));
    return list.map((g, i) => ({ g, i })).sort((a, b) => {
      const ra = rank(a.g);
      const rb = rank(b.g);
      if (ra !== rb) return ra - rb;
      if (ra === 1) { const d = kickoffMs(a.g) - kickoffMs(b.g); if (d) return d; }
      return a.i - b.i;
    }).map(x => x.g);
  }

  function sections(games) {
    const today = todayValue();
    const live = games.filter(g => !isArchived(g));
    // Unfinished boards dated in the past sort first here: they still need the host.
    const coming = live.filter(g => g.gameDate !== today).map((g, i) => ({ g, i })).sort((a, b) => {
      const da = a.g.gameDate || '';
      const db = b.g.gameDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    }).map(x => x.g);
    const past = games.filter(isArchived).sort((a, b) => ((b.gameDate || '') < (a.gameDate || '') ? -1 : (b.gameDate || '') > (a.gameDate || '') ? 1 : 0));
    return { today: sortToday(live.filter(g => g.gameDate === today)), coming, past };
  }

  // What changes a card: status, kickoff, date, names. The day itself is included so
  // the Today/Coming up split redraws at midnight.
  function fingerprint(games) {
    return todayValue() + '#' + games.map(g => [g.id, g.status, kickoffPending(g), g.gameDate, g.teamA, g.teamB, g.description].join(':')).sort().join('|');
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
    app.appendChild(topbar('<span><span class="brand-dollar">B</span>ig <span class="brand-dollar">G</span>ame <span class="brand-dollar">G</span>rids</span>', [], { hideHome: true, pill: true }));
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

  // ---------- Home ----------
  function section(main, title, grid) {
    const h = el('h2', 'home-sec', escapeHtml(title));
    main.appendChild(h);
    main.appendChild(grid);
    fitTeamBadges(grid);
  }

  // The account button in the top bar (only with a host session): who is signed in,
  // Sign out, Sign out everywhere.
  function buildAccountButton(s) {
    const emailTxt = s.mode === 'accounts' && s.email ? s.email : '';
    const btn = el('button', 'home-acct',
      `${USER_ICON}${emailTxt ? `<span class="home-acct-email">${escapeHtml(emailTxt)}</span>` : ''}${DOWN_ICON}`);
    btn.type = 'button';
    btn.setAttribute('aria-label', emailTxt ? `Account: signed in as ${emailTxt}` : 'Account');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      const items = [{
        label: 'Sign out',
        onSelect: async () => {
          try {
            await SBS.api.signOut();
          } catch (e) {
            showAlert('Could not sign out: ' + e.message);
            return;
          }
          SBS.go({ screen: 'home' });
        }
      }];
      if (emailTxt) {
        items.push({ label: 'Sign out everywhere', onSelect: () => signOutEverywhere(emailTxt, el('button')) });
      }
      showMenu(btn, {
        label: 'Account',
        alwaysHeader: true,
        headerTitle: emailTxt ? `Signed in as ${emailTxt}` : 'Signed in as host',
        items
      });
    });
    return btn;
  }

  // ---------- Home on a TV browser ----------
  // A remote can only move focus and press OK: big tiles, each one button that opens
  // Party View. No menus, no New game, no account, no Past games.
  function buildTvTile(g) {
    const tile = el('button', 'tv-tile');
    tile.type = 'button';
    const name = matchName(g);
    tile.setAttribute('aria-label', `Show Party View: ${name}, ${chipFor(g).text}`);
    const when = g.gameDate === todayValue() ? '' : whenLabel(g.gameDate);
    const desc = [g.description || `${g.teamA || ''} @ ${g.teamB || ''}`, when].filter(Boolean).join(' · ');
    tile.innerHTML = `
      ${chipHtml(g)}
      <span class="home-match badge-fit">${teamBadge(g, 'A', { logoSize: 48, cls: 'home-badge' })}<span class="vs-sep">vs</span>${teamBadge(g, 'B', { logoSize: 48, cls: 'home-badge' })}</span>
      <span class="tv-tile-desc">${escapeHtml(desc)}</span>
      <span class="tv-tile-cta">${MAXIMIZE_ICON}<span>Show Party View</span></span>`;
    tile.addEventListener('click', () => SBS.go({ screen: 'tv', id: g.id, from: 'home' }));
    return tile;
  }

  // Arrow keys move focus by where the tiles sit on screen (scoped to the grid; the
  // grid is gone when Home is left, so nothing needs removing).
  function moveTvFocus(grid, e) {
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir) return;
    const tiles = Array.from(grid.querySelectorAll('.tv-tile'));
    const cur = tiles.indexOf(document.activeElement);
    if (cur < 0) return;
    const c = center(tiles[cur]);
    let best = null;
    let bestScore = Infinity;
    tiles.forEach((t, i) => {
      if (i === cur) return;
      const p = center(t);
      const dx = (p.x - c.x) * dir[0];
      const dy = (p.y - c.y) * dir[1];
      const along = dir[0] ? dx : dy;
      if (along <= 5) return;
      const across = Math.abs(dir[0] ? p.y - c.y : p.x - c.x);
      const score = across * 4 + along;
      if (score < bestScore) { bestScore = score; best = t; }
    });
    e.preventDefault();
    if (best) best.focus();
  }
  function center(n) {
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function renderTvHome(main, games) {
    const sec = sections(games);
    const shown = sec.today.concat(sec.coming).slice(0, 6);
    main.classList.add('tv-home');
    main.appendChild(el('h2', 'tv-home-title', 'Pick a game to show'));
    if (shown.length === 0) {
      main.appendChild(el('p', 'tv-home-hint', 'No games to show right now. Start one from a phone or laptop, or pair this TV with a code.'));
      const pairBtn = el('button', 'tv-tile-pair', 'Show a pairing code');
      pairBtn.type = 'button';
      pairBtn.addEventListener('click', () => SBS.go({ screen: 'tv-pair' }));
      main.appendChild(pairBtn);
      pairBtn.focus();
      return;
    }
    const grid = el('div', 'tv-grid');
    shown.forEach(g => grid.appendChild(buildTvTile(g)));
    main.appendChild(grid);
    main.appendChild(el('p', 'tv-home-hint', 'Use the arrows on your remote, then press OK.'));
    grid.addEventListener('keydown', (e) => moveTvFocus(grid, e));
    fitTeamBadges(grid);
    const first = grid.querySelector('.tv-tile');
    if (first) first.focus();
  }

  async function renderHome() {
    const app = SBS.appEl;
    resetTeamColors();
    app.innerHTML = '';
    const tv = isTvBrowser();
    let newBtn = null;
    const extra = [];
    if (!tv) {
      newBtn = el('button', 'home-new', `${PLUS_ICON}<span>New game</span>`);
      newBtn.type = 'button';
      newBtn.addEventListener('click', () => SBS.go({ screen: 'setup' }));
      extra.push(newBtn);
    }
    const bar = topbar('<span><span class="brand-dollar">B</span>ig <span class="brand-dollar">G</span>ame <span class="brand-dollar">G</span>rids</span>', extra, { hideHome: true });
    bar.classList.add('home-topbar');
    if (tv) bar.classList.add('tv-topbar');
    app.appendChild(bar);
    const main = el('div', 'main home-main');
    app.appendChild(main);

    let games = [];
    let needsSignIn = false;
    try {
      // A TV browser has no keyboard worth the name, so it never gets the sign-in
      // prompt: with no host session it goes to the pairing code screen below.
      games = await SBS.api.getGames(tv ? { prompt: false } : undefined);
    } catch (e) {
      if (e.authRequired) {
        needsSignIn = true;
      } else {
        main.appendChild(el('div', 'error-msg', 'Could not load saved games: ' + escapeHtml(e.message)));
      }
    }

    // The saved-games list is host-only in the cloud (it used to enumerate
    // every game anyone had ever created). Anyone who isn't signed in still
    // reaches their own game through the link or QR code they were given.
    if (needsSignIn) {
      if (tv) { SBS.go({ screen: 'tv-pair' }); return; }
      if (newBtn) newBtn.remove();
      const card = el('div', 'card');
      main.appendChild(card);
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

    if (tv) {
      renderTvHome(main, games);
    } else {
      const sec = sections(games);
      if (games.length === 0) {
        main.appendChild(el('p', 'home-empty', 'No games yet. Tap New game to start one.'));
      } else if (sec.today.length + sec.coming.length === 0) {
        main.appendChild(el('p', 'home-empty', 'No active games right now. Tap New game to start one, or look in Past games below.'));
      }
      if (sec.today.length) section(main, 'Today', buildGameGrid(sec.today));
      if (sec.coming.length) section(main, 'Coming up', buildGameGrid(sec.coming));
      if (sec.past.length) {
        const wrap = el('div', 'archive-wrap');
        const toggle = el('button', 'archive-toggle', `<span class="archive-arrow">&#9656;</span> Past games (${sec.past.length})`);
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        const pastGrid = buildGameGrid(sec.past);
        pastGrid.classList.add('home-past', 'collapsed');
        toggle.addEventListener('click', () => {
          const collapsed = pastGrid.classList.toggle('collapsed');
          toggle.classList.toggle('open', !collapsed);
          toggle.setAttribute('aria-expanded', String(!collapsed));
          if (!collapsed) fitTeamBadges(pastGrid);
        });
        wrap.appendChild(toggle);
        wrap.appendChild(pastGrid);
        main.appendChild(wrap);
      }
    }

    // Build version and the account button, from one session call that Home never
    // waits on (the shell above is already drawn). Absent entirely when there is no
    // host session (auth off locally, or a LAN-style setup): New game stands alone.
    const versionNote = el('div', 'footer-note');
    versionNote.id = 'app-version';
    main.appendChild(versionNote);
    main.appendChild(SBS.ui.legalLinks());
    const nav = bar.querySelector('.nav');
    SBS.api.getSession().then(s => {
      // The answer can arrive after the host left, or after Home was drawn
      // again: then these nodes are detached and there is nothing to update.
      if (!s || !main.isConnected || SBS.currentScreen() !== 'home') return;
      if (s.version) versionNote.textContent = 'Super Squares v' + s.version;
      if (tv || !(s.authRequired && s.host)) return;
      nav.appendChild(buildAccountButton(s));
    }).catch(() => { /* never block Home on the session probe */ });

    // Games are created/edited/deleted from other devices in the room (a
    // phone setting up a new pool while the TV sits on Home), and there's no
    // push channel — so poll and re-render Home if the saved-games list has
    // changed since we last drew it.
    const before = fingerprint(games);
    SBS.setManagedInterval(async () => {
      let latest;
      try {
        // Silent: a session expiring under an 8-second poll must not throw a
        // password modal over whatever the host is looking at.
        latest = await SBS.api.getGames({ prompt: false });
      } catch (e) {
        return;
      }
      if (fingerprint(latest) !== before && SBS.currentScreen() === 'home') {
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
    // Guest picks (R28): off unless the host turns it on. A board that never had it has no
    // guestPick at all; turning it off later keeps the limit with on: false.
    const priorGuest = editGame && editGame.guestPick ? editGame.guestPick : null;
    const guestStart = { on: !!(priorGuest && priorGuest.on), max: priorGuest ? priorGuest.max : 5, liftAt: priorGuest ? priorGuest.liftAt : null };

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

      <label class="checkbox-label"><input type="checkbox" id="f-guest-on"${guestStart.on ? ' checked' : ''}> <span>Let guests pick their own squares</span></label>
      <div id="guest-wrap" class="${guestStart.on ? '' : 'hidden'}">
        <label for="f-guest-max">Most squares per person</label>
        <input type="number" id="f-guest-max" min="1" max="100" step="1" value="${escapeHtml(guestStart.max)}">
        <label for="f-guest-lift">Limit ends at (optional)</label>
        <input type="datetime-local" id="f-guest-lift" step="60" value="${guestStart.liftAt ? escapeHtml(toLocalInput(guestStart.liftAt)) : ''}">
        <p style="color:var(--muted); font-size:0.9rem;">Anyone with the board link can claim squares, up to this number each, until the time you set (leave it empty for no end time). You mark players paid yourself; we never hold or move the money.</p>
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

    form.querySelector('#f-guest-on').addEventListener('change', (e) => {
      form.querySelector('#guest-wrap').classList.toggle('hidden', !e.target.checked);
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

      const guestOn = form.querySelector('#f-guest-on').checked;
      const guestMax = Number(form.querySelector('#f-guest-max').value);
      const guestLiftValue = form.querySelector('#f-guest-lift').value;
      if ((guestOn || priorGuest) && (!Number.isInteger(guestMax) || guestMax < 1 || guestMax > 100)) {
        return showErr('Most squares per person must be a whole number from 1 to 100.');
      }
      if (guestOn && guestLiftValue && isNaN(new Date(guestLiftValue).getTime())) {
        return showErr('Choose a valid date and time for the guest limit, or clear it.');
      }
      // UTC with its zone, like the cutoff, so the server's clock agrees with the host's.
      const guestLiftAt = guestLiftValue && !isNaN(new Date(guestLiftValue).getTime()) ? new Date(guestLiftValue).toISOString() : null;
      const wantsGuestPick = guestOn || !!priorGuest;

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

      if (wantsGuestPick) {
        game.guestPick = { on: guestOn, max: guestMax, liftAt: guestLiftAt, lifted: !!(priorGuest && priorGuest.lifted) };
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        if (editGame) {
          // A guest's pick may land while the host edits: re-apply only this form's fields to
          // the newer board (the squares and players there are theirs, not ours).
          const formFields = {};
          ['teamA', 'teamB', 'description', 'gameDate', 'squarePrice', 'league', 'payouts', 'pickMode', 'autoCutoffEnabled', 'autoCutoffTime',
            'scoring', 'simulation', 'kickoffTime', 'teamAColor', 'teamBColor'].forEach(k => { formFields[k] = game[k]; });
          const modeChanged = scoring !== window.GameLogic.scoringMode(editGame);
          const result = await SBS.saveWith(editGame, doc => {
            Object.assign(doc, JSON.parse(JSON.stringify(formFields)));
            if (modeChanged) { doc.liveScore = null; delete doc.liveOverride; }
            // lifted is the picking screen's switch: keep the newer board's.
            if (wantsGuestPick) doc.guestPick = { on: guestOn, max: guestMax, liftAt: guestLiftAt, lifted: !!(doc.guestPick && doc.guestPick.lifted) };
          });
          SBS.go({ screen: 'picking', game: result.game });
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
