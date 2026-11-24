// Phone score entry: a one-thumb view for updating quarter scores while the
// grid is up on the television. Digits are tapped, not typed — no keyboard
// pops up, and every tap saves immediately.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, showAlert, applyTeamColors, teamBadge, fitTeamBadges } = SBS.ui;
  const { openManagePlayersModal } = SBS.players;
  const { QUARTERS, QLABEL, computeGame, payoutAmount } = window.GameLogic;

  function renderPhone(id, backScreen) {
    const app = SBS.appEl;
    app.innerHTML = '';
    document.body.classList.add('phone-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('phone-mode'));

    const wrap = el('div', 'phone-screen');
    app.appendChild(wrap);

    const header = el('div', 'phone-header');
    wrap.appendChild(header);

    const tabs = el('div', 'phone-tabs');
    wrap.appendChild(tabs);

    const panel = el('div', 'phone-panel');
    wrap.appendChild(panel);

    const footer = el('div', 'phone-footer');
    wrap.appendChild(footer);

    let game = null;
    let activeQ = null;
    let saving = false;
    // A scorer phone (R24) holds one board's score entry and nothing else, so every control
    // that saves the whole document is left out. The server refuses them anyway.
    let scorer = false;
    let ended = false;
    const scorePanel = SBS.scorePanel.create({
      getGame: () => game,
      setGame: (g) => {
        game = g;
        // Resuming the live feed leaves manual entry, so the whole screen changes.
        if (isManual()) drawAround(); else draw();
      },
      patch: (gid, op) => SBS.api.patchScore(gid, op, scorer ? { prompt: false } : undefined),
      onError: (e) => grantEnded(e) && endScoring()
    });
    // 403, not 401, when this phone happens to be signed in as some other host.
    const grantEnded = (e) => scorer && (e.status === 401 || e.status === 403);

    // The grant ran out or the host removed it. Never the host sign-in prompt.
    function endScoring() {
      ended = true;
      header.innerHTML = '';
      tabs.innerHTML = '';
      footer.innerHTML = '';
      panel.innerHTML = `<div class="card handoff-card"><h2 class="room-title">Scoring has ended on this phone</h2>
        <p class="error-msg" role="alert">This phone can no longer enter scores for this board. Ask the host to show a new code and scan it.</p></div>`;
      return true;
    }
    const isManual = () => game && window.GameLogic.manualEntry(game);

    function firstUnscored(g) {
      const c = computeGame(g);
      return QUARTERS.find(q => c.results[q].a === null || c.results[q].b === null) || 'final';
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
        <div class="phone-sub">${SBS.ui.leagueBadge(game.league)} ${game.description ? escapeHtml(game.description) + ' &middot; ' : ''}Pot ${money(computed.pot)}</div>
      `;
      fitTeamBadges(header);

      const actions = el('div', 'phone-actions');
      const manageBtn = el('button', 'phone-action-btn', 'Manage Players');
      manageBtn.type = 'button';
      manageBtn.addEventListener('click', () => openManagePlayersModal(game, draw));
      const gridBtn = el('button', 'phone-action-btn', 'Back');
      gridBtn.type = 'button';
      gridBtn.addEventListener('click', () => {
        if (backScreen === 'home') SBS.go({ screen: 'home' });
        else SBS.go({ screen: 'board', game });
      });
      actions.appendChild(manageBtn);
      actions.appendChild(gridBtn);
      if (!scorer) header.appendChild(actions);

      if (isManual()) { drawManual(computed); return; }
      if (scorer) { drawReadOnly(computed); return; }

      // --- quarter tabs ---
      tabs.innerHTML = '';
      QUARTERS.forEach(q => {
        const res = computed.results[q];
        const done = res.a !== null && res.b !== null;
        const tab = el('button', 'phone-tab' + (q === activeQ ? ' active' : '') + (done ? ' done' : ''));
        tab.innerHTML = `<span class="pt-label">${q === 'final' ? 'FINAL' : QLABEL[q]}</span>`;
        tab.addEventListener('click', () => { activeQ = q; draw(); });
        tabs.appendChild(tab);
      });

      // --- active quarter ---
      const res = computed.results[activeQ];
      panel.innerHTML = '';

      const amtRow = el('div', 'phone-amount');
      amtRow.innerHTML = `<span class="pa-label">${activeQ === 'final' ? 'Final Score' : QLABEL[activeQ]} pays</span><span class="pa-value">${money(payoutAmount(res))}</span>`;
      panel.appendChild(amtRow);

      panel.appendChild(keypadFor('a', res.a, 'pk-a'));
      panel.appendChild(keypadFor('b', res.b, 'pk-b'));
      fitTeamBadges(panel);

      const outcome = el('div', 'phone-outcome');
      if (res.a === null || res.b === null) {
        outcome.classList.add('pending');
        outcome.textContent = res.carryIn > 0
          ? `Tap the last digit of each score. Includes ${money(res.carryIn)} rolled over from a push.`
          : 'Tap the last digit of each team\'s score.';
      } else if (res.resolved && res.pushed) {
        outcome.classList.add('push');
        outcome.textContent = `PUSH — nobody had that square. ${money(res.amount)} rolls into the next payout.`;
      } else if (res.resolved && res.winnerName) {
        outcome.classList.add('win');
        outcome.textContent = `${res.winnerName}${res.autoResolved ? ' (auto-drawn)' : ''} wins ${money(res.amount)}`;
      } else if (activeQ === 'final' && res.needsDraw) {
        outcome.classList.add('push');
        outcome.textContent = 'That square is empty — a winner has to be drawn.';
      }
      panel.appendChild(outcome);

      if (activeQ === 'final' && res.needsDraw) {
        const drawBtn = el('button', 'phone-draw', 'Randomly Draw Winner');
        drawBtn.addEventListener('click', async () => {
          const filledIdx = game.squares.map((s, i) => s ? i : -1).filter(i => i >= 0);
          if (!filledIdx.length) { showAlert('No squares are filled in — cannot draw a winner.'); return; }
          const idx = filledIdx[Math.floor(Math.random() * filledIdx.length)];
          if (!game.results.final) game.results.final = {};
          // drawnAt lets the board and TV grid — which learn about this via
          // their own polls — play the same countdown/spin reveal in sync
          // instead of the winner just appearing.
          game.results.final.autoResolve = { key: `${res.row}-${res.col}`, row: Math.floor(idx / 10), col: idx % 10, drawnAt: Date.now() };
          await save();
        });
        panel.appendChild(drawBtn);
      }

      // --- footer: winners so far, so the host can read them out ---
      const winners = QUARTERS
        .filter(q => computed.results[q].resolved && computed.results[q].winnerName)
        .map(q => `<div class="pw-row"><span>${q === 'final' ? 'FINAL' : QLABEL[q]}</span><strong>${escapeHtml(computed.results[q].winnerName)}</strong><span class="pw-amt">${money(computed.results[q].amount)}</span></div>`);
      footer.innerHTML = winners.length
        ? `<div class="phone-winners"><div class="pw-head">Winners so far</div>${winners.join('')}</div>`
        : '';
    }

    // Manual scoring: the current-score panel replaces the per-quarter keypad.
    // The panel redraws itself (keeping keyboard focus); the draw button and
    // winners footer live outside it and are refreshed around it.
    const manualExtras = el('div', 'phone-manual-extras');

    function drawManual(computed) {
      tabs.innerHTML = '';
      if (panel.firstChild !== scorePanel.el || panel.lastChild !== manualExtras) {
        panel.innerHTML = '';
        panel.appendChild(scorePanel.el);
        panel.appendChild(manualExtras);
      }
      scorePanel.update();
      drawAround(computed);
    }

    // A scorer looking at a board nobody enters by hand: a Live board with its feed up, or a
    // simulation. Taking over a Live board is a score operation, so the scorer may.
    function drawReadOnly(computed) {
      tabs.innerHTML = '';
      const live = window.GameLogic.scoringMode(game) === 'live' && game.status === 'started';
      const cur = game.liveScore;
      panel.innerHTML = '';
      const box = el('div', 'card handoff-card');
      box.innerHTML = cur
        ? `<p class="handoff-score">${escapeHtml(game.teamA)} <strong>${Number(cur.a) || 0}</strong> &ndash; <strong>${Number(cur.b) || 0}</strong> ${escapeHtml(game.teamB)}</p>`
        : '';
      const note = el('p', 'handoff-text');
      note.textContent = game.status === 'finished' ? 'This game is final.'
        : live ? 'Scores are coming from the live feed.'
          : 'This board is simulated, so there is nothing to enter.';
      box.appendChild(note);
      if (live) {
        const take = el('button', 'phone-draw', 'Enter the score myself');
        take.type = 'button';
        take.addEventListener('click', async () => {
          take.disabled = true;
          const s = window.GameLogic.manualState(game);
          try {
            game = await SBS.api.patchScore(id, { op: 'set', a: s.a, b: s.b, override: true }, { prompt: false });
          } catch (e) {
            if (grantEnded(e)) { endScoring(); return; }
            showAlert('Could not take over the score: ' + e.message);
          }
          draw();
        });
        box.appendChild(take);
      }
      panel.appendChild(box);
      drawAround(computed);
    }

    function drawAround(computedNow) {
      if (ended) return;
      const computed = computedNow || computeGame(game);
      manualExtras.innerHTML = '';
      const fin = computed.results.final;
      if (fin.needsDraw && scorer) {
        manualExtras.appendChild(el('div', 'phone-outcome push', 'That square is empty. The host draws the winner on Game Day.'));
      } else if (fin.needsDraw) {
        manualExtras.appendChild(el('div', 'phone-outcome push', 'That square is empty — a winner has to be drawn.'));
        const drawBtn = el('button', 'phone-draw', 'Randomly Draw Winner');
        drawBtn.addEventListener('click', async () => {
          const filledIdx = game.squares.map((s, i) => s ? i : -1).filter(i => i >= 0);
          if (!filledIdx.length) { showAlert('No squares are filled in — cannot draw a winner.'); return; }
          const idx = filledIdx[Math.floor(Math.random() * filledIdx.length)];
          if (!game.results.final) game.results.final = {};
          game.results.final.autoResolve = { key: `${fin.row}-${fin.col}`, row: Math.floor(idx / 10), col: idx % 10, drawnAt: Date.now() };
          await save();
        });
        manualExtras.appendChild(drawBtn);
      }
      const winners = QUARTERS
        .filter(q => computed.results[q].resolved && computed.results[q].winnerName)
        .map(q => `<div class="pw-row"><span>${q === 'final' ? 'FINAL' : QLABEL[q]}</span><strong>${escapeHtml(computed.results[q].winnerName)}</strong><span class="pw-amt">${money(computed.results[q].amount)}</span></div>`);
      footer.innerHTML = winners.length
        ? `<div class="phone-winners"><div class="pw-head">Winners so far</div>${winners.join('')}</div>`
        : '';
    }

    function keypadFor(side, current, cls) {
      const box = el('div', 'phone-keypad ' + cls);
      const head = el('div', 'pk-head badge-fit');
      head.innerHTML = `${teamBadge(game, side === 'a' ? 'A' : 'B', { logoSize: 18, cls: 'team-badge-sm' })}<span class="pk-current">${current === null || current === '' ? '–' : current}</span>`;
      box.appendChild(head);

      // Full numeric keyboard (phone dialer layout) so multi-digit scores can
      // be typed in, not just a single last-digit tap.
      const pad = el('div', 'pk-grid');
      for (let d = 1; d <= 9; d++) {
        const key = el('button', 'pk-key', String(d));
        key.addEventListener('click', () => appendDigit(side, d));
        pad.appendChild(key);
      }
      const clearKey = el('button', 'pk-key pk-clear', 'Clear');
      clearKey.addEventListener('click', () => setScore(side, ''));
      pad.appendChild(clearKey);

      const zeroKey = el('button', 'pk-key', '0');
      zeroKey.addEventListener('click', () => appendDigit(side, 0));
      pad.appendChild(zeroKey);

      // Spelled out rather than a ⌫ glyph — that renders as a hollow box in
      // some browsers, and this key erases a character.
      const deleteKey = el('button', 'pk-key pk-clear', 'Delete');
      deleteKey.addEventListener('click', () => deleteDigit(side));
      pad.appendChild(deleteKey);

      box.appendChild(pad);
      return box;
    }

    function appendDigit(side, digit) {
      const entry = (game.results[activeQ] || {})[side];
      const cur = entry === null || entry === undefined ? '' : String(entry);
      if (cur.length >= 3) return; // scores don't realistically run past 3 digits
      setScore(side, Number(cur + String(digit)));
    }

    function deleteDigit(side) {
      const entry = (game.results[activeQ] || {})[side];
      const cur = entry === null || entry === undefined ? '' : String(entry);
      const next = cur.slice(0, -1);
      setScore(side, next === '' ? '' : Number(next));
    }

    // Warns before a correction unsettles a quarter marked paid out (R21).
    // After the first confirmed digit the quarter reads Needs settling, so the
    // rest of the number does not ask again.
    async function setScore(side, value) {
      if (saving) return;
      const after = JSON.parse(JSON.stringify(game));
      window.GameLogic.setQuarterScore(after, activeQ, side, value);
      const disturbed = window.GameLogic.paidQuartersDisturbed(game, after);
      if (disturbed.length && !(await SBS.ui.showConfirm(SBS.ui.disturbMessage(disturbed)))) return;
      window.GameLogic.setQuarterScore(game, activeQ, side, value);
      draw(); // optimistic: the tap feels instant, the save follows
      await save();
    }

    async function save() {
      saving = true;
      wrap.classList.add('is-saving');
      try {
        const saved = await SBS.api.saveGame(game);
        game = saved;
        draw();
      } catch (e) {
        if (e && e.conflict) {
          // Someone edited on the iPad at the same moment — take the server's
          // copy rather than fighting over it.
          game = e.game && e.game.squares ? e.game : await SBS.api.getGame(id);
          draw();
          showAlert('That score was changed on another device — showing the latest version.');
        } else {
          const denied = await SBS.handleForbidden(e, id);
          if (denied) {
            // Show the server's copy, not the score that was just tapped.
            if (denied.fresh) game = denied.fresh;
            draw();
          } else {
            showAlert('Could not save: ' + e.message);
          }
        }
      } finally {
        saving = false;
        wrap.classList.remove('is-saving');
      }
    }

    // What a poll compares. A scorer sees the feed's score, which moves without a save.
    function shownKey(g) {
      if (!scorer) return g.updatedAt;
      const l = g.liveScore || {};
      return JSON.stringify([g.updatedAt, g.status, l.a, l.b, l.period, g.liveFeed && g.liveFeed.available]);
    }

    async function load(initial) {
      if (ended) return;
      try {
        // No answer means the host's screen, as before R24: the server decides each save.
        const asked = initial ? SBS.api.getRole(id).catch(() => ({ role: 'host' })) : null;
        const fresh = await SBS.api.getGame(id);
        if (initial) {
          const { role } = await asked;
          scorer = role === 'scorer';
          if (role === 'host') SBS.scorerPhone.forget(id);
          if (role === 'none' && SBS.scorerPhone.was(id)) { endScoring(); return; }
        }
        if (ended) return;
        if (initial) {
          game = fresh;
          activeQ = firstUnscored(fresh);
          if (fresh.status !== 'started' && fresh.status !== 'finished') {
            panel.innerHTML = '';
            footer.innerHTML = '';
            tabs.innerHTML = '';
            header.innerHTML = `<div class="phone-sub">Squares for this game are still being picked — score entry opens once the board is locked.</div>`;
            return;
          }
          draw();
        } else if (!saving && !scorePanel.busy() && shownKey(fresh) !== shownKey(game)) {
          game = fresh;
          draw();
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
