// Mirror mode for one phone (R26). A host with no second device mirrors this phone's screen to
// the TV (AirPlay, Cast, Smart View), so everything on it is seen by the room. The screen is
// the Party View board with no private data (no paid or unpaid marks, no money owed, no
// Players), its own portrait layout (R29: score, winning now, the board fitted to the width, the
// quarters 2 x 2), and a score strip that a tap
// brings up and that hides again 3 s after the last touch. Host only: a game id alone never
// opens it (the role check below), and every score tap is still authorized by the server.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, teamBadge, teamLogoTag, fitTeamBadges, applyTeamColors } = SBS.ui;
  const { QUARTERS, QLABEL, computeGame, payoutAmount, drawnDigits } = window.GameLogic;

  const STRIP_MS = 3000;
  const POLL_MS = 8000;
  const TIP_KEY = 'sbs.mirror.tip';
  // Tabler "cast" and "device-mobile-share" (MIT, 24 px outline).
  const CAST_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19l.01 0"/><path d="M7 19a4 4 0 0 0 -4 -4"/><path d="M11 19a8 8 0 0 0 -8 -8"/><path d="M15 19h3a3 3 0 0 0 3 -3v-8a3 3 0 0 0 -3 -3h-12a3 3 0 0 0 -2.8 2"/></svg>';
  const ROTATE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21h-4a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8"/><path d="M11 4h2"/><path d="M16 22l5 -5"/><path d="M21 21.5v-4.5h-4.5"/><path d="M12 17v.01"/></svg>';

  // The "Do Not Disturb" tip is remembered per browser once dismissed.
  function tipDismissed() {
    try { return window.localStorage.getItem(TIP_KEY) === '1'; } catch (e) { return false; }
  }
  function dismissTip() {
    try { window.localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* hidden for this visit only */ }
  }

  // A dialog the score panel opened (confirm, alert) keeps the strip up until it closes.
  function dialogOpen() {
    // ui.js dialogs are fixed overlays added straight to the body, outside #app.
    return Array.prototype.some.call(document.body.children, n => n.tagName === 'DIV' && n.id !== 'app' && n.style.position === 'fixed');
  }

  function renderMirror(id, from) {
    const app = SBS.appEl;
    app.innerHTML = '';
    try { window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}#mirror-${id}`); } catch (e) { /* the hash is only for reloads */ }
    // Back (the phone's gesture or button) leaves Party View like Exit. The history entry also
    // remembers where Party View was opened from, so Exit still goes Home after a reload.
    const partyHist = SBS.ui.partyHistory(id, from, () => leave());
    from = partyHist.from;

    // tv-mode is what keeps unpaid marks off the board (board.js): this screen is the room's view.
    document.body.classList.add('tv-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('tv-mode'));
    const screenEl = el('div', 'tv-screen mirror-screen');
    app.appendChild(screenEl);

    let game = null;
    let closed = false;
    let scorePanel = null;
    let stripTimer = null;
    let lastBoardSignature = null;
    // Held while Party View is up; a phone that cannot hold it gets a one-time Auto-Lock tip.
    const releaseWakeLock = SBS.ui.keepPartyAwake(screenEl, false);

    // ---- Exit (small, top corner) ----
    const exitBtn = el('button', 'mirror-exit', 'Exit');
    exitBtn.type = 'button';
    exitBtn.setAttribute('aria-label', 'Exit Party View');
    exitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!partyHist.exit()) leave();
    });
    function leave() {
      closed = true;
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

    // ---- Do Not Disturb tip ----
    if (!tipDismissed()) {
      const tip = el('div', 'mirror-tip');
      tip.setAttribute('role', 'note');
      const text = el('span', '', "Mirroring? Turn on Do Not Disturb so messages don't show on the TV.");
      const ok = el('button', 'mirror-tip-ok', 'Got it');
      ok.type = 'button';
      ok.addEventListener('click', (e) => { e.stopPropagation(); dismissTip(); tip.remove(); });
      tip.append(text, ok);
      side.appendChild(tip);
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
      armStrip();
    }
    ['pointerdown', 'touchstart', 'input', 'click'].forEach(ev => {
      strip.addEventListener(ev, () => { if (!strip.hidden) armStrip(); }, true);
    });
    // A tap anywhere else brings the strip up. Taps in the strip, Exit and the tip do not.
    screenEl.addEventListener('click', (e) => {
      if (strip.contains(e.target) || e.target.closest('.mirror-exit, .mirror-tip')) return;
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
        setGame: (g) => {
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
          statusTxt = 'PUSH'; statusCls = 'push';
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
      const sig = JSON.stringify({
        squares: game.squares,
        players: game.players,
        cellLabels: computed.cellLabels,
        win: liveHighlight ? liveHighlight.winnerKey : null,
        near: liveHighlight ? Array.from(liveHighlight.nearKeys).sort() : null
      });
      if (sig !== lastBoardSignature) {
        lastBoardSignature = sig;
        SBS.board.renderFullBoard(boardWrap, game, computed, liveHighlight);
        fitTeamBadges(boardWrap);
        if (SBS.board.syncCornerInsets) SBS.board.syncCornerInsets(boardWrap);
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
        if (initial) {
          // Host only. No answer means the host's screen, as on the scorer phone: the server
          // still decides each save.
          const role = await SBS.api.getRole(id).catch(() => ({ role: 'host' }));
          if (closed) return;
          if (role.role !== 'host') { SBS.go({ screen: 'home' }); return; }
        }
        const fresh = await SBS.api.getGame(id);
        if (closed) return;
        if (fresh.status !== 'started' && fresh.status !== 'finished') {
          notReady('Mirror mode opens once the numbers are drawn.');
          return;
        }
        if (initial || !game) {
          game = fresh;
          drawBoard();
          makePanel();
        } else if (fresh.updatedAt !== game.updatedAt) {
          if (!('liveOverride' in fresh)) delete game.liveOverride;
          // A score the host just tapped is still being saved: the panel's own answer wins.
          if (!scorePanel.busy()) {
            Object.assign(game, fresh);
            drawBoard();
            scorePanel.update();
          }
        }
      } catch (e) {
        if (e && e.status === 404 && SBS.currentScreen() === 'mirror') { SBS.go({ screen: 'home' }); return; }
        if (initial) notReady('Could not load this game: ' + (e && e.message ? e.message : 'try again'));
        // Otherwise best-effort: the next poll tries again.
      }
    }

    load(true);
    SBS.setManagedInterval(() => load(false), POLL_MS);
  }

  SBS.mirror = { CAST_ICON };
  SBS.screens.mirror = renderMirror;
})();
