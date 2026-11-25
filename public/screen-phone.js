// Score entry on another phone (#score-<id>): the score pad and nothing else, for the host or a
// phone the host handed the scoring to (decision 018). Retired by R37 (decision 025).
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, applyTeamColors, teamBadge, fitTeamBadges } = SBS.ui;
  const { openManagePlayersModal } = SBS.players;
  const { computeGame } = window.GameLogic;

  function renderPhone(id, backScreen) {
    const app = SBS.appEl;
    app.innerHTML = '';
    document.body.classList.add('phone-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('phone-mode'));

    const wrap = el('div', 'phone-screen');
    app.appendChild(wrap);

    const header = el('div', 'phone-header');
    wrap.appendChild(header);

    const panel = el('div', 'phone-panel');
    wrap.appendChild(panel);

    let game = null;
    // A scorer phone (R24) holds one board's score entry and nothing else, so every control
    // that saves the whole document is left out. The server refuses them anyway.
    let scorer = false;
    let ended = false;
    const scorePanel = SBS.scorePanel.create({
      getGame: () => game,
      setGame: (g) => { game = g; },
      patch: (gid, op) => SBS.api.patchScore(gid, op, scorer ? { prompt: false } : undefined),
      onError: (e) => grantEnded(e) && endScoring()
    });
    // 403, not 401, when this phone happens to be signed in as some other host.
    const grantEnded = (e) => scorer && (e.status === 401 || e.status === 403);

    // The grant ran out or the host removed it. Never the host sign-in prompt.
    function endScoring() {
      ended = true;
      header.innerHTML = '';
      panel.innerHTML = `<div class="card handoff-card"><h2 class="room-title">Scoring has ended on this phone</h2>
        <p class="error-msg" role="alert">This phone can no longer enter scores for this board. Ask the host to show a new code and scan it.</p></div>`;
      return true;
    }
    function draw() {
      if (!game || ended) return;
      const computed = computeGame(game);
      applyTeamColors(game);

      header.innerHTML = `
        <div class="phone-matchup badge-fit">
          ${teamBadge(game, 'A', { logoSize: 22 })}
          <span class="pm-vs">vs</span>
          ${teamBadge(game, 'B', { logoSize: 22 })}
        </div>
        <div class="phone-sub">${SBS.ui.shownDescription(game) ? escapeHtml(SBS.ui.shownDescription(game)) + ' &middot; ' : ''}Pot ${money(computed.pot)}</div>
      `;

      // Home, top left like every host screen. A phone that was handed the scoring has no Home.
      if (!scorer) {
        const homeBtn = el('button', 'icon-btn home-btn', SBS.ui.HOME_ICON);
        homeBtn.type = 'button';
        homeBtn.setAttribute('aria-label', 'Home');
        homeBtn.title = 'Home';
        homeBtn.addEventListener('click', () => SBS.go({ screen: 'home' }));
        header.prepend(homeBtn);
      }
      header.classList.toggle('has-home', !scorer);
      fitTeamBadges(header);

      const actions = el('div', 'phone-actions');
      const manageBtn = el('button', 'phone-action-btn', 'Manage Players');
      manageBtn.type = 'button';
      manageBtn.addEventListener('click', () => openManagePlayersModal(game, draw));
      const gridBtn = el('button', 'phone-action-btn', 'Back');
      gridBtn.type = 'button';
      gridBtn.addEventListener('click', () => {
        SBS.go({ screen: 'board', game });
      });
      actions.appendChild(manageBtn);
      if (backScreen !== 'home') actions.appendChild(gridBtn); // Home does it
      if (!scorer) header.appendChild(actions);

      if (panel.firstChild !== scorePanel.el) {
        panel.innerHTML = '';
        panel.appendChild(scorePanel.el);
      }
      scorePanel.update();
    }

    async function load(initial) {
      if (ended) return;
      try {
        // No answer means the host's screen, as before R24: the server decides each save.
        const asked = initial ? SBS.api.getRole(id).catch(() => ({ role: 'host' })) : null;
        const fresh = initial ? await SBS.api.getGame(id) : await SBS.api.pollGame(id);
        if (!fresh) return;
        if (initial) {
          const { role } = await asked;
          scorer = role === 'scorer';
          if (role === 'host') SBS.scorerPhone.forget(id);
          if (role === 'none' && SBS.scorerPhone.was(id)) { endScoring(); return; }
        }
        if (ended) return;
        if (initial) {
          game = fresh;
          if (fresh.status !== 'started' && fresh.status !== 'finished') {
            panel.innerHTML = '';
            header.innerHTML = `<div class="phone-sub">Squares for this game are still being picked — score entry opens once the board is locked.</div>`;
            return;
          }
          draw();
        } else if (!scorePanel.busy() && SBS.boardKey(fresh) !== SBS.boardKey(game)) {
          const saved = fresh.updatedAt !== game.updatedAt;
          game = fresh;
          draw();
          // A change made somewhere else: what this screen scored may no longer undo cleanly.
          if (saved) scorePanel.clearUndo();
        }
      } catch (e) {
        // Deleted on another device — nothing left here to show.
        if (e && e.status === 404) {
          if (scorer) { endScoring(); return; } // Home would ask for the host sign-in
          SBS.go({ screen: 'home' });
          return;
        }
        header.innerHTML = `<div class="error-msg">Could not load this game: ${escapeHtml(e.message)}</div>`;
      }
    }

    load(true);
    // Stay in step with edits made on the iPad or PC.
    SBS.setManagedInterval(() => load(false), 6000);
  }

  SBS.screens.phone = renderPhone;
})();
