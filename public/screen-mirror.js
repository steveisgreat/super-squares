// Mirror mode for one phone (R26). A host with no second device mirrors this phone's screen to
// the TV (AirPlay, Cast, Smart View), so everything on it is seen by the room. The screen is
// the Party View board with no private data (no paid or unpaid marks, no money owed, no
// Players), its own portrait layout (R29: score, winning now, the board fitted to the width, the
// quarters 2 x 2), and a score strip that a tap
// brings up and that hides again 3 s after the last touch. Host only: a game id alone never
// opens it (the role check below), and every score tap is still authorized by the server.
// A guest opens the same view read-only from Player View (R44): no role check, no score strip, no
// mirroring tips, their own squares outlined and a small label for a tapped square. The address
// stays the Player View's, so a reload never lands a guest on the host's route.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, teamBadge, teamLogoTag, fitTeamBadges, applyTeamColors } = SBS.ui;
  const { QUARTERS, QLABEL, computeGame, payoutAmount, drawnDigits } = window.GameLogic;

  const STRIP_MS = 3000;
  const POLL_MS = 8000;
  const GUEST_POLL_MS = 15000; // as Player View: this one scales with the party
  const TIP_KEY = 'sbs.mirror.tip';
  const HOME_TIP_KEY = 'sbs.mirror.hometip';
  // Tabler "cast" and "device-mobile-share" (MIT, 24 px outline).
  const CAST_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19l.01 0"/><path d="M7 19a4 4 0 0 0 -4 -4"/><path d="M11 19a8 8 0 0 0 -8 -8"/><path d="M15 19h3a3 3 0 0 0 3 -3v-8a3 3 0 0 0 -3 -3h-12a3 3 0 0 0 -2.8 2"/></svg>';
  const ROTATE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21h-4a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8"/><path d="M11 4h2"/><path d="M16 22l5 -5"/><path d="M21 21.5v-4.5h-4.5"/><path d="M12 17v.01"/></svg>';

  // Each tip is remembered per browser once dismissed.
  function tipDismissed(key) {
    try { return window.localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }
  function dismissTip(key) {
    try { window.localStorage.setItem(key, '1'); } catch (e) { /* hidden for this visit only */ }
  }

  // An iPhone browser has no fullscreen for a page. Opened from the Home Screen there is no browser
  // around it (navigator.standalone is then true), so that is worth saying once.
  function inIphoneBrowser() {
    return /iPhone|iPod/.test(navigator.userAgent || '') && navigator.standalone !== true;
  }

  // A dialog the score panel opened (confirm, alert) keeps the strip up until it closes.
  function dialogOpen() {
    // ui.js dialogs are fixed overlays added straight to the body, outside #app.
    return Array.prototype.some.call(document.body.children, n => n.tagName === 'DIV' && n.id !== 'app' && n.style.position === 'fixed');
  }

  // `guest`: { nameFor(game) -> the name this phone shows or null, game: the board as Player View
  // had it, back: the route to return to }. Absent for the host.
  function renderMirror(id, from, guest) {
    const app = SBS.appEl;
    app.innerHTML = '';
    if (!guest) {
      try { window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}#mirror-${id}`); } catch (e) { /* the hash is only for reloads */ }
    }
    // Back (the phone's gesture or button) leaves Party View like Exit. The history entry also
    // remembers where Party View was opened from, so Exit still goes Home after a reload.
    const partyHist = SBS.ui.partyHistory(id, from, () => leave());
    from = partyHist.from;

    // tv-mode is what keeps unpaid marks off the board (board.js): this screen is the room's view.
    document.body.classList.add('tv-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('tv-mode'));
    const screenEl = el('div', 'tv-screen mirror-screen' + (guest ? ' is-guest' : ''));
    app.appendChild(screenEl);

    let game = null;
    let closed = false;
    let scorePanel = null;
    let stripTimer = null;
    let lastBoardSignature = null;
    // Held while Party View is up; a phone that cannot hold it gets a one-time Auto-Lock tip.
    const releaseWakeLock = guest ? () => {} : SBS.ui.keepPartyAwake(screenEl, false);

    // ---- Exit (small, top corner) ----
    const exitBtn = el('button', 'mirror-exit', 'Exit');
    exitBtn.type = 'button';
    exitBtn.setAttribute('aria-label', guest ? 'Exit the board' : 'Exit Party View');
    exitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!partyHist.exit()) leave();
    });
    function leave() {
      closed = true;
      if (guest) { SBS.go(guest.back); return; }
      try { window.history.replaceState(null, '', `${location.pathname}${location.search}`); } catch (e) { /* nothing to undo */ }
      // Opened from Home: Exit goes back to Home. Otherwise to the board once it has loaded.
      if (from !== 'home' && game && game.squares) SBS.go({ screen: 'board', game });
      else SBS.go({ screen: 'home' });
    }

    // ---- Board and score header ----
    const main = el('div', 'mirror-main');
    screenEl.appendChild(main);
    const boardOuter = el('div', 'tv-board-outer mirror-board');
    const boardWrap = el('div', 'tv-board-wrap');
    boardOuter.appendChild(boardWrap);
    main.appendChild(boardOuter);
    const side = el('div', 'mirror-side');
    const header = el('div', 'tv-header mirror-header');
    const quarters = el('div', 'tv-quarters mirror-quarters');
    side.append(exitBtn, header, quarters);
    main.appendChild(side);

    // ---- Portrait layout (CSS shows these only upright): score, winning now, a hint ----
    const pscore = el('div', 'mirror-pscore');
    const winning = el('div', 'mirror-winning');
    winning.hidden = true;
    const hint = el('div', 'mirror-hint', `${ROTATE_ICON}<span>Turn sideways for a bigger board</span>`);
    header.after(winning);
    header.before(pscore);
    screenEl.appendChild(hint);

    // ---- Tips, one at a time: (iPhone browser) the Home Screen, then Do Not Disturb ----
    const tips = guest ? [] : [{ key: TIP_KEY, text: "Mirroring? Turn on Do Not Disturb so messages don't show on the TV." }];
    if (!guest && inIphoneBrowser()) tips.unshift({ key: HOME_TIP_KEY, cls: ' is-home', text: 'Want full screen? Tap Share, then Add to Home Screen, and open the app from its icon.' });
    function nextTip() {
      const t = tips.find(x => !x.seen && !tipDismissed(x.key));
      if (!t) return;
      const tip = el('div', 'mirror-tip' + (t.cls || ''));
      tip.setAttribute('role', 'note');
      const ok = el('button', 'mirror-tip-ok', 'Got it');
      ok.type = 'button';
      ok.addEventListener('click', (e) => { e.stopPropagation(); t.seen = true; dismissTip(t.key); tip.remove(); nextTip(); });
      tip.append(el('span', '', t.text), ok);
      side.appendChild(tip);
    }
    nextTip();

    // ---- Guest: a small label for the tapped square ----
    const label = el('div', 'mirror-label');
    label.setAttribute('role', 'status');
    let shownCell = null; // the square the label names
    let focusCell = 0;    // the one square Tab stops on; arrows move from it
    if (guest) screenEl.appendChild(label);
    else SBS.board.tapNames(main); // phone widths show initials
    const squareCells = () => Array.from(boardWrap.querySelectorAll('.board-table .cell:not(.head)'));
    function hideLabel() {
      shownCell = null;
      label.textContent = '';
      label.classList.remove('is-on');
    }
    function showLabel(i) {
      const cell = squareCells()[i];
      if (!cell) return hideLabel();
      shownCell = i;
      const sq = game.squares[i];
      const row = Math.floor(i / 10), col = i % 10;
      const where = game.axisX && game.axisY
        ? `${SBS.ui.teamStyle(game, 'A').abbr} ${game.axisY[row]} | ${game.axisX[col]} ${SBS.ui.teamStyle(game, 'B').abbr}`
        : `Row ${row + 1}, column ${col + 1}`;
      label.replaceChildren(SBS.ui.textEl('strong', '', sq ? sq.name : 'Open square'), SBS.ui.textEl('span', '', where));
      const quarters = SBS.board.quarterText(cell);
      if (quarters) label.appendChild(SBS.ui.textEl('span', '', quarters));
      label.classList.add('is-on');
      // Above the square, or below it near the top, and never off the side of the screen.
      const r = cell.getBoundingClientRect();
      const w = label.offsetWidth, h = label.offsetHeight;
      label.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4)}px`;
      label.style.top = `${r.top - h - 6 >= 4 ? r.top - h - 6 : r.bottom + 6}px`;
    }
    // Moves the one Tab stop.
    function stopAt(i) {
      const cells = squareCells();
      if (cells[focusCell]) cells[focusCell].tabIndex = -1;
      focusCell = i;
      cells[i].tabIndex = 0;
      return cells[i];
    }
    // After a redraw: outline this phone's squares and make the cells reachable again.
    function markGuestCells(me, hadFocus) {
      squareCells().forEach((cell, i) => {
        const sq = game.squares[i];
        const mine = !!(me && sq && sq.name === me);
        cell.classList.toggle('is-yours', mine);
        cell.dataset.i = String(i);
        cell.tabIndex = i === focusCell ? 0 : -1;
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', `Row ${Math.floor(i / 10) + 1} column ${i % 10 + 1}, ${sq ? sq.name : 'open'}${mine ? ', yours' : ''}`);
      });
      if (hadFocus) squareCells()[focusCell].focus();
      if (shownCell !== null) showLabel(shownCell);
    }
    if (guest) {
      screenEl.addEventListener('click', (e) => {
        const cell = e.target.closest('.cell[data-i]');
        if (!cell) return hideLabel();
        const i = Number(cell.dataset.i);
        stopAt(i);
        if (shownCell === i) hideLabel(); else showLabel(i);
      });
      screenEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return hideLabel();
        const cell = e.target.closest && e.target.closest('.cell[data-i]');
        if (!cell) return;
        const i = Number(cell.dataset.i);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); return; }
        const row = Math.floor(i / 10), col = i % 10;
        const next = e.key === 'ArrowLeft' ? (col ? i - 1 : i)
          : e.key === 'ArrowRight' ? (col < 9 ? i + 1 : i)
          : e.key === 'ArrowUp' ? (row ? i - 10 : i)
          : e.key === 'ArrowDown' ? (row < 9 ? i + 10 : i)
          : e.key === 'Home' ? i - col
          : e.key === 'End' ? i - col + 9 : null;
        if (next === null) return;
        e.preventDefault();
        hideLabel();
        stopAt(next).focus();
      });
      // Turning the phone moves the square out from under the label.
      window.addEventListener('resize', hideLabel);
      SBS.onLeaveScreen(() => window.removeEventListener('resize', hideLabel));
    }

    // ---- Score strip ----
    const strip = el('div', 'mirror-strip');
    strip.hidden = true;
    screenEl.appendChild(strip);

    function clearStripTimer() {
      if (stripTimer) { clearTimeout(stripTimer); stripTimer = null; }
    }
    function hideStrip() {
      clearStripTimer();
      strip.hidden = true;
      screenEl.classList.remove('strip-open');
    }
    // One timeout at a time: every touch in the strip replaces it. While a dialog is open the
    // strip stays, and is looked at again after another 3 s.
    function armStrip() {
      clearStripTimer();
      stripTimer = setTimeout(() => {
        stripTimer = null;
        if (closed) return;
        if (dialogOpen()) { armStrip(); return; }
        hideStrip();
      }, STRIP_MS);
    }
    function showStrip() {
      if (closed || !scorePanel || scorePanel.el.hidden) return;
      strip.hidden = false;
      screenEl.classList.add('strip-open');
      armStrip();
    }
    ['pointerdown', 'touchstart', 'input', 'click'].forEach(ev => {
      strip.addEventListener(ev, () => { if (!strip.hidden) armStrip(); }, true);
    });
    // A tap anywhere else brings the strip up. Taps in the strip, Exit and the tip do not.
    screenEl.addEventListener('click', (e) => {
      if (strip.contains(e.target) || e.target.closest('.mirror-exit, .mirror-tip, .sleep-tip')) return;
      showStrip();
    });

    SBS.onLeaveScreen(() => {
      closed = true;
      clearStripTimer();
      releaseWakeLock();
    });

    function makePanel() {
      scorePanel = SBS.scorePanel.create({
        getGame: () => game,
        quarters: false,
        readOnly: false, // nothing to tap while the feed keeps the score
        setGame: (g) => {
          // Resume drops liveOverride from the document; assign alone would keep the old one.
          if (!('liveOverride' in g)) delete game.liveOverride;
          Object.assign(game, g);
          drawBoard();
        }
      });
      strip.appendChild(scorePanel.el);
    }

    // What the room sees: no paid marks, no amounts owed. Prize amounts only, as on the TV.
    function drawQuarters() {
      const badgeA = teamBadge(game, 'A', { logoSize: 18, cls: 'team-badge-sm' });
      const badgeB = teamBadge(game, 'B', { logoSize: 18, cls: 'team-badge-sm' });
      const computed = computeGame(game);
      quarters.innerHTML = QUARTERS.map(q => {
        const res = computed.results[q];
        const scoreTxt = (res.a === null || res.b === null) ? '– – –' : `${res.a}–${res.b}`;
        let statusTxt = '—';
        let statusCls = 'pending';
        if (res.a === null || res.b === null) {
          statusTxt = 'Awaiting';
        } else if (res.resolved && res.pushed) {
          statusTxt = SBS.board.pushText(computed.results, q); statusCls = 'push';
        } else if (res.resolved && res.winnerName) {
          statusTxt = res.winnerName; statusCls = 'win';
          if (res.autoResolved) {
            const d = drawnDigits(game, res);
            if (d) statusTxt += ` (Drawn ${d.y}-${d.x})`;
          }
        } else if (q === 'final' && res.needsDraw) {
          statusTxt = 'Needs draw'; statusCls = 'push';
        }
        return `
          <div class="tv-qchip ${statusCls}">
            <div class="tvq-top"><span class="tvq-label">${QLABEL[q]}</span><span class="tvq-amt">${money(payoutAmount(res))}</span></div>
            <div class="tvq-score badge-fit">${badgeA}<span class="tvq-digits">${scoreTxt}</span>${badgeB}</div>
            <div class="tvq-status">${escapeHtml(statusTxt)}</div>
          </div>`;
      }).join('');
      fitTeamBadges(quarters);
    }

    // Upright header: both logos, the score, the period. Prize and names only, nothing private.
    function drawPortraitHead() {
      const live = game.liveScore;
      const has = live && live.a !== null && live.a !== undefined && live.b !== null && live.b !== undefined && live.state !== 'pre';
      const period = !has ? '' : live.completed ? 'FINAL' : [live.period ? `Q${live.period}` : '', live.clock].filter(Boolean).join(' ');
      const abbrA = SBS.ui.teamStyle(game, 'A').abbr;
      const abbrB = SBS.ui.teamStyle(game, 'B').abbr;
      pscore.innerHTML = `
        ${teamLogoTag(game, 'A', 34)}
        <span class="mirror-pnum">${has ? escapeHtml(live.a) : '–'}</span>
        <span class="mirror-pmid"><span class="mirror-pperiod">${escapeHtml(period || '')}</span><span class="mirror-pteams">${escapeHtml(abbrA)} &middot; ${escapeHtml(abbrB)}</span></span>
        <span class="mirror-pnum">${has ? escapeHtml(live.b) : '–'}</span>
        ${teamLogoTag(game, 'B', 34)}`;
      const hl = window.GameLogic.computeLiveHighlight(game);
      winning.hidden = true;
      if (hl) {
        const parts = hl.winnerKey.split('-');
        const row = Number(parts[0]);
        const col = Number(parts[1]);
        const sq = game.squares[row * 10 + col];
        const y = game.axisY ? game.axisY[row] : '';
        const x = game.axisX ? game.axisX[col] : '';
        winning.innerHTML = `Winning now: <strong>${sq ? escapeHtml(sq.name) : 'Empty square'}</strong> (${escapeHtml(y)}&ndash;${escapeHtml(x)})`;
        winning.hidden = false;
      }
    }

    function drawBoard() {
      applyTeamColors(game);
      drawPortraitHead();
      const computed = computeGame(game);
      header.innerHTML = '<div class="tv-meta"></div>';
      const liveBar = SBS.board.renderLiveScoreBar(game);
      if (liveBar) header.querySelector('.tv-meta').appendChild(liveBar);
      fitTeamBadges(header);
      drawQuarters();
      const liveHighlight = window.GameLogic.computeLiveHighlight(game);
      const me = guest ? guest.nameFor(game) : null;
      const sig = JSON.stringify({
        me,
        squares: game.squares,
        players: game.players,
        cellLabels: computed.cellLabels,
        win: liveHighlight ? liveHighlight.winnerKey : null,
        near: liveHighlight ? Array.from(liveHighlight.nearKeys).sort() : null
      });
      if (sig !== lastBoardSignature) {
        lastBoardSignature = sig;
        const hadFocus = !!guest && boardWrap.contains(document.activeElement);
        SBS.board.renderFullBoard(boardWrap, game, computed, liveHighlight);
        if (guest) markGuestCells(me, hadFocus);
        fitTeamBadges(boardWrap);
        if (SBS.board.syncCornerInsets) SBS.board.syncCornerInsets(boardWrap);
        SBS.board.fitNames(screenEl);
      }
    }

    function notReady(text) {
      main.hidden = true;
      hint.hidden = true;
      let note = screenEl.querySelector('.mirror-note');
      if (!note) { note = el('div', 'mirror-note'); screenEl.appendChild(note); }
      note.textContent = text;
    }

    // Poll: redraws the board and header only, then the panel's own numbers. The strip is never
    // rebuilt while the host presses it, because the panel's draw keeps its own buttons.
    async function load(initial) {
      if (closed || SBS.currentScreen() !== 'mirror') return;
      try {
        if (initial && !guest) {
          // Host only. No answer means the host's screen, as on the scorer phone: the server
          // still decides each save.
          const role = await SBS.api.getRole(id).catch(() => ({ role: 'host' }));
          if (closed) return;
          if (role.role !== 'host') { SBS.go({ screen: 'home' }); return; }
        }
        const fresh = await SBS.api.pollGame(id, { must: initial || !game });
        if (closed || !fresh) return;
        // A guest may look at the board while picking is open: its numbers are still blank.
        if (!guest && fresh.status !== 'started' && fresh.status !== 'finished') {
          notReady('Mirror mode opens once the numbers are drawn.');
          return;
        }
        if (!game) {
          game = fresh;
          drawBoard();
          if (!guest) makePanel();
        } else if (SBS.boardKey(fresh) !== SBS.boardKey(game)) {
          // A score the host just tapped is still being saved: the panel's own answer wins.
          if (!scorePanel || !scorePanel.busy()) {
            const saved = fresh.updatedAt !== game.updatedAt;
            SBS.takeBoard(game, fresh);
            drawBoard();
            if (scorePanel) {
              scorePanel.update();
              // A change made somewhere else: what this screen scored may no longer undo cleanly.
              if (saved) scorePanel.clearUndo();
            }
          }
        }
      } catch (e) {
        // A guest's Player View is the screen that says a board is gone.
        if (e && e.status === 404 && SBS.currentScreen() === 'mirror') { SBS.go(guest ? guest.back : { screen: 'home' }); return; }
        if (initial && !game) notReady('Could not load this game: ' + (e && e.message ? e.message : 'try again'));
        // Otherwise best-effort: the next poll tries again.
      }
    }

    // Player View's copy draws at once; the poll below brings the newest.
    if (guest) {
      if (guest.game) {
        game = Object.assign({}, guest.game);
        drawBoard();
      }
      exitBtn.focus();
    }
    load(true);
    // The web font changes how wide a name is: fit again once it has loaded.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!closed) SBS.board.fitNames(screenEl); });
    SBS.setManagedInterval(() => load(false), guest ? GUEST_POLL_MS : POLL_MS);
  }

  SBS.mirror = { CAST_ICON };
  SBS.screens.mirror = renderMirror;
})();
