// Step 2: claiming squares, and the host control that locks the board.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, topbar, showConfirm, showAlert, applyTeamColors, teamBadge, fitTeamBadges, overlayEl } = SBS.ui;
  const { unpaidTotal, openManagePlayersModal, resolveNameForPick, ensurePlayerColor, addSquares, replaceGame, formatAt, ensurePlayers, renameSquares, collectNameGroups } = SBS.players;
  const { shuffle, lockGame, isPlayerName, unpaidGuestPicks, pruneEmptyPlayers } = window.GameLogic;

  // Guards the one irreversible action in the app (drawing the axis numbers).
  // Module-level so a re-render can't reset it mid-save.
  let lockInFlight = false;

  const NAME_RACE = 'Someone just picked under that name. Check the list and try again.';

  function renderPicking(game) {
    const app = SBS.appEl;
    applyTeamColors(game);
    app.innerHTML = '';
    const reopen = () => SBS.go({ screen: 'picking', game });

    const headerMeta = [SBS.ui.leagueBadge(game.league), escapeHtml(game.description || game.gameDate), SBS.ui.kickoffNotice(game)].filter(Boolean).join(' &middot; ');
    const bar = topbar(`${teamBadge(game, 'A', { logoSize: 22, cls: 'team-badge-sm' })}<span class="vs-sep">vs</span>${teamBadge(game, 'B', { logoSize: 22, cls: 'team-badge-sm' })}<span class="header-year">${headerMeta}</span>`);
    const nav = bar.querySelector('.nav');
    const manageBtn = el('button', 'secondary', 'Manage Players');
    manageBtn.addEventListener('click', () => openManagePlayersModal(game, reopen));
    nav.appendChild(manageBtn);
    app.appendChild(bar);
    fitTeamBadges(bar);

    const main = el('div', 'main');
    app.appendChild(main);

    main.appendChild(el('h2', '', 'Pick Your Squares'));
    const joinCard = SBS.playerView.joinCard(game);
    if (joinCard) main.appendChild(joinCard);

    const strip = el('div', 'stat-strip');
    main.appendChild(strip);
    function drawStrip() {
      const filled = game.squares.filter(s => s).length;
      const unpaid = unpaidTotal(game);
      strip.innerHTML = `
        <div class="stat-box"><div class="val">${100 - filled}</div><div class="lbl">Squares Available</div></div>
        <div class="stat-box"><div class="val">${money(game.squarePrice)}</div><div class="lbl">Per Square</div></div>
        <div class="stat-box"><div class="val">${money(filled * game.squarePrice)}</div><div class="lbl">Pot So Far</div></div>
        <div class="stat-box ${unpaid > 0 ? 'warn' : ''} clickable" id="unpaid-stat"><div class="val">${money(unpaid)}</div><div class="lbl">Unpaid Total</div></div>
      `;
      strip.querySelector('#unpaid-stat').addEventListener('click', () => openManagePlayersModal(game, reopen));
    }
    drawStrip();

    // A save that lost to a guest's pick is re-applied to the newer board (SBS.saveWith).
    // null: the failure was handled here (a dialog, or the screen moved on).
    async function persist(change, showErr) {
      try {
        return await SBS.saveWith(game, change);
      } catch (e) {
        if (await SBS.handleConflict(e, game.id)) return null;
        const denied = await SBS.handleForbidden(e, game.id);
        if (denied) {
          if (SBS.currentScreen() === 'picking') SBS.openGame(denied.fresh || game);
          return null;
        }
        showErr('Failed to save: ' + e.message);
        return null;
      }
    }
    // A change that was refused ("a square was just taken"): show the board as it is now.
    async function refusedReload(r) {
      replaceGame(game, r.game);
      await showAlert(r.refused);
      SBS.go({ screen: 'picking', game });
    }

    // ---- Guest picks card (only on a board where guests were ever allowed) ----
    if (game.guestPick) {
      const gp = game.guestPick;
      const gcard = el('div', 'card guest-card');
      const unpaidGuest = unpaidGuestPicks(game);
      const limit = gp.lifted ? 'No limit'
        : gp.liftAt && Date.parse(gp.liftAt) > Date.now() ? `Up to ${gp.max} squares each until ${formatAt(Date.parse(gp.liftAt) / 1000)}`
        : gp.liftAt ? 'No limit (the time has passed)' : `Up to ${gp.max} squares each`;
      gcard.innerHTML = `<h3>Guest picks</h3>
        <p class="guest-state" role="status">${gp.on ? 'On: anyone with the link can claim squares.' : 'Off: guests can only look. Their picks stay.'} <span class="guest-limit">${escapeHtml(limit)}.</span></p>`;
      const gerr = el('div', 'error-msg hidden');
      gcard.appendChild(gerr);
      const showGErr = (m) => { gerr.textContent = m; gerr.classList.remove('hidden'); };
      const row = el('div', 'actions guest-actions');
      const setGuest = async (patch) => {
        const r = await persist(doc => { doc.guestPick = Object.assign({}, doc.guestPick, patch); }, showGErr);
        if (!r) return;
        SBS.go({ screen: 'picking', game: r.game });
      };
      const addBtn = (cls, label, onClick) => { const b = textEl('button', cls, label); b.type = 'button'; b.addEventListener('click', onClick); row.appendChild(b); return b; };
      addBtn(gp.on ? 'secondary' : '', gp.on ? 'Turn guest picks off' : 'Turn guest picks on', () => setGuest({ on: !gp.on }));
      addBtn('secondary', gp.lifted ? 'Bring the limit back' : 'Let everyone pick more', () => setGuest({ lifted: !gp.lifted }));
      gcard.appendChild(row);

      const capRow = el('div', 'guest-cap-row');
      capRow.innerHTML = `<label for="g-max">Most squares per person</label><input type="number" id="g-max" min="1" max="100" step="1" value="${escapeHtml(gp.max)}">`;
      const capSave = textEl('button', 'secondary', 'Save limit');
      capSave.type = 'button';
      capSave.addEventListener('click', () => {
        const v = Number(capRow.querySelector('#g-max').value);
        if (!Number.isInteger(v) || v < 1 || v > 100) return showGErr('Enter a whole number from 1 to 100.');
        setGuest({ max: v });
      });
      capRow.appendChild(capSave);
      gcard.appendChild(capRow);

      const clear = textEl('button', 'danger', 'Remove unpaid guest picks');
      clear.type = 'button';
      clear.disabled = unpaidGuest.squares.length === 0;
      clear.addEventListener('click', async () => {
        const n = unpaidGuest.squares.length;
        const ok = await showConfirm(`Remove ${n} unpaid square${n === 1 ? '' : 's'} picked by ${unpaidGuest.people} guest${unpaidGuest.people === 1 ? '' : 's'}? Squares marked paid stay. This cannot be undone.`);
        if (!ok) return;
        const r = await persist(doc => {
          const now = unpaidGuestPicks(doc);
          if (now.squares.length !== n) return 'Guest picks changed while you were confirming. Check the card and try again.';
          now.squares.forEach(i => { doc.squares[i] = null; });
          pruneEmptyPlayers(doc);
        }, showGErr);
        if (!r) return;
        if (r.refused) return refusedReload(r);
        SBS.go({ screen: 'picking', game: r.game });
      });
      const clearWrap = el('div', 'actions');
      clearWrap.appendChild(clear);
      gcard.appendChild(clearWrap);
      gcard.appendChild(el('p', 'player-muted', unpaidGuest.squares.length
        ? `${unpaidGuest.squares.length} unpaid square${unpaidGuest.squares.length === 1 ? '' : 's'} from ${unpaidGuest.people} guest${unpaidGuest.people === 1 ? '' : 's'}.`
        : 'No unpaid guest picks.'));
      main.appendChild(gcard);
    }

    const layout = el('div', 'pick-layout');
    main.appendChild(layout);

    // ---- Left: pick form ----
    const formCard = el('div', 'card');
    layout.appendChild(formCard);
    formCard.appendChild(el('h3', '', 'Claim Squares'));

    const errBox = el('div', 'error-msg hidden');
    formCard.appendChild(errBox);
    function showErr(msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); }
    function clearErr() { errBox.classList.add('hidden'); }

    const formWrap = el('div');
    formWrap.innerHTML = `
      <label>Player Name</label>
      <input type="text" id="p-name" placeholder="Enter name" maxlength="10">
      <label># of Squares</label>
      <input type="number" id="p-count" min="1" max="100">
      <label class="checkbox-label"><input type="checkbox" id="p-paid" checked> <span>Mark as Paid</span></label>
    `;
    formCard.appendChild(formWrap);

    let mode = game.pickMode === 'both' ? 'auto' : game.pickMode;
    if (game.pickMode === 'both') {
      const modeGroup = el('div', 'radio-group centered', '');
      modeGroup.style.margin = '14px 0';
      const autoP = el('div', 'pill active', 'Auto Pick'); autoP.dataset.val = 'auto';
      const manP = el('div', 'pill', 'Manual Pick'); manP.dataset.val = 'manual';
      [autoP, manP].forEach(p => {
        p.addEventListener('click', () => {
          modeGroup.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
          p.classList.add('active');
          mode = p.dataset.val;
        });
      });
      modeGroup.appendChild(autoP);
      modeGroup.appendChild(manP);
      formCard.appendChild(el('label', '', 'Pick Method'));
      formCard.appendChild(modeGroup);
    }

    const actionBtn = el('button', 'pick full-width', game.pickMode === 'manual' ? 'Start Manual Pick' : 'Pick Squares');
    formCard.appendChild(el('div', 'actions', '')).appendChild(actionBtn);

    // ---- Manual selection state ----
    let manualSelecting = false;
    let manualTarget = 0;
    let manualSelected = [];
    let manualName = '';
    let manualPaid = false;
    let manualRename = null; // { rename } from the duplicate-name prompt, replayed on a newer board
    let manualHadName = false;
    let saving = false;

    const manualBanner = el('div', 'manual-banner hidden');
    formCard.appendChild(manualBanner);

    function updateManualBanner() {
      manualBanner.innerHTML = '';
      manualBanner.classList.toggle('hidden', !manualSelecting);
      if (!manualSelecting) return;
      manualBanner.appendChild(el('div', '', `<strong>${escapeHtml(manualName)}</strong>: ${manualSelected.length} / ${manualTarget} selected`));
      const btns = el('div', '', '');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      const confirmBtn = el('button', '', 'Confirm');
      confirmBtn.disabled = manualSelected.length === 0 || saving;
      confirmBtn.addEventListener('click', confirmManualPick);
      const cancelBtn = el('button', 'secondary', 'Cancel');
      cancelBtn.addEventListener('click', () => {
        manualSelecting = false;
        manualSelected = [];
        renderPicking(game);
      });
      btns.appendChild(confirmBtn);
      btns.appendChild(cancelBtn);
      manualBanner.appendChild(btns);
    }

    // The duplicate-name prompt can rename the bare name (Steve to Steve1) on the board it
    // was shown on; a newer board needs the same rename, and must still agree about whether
    // this name already exists (a guest may have just taken it).
    function nameGuard(doc, name, rename, hadName) {
      if (rename && rename.from) {
        const holds = doc.squares.some(sq => sq && sq.name === rename.from);
        const clash = doc.squares.some(sq => sq && sq.name === rename.to) || (ensurePlayers(doc)[rename.to] && !holds);
        if (holds && clash) return NAME_RACE;
        if (holds) renameSquares(doc, rename.from, rename.to);
      }
      if (collectNameGroups(doc).has(name.trim().toLowerCase().replace(/[₀-₉]+$/, '')) !== hadName) return NAME_RACE;
      return null;
    }

    async function confirmManualPick() {
      if (saving) return;
      saving = true;
      updateManualBanner();
      const picked = manualSelected.slice();
      const r = await persist(doc => {
        const refused = nameGuard(doc, manualName, manualRename, manualHadName);
        if (refused) return refused;
        if (picked.some(i => doc.squares[i])) return 'A square was just taken.';
        addSquares(doc, manualName, picked, manualPaid);
      }, showErr);
      saving = false;
      if (!r) return updateManualBanner();
      if (r.refused) {
        // Keep the selection: take the board as it is now and drop only what was taken.
        replaceGame(game, r.game);
        const before = manualSelected.length;
        manualSelected = manualSelected.filter(i => !game.squares[i]);
        const lost = before - manualSelected.length;
        showErr(lost ? `${lost} of your squares ${lost === 1 ? 'was' : 'were'} just taken. The rest are still selected.` : r.refused);
        drawStrip();
        return refreshPreview();
      }
      manualSelecting = false;
      manualSelected = [];
      SBS.go({ screen: 'picking', game: r.game });
    }

    actionBtn.addEventListener('click', async () => {
      clearErr();
      const rawName = formWrap.querySelector('#p-name').value.trim();
      const count = parseInt(formWrap.querySelector('#p-count').value, 10);
      const paidChecked = formWrap.querySelector('#p-paid').checked;
      if (!rawName) return showErr('Please enter a player name.');
      if (!isPlayerName(rawName)) return showErr('That name is not allowed. Choose a different name.');
      if (!count || count < 1) return showErr('Please enter a valid number of squares.');
      const emptyIdx = game.squares.map((s, i) => s ? -1 : i).filter(i => i >= 0);
      if (count > emptyIdx.length) return showErr(`Only ${emptyIdx.length} squares remain.`);

      const out = {};
      const hadName = collectNameGroups(game).has(rawName.toLowerCase());
      const name = await resolveNameForPick(game, rawName, out);
      if (!name) return; // host cancelled at the duplicate-name prompt

      if (mode === 'auto') {
        if (saving) return;
        saving = true;
        const r = await persist(doc => {
          const refused = nameGuard(doc, name, out.rename, hadName);
          if (refused) return refused;
          const empty = doc.squares.map((s, i) => s ? -1 : i).filter(i => i >= 0);
          if (count > empty.length) return `Only ${empty.length} squares remain.`;
          addSquares(doc, name, shuffle(empty).slice(0, count), paidChecked);
        }, showErr);
        saving = false;
        if (!r) return;
        if (r.refused) return refusedReload(r);
        SBS.go({ screen: 'picking', game: r.game });
      } else {
        manualSelecting = true;
        manualTarget = count;
        manualSelected = [];
        manualName = name;
        manualPaid = paidChecked;
        manualRename = out.rename || null;
        manualHadName = hadName;
        updateManualBanner();
        refreshPreview();
      }
    });

    // ---- A claimed square: who, when, and remove or give to someone else ----
    function openSquareDialog(idx) {
      const sq = game.squares[idx];
      if (!sq) return;
      const opener = document.activeElement;
      const player = (game.players || {})[sq.name];
      const byGuest = !!(player && player.g);
      const overlay = overlayEl('0.65');
      const box = el('div', 'card square-dialog');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', `Square row ${Math.floor(idx / 10) + 1} column ${idx % 10 + 1}`);
      box.style.cssText = 'max-width:440px; width:100%; box-shadow: var(--shadow-pop);';
      const when = typeof sq.at === 'number' ? `Claimed ${formatAt(sq.at)}` : 'Claim time not recorded';
      box.innerHTML = `<h3 style="margin-top:0"></h3>
        <p class="player-sub">Row ${Math.floor(idx / 10) + 1}, column ${idx % 10 + 1}</p>
        <p>${escapeHtml(when)}${byGuest ? '. Picked by the guest on their own phone.' : '. Picked by you.'}</p>`;
      box.querySelector('h3').textContent = sq.name;
      const err = el('div', 'error-msg hidden');
      box.appendChild(err);
      const showE = (m) => { err.textContent = m; err.classList.remove('hidden'); };

      const giveWrap = el('div', 'hidden');
      giveWrap.innerHTML = `<label for="sq-give">Give this square to</label><input type="text" id="sq-give" maxlength="10" placeholder="Name">`;
      const actions = el('div', 'actions');
      const removeBtn = textEl('button', 'danger', 'Remove');
      const giveBtn = textEl('button', 'secondary', 'Give to someone else');
      const goBtn = textEl('button', '', 'Give square');
      goBtn.classList.add('hidden');
      const closeBtn = textEl('button', 'secondary', 'Close');
      [removeBtn, giveBtn, goBtn, closeBtn].forEach(b => { b.type = 'button'; });
      actions.appendChild(removeBtn); actions.appendChild(giveBtn); actions.appendChild(goBtn); actions.appendChild(closeBtn);
      box.appendChild(giveWrap);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      removeBtn.focus();

      function onKey(e) { if (e.key === 'Escape') close(); }
      function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (opener && opener.isConnected) opener.focus();
      }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      closeBtn.addEventListener('click', close);

      const same = (doc) => doc.squares[idx] && doc.squares[idx].name === sq.name && doc.squares[idx].at === sq.at;
      const changed = 'That square just changed. The board has been refreshed.';

      removeBtn.addEventListener('click', async () => {
        const ok = await showConfirm(`Remove ${sq.name} from this square?`);
        if (!ok) return;
        close();
        const r = await persist(doc => {
          if (!same(doc)) return changed;
          doc.squares[idx] = null;
          pruneEmptyPlayers(doc);
        }, showErr);
        if (!r) return;
        if (r.refused) return refusedReload(r);
        SBS.go({ screen: 'picking', game: r.game });
      });

      giveBtn.addEventListener('click', () => {
        giveWrap.classList.remove('hidden');
        giveBtn.classList.add('hidden');
        removeBtn.classList.add('hidden');
        goBtn.classList.remove('hidden');
        giveWrap.querySelector('input').focus();
      });
      const input = giveWrap.querySelector('input');
      input.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });
      goBtn.addEventListener('click', async () => {
        err.classList.add('hidden');
        const raw = input.value.trim();
        if (!raw) return showE('Enter a name.');
        if (!isPlayerName(raw)) return showE('That name is not allowed. Choose a different name.');
        const out = {};
        const hadName = collectNameGroups(game).has(raw.toLowerCase());
        const name = await resolveNameForPick(game, raw, out);
        if (!name) return;
        if (name === sq.name) return close();
        close();
        const r = await persist(doc => {
          if (!same(doc)) return changed;
          const refused = nameGuard(doc, name, out.rename, hadName);
          if (refused) return refused;
          addSquares(doc, name, [idx], false); // a new owner, a new claim time
          pruneEmptyPlayers(doc);
        }, showErr);
        if (!r) return;
        if (r.refused) return refusedReload(r);
        SBS.go({ screen: 'picking', game: r.game });
      });
    }

    // ---- Right: board preview + host controls ----
    const finishWrap = el('div', 'card');
    finishWrap.innerHTML = `<h3>Host Controls</h3><p style="color:var(--muted)">When picking is complete (or you want to lock it early), generate the grid numbers and begin the game. This cannot be undone.</p>`;
    const lockBtn = el('button', 'danger', 'Finish Picking & Generate Numbers');
    lockBtn.addEventListener('click', async () => {
      const ok = await showConfirm('Lock the grid and randomly generate axis numbers now? Square picking cannot be resumed after this.');
      if (!ok) return;
      startGame();
    });
    finishWrap.appendChild(el('div', 'actions', '')).appendChild(lockBtn);

    const right = el('div');
    const boardCard = el('div', 'card');
    const boardTitle = el('h3', '', '');
    boardCard.appendChild(boardTitle);
    const boardHolder = el('div');
    boardHolder.id = 'board-holder';
    boardCard.appendChild(boardHolder);
    boardCard.appendChild(el('div', 'board-legend', '<span class="legend-chip"></span> Square is claimed but not paid for'));
    right.appendChild(boardCard);
    right.appendChild(finishWrap);
    layout.appendChild(right);

    function drawPreview() {
      const filled = game.squares.filter(s => s).length;
      boardTitle.textContent = `Board Preview (${filled}/100 sold) ${manualSelecting ? '— tap empty squares to claim' : '— tap a claimed square to see who has it'}`;
      SBS.board.renderPickBoard(boardHolder, game, {
        selecting: manualSelecting,
        selected: manualSelected,
        target: manualTarget,
        pickColor: manualSelecting ? ensurePlayerColor(game, manualName) : null,
        onFilled: manualSelecting ? null : openSquareDialog,
        onToggle: (idx) => {
          const pos = manualSelected.indexOf(idx);
          if (pos >= 0) {
            manualSelected.splice(pos, 1);
          } else {
            if (manualSelected.length >= manualTarget) return;
            manualSelected.push(idx);
          }
          refreshPreview();
        }
      });
    }

    function refreshPreview() {
      drawPreview();
      updateManualBanner();
    }

    drawPreview();

    let cutoffBlocked = false;
    async function startGame() {
      // Latched: without this a double-tap (or a stray timer) could fire two
      // saves that each generate their own axis numbers. Reset on both the
      // success and failure paths — this flag is module-level (so it
      // survives a re-render mid-save), which means leaving it stuck `true`
      // after a successful lock would silently no-op every future game's
      // "Finish Picking" button for the rest of the browser session.
      if (lockInFlight) return;
      lockInFlight = true;
      try {
        // Locks the newest board: a guest's pick that landed first stays in it.
        const r = await SBS.saveWith(game, doc => { lockGame(doc); });
        lockInFlight = false;
        SBS.go({ screen: 'board', game: r.game });
      } catch (e) {
        lockInFlight = false;
        // Not signed in, or not this host's board. Retrying can't help, so stop
        // the cutoff timer before any dialog opens, or it would stack one more
        // every few seconds. (The server locks the board on its own anyway.)
        if (e.forbidden || e.authRequired) cutoffBlocked = true;
        if (await SBS.handleConflict(e, game.id)) return;
        const denied = await SBS.handleForbidden(e, game.id);
        if (denied) {
          if (denied.fresh && ['started', 'finished'].includes(denied.fresh.status) && SBS.currentScreen() === 'picking') SBS.openGame(denied.fresh);
          return;
        }
        showAlert('Failed to start game: ' + e.message);
      }
    }

    // Auto-cutoff watcher. The server locks the board on its own too (so a
    // cutoff still fires with every device asleep); this just makes it prompt
    // while someone is watching.
    if (game.autoCutoffEnabled && game.autoCutoffTime) {
      const cutoffMs = new Date(game.autoCutoffTime).getTime();
      const checkCutoff = () => {
        if (!cutoffBlocked && SBS.currentScreen() === 'picking' && Date.now() >= cutoffMs) startGame();
      };
      checkCutoff();
      SBS.setManagedInterval(checkCutoff, 5000);
    }

    // Something the host has typed or is typing here. A full redraw would wipe it.
    function hostIsTyping() {
      const a = document.activeElement;
      if (a && a.tagName === 'INPUT' && a.type !== 'checkbox' && main.contains(a)) return true;
      return !!formWrap.querySelector('#p-name').value || !!formWrap.querySelector('#p-count').value;
    }

    // Poll for changes made on another device (the iPad and the PC are often
    // both on this screen) and, now, by guests, who may change the board every few
    // seconds. A half-finished manual pick or a half-typed name is never yanked away: the
    // board redraws in place and only squares that were taken leave the selection.
    SBS.setManagedInterval(async () => {
      if (SBS.currentScreen() !== 'picking' || lockInFlight || saving) return;
      try {
        const fresh = await SBS.api.getGame(game.id);
        if (!fresh.updatedAt || fresh.updatedAt === game.updatedAt) return;
        if (fresh.status === 'started' || fresh.status === 'finished' || (!manualSelecting && !hostIsTyping())) {
          const locked = fresh.status === 'started' || fresh.status === 'finished';
          const y = window.scrollY;
          SBS.go({ screen: locked ? 'board' : 'picking', game: fresh });
          if (!locked) window.scrollTo(0, y); // guests pick often: don't jump to the top each time
          return;
        }
        replaceGame(game, fresh);
        const before = manualSelected.length;
        manualSelected = manualSelected.filter(i => !game.squares[i]);
        if (manualSelected.length !== before) {
          const lost = before - manualSelected.length;
          showErr(`${lost} of your squares ${lost === 1 ? 'was' : 'were'} just taken. The rest are still selected.`);
        }
        drawStrip();
        refreshPreview();
      } catch (e) {
        // Deleted on another device — nothing left here to show.
        if (e && e.status === 404) SBS.go({ screen: 'home' });
        // Otherwise offline or server restarting — try again next tick.
      }
    }, 6000);
  }

  SBS.screens.picking = renderPicking;
})();
