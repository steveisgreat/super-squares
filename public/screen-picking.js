// Step 2: claiming squares, and the host control that locks the board.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, topbar, showConfirm, showAlert, applyTeamColors, teamBadge, fitTeamBadges, isPhone, overlayEl } = SBS.ui;
  const { openManagePlayersModal, resolveNameForPick, ensurePlayerColor, addSquares, replaceGame, formatAt, ensurePlayers, renameSquares, collectNameGroups } = SBS.players;
  const { shuffle, lockGame, isPlayerName, unpaidGuestPicks, pruneEmptyPlayers, parsePlayerList } = window.GameLogic;

  // Guards the one irreversible action in the app (drawing the axis numbers).
  // Module-level so a re-render can't reset it mid-save.
  let lockInFlight = false;

  // A pasted list, kept outside the render so a redraw (Cancel, Manage Players, a save) never
  // loses it. One board at a time.
  let pasteDraft = { id: null, text: '' };

  // Which tab is open, kept the same way (every save redraws the screen).
  let view = { id: null, tab: 'add' };

  const NAME_RACE = 'Someone just picked under that name. Check the list and try again.';

  function renderPicking(game) {
    const app = SBS.appEl;
    applyTeamColors(game);
    app.innerHTML = '';
    app.classList.remove('fit-screen'); // set again on a wide screen (R35)
    const reopen = () => SBS.go({ screen: 'picking', game });

    const phone = isPhone();
    if (view.id !== game.id) view = { id: game.id, tab: 'add' };
    const headerMeta = [escapeHtml(SBS.ui.shownDescription(game) || game.gameDate), SBS.ui.kickoffNotice(game)].filter(Boolean).join(' &middot; ');
    // The top bar: Home, the matchup in the exact center, then (wide) the join chip, and Connect.
    const bar = topbar('', [], { hideIcon: true });
    bar.classList.add('gd-topbar', 'pick-topbar');
    if (phone) bar.classList.add('gd-topbar-phone');
    const head = el('div', 'gd-head');
    const match = el('h1', 'gd-match badge-fit',
      `${teamBadge(game, 'A', { logoSize: 20, cls: 'team-badge-sm' })}<span class="vs-sep">vs</span>${teamBadge(game, 'B', { logoSize: 20, cls: 'team-badge-sm' })}`);
    head.append(match, el('div', 'gd-meta', headerMeta));
    bar.replaceChild(head, bar.querySelector('h1'));
    const nav = bar.querySelector('.nav');
    if (!phone && game.joinCode) nav.appendChild(SBS.playerView.joinChip(game));
    nav.appendChild(SBS.deviceChooser.button(game));
    app.appendChild(bar);
    fitTeamBadges(bar);

    const main = el('div', 'main pick-main');
    app.appendChild(main);

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

    // ---- Player picks: a row in the panel; the settings open in a dialog ----
    const picksSec = el('section', 'pick-sec picks-row');
    picksSec.setAttribute('aria-label', 'Player picks');
    function drawPicksRow() {
      const gp = game.guestPick;
      const limit = !gp || !gp.on ? 'Only you can add squares'
        : gp.lifted || (gp.liftAt && Date.parse(gp.liftAt) <= Date.now()) ? 'No limit per person'
        : `Up to ${gp.max} square${gp.max === 1 ? '' : 's'} each${gp.liftAt ? ` until ${formatAt(Date.parse(gp.liftAt) / 1000)}` : ''}`;
      picksSec.innerHTML = `<div class="picks-info"><h3>Player picks: ${gp && gp.on ? 'On' : 'Off'}</h3><p>${escapeHtml(limit)}</p></div>`;
      const change = textEl('button', 'secondary', 'Change');
      change.type = 'button';
      change.setAttribute('aria-label', 'Change player picks');
      change.setAttribute('aria-haspopup', 'dialog');
      change.addEventListener('click', openPicksDialog);
      picksSec.appendChild(change);
    }

    function openPicksDialog() {
      const opener = document.activeElement;
      const gp = game.guestPick || { on: false, max: 5, liftAt: null, lifted: false };
      const overlay = overlayEl('0.65');
      const box = el('div', 'card pick-dialog');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'pp-title');
      box.innerHTML = `
        <h3 id="pp-title">Player picks</h3>
        <label class="dialog-row"><span>Allow picks in Player View<small>Anyone with the link can claim squares.</small></span><input type="checkbox" id="pp-on"${gp.on ? ' checked' : ''}></label>
        <div class="dialog-row"><label for="pp-max">Most squares per person</label><input type="number" id="pp-max" min="1" max="100" step="1" value="${escapeHtml(gp.max)}"></div>
        <label class="dialog-row"><span>Lift the limit now<small>${gp.liftAt && !gp.lifted ? `It ${Date.parse(gp.liftAt) > Date.now() ? 'ends on its own' : 'ended'} ${escapeHtml(formatAt(Date.parse(gp.liftAt) / 1000))}.` : 'Players can pick as many as they like.'}</small></span><input type="checkbox" id="pp-lift"${gp.lifted ? ' checked' : ''}></label>
        <div class="error-msg hidden" role="alert"></div>`;
      const err = box.querySelector('.error-msg');
      const showE = (m) => { err.textContent = m; err.classList.remove('hidden'); };

      const unpaid = unpaidGuestPicks(game);
      const n = unpaid.squares.length;
      const clear = textEl('button', 'danger-line', n ? `Remove ${n} unpaid player pick${n === 1 ? '' : 's'}` : 'No unpaid player picks');
      clear.type = 'button';
      clear.disabled = n === 0;
      box.appendChild(clear);

      const actions = el('div', 'pick-dialog-actions');
      const cancel = textEl('button', 'secondary', 'Cancel');
      const save = textEl('button', '', 'Save');
      [cancel, save].forEach(b => { b.type = 'button'; actions.appendChild(b); });
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      box.querySelector('#pp-on').focus();

      function onKey(e) { if (e.key === 'Escape') close(); }
      function close() {
        if (!overlay.isConnected) return; // also runs when the screen changes
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (opener && opener.isConnected) opener.focus();
      }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      SBS.onLeaveScreen(close);
      cancel.addEventListener('click', close);

      save.addEventListener('click', async () => {
        const next = { on: box.querySelector('#pp-on').checked, max: Number(box.querySelector('#pp-max').value), lifted: box.querySelector('#pp-lift').checked };
        if (!Number.isInteger(next.max) || next.max < 1 || next.max > 100) return showE('Enter a whole number from 1 to 100.');
        // Only what the host changed here is written, so another device's change is kept.
        const patch = {};
        Object.keys(next).forEach(k => { if (next[k] !== gp[k]) patch[k] = next[k]; });
        if (!Object.keys(patch).length) return close();
        save.disabled = true;
        const r = await persist(doc => { doc.guestPick = Object.assign({ on: false, max: 5, liftAt: null, lifted: false }, doc.guestPick, patch); }, showE);
        save.disabled = false;
        if (!r) return;
        close();
        SBS.go({ screen: 'picking', game: r.game });
      });

      clear.addEventListener('click', async () => {
        const ok = await showConfirm(`Remove ${n} unpaid square${n === 1 ? '' : 's'} picked by ${unpaid.people} player${unpaid.people === 1 ? '' : 's'} in Player View? Squares marked paid stay. This cannot be undone.`);
        if (!ok) return;
        const r = await persist(doc => {
          const now = unpaidGuestPicks(doc);
          if (now.squares.length !== n) return 'Player picks changed while you were confirming. Check and try again.';
          now.squares.forEach(i => { doc.squares[i] = null; });
          pruneEmptyPlayers(doc);
        }, showE);
        if (!r) return;
        close();
        if (r.refused) return refusedReload(r);
        SBS.go({ screen: 'picking', game: r.game });
      });
    }

    // From 1024 px: one panel with Add squares and Players tabs, then the board. Below that one
    // column: that panel, the board, then player picks and the lock. A phone (or a window as narrow)
    // shows one thing at a time, like Game Day: what is sold, then Squares, Grid and Players tabs.
    const layout = el('div', 'pick-fill' + (phone ? ' is-phone' : ''));
    main.appendChild(layout);
    const boardCard = el('div', 'card board-card');
    const side = el('div', 'card pick-side');
    const foot = el('div', 'pick-foot');

    // ---- Tabs ----
    const tabBar = el('div', 'gd-tabs pick-tabs');
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Squares');
    const addSec = el('section', 'pick-sec add-sec');
    const playersSec = el('section', 'pick-sec players-sec');
    const tabs = { add: { panel: addSec }, grid: { panel: boardCard }, players: { panel: playersSec } };
    let tabbed = false; // the phone layout: the grid is a tab too
    const tabKeys = () => Object.keys(tabs).filter(k => tabbed || k !== 'grid');
    Object.keys(tabs).forEach((k) => {
      const t = tabs[k].btn = el('button', 'gd-tab', '');
      t.type = 'button';
      t.id = `pick-tab-${k}`;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-controls', `pick-panel-${k}`);
      tabs[k].panel.id = `pick-panel-${k}`;
      t.addEventListener('click', () => selectTab(k));
      t.addEventListener('keydown', (e) => {
        const keys = tabKeys();
        const i = keys.indexOf(k);
        const to = e.key === 'ArrowRight' ? keys[(i + 1) % keys.length]
          : e.key === 'ArrowLeft' ? keys[(i + keys.length - 1) % keys.length]
            : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys[keys.length - 1] : null;
        if (!to) return;
        e.preventDefault();
        selectTab(to);
        tabs[to].btn.focus();
      });
      tabBar.appendChild(t);
    });
    function labelTabs() {
      const n = new Set(game.squares.filter(Boolean).map(sq => sq.name)).size;
      tabs.add.btn.textContent = tabbed ? 'Squares' : 'Add squares';
      tabs.grid.btn.textContent = 'Grid';
      tabs.players.btn.textContent = n ? `Players (${n})` : 'Players';
    }
    function selectTab(k) {
      view.tab = k;
      const keys = tabKeys();
      const shown = keys.indexOf(k) < 0 ? 'add' : k; // the grid is only a tab on a phone
      Object.keys(tabs).forEach(o => {
        const isTab = keys.indexOf(o) >= 0;
        const on = o === shown;
        const { btn, panel } = tabs[o];
        btn.hidden = !isTab;
        btn.setAttribute('aria-selected', String(on));
        btn.tabIndex = on ? 0 : -1;
        panel.hidden = isTab && !on;
        if (isTab) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', btn.id); }
        else { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
      });
      side.hidden = tabbed && shown === 'grid';
      if (tabbed && shown === 'grid') drawPreview(); // it was hidden: fit the names again
    }
    // Where a half-made pick is finished: beside the board, or on the phone's Grid tab.
    const claimTab = () => (tabbed ? 'grid' : 'add');
    side.append(tabBar, addSec, playersSec);

    // ---- Add squares: one player; the icon in the corner opens Paste a list ----
    const onePane = el('div', 'one-pane');
    const addHead = el('div', 'add-head', '<h3>Add a player</h3>');
    if (game.pickMode !== 'manual') {
      const pasteOpen = el('button', 'icon-btn paste-open', SBS.ui.PASTE_ICON);
      pasteOpen.type = 'button';
      pasteOpen.title = 'Paste a list';
      pasteOpen.setAttribute('aria-label', 'Paste a list of players');
      pasteOpen.setAttribute('aria-haspopup', 'dialog');
      pasteOpen.addEventListener('click', () => openPasteDialog(pasteOpen));
      addHead.appendChild(pasteOpen);
    }
    const addedNote = el('p', 'added-note');
    addedNote.setAttribute('role', 'status');
    addSec.append(addHead, addedNote);

    const errBox = el('div', 'error-msg hidden');
    errBox.setAttribute('role', 'alert');
    addSec.append(errBox, onePane);
    // Whatever tab is open, the message is where the host can see it.
    function showErr(msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); selectTab(manualSelecting ? claimTab() : 'add'); }
    function clearErr() { errBox.classList.add('hidden'); }

    // "Claiming for" panel: shown in place of the form from the first selected square until Done or
    // Cancel. Already paid stays, so it can still be changed.
    const manualBanner = el('div', 'manual-banner hidden');
    manualBanner.setAttribute('aria-label', 'Claiming for');
    const manualBtns = el('div', 'manual-actions hidden');
    const formWrap = el('div', 'pick-form');
    formWrap.innerHTML = `
      <div class="pick-fields">
        <div><label for="p-name">Name</label><input type="text" id="p-name" placeholder="Enter name" maxlength="10" autocomplete="off" required></div>
        <div><label for="p-count">Squares</label><input type="number" id="p-count" min="1" max="100" step="1" inputmode="numeric" required></div>
      </div>
      <div class="pick-total" role="status"></div>
      <label class="checkbox-label"><input type="checkbox" id="p-paid"> <span>Already paid</span></label>
    `;
    onePane.append(manualBanner, formWrap, manualBtns);
    const nameInput = formWrap.querySelector('#p-name');
    const countInput = formWrap.querySelector('#p-count');
    const paidInput = formWrap.querySelector('#p-paid');
    // What the squares typed in come to, so the host can say it as the player pays.
    const totalRow = formWrap.querySelector('.pick-total');
    function drawTotal() {
      const n = Number(countInput.value);
      const price = parseFloat(game.squarePrice) || 0;
      const show = Number.isInteger(n) && n > 0 && price > 0;
      totalRow.innerHTML = show ? `<span>${paidInput.checked ? 'Total paid' : 'Total owed'}</span><strong>${money(n * price)}</strong>` : '';
    }
    countInput.addEventListener('input', () => { drawTotal(); clearErr(); });
    nameInput.addEventListener('input', () => { clearErr(); addedNote.textContent = ''; });
    paidInput.addEventListener('change', drawTotal);
    // The name and the number of squares, both required, or null with the reason shown.
    function readForm(noName) {
      const refuse = (msg, input) => { showErr(msg); input.focus(); return null; };
      const name = nameInput.value.trim();
      if (!name) return refuse(noName, nameInput);
      if (!isPlayerName(name)) return refuse('That name is not allowed. Choose a different name.', nameInput);
      const raw = countInput.value.trim();
      const count = Number(raw);
      if (!raw) return refuse('Enter how many squares.', countInput);
      if (!Number.isInteger(count) || count < 1) return refuse('Enter a whole number of squares.', countInput);
      const open = openSquares().length;
      if (count > open) return refuse(`Only ${open} square${open === 1 ? ' is' : 's are'} open.`, countInput);
      return { name, count, paid: paidInput.checked };
    }

    // Tapping open squares claims them in manual and both modes; in auto they stay inert.
    const tapToClaim = game.pickMode !== 'auto';
    let actionBtn = null;
    if (game.pickMode !== 'manual') {
      actionBtn = el('button', 'full-width add-btn', 'Auto-pick squares');
      actionBtn.type = 'button';
      onePane.appendChild(actionBtn);
    }
    if (tapToClaim) {
      // On a phone the board is another tab, so a button goes there with the typed name.
      const gridBtn = el('button', 'full-width grid-btn' + (actionBtn ? ' secondary' : ''), 'Pick on the grid');
      gridBtn.type = 'button';
      gridBtn.addEventListener('click', () => startManual(null));
      onePane.appendChild(gridBtn);
    }
    if (tapToClaim) onePane.appendChild(el('p', 'tap-hint', actionBtn ? 'or tap open squares on the board' : 'Type a name, then tap open squares on the board.'));
    addSec.appendChild(el('p', 'claim-note', 'Finish the pick on the Grid tab, or cancel it there.'));
    const fullNote = el('p', 'tap-hint full-note hidden', 'Every square is taken. Tap a square on the board to remove it or give it to someone else.');
    addSec.insertBefore(fullNote, errBox);

    // ---- Manual selection state ----
    let manualSelecting = false;
    let manualTarget = 0;
    let manualSelected = [];
    let manualName = '';
    let manualPaid = false;
    let manualRename = null; // { rename } from the duplicate-name prompt, replayed on a newer board
    let manualHadName = false;
    let saving = false;

    const playerPrice = () => parseFloat(game.squarePrice) || 0;
    const openSquares = () => game.squares.map((s, i) => s ? -1 : i).filter(i => i >= 0);

    // Claiming for, Already paid, Done and any message sit in the panel, or above the phone's grid.
    const claimSlot = el('div', 'claim-slot');
    function placeClaim() {
      const onGrid = tabbed && manualSelecting;
      addSec.classList.toggle('is-claiming', manualSelecting);
      claimSlot.classList.toggle('is-claiming', onGrid);
      if (onGrid === (manualBanner.parentNode === claimSlot)) return;
      const act = document.activeElement;
      if (onGrid) claimSlot.append(manualBanner, errBox, formWrap, manualBtns);
      else { addSec.insertBefore(errBox, onePane); onePane.prepend(manualBanner, formWrap, manualBtns); }
      if (act && act !== document.activeElement && formWrap.contains(act)) act.focus();
    }
    function updateManualBanner() {
      // The banner is redrawn on every tap and poll: keep the keyboard on the same button.
      const had = document.activeElement && manualBtns.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      manualBanner.innerHTML = '';
      manualBtns.innerHTML = '';
      manualBanner.classList.toggle('hidden', !manualSelecting);
      manualBtns.classList.toggle('hidden', !manualSelecting);
      placeClaim();
      if (!manualSelecting) return;
      const n = manualSelected.length;
      const count = `${n} of ${manualTarget} picked`;
      const amount = money(n * playerPrice());
      manualBanner.appendChild(el('div', 'manual-for', 'Claiming for'));
      manualBanner.appendChild(el('div', 'manual-name', escapeHtml(manualName)));
      const status = el('div', 'manual-count', `${escapeHtml(count)}`);
      status.setAttribute('role', 'status');
      manualBanner.appendChild(status);
      manualBanner.appendChild(el('div', 'manual-paid', `${escapeHtml(manualName)} ${manualPaid ? 'paid' : 'owes'} ${escapeHtml(amount)}`));
      const btns = manualBtns;
      const other = manualTarget - n;
      if (game.pickMode === 'both' && other > 0) {
        const autoBtn = el('button', 'secondary', `Auto-pick the other ${other}`);
        autoBtn.type = 'button';
        autoBtn.dataset.act = 'auto';
        autoBtn.disabled = saving;
        autoBtn.addEventListener('click', autoPickRest);
        btns.appendChild(autoBtn);
      }
      const confirmBtn = el('button', '', 'Done');
      confirmBtn.type = 'button';
      confirmBtn.dataset.act = 'done';
      confirmBtn.disabled = n === 0 || saving;
      confirmBtn.addEventListener('click', confirmManualPick);
      const cancelBtn = el('button', 'secondary', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.dataset.act = 'cancel';
      cancelBtn.addEventListener('click', () => {
        manualSelecting = false;
        manualSelected = [];
        pruneEmptyPlayers(game); // the preview gave this name a color; without squares it is nobody
        const y = window.scrollY;
        reopen(); // through SBS.go, so this screen's poll and cutoff timers end with it
        window.scrollTo(0, y);
      });
      btns.appendChild(confirmBtn);
      btns.appendChild(cancelBtn);
      if (had) { const b = manualBtns.querySelector(`[data-act="${had}"]`); if (b && !b.disabled) b.focus(); }
    }

    // Adds random open squares to the selection until it reaches the target. Done still saves once.
    function autoPickRest() {
      if (!manualSelecting || saving) return;
      const free = shuffle(openSquares().filter(i => manualSelected.indexOf(i) < 0));
      manualSelected = manualSelected.concat(free.slice(0, manualTarget - manualSelected.length));
      refreshPreview();
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
        return refreshPreview();
      }
      manualSelecting = false;
      manualSelected = [];
      SBS.go({ screen: 'picking', game: r.game });
    }

    if (actionBtn) actionBtn.addEventListener('click', async () => {
      clearErr();
      const form = readForm('Enter a name.');
      if (!form) return;
      const { name: rawName, count, paid: paidChecked } = form;
      const out = {};
      const hadName = collectNameGroups(game).has(rawName.toLowerCase());
      const name = await resolveNameForPick(game, rawName, out);
      if (!name) return; // host cancelled at the duplicate-name prompt
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
    });

    paidInput.addEventListener('change', (e) => {
      if (!manualSelecting) return;
      manualPaid = e.target.checked;
      updateManualBanner();
    });

    // ---- Tap an open square (manual and both modes) ----
    // With no selection yet, the tap starts one with the typed name; with one, it selects or un-selects the square.
    let starting = false;
    async function onOpenTap(idx) {
      if (saving || starting) return;
      if (manualSelecting) {
        const pos = manualSelected.indexOf(idx);
        if (pos >= 0) {
          manualSelected.splice(pos, 1);
        } else {
          if (game.squares[idx]) return;
          if (manualSelected.length >= manualTarget) return showErr(`All ${manualTarget} are picked. Tap Done, or tap a picked square to undo.`);
          manualSelected.push(idx);
        }
        clearErr();
        selectTab(claimTab());
        return refreshPreview();
      }
      return startManual(idx);
    }

    // Starts a pick for the typed name, with `idx` as its first square (null: none yet).
    async function startManual(idx) {
      if (saving || starting || manualSelecting) return;
      clearErr();
      const form = readForm(tabbed ? 'Enter a name first, then pick on the grid.' : 'Enter a name first, then tap squares.');
      if (!form) return;
      const rawName = form.name;
      const out = {};
      const hadName = collectNameGroups(game).has(rawName.toLowerCase());
      starting = true;
      let name;
      try { name = await resolveNameForPick(game, rawName, out); } finally { starting = false; }
      if (!name) return; // host cancelled at the duplicate-name prompt
      if (idx !== null && game.squares[idx]) return showErr('That square was just taken.');
      manualSelecting = true;
      manualTarget = form.count;
      manualSelected = idx === null ? [] : [idx];
      manualName = name;
      manualPaid = paidInput.checked;
      manualRename = out.rename || null;
      manualHadName = hadName;
      selectTab(claimTab());
      refreshPreview();
    }

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
        <p>${escapeHtml(when)}${byGuest ? '. Picked in Player View.' : '. Picked by you.'}</p>`;
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

    // ---- Lock the board ----
    const lockSec = el('section', 'pick-sec lock-sec');
    lockSec.setAttribute('aria-label', 'Lock the board');
    lockSec.innerHTML = '<h3></h3><p></p>';
    const lockBtn = el('button', 'full-width lock-btn', 'Lock board and draw numbers');
    lockBtn.type = 'button';
    lockBtn.addEventListener('click', async () => {
      const ok = await showConfirm('Lock the grid and randomly generate axis numbers now? Square picking cannot be resumed after this.');
      if (!ok) return;
      startGame();
    });
    lockSec.appendChild(lockBtn);
    foot.append(picksSec, lockSec);

    // ---- The board: the stat panels above it, how to use it below ----
    const boardHead = el('div', 'board-head');
    boardHead.innerHTML = [['sold', 'Sold'], ['open', 'Open'], ['pot', 'Pot'], ['price', 'Per square']]
      .map(([k, label]) => `<div class="board-stat is-${k}"><span class="val" data-v="${k}"></span><span class="lbl">${label}</span></div>`).join('');
    boardCard.append(boardHead, claimSlot);
    const boardHolder = el('div');
    boardHolder.id = 'board-holder';
    boardHolder.dataset.fit = '1'; // board.js keeps its axis bars and names fitted as it resizes (R35)
    boardCard.appendChild(boardHolder);
    const boardFoot = el('div', 'board-legend', '<span class="board-hint"></span><span class="legend-unpaid"><span class="legend-chip"></span> Not paid yet</span>');
    boardCard.appendChild(boardFoot);

    function drawPreview() {
      const filled = game.squares.filter(s => s).length;
      const open = 100 - filled;
      const full = open === 0;
      const put = (k, v) => { boardHead.querySelector(`[data-v="${k}"]`).textContent = v; };
      put('sold', String(filled));
      put('open', String(open));
      put('pot', money(filled * game.squarePrice));
      put('price', money(game.squarePrice));
      boardFoot.querySelector('.board-hint').textContent = manualSelecting ? 'Tap more squares, or tap a picked one to undo.'
        : tapToClaim && !full ? 'Tap an open square to claim it, or a name to see who has it.' : 'Tap a name to see who has it.';
      addSec.classList.toggle('is-full', full && !manualSelecting);
      fullNote.classList.toggle('hidden', !full || manualSelecting);
      lockSec.classList.toggle('is-ready', full);
      lockSec.querySelector('h3').textContent = full ? 'Sold out' : 'When everyone is in';
      lockSec.querySelector('p').textContent = full
        ? 'Lock the board to draw the numbers and go to Game Day. This cannot be undone.'
        : `${open} square${open === 1 ? ' is' : 's are'} still open. Locking draws the numbers and ends picking for good.`;
      SBS.board.renderPickBoard(boardHolder, game, {
        selecting: manualSelecting,
        selected: manualSelected,
        target: manualTarget,
        pickColor: manualSelecting ? ensurePlayerColor(game, manualName) : null,
        onFilled: manualSelecting ? null : openSquareDialog,
        onOpen: tapToClaim ? onOpenTap : null
      });
    }

    function refreshPreview() {
      drawPreview();
      updateManualBanner();
    }

    // ---- Players: who has what and who owes (shared with Game Day) ----
    const players = SBS.players.playersCard({
      cls: 'pick-players',
      emptyText: 'No one is in yet. Add the first player, or share the join code.',
      getGame: () => game,
      save: persist,
      manage: () => openManagePlayersModal(game, reopen),
      busy: () => saving,
      setBusy: (v) => { saving = v; },
      onSaved: (r) => { replaceGame(game, r.game); afterGameChange(); }
    });
    players.el.classList.remove('card'); // it sits inside the panel
    playersSec.appendChild(players.el);
    function drawPlayers() {
      players.draw();
      labelTabs();
    }

    // ---- Paste a list of players (auto and both modes): a dialog, drawn while it is open ----
    let pasteCard = null;
    let pasteBox = null;
    let pasteNote = '';
    let pasteStatus = null;
    let pasteMsg = null;
    let pasteBtn = null;
    let closePaste = () => {};
    function openPasteDialog(opener) {
      if (pasteCard) return;
      const overlay = overlayEl('0.65');
      pasteCard = el('div', 'card pick-dialog paste-card');
      pasteCard.setAttribute('role', 'dialog');
      pasteCard.setAttribute('aria-modal', 'true');
      pasteCard.setAttribute('aria-labelledby', 'paste-title');
      pasteCard.innerHTML = `<h3 id="paste-title">Paste a list</h3>
        <label for="paste-list">One player per line: name, squares, then “unpaid” if they still owe.</label>
        <textarea id="paste-list" rows="7" spellcheck="false" autocomplete="off" placeholder="Lee 5&#10;Ann 3 unpaid"></textarea>`;
      pasteBox = pasteCard.querySelector('#paste-list');
      pasteStatus = el('div', 'paste-status');
      pasteStatus.setAttribute('role', 'status');
      pasteMsg = el('div', 'paste-msg');
      pasteMsg.setAttribute('role', 'status');
      const actions = el('div', 'pick-dialog-actions');
      const cancel = textEl('button', 'secondary', 'Cancel');
      pasteBtn = textEl('button', '', 'Add everyone');
      [cancel, pasteBtn].forEach(b => { b.type = 'button'; actions.appendChild(b); });
      pasteCard.append(pasteStatus, pasteMsg, actions);
      overlay.appendChild(pasteCard);
      document.body.appendChild(overlay);
      // The text stays in the draft when the dialog closes, so a stray tap loses nothing.
      pasteNote = '';
      if (pasteDraft.id === game.id) pasteBox.value = pasteDraft.text;
      pasteBox.addEventListener('input', () => {
        pasteDraft = { id: game.id, text: pasteBox.value };
        pasteNote = '';
        updatePaste();
      });
      // An alert on top keeps its own keys.
      function onKey(e) {
        if (document.body.lastElementChild !== overlay) return;
        if (e.key === 'Escape') { if (!saving) closePaste(); return; }
        if (e.key !== 'Tab') return;
        const items = [pasteBox, cancel, pasteBtn].filter(n => !n.disabled);
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      closePaste = () => {
        closePaste = () => {};
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        pasteCard = pasteBox = pasteStatus = pasteMsg = pasteBtn = null;
        if (opener && opener.isConnected) opener.focus();
      };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !saving) closePaste(); });
      cancel.addEventListener('click', () => { if (!saving) closePaste(); });
      pasteBtn.addEventListener('click', addPasted);
      updatePaste();
      pasteBox.focus();
    }
    SBS.onLeaveScreen(() => closePaste());

    function updatePaste() {
      if (!pasteCard) return;
      const text = pasteBox.value;
      const p = parsePlayerList(text, game);
      pasteStatus.textContent = '';
      const say = (m, bad) => { const d = el('div', bad ? 'paste-bad' : 'paste-ok'); d.textContent = m; pasteStatus.appendChild(d); };
      if (!text.trim()) {
        say('Nothing pasted yet.');
      } else if (p.errors.length) {
        const sorted = p.errors.slice().sort((a, b) => (a.line || 1e9) - (b.line || 1e9));
        sorted.slice(0, 4).forEach(e => say(e.line ? `Line ${e.line}: ${e.message}` : e.message, true));
        if (sorted.length > 4) say(`and ${sorted.length - 4} more.`, true);
      } else {
        say(`${p.rows.length} player${p.rows.length === 1 ? '' : 's'}, ${p.total} square${p.total === 1 ? '' : 's'}, fits (${p.open} open)`);
      }
      pasteMsg.textContent = pasteNote;
      pasteBtn.disabled = saving || !text.trim() || p.errors.length > 0 || p.rows.length === 0;
    }

    // All or nothing, one save. The change parses the list again on the newest board and refuses
    // if it no longer fits (a guest took squares, or a name appeared): the text stays in the box.
    async function addPasted() {
      if (saving) return;
      const text = pasteBox.value;
      const pre = parsePlayerList(text, game);
      if (!pre.rows.length || pre.errors.length) return updatePaste();
      saving = true;
      updatePaste();
      updateManualBanner();
      let added = null;
      const r = await persist(doc => {
        const p = parsePlayerList(text, doc);
        if (p.errors.length || !p.rows.length) {
          const e = p.errors[0];
          return 'The board changed and the list no longer fits. ' + (e ? (e.line ? `Line ${e.line}: ` : '') + e.message : '');
        }
        const free = shuffle(doc.squares.map((s, i) => s ? -1 : i).filter(i => i >= 0));
        let at = 0;
        pruneEmptyPlayers(doc);
        p.rows.forEach(row => { addSquares(doc, row.name, free.slice(at, at + row.count), row.paid); at += row.count; });
        added = p;
      }, m => { pasteNote = m; });
      saving = false;
      if (!r) return afterGameChange();
      if (r.refused) {
        replaceGame(game, r.game);
        pasteNote = r.refused;
        return afterGameChange();
      }
      replaceGame(game, r.game);
      pasteDraft = { id: null, text: '' };
      pasteNote = '';
      closePaste();
      addedNote.textContent = added ? `Added ${added.rows.length} player${added.rows.length === 1 ? '' : 's'}, ${added.total} square${added.total === 1 ? '' : 's'}.` : 'Added.';
      afterGameChange();
    }

    // The board changed under us (a poll, a save): redraw everything in place. Typed text and a
    // half-made selection stay; only squares that were taken leave the selection.
    function afterGameChange() {
      const before = manualSelected.length;
      manualSelected = manualSelected.filter(i => !game.squares[i]);
      if (manualSelected.length !== before) {
        const lost = before - manualSelected.length;
        showErr(`${lost} of your squares ${lost === 1 ? 'was' : 'were'} just taken. The rest are still selected.`);
      }
      drawPlayers();
      drawPicksRow();
      updatePaste();
      refreshPreview();
    }

    // The page order is the visual order, so the keyboard follows it.
    const wideQuery = window.matchMedia('(min-width: 1024px)');
    const narrowQuery = window.matchMedia('(max-width: 699px)');
    function placeCards() {
      const wide = wideQuery.matches && !phone;
      tabbed = phone || narrowQuery.matches;
      const focused = document.activeElement;
      layout.classList.toggle('is-wide', wide);
      layout.classList.toggle('is-tabbed', tabbed);
      boardCard.classList.toggle('glass-board', wide); // the Party View grid (R35)
      app.classList.toggle('fit-screen', wide);
      foot.classList.toggle('card', !wide && !tabbed);
      if (wide || tabbed) side.appendChild(foot);
      if (tabbed) {
        [boardHead, tabBar, boardCard, side].forEach(n => layout.appendChild(n));
      } else {
        boardCard.prepend(boardHead);
        side.prepend(tabBar);
        (wide ? [side, boardCard] : [side, boardCard, foot]).forEach(n => layout.appendChild(n));
      }
      labelTabs();
      placeClaim();
      selectTab(view.tab);
      if (focused && focused !== document.activeElement && layout.contains(focused)) focused.focus();
    }
    // (addListener: iPads before Safari 14 have no addEventListener on a media query)
    [wideQuery, narrowQuery].forEach(q => { if (q.addEventListener) q.addEventListener('change', placeCards); else q.addListener(placeCards); });
    SBS.onLeaveScreen(() => {
      [wideQuery, narrowQuery].forEach(q => { if (q.removeEventListener) q.removeEventListener('change', placeCards); else q.removeListener(placeCards); });
      app.classList.remove('fit-screen');
    });
    drawPlayers();
    drawPicksRow();
    updatePaste();
    placeCards();
    drawPreview(); // last: the frame measures the board where it ends up

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

    // Something the host has typed or is typing here, or has open. A full redraw would wipe it.
    function hostIsTyping() {
      if (document.querySelector('.pick-dialog, .connect-layer')) return true;
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'checkbox' && main.contains(a)) return true;
      return !!nameInput.value || !!countInput.value;
    }

    // Poll for changes made on another device (the iPad and the PC are often
    // both on this screen) and, now, by guests, who may change the board every few
    // seconds. A half-finished manual pick or a half-typed name is never yanked away: the
    // board redraws in place and only squares that were taken leave the selection.
    SBS.setManagedInterval(async () => {
      if (SBS.currentScreen() !== 'picking' || lockInFlight || saving) return;
      try {
        const fresh = await SBS.api.pollGame(game.id);
        if (!fresh || lockInFlight || saving) return;
        if (!fresh.updatedAt || fresh.updatedAt === game.updatedAt) return;
        if (fresh.status === 'started' || fresh.status === 'finished' || (!manualSelecting && !hostIsTyping())) {
          const locked = fresh.status === 'started' || fresh.status === 'finished';
          // Players pick often: keep the place instead of jumping to the top.
          const y = window.scrollY;
          SBS.go({ screen: locked ? 'board' : 'picking', game: fresh });
          if (!locked) window.scrollTo(0, y);
          return;
        }
        replaceGame(game, fresh);
        afterGameChange();
      } catch (e) {
        // Deleted on another device — nothing left here to show.
        if (e && e.status === 404) SBS.go({ screen: 'home' });
        // Otherwise offline or server restarting — try again next tick.
      }
    }, 6000);
  }

  SBS.screens.picking = renderPicking;
})();
