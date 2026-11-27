// Players, payments, and duplicate-name handling — the bookkeeping side of the
// board, shared by the picking screen and game day.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, money, overlayEl, showChoice, showConfirm, showAlert } = SBS.ui;

  const { isPlayerName, pickPlayerColor, owedSummary, hostAddSquares, setPaidCount, pruneEmptyPlayers } = window.GameLogic;

  const MAX_NAME_LEN = 10;

  const EDIT_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M13 6l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const SUBSCRIPT_MAP = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
  const SUBSCRIPT_REV = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

  function toSubscript(n) { return String(n).split('').map(d => SUBSCRIPT_MAP[d] || d).join(''); }
  function fromSubscript(s) { return s.split('').map(c => SUBSCRIPT_REV[c] || '').join(''); }
  function stripSubscript(name) { return String(name).replace(/[₀₁₂₃₄₅₆₇₈₉]+$/, ''); }

  function ensurePlayers(game) {
    if (!game.players) game.players = {};
    return game.players;
  }

  // Assigns a color the first time a name appears, and never reassigns it
  // afterward — each player keeps one color for the life of the game. The palette and the
  // pick rule live in compute.js, which the server shares for guest picks.
  function ensurePlayerColor(game, name) {
    const players = ensurePlayers(game);
    if (!players[name]) players[name] = { paid: false };
    if (!players[name].color) players[name].color = pickPlayerColor(players);
    return players[name].color;
  }

  // Puts squares under a name for the host (the paid rules are in compute.js hostAddSquares).
  function addSquares(game, name, indexes, ticked) {
    hostAddSquares(game, name, indexes, ticked, Math.floor(Date.now() / 1000));
    ensurePlayerColor(game, name);
  }

  // Replaces what `game` holds with a newer copy, in place, so every screen that holds the
  // same object sees it.
  function replaceGame(game, next) {
    Object.keys(game).forEach(k => { delete game[k]; });
    Object.assign(game, next);
    return game;
  }

  // "Nov 24, 3:05 PM" in the viewer's own time zone.
  function formatAt(at) {
    return new Date(at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renameSquares(game, oldName, newName) {
    game.squares.forEach(sq => { if (sq && sq.name === oldName) sq.name = newName; });
    // A paid-out record follows the person, or the quarter would read Needs settling (R21).
    if (game.paidOut) Object.values(game.paidOut).forEach(r => { if (r && r.name === oldName) r.name = newName; });
    const players = ensurePlayers(game);
    if (players[oldName]) {
      players[newName] = players[oldName];
      delete players[oldName];
    }
  }

  // Groups existing squares by base name (ignoring any subscript) for duplicate detection.
  function collectNameGroups(game) {
    const groups = new Map();
    game.squares.forEach(sq => {
      if (!sq) return;
      const base = stripSubscript(sq.name);
      const key = base.toLowerCase();
      if (!groups.has(key)) groups.set(key, { base, variants: new Map() });
      const g = groups.get(key);
      g.variants.set(sq.name, (g.variants.get(sq.name) || 0) + 1);
    });
    return groups;
  }

  // Resolves the name to actually store for a new pick, prompting the host when
  // it collides with an existing player so they can combine or keep separate
  // (in which case a subscript number is appended, e.g. Steve₁ / Steve₂).
  // Returns null if the host cancels the pick entirely.
  async function resolveNameForPick(game, typedName, out) {
    const trimmed = typedName.trim();
    const groups = collectNameGroups(game);
    const key = trimmed.toLowerCase();
    if (!groups.has(key)) return trimmed;

    const group = groups.get(key);
    const variantNames = Array.from(group.variants.keys());
    const totalCount = Array.from(group.variants.values()).reduce((a, b) => a + b, 0);

    const choice = await showChoice({
      message: `"${trimmed}" already has ${totalCount} square${totalCount === 1 ? '' : 's'} picked (${variantNames.map(v => `"${v}"`).join(', ')}). Is this the same person?`,
      buttons: [
        { label: 'Same Person — Combine', value: 'same' },
        { label: 'Different Person — Keep Separate', value: 'separate' },
        { label: 'Cancel', value: null, variant: 'secondary' }
      ]
    });
    if (!choice) return null;

    if (choice === 'same') {
      return variantNames.find(v => stripSubscript(v) === v) || variantNames[0];
    }

    // "separate": figure out the next available subscript index.
    let maxIdx = 0;
    variantNames.forEach(v => {
      if (stripSubscript(v) !== v) {
        const m = v.match(/[₀₁₂₃₄₅₆₇₈₉]+$/);
        if (m) {
          const num = parseInt(fromSubscript(m[0]), 10);
          if (num > maxIdx) maxIdx = num;
        }
      }
    });
    const bareName = variantNames.find(v => stripSubscript(v) === v);
    if (bareName && !variantNames.includes(group.base + toSubscript(1))) {
      // With `out` the rename is only reported, so a save that is retried on a newer board
      // can make the same rename there. Without it the board is changed here, as before.
      if (out) out.rename = { from: bareName, to: group.base + toSubscript(1) };
      else renameSquares(game, bareName, group.base + toSubscript(1));
      maxIdx = Math.max(maxIdx, 1);
    }
    return group.base + toSubscript(maxIdx + 1);
  }

  function playerSummaries(game) {
    ensurePlayers(game);
    const sums = owedSummary(game);
    return Object.keys(sums).sort((a, b) => a.localeCompare(b)).map(name => {
      const s = sums[name];
      const color = ensurePlayerColor(game, name);
      // `owed` is what is still owed: only the unpaid squares are charged. With no part-paid
      // name it is count x price while unpaid and 0 once paid, so every total is as it was.
      return { name, count: s.count, paid: s.paid, owed: s.owed, total: s.count * (parseFloat(game.squarePrice) || 0), paidCount: s.paidCount, unpaidCount: s.unpaidCount, color };
    });
  }

  function unpaidTotal(game) {
    return playerSummaries(game).reduce((sum, p) => sum + p.owed, 0);
  }

  // The line under a name: "3 squares · $30 owed", or "3 paid, 2 owed ($20)" when part is paid.
  function ownedLine(p) {
    if (p.paidCount > 0 && p.unpaidCount > 0) return `${p.paidCount} paid, ${p.unpaidCount} owed (${money(p.owed)})`;
    return `${p.count} square${p.count === 1 ? '' : 's'} &middot; ${money(p.total)} ${p.paid ? 'paid' : 'owed'}`;
  }

  // For a name a guest picked: when, in the host's own time zone.
  function guestLine(game, name) {
    const times = [];
    game.squares.forEach(sq => { if (sq && sq.name === name && typeof sq.at === 'number' && times.indexOf(sq.at) === -1) times.push(sq.at); });
    times.sort((a, b) => a - b);
    const all = times.map(formatAt).filter((t, i, list) => list.indexOf(t) === i); // to the minute
    const shown = all.slice(0, 4);
    const more = all.length > 4 ? ` and ${all.length - 4} more` : '';
    return `Picked on their own phone${shown.length ? ' &middot; ' + escapeHtml(shown.join(', ')) + more : ''}`;
  }

  const changedMsg = "That player's squares just changed. Check the list and try again.";
  const countOf = (doc, name) => doc.squares.filter(sq => sq && sq.name === name).length;

  // The one guarded way to say what a name has paid for (the Paid pill and the player window
  // both save it): `p` is the summary the host was looking at and `n` how many of its squares
  // are paid. If that name's squares changed since, the mark could settle squares nobody has paid
  // for, so it is refused.
  function paidCountChange(p, n) {
    return (doc) => (countOf(doc, p.name) === p.count && setPaidCount(doc, p.name, n) ? undefined : changedMsg);
  }
  const paidChange = (p, checked) => paidCountChange(p, checked ? p.count : 0);

  // 'paid', 'part' or 'none', and the word the host sees for it.
  const payState = (p) => (p.paid ? 'paid' : p.paidCount > 0 ? 'part' : 'none');
  const PAY_WORD = { paid: 'Paid', part: 'Partial', none: 'Unpaid' };

  // The changes the player window makes besides payment. Each is guarded like paidCountChange:
  // refused if that name's squares changed since the host opened the window.
  function renameChange(p, newName) {
    const taken = (doc) => Object.keys(ensurePlayers(doc)).concat(doc.squares.filter(Boolean).map(sq => sq.name))
      .find(nm => nm.toLowerCase() === newName.toLowerCase() && nm !== p.name);
    return (doc) => {
      if (countOf(doc, p.name) !== p.count) return changedMsg;
      const clash = taken(doc);
      if (clash) return `"${clash}" is already a player in this game. Choose a different name.`;
      renameSquares(doc, p.name, newName);
    };
  }
  function removeChange(p) {
    return (doc) => {
      if (countOf(doc, p.name) !== p.count) return changedMsg;
      doc.squares.forEach((sq, i) => { if (sq && sq.name === p.name) doc.squares[i] = null; });
      delete ensurePlayers(doc)[p.name];
    };
  }
  // A new name as typed, or the message that says why it can't be used. `names` are the board's.
  function checkNewName(raw, p, names) {
    const name = raw.trim().slice(0, MAX_NAME_LEN);
    if (!name) return { msg: 'Name cannot be empty.' };
    if (!isPlayerName(name)) return { msg: 'That name is not allowed. Choose a different name.' };
    const clash = names.find(nm => nm.toLowerCase() === name.toLowerCase() && nm !== p.name);
    if (clash) return { msg: `"${clash}" is already a player in this game. Choose a different name.` };
    return { name };
  }

  // The player window: how many of one player's squares are paid for (a stepper, saved once on
  // Save, or at once by Paid in full), the player's name (the pencil), and Remove player.
  // `p` is the summary the host tapped; `apply(n)` saves and resolves to a message when it was
  // refused, null when it was saved or the failure was dealt with elsewhere. `edit`, when given,
  // is { names(), rename(name), remove(), started, guest }: rename and remove resolve the same
  // way; `guest` is the "Picked on their own phone" line (HTML), or ''.
  function openPaymentBox(p, price, apply, refocus, edit) {
    const opener = document.activeElement;
    let n = p.paidCount;
    let saving = false;
    const overlay = overlayEl('0.65');
    const box = el('div', 'card pick-dialog pay-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'pay-name');
    box.innerHTML = `
      <div class="pay-name-row"><h3 id="pay-name">${escapeHtml(p.name)}</h3>${edit ? `<button type="button" class="icon-btn pay-rename" data-act="rename" aria-label="Rename ${escapeHtml(p.name)}" title="Rename">${EDIT_ICON}</button>` : ''}</div>
      <p class="pick-dialog-sub">${p.count} square${p.count === 1 ? '' : 's'} &middot; ${money(p.total)}</p>
      ${edit && edit.guest ? `<p class="pick-dialog-sub player-guest-line">${edit.guest}</p>` : ''}
      <div class="pay-row"><span>Squares paid for</span>
        <div class="pay-step">
          <button type="button" class="secondary" data-act="less" aria-label="One less">&minus;</button>
          <span class="pay-count" role="status"></span>
          <button type="button" class="secondary" data-act="more" aria-label="One more">+</button>
        </div></div>
      <div class="money-boxes">
        <div class="money-box"><span class="lbl">Paid</span><span class="val is-good" data-v="paid"></span></div>
        <div class="money-box"><span class="lbl">Owes</span><span class="val" data-v="owes"></span></div>
      </div>
      <div class="error-msg hidden" role="alert"></div>
      <div class="pick-dialog-actions">
        <button type="button" class="pay-full" data-act="full">Paid in full</button>
        <button type="button" data-act="done">Save</button>
      </div>
      ${edit ? `<button type="button" class="pay-remove" data-act="remove">Remove ${escapeHtml(p.name)} and ${p.count === 1 ? 'their square' : `all ${p.count} squares`}</button>` : ''}`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const q = (act) => box.querySelector(`[data-act="${act}"]`);
    SBS.ui.addCloseX(box, () => close());
    const showErr = (m) => {
      const err = box.querySelector('.error-msg');
      err.textContent = m;
      err.classList.toggle('hidden', !m);
    };
    function draw() {
      box.querySelector('.pay-count').textContent = `${n} of ${p.count}`;
      box.querySelector('[data-v="paid"]').textContent = money(n * price);
      box.querySelector('[data-v="owes"]').textContent = money((p.count - n) * price);
      box.querySelector('[data-v="owes"]').classList.toggle('is-owed', n < p.count);
      q('less').disabled = saving || n <= 0;
      q('more').disabled = saving || n >= p.count;
      q('full').disabled = q('done').disabled = saving;
      if (edit) q('remove').disabled = saving;
    }
    function close() {
      if (!overlay.isConnected) return; // also runs when the screen changes
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opener && opener !== document.body && opener.isConnected) opener.focus(); else refocus(); // a save rebuilt the row
    }
    // Esc cancels a rename in progress first, then closes.
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (box.querySelector('.pay-name-input')) { e.preventDefault(); drawName(); return; }
      close();
    }
    // Saves through `run` and closes, or shows why it was refused.
    async function save(run) {
      if (saving) return;
      saving = true;
      showErr('');
      draw();
      const refused = await run();
      saving = false;
      if (!refused) return close();
      showErr(refused);
      draw();
    }
    function commit(to) {
      if (to === p.paidCount) return close();
      return save(() => apply(to));
    }
    // The name row: the name and its pencil, or a field while renaming.
    function drawName() {
      if (!edit) return;
      const row = box.querySelector('.pay-name-row');
      row.innerHTML = `<h3 id="pay-name">${escapeHtml(p.name)}</h3><button type="button" class="icon-btn pay-rename" data-act="rename" aria-label="Rename ${escapeHtml(p.name)}" title="Rename">${EDIT_ICON}</button>`;
      q('rename').addEventListener('click', startRename);
    }
    function startRename() {
      const row = box.querySelector('.pay-name-row');
      row.innerHTML = `<input type="text" class="pay-name-input" id="pay-name" maxlength="${MAX_NAME_LEN}" aria-label="Player name">
        <button type="button" class="icon-btn" data-act="name-ok" aria-label="Save name" title="Save">&#10003;</button>
        <button type="button" class="icon-btn" data-act="name-no" aria-label="Cancel rename" title="Cancel">&#10005;</button>`;
      const input = row.querySelector('input');
      input.value = p.name;
      const ok = () => {
        const got = checkNewName(input.value, p, edit.names());
        if (got.msg) { showErr(got.msg); input.focus(); return; }
        if (got.name === p.name) { drawName(); return; }
        save(() => edit.rename(got.name));
      };
      q('name-ok').addEventListener('click', ok);
      q('name-no').addEventListener('click', () => { showErr(''); drawName(); q('rename').focus(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      input.focus();
      input.select();
    }
    if (edit) {
      q('rename').addEventListener('click', startRename);
      q('remove').addEventListener('click', async () => {
        const warn = edit.started ? ' The game has already started — this may change quarter results tied to their square(s).' : '';
        if (!(await showConfirm(`Remove ${p.count === 1 ? 'the square' : `all ${p.count} squares`} picked by "${p.name}"?${warn} This cannot be undone.`))) return;
        save(() => edit.remove());
      });
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    q('less').addEventListener('click', () => { if (n > 0) n--; draw(); });
    q('more').addEventListener('click', () => { if (n < p.count) n++; draw(); });
    q('full').addEventListener('click', () => commit(p.count));
    q('done').addEventListener('click', () => commit(n));
    if (SBS.onLeaveScreen) SBS.onLeaveScreen(close);
    draw();
    q('done').focus();
  }

  // The Players card of a wide screen (the picking screen and Game Day share it): what is
  // collected and still owed, then each name, its squares, what it owes, and a Paid, Partial or
  // Unpaid pill. The pill makes the same guarded save as the player window (paidCountChange); a
  // name, or a Partial pill, opens the player window (payment, rename, remove).
  // opts: { getGame(), save(change, showErr) -> result or null, onSaved(result), cls?,
  //         busy?(), setBusy?(bool), emptyText? }. `save` is the screen's own saver (it knows how
  //         to handle a conflict there); null means it dealt with the failure. `onSaved` redraws.
  function playersCard(opts) {
    const card = el('div', 'card players-card' + (opts.cls ? ' ' + opts.cls : ''));
    card.innerHTML = `<div class="players-head"><h3>Players</h3><span class="players-n"></span></div>
      <div class="money-boxes">
        <div class="money-box"><span class="lbl">Collected</span><span class="val is-good" data-v="in"></span></div>
        <div class="money-box"><span class="lbl">Still owed</span><span class="val" data-v="owed"></span></div>
      </div>`;
    const msg = el('div', 'paste-bad');
    msg.setAttribute('role', 'status');
    card.appendChild(msg);
    const list = el('div', 'fill-players');
    card.appendChild(list);

    let busyNow = false;
    const busy = () => (opts.busy ? opts.busy() : busyNow);
    const setBusy = (v) => { if (opts.setBusy) opts.setBusy(v); else busyNow = v; };
    let sig = null;

    // Redraws in place. Unchanged rows are not rebuilt (so a poll never takes focus or a hover
    // from the pill), and a rebuild puts focus back on the same person's pill.
    function draw() {
      const sums = playerSummaries(opts.getGame());
      const next = JSON.stringify(sums.map(p => [p.name, p.count, p.paid, p.owed, p.paidCount, p.unpaidCount, p.total, p.color]));
      if (next === sig) return;
      sig = next;
      const total = sums.reduce((t, p) => t + p.total, 0);
      const owed = sums.reduce((t, p) => t + p.owed, 0);
      card.querySelector('.players-n').textContent = `${sums.length} player${sums.length === 1 ? '' : 's'}`;
      card.querySelector('[data-v="in"]').textContent = money(total - owed);
      card.querySelector('[data-v="owed"]').textContent = money(owed);
      card.querySelector('[data-v="owed"]').classList.toggle('is-owed', owed > 0);
      const act = document.activeElement;
      const focused = act && list.contains(act) ? [act.dataset.name, act.dataset.part] : null;
      list.innerHTML = '';
      if (!sums.length) list.appendChild(el('p', 'players-empty', opts.emptyText || 'No squares picked yet.'));
      sums.forEach(p => {
        const st = payState(p);
        const row = el('div', 'fill-player');
        const dot = el('span', 'fill-player-dot');
        dot.setAttribute('aria-hidden', 'true');
        dot.style.setProperty('--nc', p.color);
        const info = el('button', 'fill-player-info' + (st === 'part' ? ' is-part' : ''),
          `<span class="player-name">${escapeHtml(p.name)}</span><span class="player-sub">${ownedLine(p)}</span>`);
        info.type = 'button';
        info.setAttribute('aria-haspopup', 'dialog');
        info.setAttribute('aria-label', `${p.name}, ${p.paidCount} of ${p.count} paid. Payment`);
        info.addEventListener('click', () => pay(p));
        const pill = el('button', `paid-pill is-${st === 'none' ? 'unpaid' : st}`, PAY_WORD[st]);
        pill.type = 'button';
        pill.setAttribute('aria-label', st === 'part'
          ? `${p.name}: part paid, ${p.paidCount} of ${p.count}. Change`
          : `${p.name}: ${st === 'paid' ? 'paid. Mark unpaid' : 'unpaid. Mark paid'}`);
        pill.addEventListener('click', () => (st === 'part' ? pay(p) : toggle(p)));
        [info, pill].forEach((b, i) => { b.dataset.name = p.name; b.dataset.part = String(i); });
        row.append(dot, info, pill);
        list.appendChild(row);
        if (focused && focused[0] === p.name) (focused[1] === '0' ? info : pill).focus();
      });
    }

    // Saves one guarded change. Resolves to the message to show, or null.
    async function run(change) {
      if (busy()) return 'Still saving. Try again.';
      setBusy(true);
      let failed = '';
      let r = null;
      try {
        r = await opts.save(change, m => { failed = m; });
      } finally {
        setBusy(false);
      }
      sig = null;
      if (!r) { draw(); return failed || null; }
      opts.onSaved(r);
      return r.refused || null;
    }
    // Refused if someone changed this name's squares since the list was drawn.
    const set = (p, n) => run(paidCountChange(p, n));
    async function toggle(p) {
      if (busy()) return;
      msg.textContent = (await set(p, p.paid ? 0 : p.count)) || '';
    }
    function pay(p) {
      msg.textContent = '';
      const g = opts.getGame();
      openPaymentBox(p, parseFloat(g.squarePrice) || 0, (n) => set(p, n), () => {
        const again = Array.from(list.querySelectorAll('.fill-player-info')).find(b => b.dataset.name === p.name);
        if (again) again.focus();
      }, {
        names: () => { const doc = opts.getGame(); return Object.keys(ensurePlayers(doc)).concat(doc.squares.filter(Boolean).map(sq => sq.name)); },
        rename: (name) => run(renameChange(p, name)),
        remove: () => run(removeChange(p)),
        started: g.status === 'started' || g.status === 'finished',
        guest: g.players && g.players[p.name] && g.players[p.name].g ? guestLine(g, p.name) : '' // already escaped
      });
    }

    return { el: card, draw };
  }

  SBS.players = {
    ensurePlayers, ensurePlayerColor, addSquares, replaceGame, formatAt, renameSquares,
    collectNameGroups, resolveNameForPick, paidChange, ownedLine,
    playerSummaries, unpaidTotal, playersCard, openPaymentBox, payState, PAY_WORD,
    toSubscript, fromSubscript, stripSubscript
  };
})();
