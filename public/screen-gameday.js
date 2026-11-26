// Step 3 (score entry on the iPad) and the TV grid-only view (AirPlayed to the
// 1080p screen the room watches).
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, topbar, showAlert, showConfirm, applyTeamColors, teamBadge, teamStyle, fitTeamBadges, readableTextColor, isPhone } = SBS.ui;
  const { unpaidTotal, openManagePlayersModal } = SBS.players;
  const { disturbMessage } = SBS.ui;
  const { QUARTERS, QLABEL, computeGame, payoutAmount, drawnDigits, payoutStatus, whoToPay, paidQuartersDisturbed } = window.GameLogic;

  // Silver Lombardi-style trophy for the NFL quarter-end celebration.
  const TROPHY_NFL_SVG =
    '<svg viewBox="0 0 64 88" xmlns="http://www.w3.org/2000/svg">'
      + '<ellipse cx="32" cy="18" rx="10" ry="17" fill="#cfd2d4" stroke="#8f9296" stroke-width="1"/>'
      + '<ellipse cx="28" cy="12" rx="4" ry="7" fill="#eef0f1" opacity="0.7"/>'
      + '<line x1="32" y1="4" x2="32" y2="32" stroke="#8f9296" stroke-width="1.1"/>'
      + '<line x1="28.6" y1="9" x2="35.4" y2="9" stroke="#8f9296" stroke-width="1"/>'
      + '<line x1="27.6" y1="14" x2="36.4" y2="14" stroke="#8f9296" stroke-width="1"/>'
      + '<line x1="27.6" y1="19" x2="36.4" y2="19" stroke="#8f9296" stroke-width="1"/>'
      + '<line x1="28.6" y1="24" x2="35.4" y2="24" stroke="#8f9296" stroke-width="1"/>'
      + '<path d="M18 34 L46 34 L34 40 L30 40 Z" fill="#d6d9db" stroke="#8f9296" stroke-width="0.8"/>'
      + '<path d="M25 40 L26 66 L23 74 L20 40 Z" fill="#c3c6c8" stroke="#8f9296" stroke-width="0.8"/>'
      + '<path d="M32 40 L32 66 L32 74 L32 40 Z" fill="#d6d9db" stroke="#8f9296" stroke-width="0.8"/>'
      + '<path d="M39 40 L38 66 L41 74 L44 40 Z" fill="#c3c6c8" stroke="#8f9296" stroke-width="0.8"/>'
      + '<rect x="14" y="74" width="36" height="7" rx="1.5" fill="#e4e6e7" stroke="#8f9296" stroke-width="1"/>'
      + '<rect x="10" y="81" width="44" height="6" rx="2" fill="#9a9d9f" stroke="#75787a" stroke-width="1"/>'
      + '<ellipse cx="27" cy="10" rx="2.4" ry="5" fill="#ffffff" opacity="0.55"/>'
    + '</svg>';

  // Gold, basketball-topped trophy (Larry O'Brien-style silhouette) for NBA.
  const TROPHY_NBA_SVG =
    '<svg viewBox="0 0 64 88" xmlns="http://www.w3.org/2000/svg">'
      + '<circle cx="32" cy="19" r="15" fill="#e8b923" stroke="#a67c00" stroke-width="1"/>'
      + '<path d="M32 4 V34" stroke="#a67c00" stroke-width="1.1" fill="none"/>'
      + '<path d="M17.5 19 Q32 24 46.5 19" stroke="#a67c00" stroke-width="1.1" fill="none"/>'
      + '<path d="M20 8 Q28 19 20 30" stroke="#a67c00" stroke-width="1" fill="none"/>'
      + '<path d="M44 8 Q36 19 44 30" stroke="#a67c00" stroke-width="1" fill="none"/>'
      + '<ellipse cx="27" cy="13" rx="4" ry="6" fill="#f7d774" opacity="0.6"/>'
      + '<path d="M18 34 L46 34 L34 40 L30 40 Z" fill="#f0c94a" stroke="#a67c00" stroke-width="0.8"/>'
      + '<path d="M25 40 L26 66 L23 74 L20 40 Z" fill="#e2b93e" stroke="#a67c00" stroke-width="0.8"/>'
      + '<path d="M32 40 L32 66 L32 74 L32 40 Z" fill="#f0c94a" stroke="#a67c00" stroke-width="0.8"/>'
      + '<path d="M39 40 L38 66 L41 74 L44 40 Z" fill="#e2b93e" stroke="#a67c00" stroke-width="0.8"/>'
      + '<rect x="14" y="74" width="36" height="7" rx="1.5" fill="#f3dd8e" stroke="#a67c00" stroke-width="1"/>'
      + '<rect x="10" y="81" width="44" height="6" rx="2" fill="#c9a227" stroke="#8a6c1a" stroke-width="1"/>'
    + '</svg>';

  // Plain gold loving-cup trophy for any 'other' (non-NFL/NBA) sport.
  const TROPHY_OTHER_SVG =
    '<svg viewBox="0 0 64 88" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M20 10 h24 v14 a12 12 0 0 1-24 0 z" fill="#d8b46a" stroke="#8a6c1a" stroke-width="1"/>'
      + '<path d="M20 14 Q8 14 8 24 Q8 32 20 30" fill="none" stroke="#8a6c1a" stroke-width="2.4"/>'
      + '<path d="M44 14 Q56 14 56 24 Q56 32 44 30" fill="none" stroke="#8a6c1a" stroke-width="2.4"/>'
      + '<ellipse cx="26" cy="16" rx="3.5" ry="6" fill="#f0dca0" opacity="0.6"/>'
      + '<rect x="30" y="36" width="4" height="30" fill="#c9a24a" stroke="#8a6c1a" stroke-width="0.8"/>'
      + '<path d="M18 66 L46 66 L40 74 L24 74 Z" fill="#d8b46a" stroke="#8a6c1a" stroke-width="0.8"/>'
      + '<rect x="14" y="74" width="36" height="7" rx="1.5" fill="#e4c98a" stroke="#8a6c1a" stroke-width="1"/>'
      + '<rect x="10" y="81" width="44" height="6" rx="2" fill="#b7924a" stroke="#8a6c1a" stroke-width="1"/>'
    + '</svg>';

  const QR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
    <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
    <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
    <path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const TROPHY_SVGS = { nfl: TROPHY_NFL_SVG, nba: TROPHY_NBA_SVG, other: TROPHY_OTHER_SVG };
  function trophySvgFor(league) { return TROPHY_SVGS[league] || TROPHY_SVGS.other; }

  const CELEBRATION_SPARKLE_SPOTS = [
    [4, 4, 20, 0], [66, 12, 16, 0.5], [10, 55, 14, 1.0], [60, 68, 18, 0.3], [36, -8, 14, 0.8], [70, 88, 16, 1.3]
  ];

  // Small trophy dropped into each winner row's per-quarter pill.
  const MINI_TROPHY_SVG = '<svg viewBox="0 0 16 22" xmlns="http://www.w3.org/2000/svg" width="11" height="15" aria-hidden="true">'
    + '<path d="M3 1h10v4a5 5 0 0 1-10 0V1z" fill="currentColor"/>'
    + '<path d="M3 2H1a2.5 2.5 0 0 0 2.6 3.6" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<path d="M13 2h2a2.5 2.5 0 0 1-2.6 3.6" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<rect x="7" y="10.5" width="2" height="4" fill="currentColor"/>'
    + '<rect x="4.5" y="16" width="7" height="1.8" rx="0.6" fill="currentColor"/>'
    + '<rect x="3.5" y="19" width="9" height="2" rx="0.8" fill="currentColor"/>'
    + '</svg>';

  // ---------- Randomly-drawn Final winner reveal ----------
  // Plays whenever the Final quarter's winning square is empty and gets
  // resolved via the "Randomly Draw Winner" button (board or phone): a big
  // countdown, then a two-wheel slot-machine spin that lands on the drawn
  // square's coordinates. Timed off the shared `drawnAt` timestamp stored on
  // the game so a screen that only learns about it a few seconds late (the
  // next poll) catches up mid-sequence and still lands at the same moment
  // as everyone else, instead of just snapping straight to the result.
  const DRAW_COUNTDOWN_MS = 10000; // 10, 9, ... 1
  const DRAW_SPIN_MS = 10000;
  const DRAW_TOTAL_MS = DRAW_COUNTDOWN_MS + DRAW_SPIN_MS;
  // A screen that notices the draw well after the sequence would already be
  // over everywhere else (TV was off, tab was backgrounded) just skips the
  // animation rather than replaying a stale one.
  const DRAW_CATCHUP_WINDOW_MS = DRAW_TOTAL_MS + 6000;

  function playDrawReveal({ game, row, col, elapsedMs, onDone }) {
    elapsedMs = Math.max(0, elapsedMs || 0);
    const overlay = el('div', 'draw-reveal-overlay');
    const card = el('div', 'draw-reveal-card');
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let cancelled = false;
    let timer = null;

    function finish() {
      if (overlay.parentNode) overlay.remove();
      if (!cancelled && onDone) onDone();
    }
    function cancel() {
      cancelled = true;
      clearTimeout(timer);
      if (overlay.parentNode) overlay.remove();
    }

    function showReveal() {
      const winner = game.squares[row * 10 + col];
      const yDigit = game.axisY ? game.axisY[row] : null;
      const xDigit = game.axisX ? game.axisX[col] : null;
      card.innerHTML = `
        <div class="draw-reveal-label">Winning square</div>
        <div class="draw-reveal-nums">${yDigit === null ? '&ndash;' : escapeHtml(yDigit)}&nbsp;&ndash;&nbsp;${xDigit === null ? '&ndash;' : escapeHtml(xDigit)}</div>
        <div class="draw-reveal-name">${winner ? escapeHtml(winner.name) : 'Empty square'}</div>
      `;
      timer = setTimeout(finish, 5000);
    }

    function landWheels(wheelA, wheelB, spinInterval, yDigit, xDigit) {
      clearInterval(spinInterval);
      wheelA.classList.remove('spinning'); wheelA.classList.add('landed');
      wheelB.classList.remove('spinning'); wheelB.classList.add('landed');
      wheelA.textContent = yDigit === null ? '–' : yDigit;
      wheelB.textContent = xDigit === null ? '–' : xDigit;
      timer = setTimeout(showReveal, 900);
    }

    function startSpin(spinElapsedMs) {
      const spinRemaining = Math.max(0, DRAW_SPIN_MS - spinElapsedMs);
      const yDigit = game.axisY ? game.axisY[row] : null;
      const xDigit = game.axisX ? game.axisX[col] : null;
      // Each reel is tinted with its own team's two colors (primary for the
      // border/glow, secondary for the gradient behind the spinning digit)
      // so the wheel that lands on Team A's number reads as A's the whole
      // time it's spinning, not just once it stops.
      const styleA = teamStyle(game, 'A');
      const styleB = teamStyle(game, 'B');
      const wheelVars = s => `--wheel-primary:${s.primary}; --wheel-secondary:${s.secondary}; color:${readableTextColor(s.primary)};`;
      card.innerHTML = `
        <div class="draw-reveal-label">Spinning the grid&hellip;</div>
        <div class="draw-wheels">
          <div class="draw-wheel">
            ${teamBadge(game, 'A', { logoSize: 20, cls: 'team-badge-sm' })}
            <div class="draw-wheel-num spinning" style="${wheelVars(styleA)}">0</div>
          </div>
          <div class="draw-wheel-sep">&ndash;</div>
          <div class="draw-wheel">
            ${teamBadge(game, 'B', { logoSize: 20, cls: 'team-badge-sm' })}
            <div class="draw-wheel-num spinning" style="${wheelVars(styleB)}">0</div>
          </div>
        </div>
      `;
      fitTeamBadges(card);
      const wheels = card.querySelectorAll('.draw-wheel-num');
      const wheelA = wheels[0], wheelB = wheels[1];
      const spinInterval = setInterval(() => {
        wheelA.textContent = Math.floor(Math.random() * 10);
        wheelB.textContent = Math.floor(Math.random() * 10);
      }, 70);
      timer = setTimeout(() => landWheels(wheelA, wheelB, spinInterval, yDigit, xDigit), spinRemaining);
    }

    function tickCountdown(remainingMs) {
      const n = Math.max(1, Math.ceil(remainingMs / 1000));
      card.innerHTML = `
        <div class="draw-reveal-label">Drawing a winner&hellip;</div>
        <div class="draw-countdown-num">${n}</div>
      `;
      if (remainingMs <= 1000) {
        timer = setTimeout(() => startSpin(0), remainingMs);
        return;
      }
      const msIntoSecond = remainingMs - (n - 1) * 1000;
      const nextDelay = msIntoSecond > 0 ? msIntoSecond : 1000;
      timer = setTimeout(() => tickCountdown(remainingMs - nextDelay), nextDelay);
    }

    if (elapsedMs >= DRAW_TOTAL_MS) {
      showReveal();
    } else if (elapsedMs < DRAW_COUNTDOWN_MS) {
      tickCountdown(DRAW_COUNTDOWN_MS - elapsedMs);
    } else {
      startSpin(elapsedMs - DRAW_COUNTDOWN_MS);
    }

    return { cancel };
  }

  // The Edit game panel open on a wide Game Day: { id, state } (screen-edit.js).
  let gdEdit = null;
  // Removes the layout listeners of the last wide render. A redraw in place (after a score save)
  // runs no screen cleanups, so without this each one would add another pair.
  let unplaceCards = null;

  function renderBoard(game) {
    const app = SBS.appEl;
    applyTeamColors(game);
    app.innerHTML = '';
    app.classList.remove('fit-screen'); // set again below on a wide screen (R35)
    const reopen = () => SBS.go({ screen: 'board', game });
    const phone = isPhone();
    const headerMeta = [escapeHtml(SBS.ui.shownDescription(game) || SBS.ui.formatGameDate(game.gameDate)), SBS.ui.kickoffNotice(game)].filter(Boolean).join(' &middot; ');
    // The top bar (R29): Home, the matchup on one line (full names when they fit, else short ones),
    // then on a wide screen the join chip and the "On the TV" pill, then Party View and Connect.
    const bar = topbar('', [], { hideIcon: true });
    bar.classList.add('gd-topbar');
    if (phone) bar.classList.add('gd-topbar-phone');
    else bar.classList.add('gd-topbar-center'); // from 1024 px the matchup is centered, as on the picking screen (R35)
    const head = el('div', 'gd-head');
    const match = el('h1', 'gd-match badge-fit',
      `${teamBadge(game, 'A', { logoSize: 20, cls: 'team-badge-sm' })}<span class="vs-sep">vs</span>${teamBadge(game, 'B', { logoSize: 20, cls: 'team-badge-sm' })}`);
    head.append(match, el('div', 'gd-meta', headerMeta));
    bar.replaceChild(head, bar.querySelector('h1'));
    const nav = bar.querySelector('.nav');

    if (!phone && game.joinCode) nav.appendChild(SBS.playerView.joinChip(game));
    if (!phone) {
      const pill = el('button', 'gd-onair', '<span class="gd-onair-dot" aria-hidden="true"></span>On the TV &middot; Stop');
      pill.type = 'button';
      pill.addEventListener('click', () => { SBS.present.stop(game.id); });
      const syncPill = () => { pill.hidden = !SBS.present.isOpen(game.id); };
      syncPill();
      SBS.onLeaveScreen(SBS.present.subscribe(syncPill));
      nav.appendChild(pill);
    }
    const partyBtn = el('button', 'gd-bar-btn gd-party' + (phone ? ' gd-icon-only' : ''),
      SBS.ui.MAXIMIZE_ICON + (phone ? '' : '<span>Party View</span>'));
    partyBtn.type = 'button';
    partyBtn.title = 'Party View';
    partyBtn.setAttribute('aria-label', 'Party View');
    // Party View opens in this tab: the mirror screen on a phone, the TV board elsewhere. Its Exit comes back here.
    partyBtn.addEventListener('click', () => {
      SBS.go(phone ? { screen: 'mirror', id: game.id, from: 'board' } : { screen: 'tv', id: game.id, from: 'board' });
    });
    // Edit game (R41): beside the board on a wide screen, its own screen below that.
    let toggleEdit = () => SBS.editForm.open(game.id, 'board');
    const editBtn = SBS.editForm.barButton(phone, () => toggleEdit());
    nav.append(editBtn, partyBtn, SBS.deviceChooser.button(game));
    app.appendChild(bar);
    const main = el('div', 'main' + (phone ? ' gd-phone' : ''));
    app.appendChild(main);

    const computed = computeGame(game);

    const isPotEdited = game.potOverride !== null && game.potOverride !== undefined && game.potOverride !== '';
    const strip = el('div', 'board-head');
    const filled = game.squares.filter(s => s).length;
    const unpaidNow = unpaidTotal(game);
    strip.innerHTML = `
      <div class="board-stat is-sold"><span class="val" data-v="sold">${filled}</span><span class="lbl">Sold</span></div>
      <label class="board-stat is-pot"><span class="val pot-line">$<input type="number" id="pot-input" class="val-input" min="0" step="1" value="${Math.round(computed.pot)}"></span><span class="lbl">Pot${isPotEdited ? ' <span class="pot-edited-tag">(edited)</span>' : ''}</span></label>
      <div class="board-stat is-price"><span class="val">${money(game.squarePrice)}</span><span class="lbl">Per square</span></div>
      <div class="board-stat is-unpaid${unpaidNow > 0 ? ' warn' : ''} clickable" id="unpaid-stat"><span class="val" data-v="unpaid">${money(unpaidNow)}</span><span class="lbl">Unpaid</span></div>
    `;
    main.appendChild(strip);
    strip.querySelector('#unpaid-stat').addEventListener('click', () => openManagePlayersModal(game, reopen));
    // The box is as wide as the number in it, so the "$" sits against it.
    const stripPot = strip.querySelector('#pot-input');
    const sizeStripPot = () => { stripPot.style.width = Math.max(1, stripPot.value.length) + 'ch'; };
    stripPot.addEventListener('input', sizeStripPot);
    sizeStripPot();
    // Brings the numbers up to date in place (a poll, a Paid pill). The pot box is left alone while
    // the host is typing in it.
    function drawStrip() {
      strip.querySelector('[data-v="sold"]').textContent = String(game.squares.filter(sq => sq).length);
      const unpaid = unpaidTotal(game);
      strip.querySelector('[data-v="unpaid"]').textContent = money(unpaid);
      strip.querySelector('#unpaid-stat').classList.toggle('warn', unpaid > 0);
      if (document.activeElement !== stripPot) { stripPot.value = String(Math.round(computeGame(game).pot)); sizeStripPot(); }
    }

    // Blanking the field clears the override and falls back to the actual
    // collected total (squares sold × price); typing a number overrides it. The stat strip's box and
    // the pot box above the grid on a wide screen (R35) both come here.
    // Saved as one settings edit (R40, decision 026): the server judges it, and the host confirms the
    // warnings it sends back (only the Final changes) before it is saved.
    async function savePot(raw) {
      raw = raw.trim();
      const before = JSON.parse(JSON.stringify(game));
      let pot = null;
      if (raw !== '') {
        const num = Math.round(parseFloat(raw));
        pot = (Number.isFinite(num) && num >= 0) ? num : null;
      }
      const disturbed = paidQuartersDisturbed(before, Object.assign({}, before, { potOverride: pot }));
      if (disturbed.length && !(await showConfirm(disturbMessage(disturbed)))) {
        renderBoard(before);
        return;
      }
      const seen = before.potOverride === undefined || before.potOverride === '' ? null : before.potOverride;
      const op = { op: 'edit', set: { potOverride: pot }, saw: { potOverride: seen }, ack: [] };
      try {
        let saved;
        try {
          saved = await SBS.api.patchSettings(game.id, op);
        } catch (err) {
          if (err.code !== 'unacked' || !err.warnings) throw err;
          if (!(await showConfirm(err.warnings.map(w => w.text).join(' ')))) {
            renderBoard(before);
            return;
          }
          op.ack = err.warnings.map(w => w.code);
          saved = await SBS.api.patchSettings(game.id, op);
        }
        renderBoard(saved);
      } catch (err) {
        if (await SBS.handleConflict(err, game.id)) return;
        const denied = await SBS.handleForbidden(err, game.id);
        if (denied) {
          if (SBS.currentScreen() === 'board') SBS.openGame(denied.fresh || game);
          return;
        }
        showAlert('Could not save the total pot: ' + err.message);
        renderBoard(err.game || before);
      }
    }
    strip.querySelector('#pot-input').addEventListener('change', (e) => savePot(e.target.value));

    const layout = el('div', 'pick-layout board-first');
    // Phone: banner for a down feed, then tabs; each tab shows one panel.
    const feedBanner = phone ? el('div', 'gd-feed-banner') : null;
    if (feedBanner) { feedBanner.hidden = true; feedBanner.setAttribute('role', 'status'); main.appendChild(feedBanner); }
    const tabBar = phone ? el('div', 'gd-tabs') : null;
    if (tabBar) { tabBar.setAttribute('role', 'tablist'); tabBar.setAttribute('aria-label', 'Game Day'); main.appendChild(tabBar); }
    main.appendChild(layout);

    // ---- Board ----
    const boardCard = el('div', 'card');
    layout.appendChild(boardCard);

    const boardHolder = el('div', 'gd-board-holder');
    boardHolder.dataset.fit = '1'; // board.js keeps its axis bars and names fitted as it resizes
    boardCard.appendChild(boardHolder);
    SBS.board.tapNames(boardCard); // phone widths show initials
    // Redraws the grid and fits what depends on its size: team pills, long names (R35).
    function drawBoard(c) {
      SBS.board.renderFullBoard(boardHolder, game, c);
      fitTeamBadges(boardHolder);
      SBS.board.fitNames(boardHolder);
    }
    SBS.board.renderFullBoard(boardHolder, game, computed);
    boardCard.appendChild(el('div', 'board-legend', '<span class="legend-chip"></span> Square is claimed but not paid for'));

    // ---- Results panel ----
    const resultsCard = el('div', 'card gd-results');
    layout.appendChild(resultsCard);
    // The score pad sits above the quarters list, which carries the payouts.
    const scorePanel = SBS.scorePanel.create({
      keyboard: !phone, // the Keyboard scoring switch shows on wide screens with a mouse only
      quarters: false,
      // The winner the server drew: spin for it here at once, as the TV does on its next poll.
      onDrawn: (g) => {
        const info = g.results && g.results.final && g.results.final.autoResolve;
        if (!info) return;
        lastSeenDrawAt = info.drawnAt;
        if (activeDrawReveal) activeDrawReveal.cancel();
        activeDrawReveal = playDrawReveal({ game: g, row: info.row, col: info.col, elapsedMs: 0, onDone: () => { activeDrawReveal = null; } });
      },
      getGame: () => game,
      setGame: (g) => {
        // Resume drops liveOverride from the document; assign alone would keep the old one, and
        // a key would then take the board over from the feed again.
        if (!('liveOverride' in g)) delete game.liveOverride;
        Object.assign(game, g);
        const c = computeGame(game);
        drawBoard(c);
        refreshResults(c);
      }
    });
    resultsCard.appendChild(scorePanel.el);
    scorePanel.update();

    // ---- Phone tabs: Score | Board | Players ----
    let playersCard = null;
    let updateFeedBanner = () => {};
    if (phone) {
      playersCard = el('div', 'card');
      playersCard.innerHTML = '<h3 style="margin-top:0">Players</h3><p class="gd-players-note"></p>';
      const openBtn = el('button', '', 'Manage players');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => openManagePlayersModal(game, reopen));
      playersCard.appendChild(openBtn);
      layout.appendChild(playersCard);
      const refreshPlayersNote = () => {
        const sold = game.squares.filter(s => s).length;
        const unpaid = unpaidTotal(game);
        playersCard.querySelector('.gd-players-note').textContent =
          `${sold} of 100 squares claimed. ` + (unpaid > 0 ? `${money(unpaid)} still unpaid.` : 'Everyone is paid up.');
      };
      refreshPlayersNote();

      const panels = { score: resultsCard, board: boardCard, players: playersCard };
      const names = { score: 'Score', board: 'Board', players: 'Players' };
      const order = ['score', 'board', 'players'];
      const mode = window.GameLogic.scoringMode(game);
      let tab = SBS.gamedayTab && SBS.gamedayTab.id === game.id
        ? SBS.gamedayTab.tab
        : (mode === 'manual' ? 'score' : 'board');
      const tabEls = {};
      order.forEach(k => {
        const t = el('button', 'gd-tab', names[k]);
        t.type = 'button';
        t.id = `gd-tab-${k}`;
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-controls', `gd-panel-${k}`);
        panels[k].id = `gd-panel-${k}`;
        panels[k].setAttribute('role', 'tabpanel');
        panels[k].setAttribute('aria-labelledby', t.id);
        t.addEventListener('click', () => select(k, false));
        t.addEventListener('keydown', (e) => {
          const i = order.indexOf(k);
          let n = null;
          if (e.key === 'ArrowRight') n = order[(i + 1) % 3];
          else if (e.key === 'ArrowLeft') n = order[(i + 2) % 3];
          else if (e.key === 'Home') n = order[0];
          else if (e.key === 'End') n = order[2];
          if (n) { e.preventDefault(); select(n, true); }
        });
        tabEls[k] = t;
        tabBar.appendChild(t);
      });
      function select(k, focus) {
        tab = k;
        SBS.gamedayTab = { id: game.id, tab: k };
        order.forEach(o => {
          const on = o === k;
          tabEls[o].setAttribute('aria-selected', on ? 'true' : 'false');
          tabEls[o].tabIndex = on ? 0 : -1;
          panels[o].hidden = !on;
        });
        if (focus) tabEls[k].focus();
        if (k === 'board') fitTeamBadges(boardHolder);
        updateFeedBanner(); // the pad says it on the Score tab
      }
      select(tab, false);

      // ---- Feed-down banner (live boards only) ----
      // Signal: the server marks a live board's response liveFeed.available === false
      // when the shared slate is stale or erroring (lib/api.js readLiveGame); the poll
      // below replaces `game`, so this just re-reads it. Take over = a score op with
      // override (what the first tap in the score panel does anyway); Resume = op 'resume'.
      async function runOp(op) {
        try {
          const saved = await SBS.api.patchScore(game.id, op);
          // Resume drops liveOverride from the document; assign alone would keep the old one.
          if (!('liveOverride' in saved)) delete game.liveOverride;
          Object.assign(game, saved);
          const c = computeGame(game);
          drawBoard(c);
          refreshResults(c);
          scorePanel.update();
          updateFeedBanner();
        } catch (e) {
          if (await SBS.handleConflict(e, game.id)) return;
          showAlert('Could not switch scoring: ' + e.message);
        }
      }
      updateFeedBanner = () => {
        refreshPlayersNote();
        const live = window.GameLogic.scoringMode(game) === 'live' && game.status === 'started';
        const holding = game.liveOverride === true;
        const down = !!(game.liveFeed && game.liveFeed.available === false);
        feedBanner.innerHTML = '';
        feedBanner.hidden = tab === 'score' || !(live && (down || holding));
        if (feedBanner.hidden) return;
        const msg = el('span', 'gd-feed-msg');
        const b = el('button', '');
        b.type = 'button';
        if (holding) {
          msg.textContent = 'You are entering scores by hand.';
          b.textContent = 'Resume live';
          b.addEventListener('click', () => runOp({ op: 'resume' }));
        } else {
          msg.innerHTML = '<strong>Live scores are down.</strong>';
          b.textContent = 'Take over';
          // No points: the server starts from its own copy of the feed, newer than this screen's.
          b.addEventListener('click', () => runOp({ op: 'add', side: 'a', points: 0, override: true }));
        }
        feedBanner.append(msg, b);
      };
      updateFeedBanner();
    }
    // A wide screen (R35) keeps its panel in sync from here; set once that panel is built.
    let drawWide = () => {};
    const GL = window.GameLogic;
    const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"></path></svg>';

    // One line per quarter: score, winner, Mark paid out, Fix. Rows are built once and filled in
    // place (a row is left alone while nothing about it changed).
    const rows = {};
    const qsec = el('section', 'gd-quarters');
    const qhead = el('div', 'gd-qhead', '<h3>Quarters</h3><span class="gd-qeach"></span>');
    const qlist = el('ul', 'gd-qlist');
    qsec.append(qhead, qlist);
    QUARTERS.forEach(q => {
      const li = el('li', 'gd-q');
      li.dataset.q = q;
      rows[q] = { li, sig: null };
      qlist.appendChild(li);
    });
    const qName = (q) => (q === 'final' ? 'Final' : QLABEL[q]);

    function focusIn(li, key) {
      const hit = key && li.querySelector(`[data-gdq="${key}"]`);
      if (hit) hit.focus();
    }

    function drawRow(q, i, c, pays, firstPending) {
      const r = rows[q];
      const res = c.results[q];
      const pay = pays[q];
      const scored = res.a !== null && res.b !== null;
      const digits = res.autoResolved ? drawnDigits(game, res) : null;
      // Scoring a later quarter changes where an earlier push rolls, so the phrase is in the signature.
      const push = res.pushed ? SBS.board.pushText(c.results, q) : '';
      const sig = JSON.stringify([push, res.a, res.b, res.resolved, res.pushed, res.needsDraw, res.winnerName, res.autoResolved, digits, res.amount, res.carryIn, pay.state, pay.name, pay.amount, pay.paid, game.status, i === firstPending]);
      if (sig === r.sig) return;
      r.sig = sig;
      const act = document.activeElement;
      const keep = act && r.li.contains(act) ? act.dataset.gdq : null;
      const li = r.li;
      li.innerHTML = '';
      li.className = 'gd-q is-' + pay.state;
      const label = qName(q);
      let who = '';
      let whoCls = '';
      let note = null;
      let noteCls = '';
      let draw = false;
      if (!scored) {
        if (game.status === 'started' && i === firstPending) { who = 'In play'; whoCls = ' is-dim'; }
        if (res.carryIn > 0) note = `Includes ${money(res.carryIn)} rolled over from an earlier push. It goes to whichever quarter is scored next.`;
      } else if (res.resolved && res.pushed) {
        who = push;
        whoCls = ' is-push';
        note = `No one in that square. ${money(res.amount)} rolls into the next payout.`;
      } else if (res.resolved && res.winnerName) {
        who = res.winnerName;
        if (res.autoResolved) note = `Auto-drawn: the square was empty${digits ? `; drawn numbers ${digits.y}-${digits.x}` : ''}.`;
      } else if (q === 'final' && res.needsDraw) {
        note = 'That square is empty! A winner must be drawn.';
        noteCls = ' is-push';
        draw = true;
      }
      li.appendChild(el('span', 'gd-q-lbl', label));
      li.appendChild(el('span', 'gd-q-score', scored ? `${res.a}–${res.b}` : '–'));
      const whoEl = el('span', 'gd-q-who' + whoCls);
      const nameEl = el('span', 'gd-q-name');
      nameEl.textContent = who;
      nameEl.title = who;
      whoEl.appendChild(nameEl);
      if (pay.name && (pay.state === 'unpaid' || pay.state === 'paid' || pay.state === 'needsSettling')) whoEl.appendChild(el('span', 'gd-q-amt', money(pay.amount)));
      li.appendChild(whoEl);
      const payEl = el('span', 'gd-q-pay');
      if (pay.state === 'unpaid') {
        const b = payButton('Mark paid out', 'gd-pay is-owed', 'paid', pay);
        b.setAttribute('aria-label', `Mark ${pay.name} paid out for ${label}, ${money(pay.amount)}`);
        b.dataset.gdq = 'pay';
        payEl.appendChild(b);
      } else if (pay.state === 'paid') {
        const b = payButton(CHECK + 'Paid out', 'gd-pay is-paid', 'unpaid', pay);
        b.setAttribute('aria-label', `${label} is paid out to ${pay.name}, ${money(pay.amount)}. Undo`);
        b.title = 'Tap to undo';
        b.dataset.gdq = 'pay';
        payEl.appendChild(b);
      }
      li.appendChild(payEl);
      const editEl = el('span', 'gd-q-fix-slot');
      // A Manual quarter is scored by ending it; on any other board the host may also fill one in.
      if (scored || GL.scoringMode(game) !== 'manual') {
        const b = el('button', 'sp-fix', scored ? 'Fix' : 'Enter');
        b.type = 'button';
        b.dataset.gdq = 'fix';
        b.setAttribute('aria-label', `${scored ? 'Fix' : 'Enter'} the ${label} score`);
        b.addEventListener('click', () => scorePanel.fix(q));
        editEl.appendChild(b);
      }
      li.appendChild(editEl);
      if (pay.state === 'needsSettling') {
        const nowTxt = pay.name ? `${pay.name} is owed ${money(pay.amount)}` : 'nobody is owed anything for it';
        const box = el('div', 'gd-q-note is-settle');
        box.setAttribute('role', 'status');
        const msg = el('span', 'gd-q-msg', `<strong>Needs settling.</strong> ${escapeHtml(`You paid ${pay.paid.name} ${money(pay.paid.amount)}; now ${nowTxt}. Sort it out with them, then mark it settled.`)}`);
        const b = payButton('Settled', 'small', 'settle', pay);
        b.dataset.gdq = 'settle';
        box.append(msg, b);
        li.appendChild(box);
      } else if (note || draw) {
        const box = el('div', 'gd-q-note' + noteCls);
        const msg = el('span', 'gd-q-msg');
        msg.textContent = note;
        box.appendChild(msg);
        if (draw) {
          const b = el('button', 'small', 'Draw the winner');
          b.type = 'button';
          b.dataset.gdq = 'draw';
          b.addEventListener('click', () => scorePanel.drawWinner());
          box.appendChild(b);
        }
        li.appendChild(box);
      }
      focusIn(li, keep);
    }

    function drawRows(c) {
      const pays = payoutStatus(game);
      let firstPending = -1;
      QUARTERS.forEach((q, i) => { if (firstPending < 0 && (c.results[q].a === null || c.results[q].b === null)) firstPending = i; });
      QUARTERS.forEach((q, i) => drawRow(q, i, c, pays, firstPending));
      const base = QUARTERS.map(q => c.results[q].baseAmount);
      qhead.querySelector('.gd-qeach').textContent = base.every(v => v === base[0]) ? `${money(base[0])} each` : '';
    }

    function refreshResults(c) {
      renderWhoToPay();
      drawRows(c);
      drawWide(c);
    }

    // ---- Payout tracking (R21) ----
    // A record the host keeps of who they paid off-app (decision 004). The
    // state is worked out from the results by GameLogic.payoutStatus.
    const whoCard = el('div', 'who-to-pay');
    whoCard.hidden = true;

    // paid and settle send the winner and amount shown, so the server refuses
    // the mark if the result moved since this card drew (decision 015).
    function payButton(text, cls, op, s) {
      const b = el('button', cls, text);
      b.type = 'button';
      const body = op === 'unpaid' ? { op, quarter: s.quarter } : { op, quarter: s.quarter, name: s.name, amount: s.amount };
      b.addEventListener('click', () => sendPayout(body, b));
      return b;
    }

    // Game over: who still gets paid, per person, plus any quarter to settle.
    function renderWhoToPay() {
      const w = whoToPay(game);
      whoCard.hidden = !(game.status === 'finished' && w.rows.length);
      if (whoCard.hidden) { whoCard.innerHTML = ''; return; }
      const head = w.outstanding > 0 ? `${money(w.outstanding)} still to pay`
        : w.outstanding < 0 ? `${money(-w.outstanding)} overpaid` : 'Everyone is paid out';
      const owes = p => p.outstanding > 0 ? `${money(p.outstanding)} to pay`
        : p.outstanding < 0 ? `overpaid ${money(-p.outstanding)}` : `${money(p.total)} paid`;
      const settle = w.needsSettling ? ` <span class="who-settle">${w.needsSettling} to settle</span>` : '';
      const people = w.people.map(p => `
        <li class="${p.outstanding !== 0 ? '' : 'done'}"><span class="who-name">${escapeHtml(p.name)}</span>
          <span class="who-amt">${owes(p)}</span></li>`).join('');
      whoCard.innerHTML = `<h3>Who to pay</h3><p class="who-head">${head}${settle}</p><ul class="who-list">${people}</ul>
        <p class="who-note">You pay winners yourself, outside the app. Mark each quarter paid out as you go.</p>`;
    }

    let payBusy = false;
    async function sendPayout(op, btn) {
      if (payBusy) return;
      payBusy = true;
      if (btn) btn.disabled = true;
      try {
        const saved = await SBS.api.patchPayout(game.id, op);
        Object.assign(game, saved);
        const c = computeGame(game);
        drawBoard(c);
        refreshResults(c);
        scorePanel.update();
      } catch (e) {
        if (await SBS.handleConflict(e, game.id)) return;
        showAlert('Could not save the payout: ' + e.message);
        // A refused mark usually means the result moved: show the current one.
        try { Object.assign(game, await SBS.api.getGame(game.id)); } catch (e2) { /* keep what we have */ }
        const c = computeGame(game);
        drawBoard(c);
        refreshResults(c);
        scorePanel.update();
      } finally {
        payBusy = false;
      }
    }

    resultsCard.append(qsec, whoCard);
    refreshResults(computed);
    fitTeamBadges(app);

    // ---- Wide screens (1024 px and up, not a phone): board left, panel right ----
    // Everything above is built in the order of the narrow page. On a wide screen the same pieces
    // are put in the panel in their reading order, which is the keyboard order too.
    let players = null;
    function redrawAll() {
      const c = computeGame(game);
      drawBoard(c);
      refreshResults(c);
      scorePanel.update();
      updateFeedBanner();
      drawStrip();
      if (players) players.draw();
    }

    // The Paid pill: the same guarded save as Manage Players, through saveWith, so a score that
    // changed on another device is kept (the change is applied again to the newer board).
    async function savePlayers(change, showErr) {
      try {
        return await SBS.saveWith(game, change);
      } catch (e) {
        if (await SBS.handleConflict(e, game.id)) return null;
        const denied = await SBS.handleForbidden(e, game.id);
        if (denied) {
          if (SBS.currentScreen() === 'board') SBS.openGame(denied.fresh || game);
          return null;
        }
        showErr('Failed to save: ' + e.message);
        return null;
      }
    }

    if (!phone) {
      players = SBS.players.playersCard({
        getGame: () => game,
        save: savePlayers,
        manage: () => openManagePlayersModal(game, reopen),
        // Assigned over, not replaced: the answer to a save has no live-feed fields.
        onSaved: (r) => { Object.assign(game, r.game); redrawAll(); }
      });
      players.el.classList.remove('card'); // it sits inside the wide panel
      players.draw();

      // ---- Wide Game Day (R35): a tabbed panel on the left, the grid on the right ----
      const periodLabel = SBS.board.periodLabel;
      const PENCIL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"></path><path d="M13.5 6.5l4 4"></path></svg>';

      const side = el('aside', 'card gd-side');
      side.setAttribute('aria-label', 'Scoring and players');
      const tabBar = el('div', 'gd-tabs pick-tabs');
      tabBar.setAttribute('role', 'tablist');
      tabBar.setAttribute('aria-label', 'Game Day');
      const scorePane = el('section', 'gd-pane gd-score-pane');
      const playersPane = el('section', 'gd-pane players-sec');
      playersPane.appendChild(players.el);
      const helpersPane = el('section', 'gd-pane gd-helpers-pane');
      const helpersTab = SBS.helpers.tab(game);
      helpersPane.appendChild(helpersTab.el);
      const tabOrder = ['score', 'players', 'helpers'];
      const tabNames = { score: 'Score', players: 'Players', helpers: 'Helpers' };
      const panes = { score: scorePane, players: playersPane, helpers: helpersPane };
      const tabEls = {};
      tabOrder.forEach(k => {
        const t = el('button', 'gd-tab', tabNames[k]);
        t.type = 'button';
        t.id = `gd-wtab-${k}`;
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-controls', `gd-wpanel-${k}`);
        panes[k].id = `gd-wpanel-${k}`;
        panes[k].setAttribute('role', 'tabpanel');
        panes[k].setAttribute('aria-labelledby', t.id);
        t.addEventListener('click', () => selectWide(k, false));
        t.addEventListener('keydown', (e) => {
          const i = tabOrder.indexOf(k);
          let n = null;
          if (e.key === 'ArrowRight') n = tabOrder[(i + 1) % tabOrder.length];
          else if (e.key === 'ArrowLeft') n = tabOrder[(i + tabOrder.length - 1) % tabOrder.length];
          else if (e.key === 'Home') n = tabOrder[0];
          else if (e.key === 'End') n = tabOrder[tabOrder.length - 1];
          if (n) { e.preventDefault(); selectWide(n, true); }
        });
        tabEls[k] = t;
        tabBar.appendChild(t);
      });
      // The tab is remembered for this board, so a redraw (a saved pot, a resize) keeps it.
      let wideTab = SBS.gamedayTab && SBS.gamedayTab.id === game.id && tabOrder.includes(SBS.gamedayTab.tab) ? SBS.gamedayTab.tab : 'score';
      function selectWide(k, focus) {
        wideTab = k;
        SBS.gamedayTab = { id: game.id, tab: k };
        tabOrder.forEach(o => {
          const on = o === k;
          tabEls[o].setAttribute('aria-selected', on ? 'true' : 'false');
          tabEls[o].tabIndex = on ? 0 : -1;
          panes[o].hidden = !on;
        });
        // Asked only when the tab is opened, and again each time.
        if (k === 'helpers') helpersTab.show(); else helpersTab.stop();
        if (focus) tabEls[k].focus();
      }
      side.append(tabBar, scorePane, playersPane, helpersPane);

      function shown(g) {
        const ls = g.liveScore;
        const num = (v) => Number.isFinite(v);
        if (g.status === 'finished') {
          const f = g.results && g.results.final;
          if (GL.hasResult(f)) return { a: Number(f.a), b: Number(f.b), when: 'Final' };
          if (ls && num(ls.a) && num(ls.b)) return { a: ls.a, b: ls.b, when: 'Final' };
          return { a: null, b: null, when: 'Final' };
        }
        if (GL.scoringMode(g) === 'manual') { const m = GL.manualState(g); return { a: m.a, b: m.b, when: periodLabel(m.period) }; }
        if (ls && ls.state !== 'pre' && num(ls.a) && num(ls.b)) {
          return { a: ls.a, b: ls.b, when: ls.completed ? 'Final' : [periodLabel(ls.period), ls.clock].filter(Boolean).join(' ') };
        }
        return { a: null, b: null, when: ls && ls.state === 'pre' ? 'Not started' : '' };
      }
      // What feeds the score, said once above the grid so it shows on both tabs (the live-score bar
      // that used to say this is hidden on a wide screen).
      function statusOf(g) {
        if (g.status !== 'started') return null;
        const ls = g.liveScore;
        const mode = GL.scoringMode(g);
        if (mode === 'simulation' || (ls && ls.simulation)) return ['SIMULATION', 'sim'];
        if (mode === 'manual' || (ls && ls.manual)) return ['MANUAL', 'manual'];
        if (g.liveFeed && g.liveFeed.available === false) return ['FEED OFFLINE', 'off'];
        return ls && ls.state !== 'pre' ? ['LIVE', 'live'] : null; // nothing is live before kickoff
      }

      // ---- Above the grid: score and period, squares sold, the pot, the price ----
      const stage = el('section', 'gd-stage');
      stage.setAttribute('aria-label', 'Board');
      const head = el('div', 'gd-stage-head');
      head.innerHTML = `<div class="gd-now"></div>
        <div class="gd-stat"><span class="lbl">Sold</span><span class="val" data-v="sold"></span></div>
        <label class="gd-stat gd-pot"><span class="lbl">Pot</span><span class="gd-pot-in"><span class="gd-cur">$</span><input type="number" min="0" step="1" class="val-input" data-v="pot" aria-label="Total pot"></span><span class="gd-pot-edit">${PENCIL}</span></label>
        <div class="gd-stat"><span class="lbl">Per square</span><span class="val" data-v="price"></span></div>`;
      const potIn = head.querySelector('[data-v="pot"]');
      const sizePot = () => { potIn.style.width = Math.max(2, potIn.value.length + 0.6) + 'ch'; };
      potIn.addEventListener('input', sizePot);
      potIn.addEventListener('change', () => savePot(potIn.value));
      stage.appendChild(head);
      let nowSig = null;
      // The full names; the short ones when the line would not fit on one row with the numbers
      // (fitStage adds .is-short, and CSS swaps them).
      function fitStage() {
        head.classList.remove('is-short');
        if (head.offsetHeight > 56) head.classList.add('is-short');
      }
      if (window.ResizeObserver) new ResizeObserver(fitStage).observe(stage);
      const nm = (g, side) => {
        const full = side === 'A' ? g.teamA : g.teamB;
        return `<span class="gd-nm" title="${escapeHtml(full)}"><span class="gd-nm-full">${escapeHtml(full)}</span><span class="gd-nm-abbr" aria-hidden="true">${escapeHtml(teamStyle(g, side).abbr)}</span></span>`;
      };
      function drawStage(c) {
        const g = game;
        const sc = shown(g);
        const st = statusOf(g);
        const names = [...new Set(g.squares.filter(Boolean).map(sq => sq.name))].length;
        tabEls.players.textContent = `Players (${names})`;
        const sig = JSON.stringify([sc, st, g.teamA, g.teamB]);
        if (sig !== nowSig) {
          nowSig = sig;
          const val = (v) => (v === null ? '–' : String(v));
          head.querySelector('.gd-now').innerHTML =
            `${nm(g, 'A')}<b class="gd-pts">${val(sc.a)}</b><span class="gd-dash" aria-hidden="true">–</span><b class="gd-pts">${val(sc.b)}</b>${nm(g, 'B')}`
            + (sc.when ? `<span class="gd-when">${escapeHtml(sc.when)}</span>` : '')
            + (st ? `<span class="gd-src is-${st[1]}">${st[0]}</span>` : '');
        }
        head.querySelector('[data-v="sold"]').textContent = String(g.squares.filter(sq => sq).length);
        head.querySelector('[data-v="price"]').textContent = money(g.squarePrice);
        if (document.activeElement !== potIn) { potIn.value = String(Math.round(c.pot)); sizePot(); }
        const edited = g.potOverride !== null && g.potOverride !== undefined && g.potOverride !== '';
        head.querySelector('.gd-pot').title = edited ? 'The pot was edited by hand. Clear the box to use squares sold × price.' : 'Total pot. Type a number to change it.';
        fitStage();
      }

      drawWide = drawStage;

      // The edit form takes the panel's place while it is open. It is kept across a redraw of
      // this screen, so a change typed in it is not lost.
      let editor = null;
      function showEditor() {
        const open = !!(gdEdit && gdEdit.id === game.id) && layout.classList.contains('gd-wide');
        editBtn.setAttribute('aria-pressed', String(open));
        potIn.disabled = open; // the form has the pot while it is open
        if (!open) {
          editor = null;
          if (side.firstElementChild !== tabBar) { side.replaceChildren(tabBar, scorePane, playersPane, helpersPane); scorePanel.update(); }
          return;
        }
        if (editor) return;
        editor = SBS.editForm.create({
          state: gdEdit.state,
          panel: true,
          onSaved: (saved) => { gdEdit = null; SBS.openGame(saved); },
          onClose: () => { gdEdit = null; showEditor(); editBtn.focus(); }
        });
        side.replaceChildren(editor.el);
      }
      let opening = false;
      toggleEdit = async () => {
        if (!layout.classList.contains('gd-wide')) return SBS.editForm.open(game.id, 'board');
        if (editor) return editor.close();
        if (opening) return;
        opening = true;
        try {
          const fresh = await SBS.api.getGame(game.id);
          if (!editBtn.isConnected) return;
          gdEdit = { id: game.id, state: SBS.editForm.newState(fresh) };
          showEditor();
        } catch (e) {
          showAlert('Could not open Edit game: ' + e.message);
        } finally {
          opening = false;
        }
      };

      const wideQuery = window.matchMedia('(min-width: 1024px)');
      const fineQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
      const placeCards = () => {
        const wide = wideQuery.matches;
        const focused = document.activeElement;
        layout.classList.toggle('gd-wide', wide);
        boardCard.classList.toggle('gd-board', wide);
        boardCard.classList.toggle('glass-board', wide);
        app.classList.toggle('fit-screen', wide);
        main.classList.toggle('gd-main', wide);
        if (wide) {
          selectWide(wideTab, false);
          scorePane.append(scorePanel.el, whoCard, qsec);
          stage.appendChild(boardCard);
          layout.append(side, stage);
          resultsCard.remove();
          strip.remove();
          drawWide(computeGame(game));
          scorePanel.update();
          showEditor();
        } else {
          // Narrowed with the form open: it carries on as its own screen.
          if (editor && gdEdit) {
            SBS.go({ screen: 'editGame', game, from: 'board', state: gdEdit.state });
            return;
          }
          resultsCard.append(scorePanel.el, qsec, whoCard);
          layout.append(boardCard, resultsCard);
          side.remove();
          stage.remove();
          main.insertBefore(strip, layout);
          scorePanel.update();
        }
        if (focused && focused !== document.activeElement && document.body.contains(focused) && focused !== document.body) focused.focus();
        fitTeamBadges(boardHolder);
        SBS.board.fitNames(boardHolder);
      };
      if (unplaceCards) unplaceCards();
      [wideQuery, fineQuery].forEach(m => { if (m.addEventListener) m.addEventListener('change', placeCards); else m.addListener(placeCards); });
      unplaceCards = () => {
        [wideQuery, fineQuery].forEach(m => { if (m.removeEventListener) m.removeEventListener('change', placeCards); else m.removeListener(placeCards); });
        unplaceCards = null;
      };
      SBS.onLeaveScreen(() => {
        // Reopening this same board (after Manage players) keeps the open form and its changes.
        const next = SBS.getRoute();
        if (!(next && next.screen === 'board' && next.game && next.game.id === game.id)) gdEdit = null;
        if (unplaceCards) unplaceCards();
        app.classList.remove('fit-screen');
      });
      if (wideQuery.matches) placeCards();
    }

    // Tracks the most recent Final "Randomly Draw Winner" event this board
    // has already shown a reveal for, so a background poll that picks up a
    // draw triggered elsewhere (e.g. from the phone) still plays the
    // animation here, but one from before this screen was opened doesn't.
    let lastSeenDrawAt = null;
    let activeDrawReveal = null;
    function checkDrawSync(freshGame) {
      // Only a draw that decides the final counts: a corrected score leaves
      // the old draw stored but unused.
      if (!computeGame(freshGame).results.final.autoResolved) return;
      const info = freshGame.results && freshGame.results.final && freshGame.results.final.autoResolve;
      if (!info || !info.drawnAt || info.drawnAt === lastSeenDrawAt) return;
      lastSeenDrawAt = info.drawnAt;
      const elapsed = Date.now() - info.drawnAt;
      if (elapsed >= DRAW_CATCHUP_WINDOW_MS) return;
      if (activeDrawReveal) activeDrawReveal.cancel();
      activeDrawReveal = playDrawReveal({ game: freshGame, row: info.row, col: info.col, elapsedMs: elapsed, onDone: () => { activeDrawReveal = null; } });
    }

    // Picks up the server's ESPN live-score poll (see server-livescore.js)
    // and any quarter scores it auto-fills. Skipped while a tap on the score
    // pad is in flight so the two never race each other.
    let syncing = false;
    async function pollLive() {
      if (syncing || scorePanel.busy()) return;
      syncing = true;
      // A TV window the host closed by hand is noticed here (and when this window is focused).
      if (SBS.present) SBS.present.refresh();
      try {
        const fresh = await SBS.api.pollGame(game.id);
        // A save may have started while the poll was out: its answer wins.
        if (!fresh || scorePanel.busy()) return;
        const feedChanged = !!(fresh.liveFeed && fresh.liveFeed.available === false) !== !!(game.liveFeed && game.liveFeed.available === false);
        if (feedChanged) { game.liveFeed = fresh.liveFeed; updateFeedBanner(); scorePanel.update(); drawWide(computeGame(game)); }
        const saved = fresh.updatedAt !== game.updatedAt;
        if (saved || SBS.boardKey(fresh) !== SBS.boardKey(game)) {
          SBS.takeBoard(game, fresh);
          if (saved) checkDrawSync(game);
          const newComputed = computeGame(game);
          drawBoard(newComputed);
          refreshResults(newComputed);
          scorePanel.update();
          updateFeedBanner();
          drawStrip();
          if (saved && players) players.draw();
          // A change made somewhere else: what this screen scored no longer undoes cleanly.
          if (saved) scorePanel.clearUndo();
        }
      } catch (e) {
        // Deleted on another device — nothing left here to show.
        if (e && e.status === 404 && SBS.currentScreen() === 'board') {
          SBS.go({ screen: 'home' });
          return;
        }
        // Otherwise best-effort — the host's own edits still save independently.
      } finally {
        syncing = false;
      }
    }
    SBS.setManagedInterval(pollLive, 8000);
    SBS.deviceChooser.onGameDay(game);
    SBS.onLeaveScreen(() => {
      if (activeDrawReveal) { activeDrawReveal.cancel(); activeDrawReveal = null; }
    });
  }

  // ---------- TV / grid-only view (1080p, no controls, self-refreshing) ----------
  function renderTV(id, paired, from) {
    // Opened from Game Day: remember it for this tab, so Exit still goes back there after a reload
    // (the #tv-<id> hash alone does not say where it came from).
    const FROM_KEY = 'sbs.tvfrom';
    try {
      if (from === 'board') window.sessionStorage.setItem(FROM_KEY, id);
      else if (from !== 'home' && !paired && window.sessionStorage.getItem(FROM_KEY) === id) from = 'board';
      else window.sessionStorage.removeItem(FROM_KEY);
    } catch (e) { /* Exit goes Home after a reload */ }
    const app = SBS.appEl;
    app.innerHTML = '';
    document.body.classList.add('tv-mode');

    const screenEl = el('div', 'tv-screen');
    app.appendChild(screenEl);

    const header = el('div', 'tv-header');
    screenEl.appendChild(header);

    // Live "time until kickoff" clock — separate from `header` (which the
    // poll below rebuilds from scratch every 4s) so it can tick every
    // second on its own without fighting that rebuild. Only ever shown pre-
    // kickoff; ticks itself into hiding the moment kickoff time passes.
    const kickoffCountdown = el('div', 'tv-kickoff-countdown hidden');
    screenEl.appendChild(kickoffCountdown);

    const tvQuarters = el('div', 'tv-quarters');
    screenEl.appendChild(tvQuarters);

    const boardOuter = el('div', 'tv-board-outer');
    screenEl.appendChild(boardOuter);
    const boardWrap = el('div', 'tv-board-wrap');
    boardOuter.appendChild(boardWrap);
    // Sits outside boardWrap (which renderFullBoard wipes and rebuilds
    // wholesale on every board change) so it survives untouched across
    // rebuilds — only its position/size needs recomputing, via
    // positionCornerQrBig below, not its content.
    const cornerQrBig = el('div', 'tv-corner-qr-big');
    boardOuter.appendChild(cornerQrBig);

    // Controls fade out so the television shows nothing but the grid; any tap
    // or mouse move brings them back.
    const controls = el('div', 'tv-controls');
    screenEl.appendChild(controls);

    const fsBtn = el('button', 'tv-btn', 'Fullscreen');
    const exitBtn = el('button', 'tv-btn', 'Exit');

    function syncFsLabel() {
      const on = SBS.ui.fullscreen.active();
      fsBtn.textContent = on ? 'Leave Fullscreen' : 'Fullscreen';
      document.body.classList.toggle('tv-fullscreen', on);
      // Entering/leaving fullscreen resizes the grid without rebuilding it,
      // which would otherwise leave the team-label insets and the corner QR
      // sized for the viewport that no longer exists. Fires once now and
      // again shortly after — some browsers settle the fullscreen layout a
      // frame or two after the change event itself.
      syncCornerLayout();
      setTimeout(syncCornerLayout, 150);
    }

    fsBtn.addEventListener('click', async () => {
      if (SBS.ui.fullscreen.active()) {
        await SBS.ui.fullscreen.exit();
      } else if (!await SBS.ui.fullscreen.enter()) {
        // iPhone Safari (and anything else without the API): the view is
        // already edge-to-edge, so just say so rather than failing silently.
        showAlert('This browser won\'t let a web page go fullscreen. The grid is already filling the window — on an iPad, hide Safari\'s toolbar by tapping the grid and scrolling, or add this page to your Home Screen.');
        return;
      }
      syncFsLabel();
    });

    // Exit, or Back on a phone or TV remote (see partyHistory below).
    async function leaveTV() {
      if (SBS.ui.fullscreen.active()) await SBS.ui.fullscreen.exit();
      // A window the host console opened to present on a TV (R25 part b): Exit closes it.
      // (The opener may be gone: the console tab was closed. Closing still works for a window a
      // script opened; if the browser refuses, fall through to Home.)
      if (window.name.indexOf('sbs-tv-') === 0) {
        window.close();
        if (window.closed) return;
      }
      if (from === 'board') {
        // Back to this board's Game Day (Home if it cannot be loaded).
        try { window.history.replaceState(null, '', `${location.pathname}${location.search}`); } catch (e) { /* nothing to undo */ }
        try { SBS.openGame(await SBS.api.getGame(id)); } catch (e) { SBS.go({ screen: 'home' }); }
        return;
      }
      window.location.hash = '';
      SBS.go({ screen: 'home' });
    }
    let partyHist = null;
    exitBtn.addEventListener('click', () => { if (!partyHist || !partyHist.exit()) leaveTV(); });

    controls.appendChild(fsBtn);
    // A paired TV has no host to go back to: no Exit.
    if (!paired) controls.appendChild(exitBtn);

    const stopFsWatch = SBS.ui.fullscreen.onChange(syncFsLabel);
    syncFsLabel();

    // Best-effort: browsers only grant fullscreen off a user gesture, so this
    // silently no-ops when TV view was reached without one (e.g. the
    // auto-launch on a fresh TV-browser load) — the Fullscreen button in the
    // controls remains the fallback.
    if (!SBS.ui.fullscreen.active()) {
      SBS.ui.fullscreen.enter().then(syncFsLabel);
    }

    let idleTimer = null;
    function wake() {
      screenEl.classList.remove('chrome-hidden');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => screenEl.classList.add('chrome-hidden'), 3000);
    }
    ['mousemove', 'touchstart', 'keydown'].forEach(ev => screenEl.addEventListener(ev, wake));
    wake();

    // Opened from Game Day in this tab: the hash makes a reload land here again, and Exit goes back.
    // Opened from Home, the same (Exit goes Home).
    if (from === 'board' || from === 'home') {
      try { window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}#tv-${id}`); } catch (e) { /* the hash is only for reloads */ }
    }
    // Back on a phone or TV remote leaves Party View like Exit. A paired TV has no Exit, so no entry.
    if (!paired) partyHist = SBS.ui.partyHistory(id, from, leaveTV);
    // Held while Party View is up; a touch device that cannot hold it gets a one-time Auto-Lock tip.
    const releaseWakeLock = SBS.ui.keepPartyAwake(screenEl, !!paired);

    // ---- Quarter-end celebration ----
    // Fires whenever a quarter transitions from unresolved to "has a winner",
    // however that happened: the ESPN live-score poll auto-filling a score,
    // the host typing one in on the board, or a phone score entry — this
    // screen's own 4s poll (see load() below) is what actually notices it.
    // `prevResolved` starts null so the very first load never celebrates
    // quarters that were already won before the TV screen opened.
    let prevResolved = null;
    let celebrationQueue = [];
    let celebrating = false;
    let celebrationEl = null;
    let celebrationDismissTimer = null;
    let celebrationBurstTimer = null;

    // Set once the Final quarter's own celebration card has run its course;
    // the persistent winners summary (built below) takes over the whole
    // screen at that point and load() stops touching the board underneath
    // it — but keeps polling and re-deriving the summary itself, so a score
    // corrected after the fact (a push edited back into a real win, say)
    // still updates the totals and pills instead of freezing forever.
    let finalSummaryShown = false;
    let finalSummaryEl = null;
    let finalSummaryBurstTimer = null;
    let finalSummarySignature = null;
    let lastGame = null;

    // ---- Corner QR: scan-to-view-your-squares ----
    // Both the true blank corner of the outer team-label grid (above/left of
    // the table entirely) and the table's own blank corner cell (top-left of
    // the numbers) are dead space — always, regardless of game state, since
    // neither ever shows real game info. So instead of squeezing the QR into
    // just the smaller of the two, cornerQrBig spans their combined
    // rectangle: from the outer grid's actual top-left corner down to the
    // table corner cell's bottom-right. Points at the read-only player
    // companion view (see screen-player.js's own showPlayerLink, which this
    // mirrors inline instead of behind a modal). Fetched once per TV session
    // — the LAN address doesn't change mid-game — but its on-screen size and
    // position are re-measured on every board rebuild and viewport change,
    // since both blank rectangles are sized by layout, not fixed pixels.
    let cornerQrReady = false;
    function positionCornerQrBig() {
      if (!cornerQrReady) return;
      const outer = boardWrap.querySelector('.board-grid-outer');
      const corner = boardWrap.querySelector('.cell.head.corner');
      if (!outer || !corner) return;
      const hostRect = boardOuter.getBoundingClientRect();
      const outerRect = outer.getBoundingClientRect();
      const cornerRect = corner.getBoundingClientRect();
      // outerRect is .board-grid-outer's border box, which includes its own
      // neon border + padding ring (see .tv-screen .board-grid-outer). Start
      // the QR box inside that ring — at the outer grid's actual content
      // edge — instead of at its border-box edge, so that ring stays visible
      // all the way around instead of getting painted over by the QR panel.
      const outerStyle = getComputedStyle(outer);
      const insetX = parseFloat(outerStyle.borderLeftWidth) + parseFloat(outerStyle.paddingLeft);
      const insetY = parseFloat(outerStyle.borderTopWidth) + parseFloat(outerStyle.paddingTop);
      const left = outerRect.left + insetX;
      const top = outerRect.top + insetY;
      const w = cornerRect.right - left;
      const h = cornerRect.bottom - top;
      cornerQrBig.style.left = (left - hostRect.left) + 'px';
      cornerQrBig.style.top = (top - hostRect.top) + 'px';
      cornerQrBig.style.width = w + 'px';
      cornerQrBig.style.height = h + 'px';
      // Padding as a percentage of this box's own size, not CSS `%` (which
      // resolves against the containing block — the whole board, hundreds
      // of pixels wider — and so would demand more padding than this small
      // box has room for, inflating it right back out to roughly that
      // width regardless of the explicit size just set above).
      cornerQrBig.style.padding = Math.round(Math.min(w, h) * 0.1) + 'px';
    }
    function syncCornerLayout() {
      if (!boardWrap.querySelector('.board-grid-outer')) return;
      SBS.board.syncCornerInsets(boardWrap);
      positionCornerQrBig();
    }
    function setCornerQr(game) {
      // Before the lock the join panel (below) has the QR; hide this one so the
      // screen never shows two codes that mean different things.
      cornerQrBig.style.display = joiningNow(game) ? 'none' : '';
      const url = `${location.origin}${location.pathname}#player-${id}`;
      if (url === cornerQrKey) return;
      try {
        cornerQrBig.innerHTML = window.QRCode.toSvg(url, 200)
          + '<div class="tv-corner-qr-label"><span>Your squares</span></div>';
        cornerQrKey = url;
        cornerQrReady = true;
        positionCornerQrBig();
      } catch (e) {
        // Best-effort — the corner just stays blank if this fails.
      }
    }
    let cornerQrKey = null;

    // Pre-lock join panel (R22): a big QR for /<code> and the code in text,
    // beside the filling board. Gone once the board locks.
    const joinPanel = el('div', 'tv-join-panel');
    joinPanel.hidden = true;
    boardOuter.insertBefore(joinPanel, boardWrap.nextSibling);
    let joinPanelKey = null;
    function joiningNow(game) { return game.status === 'picking' && !!game.joinCode; }
    function syncJoinPanel(game) {
      const on = joiningNow(game);
      joinPanel.hidden = !on;
      if (!on) { joinPanelKey = null; return; }
      // The title says what the scan does: with guest picks on, it lets them claim squares.
      const title = game.guestPick && game.guestPick.on ? 'Scan to pick your squares' : 'Scan to join';
      const key = game.joinCode + '|' + title;
      if (joinPanelKey === key) return;
      try {
        const url = `${location.origin}/${game.joinCode}`;
        joinPanel.innerHTML = `<div class="tv-join-title">${title}</div>${window.QRCode.toSvg(url, 300)}`
          + `<div class="tv-join-or">or go to</div><div class="tv-join-url">${escapeHtml(location.host)}</div>`
          + `<div class="tv-join-or">and enter</div><div class="tv-join-code-big">${escapeHtml(game.joinCode)}</div>`
          + `<div class="tv-join-host">Host your own board: ${escapeHtml(location.host)}/?ref=${escapeHtml(game.joinCode)}</div>`;
        joinPanelKey = key;
      } catch (e) {
        joinPanel.hidden = true; // best-effort, like the corner QR
      }
    }
    window.addEventListener('resize', syncCornerLayout);
    SBS.onLeaveScreen(() => window.removeEventListener('resize', syncCornerLayout));
    // Belt and suspenders beyond the resize/fullscreen hooks above: boardWrap
    // itself changes size for reasons neither of those catch — most notably
    // a web font finishing its swap after first paint and nudging the
    // header's height, which reflows how much room is left for the grid
    // below it. ResizeObserver watches boardWrap's own box directly (it
    // persists across board rebuilds — only its innerHTML gets replaced —
    // so one observer keeps working across every renderFullBoard call).
    if (window.ResizeObserver) {
      const cornerLayoutObserver = new ResizeObserver(() => syncCornerLayout());
      cornerLayoutObserver.observe(boardWrap);
      SBS.onLeaveScreen(() => cornerLayoutObserver.disconnect());
    }

    // ---- Score-change axis ripple ----
    // Whenever the live score changes (either team), the axis number
    // matching EACH team's current last digit — the square that would
    // win if the game ended right now — fires five staggered rings, on
    // both axes together, so the room's eye is drawn straight to it
    // without the number itself moving. `null` (not yet seen a score at
    // all) never triggers it, only an actual change once a first value
    // has been seen.
    let lastLiveScoreKey = null;
    function rippleAxisCell(cell) {
      if (!cell) return;
      cell.querySelectorAll('.score-ring').forEach(r => r.remove());
      for (let i = 0; i < 5; i++) {
        const ring = document.createElement('span');
        ring.className = 'score-ring r' + (i + 1);
        cell.appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove());
      }
    }
    function bumpAxisCells(game) {
      const live = game.liveScore;
      if (!live || live.a === null || live.a === undefined || live.b === null || live.b === undefined) return;
      if (!game.axisX || !game.axisY) return;

      const key = live.a + '-' + live.b;
      const firstSeen = lastLiveScoreKey === null;
      const changed = key !== lastLiveScoreKey;
      lastLiveScoreKey = key;
      if (!changed || firstSeen) return;

      const colIdx = game.axisX.indexOf(live.b % 10);
      const rowIdx = game.axisY.indexOf(live.a % 10);
      rippleAxisCell(boardWrap.querySelectorAll('.cell.head.x')[colIdx]);
      rippleAxisCell(boardWrap.querySelectorAll('.cell.head.y')[rowIdx]);
    }

    // "Kickoff in 1d 03:22:07" — days only shown once there's more than a
    // day left, so the common case doesn't waste width on a leading "0d".
    function formatCountdown(ms) {
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      const clock = [hours, mins, secs].map(n => String(n).padStart(2, '0')).join(':');
      return days > 0 ? `${days}d ${clock}` : clock;
    }

    function tickKickoffCountdown() {
      const game = lastGame;
      // Same pill, repurposed: once ESPN reports halftime (see
      // server-livescore.js's STATUS_HALFTIME handling), show that instead of
      // a countdown — there's nothing to count down to until 2nd half kickoff.
      if (game && game.liveScore && game.liveScore.statusName === 'STATUS_HALFTIME') {
        kickoffCountdown.classList.remove('hidden');
        kickoffCountdown.innerHTML = `<span class="tv-kickoff-label">Halftime</span>`;
        return;
      }
      const kickoffMs = game && game.kickoffTime ? Date.parse(game.kickoffTime) : NaN;
      // Deliberately not gated on game.status: the grid is routinely locked
      // (status -> 'started') well ahead of the actual kickoff once squares
      // fill up, and the countdown should keep counting down through that —
      // only real kickoff time (or a finished game, which is never still
      // pre-kickoff) makes it disappear.
      if (!game || isNaN(kickoffMs) || game.status === 'finished') {
        kickoffCountdown.classList.add('hidden');
        return;
      }
      const diff = kickoffMs - Date.now();
      if (diff <= 0) {
        kickoffCountdown.classList.add('hidden');
        return;
      }
      kickoffCountdown.classList.remove('hidden');
      kickoffCountdown.innerHTML = `<span class="tv-kickoff-label">Kickoff in</span><span class="tv-kickoff-clock">${formatCountdown(diff)}</span>`;
    }
    tickKickoffCountdown();
    const kickoffCountdownTimer = setInterval(tickKickoffCountdown, 1000);

    // ---- "Host changed …" for ten minutes after a change (R43) ----
    // Judged on each poll; the line exists only while there is something to say.
    let changeLine = null;
    function syncChangeLine(game) {
      const text = game ? SBS.playerHome.tvChangeText(game, Date.now()) : '';
      if (!text) {
        if (changeLine) { changeLine.remove(); changeLine = null; }
        return;
      }
      if (!changeLine) {
        changeLine = el('div', 'tv-change-line');
        changeLine.setAttribute('role', 'status');
        screenEl.insertBefore(changeLine, tvQuarters);
      }
      if (changeLine.textContent !== text) changeLine.textContent = text;
    }

    // ---- Randomly-drawn Final winner reveal (mirrors the board's) ----
    // While this is playing, the normal quarter-win celebration for Final is
    // held back so the trophy card doesn't pop up mid-spin — checkForNewWinners
    // runs for it once the reveal's onDone fires instead.
    let lastSeenDrawAt = null;
    let activeDrawReveal = null;
    let drawRevealActive = false;

    // Persistent "no winner yet" notice while the Final score is in but its
    // winning square is empty — up for as long as needsDraw stays true.
    let needsDrawBannerEl = null;
    function showNeedsDrawBanner() {
      if (needsDrawBannerEl) return;
      const overlay = el('div', 'tv-needsdraw-overlay');
      overlay.innerHTML = `
        <div class="tv-needsdraw-card">
          <div class="tv-needsdraw-icon">🎟️</div>
          <div class="tv-needsdraw-title">No Winner Yet</div>
          <div class="tv-needsdraw-body">The winning square for the Final score is empty — we'll be randomly picking a winner shortly.</div>
        </div>
      `;
      screenEl.appendChild(overlay);
      needsDrawBannerEl = overlay;
    }
    function hideNeedsDrawBanner() {
      if (needsDrawBannerEl) { needsDrawBannerEl.remove(); needsDrawBannerEl = null; }
    }

    // The grid is only rebuilt when something that actually changes its
    // pixels changes — a claimed/paid square, a quarter badge, or the live
    // winner/near-miss highlight. Without this, every 4s poll rebuilt the
    // whole board even when only the live clock ticked, which snapped the
    // live-winner ping/glow animations back to frame zero and read as a
    // flash every few seconds.
    let lastBoardSignature = null;

    function quarterLabel(q) { return q === 'final' ? 'Final Score' : QLABEL[q]; }

    function checkForNewWinners(computed) {
      const snapshot = {};
      QUARTERS.forEach(q => { snapshot[q] = !!(computed.results[q].resolved && computed.results[q].winnerName); });
      if (prevResolved) {
        QUARTERS.forEach(q => {
          if (snapshot[q] && !prevResolved[q]) {
            const res = computed.results[q];
            celebrationQueue.push({ name: res.winnerName, quarter: quarterLabel(q), amount: money(res.amount), isFinal: q === 'final' });
          }
        });
        if (celebrationQueue.length && !celebrating) playNextCelebration();
      }
      prevResolved = snapshot;
    }

    function moneyPiece() {
      const p = el('div', 'tv-celebration-piece');
      const left = Math.random() * 100;
      const delay = Math.random() * 0.5;
      const dur = 1.7 + Math.random() * 0.9;
      const rot = Math.random() * 360;
      const spin = (360 + Math.random() * 540) * (Math.random() < 0.5 ? -1 : 1);
      const drift = Math.random() * 80 - 40;
      const vars = `animation-duration:${dur}s; animation-delay:${delay}s; --rot:${rot}deg; --spin:${spin}deg; --drift:${drift}px;`;
      if (Math.random() < 0.75) {
        const w = 14 + Math.random() * 6;
        p.style.cssText = `left:${left}%; width:${w}px; height:${w * 0.46}px; background:#3f8f4f; border:1px solid #cfead6; border-radius:2px; display:flex; align-items:center; justify-content:center; color:#cfead6; font-size:${w * 0.4}px; font-weight:800; line-height:1; ${vars}`;
        p.textContent = '$';
      } else {
        const s = 9 + Math.random() * 4;
        p.style.cssText = `left:${left}%; width:${s}px; height:${s}px; border-radius:50%; background:#e8b923; border:1px solid #fbe08a; ${vars}`;
      }
      // The quarter-win celebration always tears its whole overlay down
      // within a minute, but the final summary screen can sit on the TV for
      // hours — without this, every re-burst would leave its pieces in the
      // DOM forever once their fall animation finishes.
      p.addEventListener('animationend', () => p.remove());
      return p;
    }

    function spawnMoneyBurst(container, count) {
      for (let i = 0; i < count; i++) container.appendChild(moneyPiece());
    }

    // Drops the same wandering ✦ sparkles used on the quarter-win trophy
    // onto any trophy wrapper — shared so the final summary's champion
    // trophy reads identically instead of getting its own effect.
    function appendTrophySparkles(wrap) {
      CELEBRATION_SPARKLE_SPOTS.forEach(([x, y, size, delay]) => {
        const sp = el('div', 'tv-celebration-sparkle', '✦');
        sp.style.cssText = `left:${x}px; top:${y}px; font-size:${size}px; animation-delay:${delay}s; animation-duration:${(1.3 + Math.random() * 0.6).toFixed(2)}s;`;
        wrap.appendChild(sp);
      });
    }

    function removeCelebration() {
      clearTimeout(celebrationDismissTimer);
      celebrationDismissTimer = null;
      clearInterval(celebrationBurstTimer);
      celebrationBurstTimer = null;
      if (celebrationEl) { celebrationEl.remove(); celebrationEl = null; }
    }

    function playNextCelebration() {
      if (!celebrationQueue.length) { celebrating = false; return; }
      celebrating = true;
      const item = celebrationQueue.shift();
      removeCelebration();

      const overlay = el('div', 'tv-celebration');
      spawnMoneyBurst(overlay, 50);

      const card = el('div', 'tv-celebration-card');
      const trophyWrap = el('div', 'tv-celebration-trophy');
      trophyWrap.innerHTML = trophySvgFor(lastGame && lastGame.league);
      appendTrophySparkles(trophyWrap);
      card.appendChild(trophyWrap);
      card.appendChild(el('div', 'tv-celebration-quarter', `${escapeHtml(item.quarter)} winner`));
      card.appendChild(el('div', 'tv-celebration-name', escapeHtml(item.name)));
      card.appendChild(el('div', 'tv-celebration-amount', item.amount));
      overlay.appendChild(card);

      screenEl.appendChild(overlay);
      celebrationEl = overlay;

      // Simulation Mode plays through a whole game in 8 minutes (2-minute
      // quarters), so a full 60s banner would eat a quarter of the next
      // quarter's runtime — 30s keeps it snappy without losing the celebration.
      const isSim = !!(lastGame && lastGame.simulation);
      const dismissMs = isSim ? 30000 : 60000;

      // Periodic re-bursts keep it festive across the banner's runtime without
      // nonstop falling money the whole time.
      celebrationBurstTimer = setInterval(() => spawnMoneyBurst(overlay, 18), isSim ? 8000 : 12000);

      celebrationDismissTimer = setTimeout(() => {
        removeCelebration();
        if (item.isFinal) {
          celebrating = false;
          showFinalSummary();
        } else {
          playNextCelebration();
        }
      }, dismissMs);
    }

    // ---- Final summary screen ----
    // Every player who won at least one quarter, ranked by their total
    // winnings (ties share a rank — standard competition ranking, so two
    // people tied for 2nd both show "2nd" and the next rank is 4th).
    // A pushed quarter has no winner of its own — its payout just rolls into
    // whichever quarter is scored next (see compute.js). So a push's credit
    // goes to whoever ends up winning that next quarter: it's shown as an
    // extra gold "Q1 PUSH"-style pill alongside their own quarter win, on
    // top of the dollar total which already includes the carried amount.
    function computeWinnersSummary(computed, game) {
      const byName = new Map();
      let pendingPushLabels = [];
      QUARTERS.forEach(q => {
        const res = computed.results[q];
        if (!res.resolved) return;
        if (res.pushed) {
          pendingPushLabels.push(QLABEL[q]);
          return;
        }
        if (!res.winnerName) return;
        const entry = byName.get(res.winnerName) || { name: res.winnerName, quarters: [], pushLabels: [] };
        entry.quarters.push({ label: QLABEL[q], amount: res.amount, drawn: res.autoResolved ? drawnDigits(game, res) : null });
        if (pendingPushLabels.length) {
          entry.pushLabels = entry.pushLabels.concat(pendingPushLabels);
          pendingPushLabels = [];
        }
        byName.set(res.winnerName, entry);
      });
      const winners = Array.from(byName.values());
      winners.forEach(w => { w.total = w.quarters.reduce((sum, q) => sum + q.amount, 0); });
      winners.sort((a, b) => b.total - a.total);
      let prevTotal = null, prevRank = 0;
      winners.forEach((w, i) => {
        w.rank = (w.total === prevTotal) ? prevRank : i + 1;
        prevTotal = w.total;
        prevRank = w.rank;
      });
      return winners;
    }

    function removeFinalSummary() {
      clearInterval(finalSummaryBurstTimer);
      finalSummaryBurstTimer = null;
      if (finalSummaryEl) { finalSummaryEl.remove(); finalSummaryEl = null; }
    }

    // Replaces the board entirely once the Final celebration card closes, and
    // stays up until the host taps Exit. load() keeps calling this on every
    // poll while it's showing (see below) so a late correction — a push
    // edited back into a real win, a winner's name fixed, and so on — still
    // reaches the screen; the signature check below is what stops that from
    // rebuilding (and re-flashing) the whole overlay on every single poll
    // when nothing about the winners actually changed.
    function showFinalSummary() {
      if (!lastGame) return;
      finalSummaryShown = true;

      const computed = computeGame(lastGame);
      const winners = computeWinnersSummary(computed, lastGame);
      const finalRes = computed.results.final;

      const signature = JSON.stringify({ winners, a: finalRes.a, b: finalRes.b, pot: computed.pot });
      if (signature === finalSummarySignature && finalSummaryEl) return;
      finalSummarySignature = signature;
      removeFinalSummary();

      const overlay = el('div', 'tv-final-summary');
      spawnMoneyBurst(overlay, 40);

      const head = el('div', 'tvfs-head');
      const trophyWrap = el('div', 'tvfs-champion-trophy');
      trophyWrap.innerHTML = trophySvgFor(lastGame && lastGame.league);
      appendTrophySparkles(trophyWrap);
      head.appendChild(trophyWrap);
      head.appendChild(el('div', 'tvfs-eyebrow', 'Game Complete'));
      const scoreLine = el('div', 'tvfs-score badge-fit');
      scoreLine.innerHTML = `
        ${teamBadge(lastGame, 'A', { logoSize: 26, cls: 'team-badge-sm' })}
        <span class="tvfs-score-digits">${finalRes.a}&ndash;${finalRes.b}</span>
        ${teamBadge(lastGame, 'B', { logoSize: 26, cls: 'team-badge-sm' })}
      `;
      head.appendChild(scoreLine);
      head.appendChild(el('div', 'tvfs-sub', `Final pot <span class="tvfs-pot">${money(computed.pot)}</span> &middot; ${winners.length} winner${winners.length === 1 ? '' : 's'}`));
      overlay.appendChild(head);

      const board = el('div', 'tvfs-board');
      winners.forEach(w => {
        const row = el('div', 'tvfs-row' + (w.rank <= 3 ? ' rank-' + w.rank : ''));
        const wonTrophies = w.quarters.map(q => `<span class="tvfs-qtrophy">${MINI_TROPHY_SVG}${q.label}${q.drawn ? ` <span class="tvfs-drawn">(Drawn ${q.drawn.y}-${q.drawn.x})</span>` : ''}</span>`);
        const pushTrophies = w.pushLabels.map(label => `<span class="tvfs-qtrophy">${MINI_TROPHY_SVG}${label} PUSH</span>`);
        const trophies = wonTrophies.concat(pushTrophies).join('');
        row.innerHTML = `
          <div class="tvfs-rank">${w.rank}</div>
          <div class="tvfs-main">
            <div class="tvfs-name">${escapeHtml(w.name)}</div>
            <div class="tvfs-trophies">${trophies}</div>
          </div>
          <div class="tvfs-amount">
            <div class="tvfs-amount-val">${money(w.total)}</div>
            <div class="tvfs-amount-lbl">${w.quarters.length} quarter${w.quarters.length === 1 ? '' : 's'}</div>
          </div>
        `;
        board.appendChild(row);
      });
      overlay.appendChild(board);

      screenEl.appendChild(overlay);
      finalSummaryEl = overlay;
      fitTeamBadges(overlay);

      // Same idea as the quarter celebration's re-bursts, just slower — this
      // screen can be up for a long time, not just a minute.
      finalSummaryBurstTimer = setInterval(() => spawnMoneyBurst(overlay, 14), 14000);
    }

    // Leaving the TV route tears down everything the screen installed.
    SBS.onLeaveScreen(() => {
      clearTimeout(idleTimer);
      clearInterval(kickoffCountdownTimer);
      stopFsWatch();
      releaseWakeLock();
      removeCelebration();
      removeFinalSummary();
      hideNeedsDrawBanner();
      if (activeDrawReveal) { activeDrawReveal.cancel(); activeDrawReveal = null; }
      celebrationQueue = [];
      document.body.classList.remove('tv-mode', 'tv-fullscreen');
    });

    // Read-only, single-row summary of all four quarters — full team pills
    // (matching the rest of the app) but no score inputs, so the board
    // underneath keeps almost all of the screen.
    function renderTvQuarters(game, computed) {
      const badgeA = teamBadge(game, 'A', { logoSize: 18, cls: 'team-badge-sm' });
      const badgeB = teamBadge(game, 'B', { logoSize: 18, cls: 'team-badge-sm' });
      tvQuarters.innerHTML = QUARTERS.map(q => {
        const res = computed.results[q];
        const scoreTxt = (res.a === null || res.b === null) ? '– – –' : `${res.a}–${res.b}`;
        let statusTxt, statusCls;
        if (res.a === null || res.b === null) {
          statusTxt = 'Awaiting'; statusCls = 'pending';
        } else if (res.resolved && res.pushed) {
          statusTxt = SBS.board.pushText(computed.results, q); statusCls = 'push';
        } else if (res.resolved && res.winnerName) {
          statusTxt = res.winnerName; statusCls = 'win';
          if (res.autoResolved) {
            const digits = drawnDigits(game, res);
            if (digits) statusTxt += ` (Drawn ${digits.y}-${digits.x})`;
          }
        } else if (q === 'final' && res.needsDraw) {
          statusTxt = 'Needs draw'; statusCls = 'push';
        } else {
          statusTxt = '—'; statusCls = 'pending';
        }
        return `
          <div class="tv-qchip ${statusCls}">
            <div class="tvq-top"><span class="tvq-label">${QLABEL[q]}</span><span class="tvq-amt">${money(payoutAmount(res))}</span></div>
            <div class="tvq-score badge-fit">
              ${badgeA}
              <span class="tvq-digits">${scoreTxt}</span>
              ${badgeB}
            </div>
            <div class="tvq-status">${escapeHtml(statusTxt)}</div>
          </div>
        `;
      }).join('');
    }

    async function load() {
      if (SBS.currentScreen() !== 'tv') return;
      try {
        const game = await SBS.api.pollGame(id, { must: !lastGame });
        if (!game) return;
        lastGame = game;
        applyTeamColors(game);
        syncChangeLine(game);
        syncJoinPanel(game);
        setCornerQr(game);

        // Numbers haven't been drawn yet, so there are no quarter results or
        // winners to show — but the grid itself is exactly what the room
        // wants to watch fill up as people claim squares, so it stays up
        // (with blank "–" axis headers) under the remaining/pot counts.
        if (game.status === 'picking') {
          hideNeedsDrawBanner();
          header.innerHTML = '';
          tvQuarters.innerHTML = '';
          const filled = game.squares.filter(s => s).length;
          const computed = computeGame(game);
          // No paid or unpaid figures here: the TV never shows who owes.
          const info = el('div', 'tv-picking-info');
          const joinPart = game.joinCode
            ? `<span>Join Code: <span class="tv-picking-val tv-join-code">${escapeHtml(game.joinCode)}</span></span>` : '';
          info.innerHTML = `
            <div class="tv-picking-line tv-picking-pill">
              <span>Squares Available: <span class="tv-picking-val">${100 - filled}</span></span>
              <span>Total Pot: <span class="tv-picking-val">${money(computed.pot)}</span></span>
              ${joinPart}
            </div>
          `;
          header.appendChild(info);

          const boardSignature = JSON.stringify({ squares: game.squares, players: game.players });
          if (boardSignature !== lastBoardSignature) {
            lastBoardSignature = boardSignature;
            SBS.board.renderFullBoard(boardWrap, game, computed, null);
            fitTeamBadges(boardWrap);
            positionCornerQrBig();
          }
          return;
        }

        const computed = computeGame(game);

        // A "Randomly Draw Winner" click (board or phone) is resolved and
        // persisted instantly, so the Final quarter already reads as won on
        // this very poll — but the room should see the countdown/spin first.
        // Detect the shared drawnAt timestamp and, if the sequence hasn't
        // already played out elsewhere, run it here too before letting the
        // normal celebration flow announce the winner.
        const finalEntry = game.results && game.results.final;
        // Ignore a stored draw the current score no longer uses.
        const drawInfo = computed.results.final.autoResolved && finalEntry && finalEntry.autoResolve;
        if (drawInfo && drawInfo.drawnAt && drawInfo.drawnAt !== lastSeenDrawAt) {
          lastSeenDrawAt = drawInfo.drawnAt;
          const elapsed = Date.now() - drawInfo.drawnAt;
          if (elapsed < DRAW_CATCHUP_WINDOW_MS && !finalSummaryShown) {
            drawRevealActive = true;
            if (activeDrawReveal) activeDrawReveal.cancel();
            activeDrawReveal = playDrawReveal({
              game, row: drawInfo.row, col: drawInfo.col, elapsedMs: elapsed,
              onDone: () => {
                activeDrawReveal = null;
                drawRevealActive = false;
                if (SBS.currentScreen() === 'tv') checkForNewWinners(computeGame(lastGame));
              }
            });
          }
        }

        // Up for as long as the Final score is in but its winning square is
        // still empty — disappears the instant a draw resolves it (needsDraw
        // and resolved/autoResolved are mutually exclusive in computeGame).
        if (computed.results.final.needsDraw) {
          showNeedsDrawBanner();
        } else {
          hideNeedsDrawBanner();
        }

        if (finalSummaryShown) {
          const finalRes = computed.results.final;
          if (finalRes.resolved && finalRes.winnerName) {
            // Still finished — re-derive the summary; it only actually
            // rebuilds the DOM when a correction changed something.
            showFinalSummary();
            return;
          }
          // The host cleared or edited Final back to unresolved — drop back
          // to the live board instead of leaving a stale summary up.
          finalSummaryShown = false;
          finalSummarySignature = null;
          removeFinalSummary();
        }

        if (!drawRevealActive) checkForNewWinners(computed);
        header.innerHTML = '<div class="tv-meta"></div>';
        const liveBar = SBS.board.renderLiveScoreBar(game);
        if (liveBar) header.querySelector('.tv-meta').appendChild(liveBar);
        fitTeamBadges(header);
        renderTvQuarters(game, computed);
        fitTeamBadges(tvQuarters);
        const liveHighlight = window.GameLogic.computeLiveHighlight(game);
        const boardSignature = JSON.stringify({
          squares: game.squares,
          players: game.players,
          cellLabels: computed.cellLabels,
          win: liveHighlight ? liveHighlight.winnerKey : null,
          near: liveHighlight ? Array.from(liveHighlight.nearKeys).sort() : null
        });
        if (boardSignature !== lastBoardSignature) {
          lastBoardSignature = boardSignature;
          SBS.board.renderFullBoard(boardWrap, game, computed, liveHighlight);
          fitTeamBadges(boardWrap);
          positionCornerQrBig();
        }
        bumpAxisCells(game);
      } catch (e) {
        // Deleted on another device — nothing left here to show.
        if (e && e.status === 404) {
          if (paired) {
            syncChangeLine(null);
            // The host's board is gone; stay and keep checking the pairing for the next one.
            header.innerHTML = '<div class="error-msg">This board is no longer available. Waiting for the host…</div>';
            return;
          }
          SBS.go({ screen: 'home' });
          return;
        }
        header.innerHTML = `<div class="error-msg">Could not load this game: ${escapeHtml(e.message)}</div>`;
      }
    }

    load();
    SBS.setManagedInterval(load, 4000);

    // A paired TV keeps asking its token which board it is for, at the same cadence, so
    // when the host opens another locked board the TV moves with them. It holds only the
    // token: no session, nothing that writes.
    if (paired) {
      let checking = false;
      SBS.setManagedInterval(async () => {
        if (checking || SBS.currentScreen() !== 'tv') return;
        checking = true;
        try {
          const r = await SBS.api.getTv(SBS.tvToken.get() || '');
          if (SBS.currentScreen() !== 'tv') return;
          if (r.state === 'paired' && r.gameId !== id) SBS.go({ screen: 'tv', id: r.gameId, paired: true });
          else if (r.state !== 'paired') SBS.go({ screen: 'tv-pair' });
        } catch (e) {
          // Unknown or expired: get a new code. Anything else (offline): keep showing the board.
          if (e && e.status === 404 && SBS.currentScreen() === 'tv') { SBS.tvToken.clear(); SBS.go({ screen: 'tv-pair' }); }
        } finally {
          checking = false;
        }
      }, 4000);
    }
  }

  SBS.screens.board = renderBoard;
  SBS.screens.tv = renderTV;
})();
