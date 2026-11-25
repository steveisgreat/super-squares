// Player companion view: what a grid player sees after scanning the QR code
// printed or displayed at the party. Read-only for everyone but a helper,
// whose jobs are tabs at the bottom (decision 025): just "how am I doing right now" plus quarter winners so far. Polls
// like the TV/phone screens so it stays live without a manual refresh.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, showAlert, applyTeamColors, teamBadge, teamAbbr, teamStyle, fitTeamBadges, isPhone } = SBS.ui;
  const { playerSummaries } = SBS.players;
  const { QUARTERS, QLABEL, computeGame, computeLiveHighlight, payoutAmount, drawnDigits } = window.GameLogic;

  function storageKey(id) { return `sbs-player-view-${id}`; }
  // Set once this phone has tapped Pick squares on the board, so a reload opens picking again.
  // Choosing a name just to look never does: looking must not set the pick cookie.
  function pickerKey(id) { return `sbs-guest-picker-${id}`; }
  function isPicker(id) { try { return window.localStorage.getItem(pickerKey(id)) === '1'; } catch (e) { return false; } }

  function squareInfo(game, computed, liveHighlight, idx) {
    const row = Math.floor(idx / 10), col = idx % 10;
    const key = `${row}-${col}`;
    const labels = computed.cellLabels[key] || [];
    const won = labels.filter(l => !l.pushed).map(l => l.label);
    const pushed = labels.filter(l => l.pushed).map(l => l.label);
    const isLiveWinner = !!(liveHighlight && liveHighlight.winnerKey === key);
    const isNear = !!(liveHighlight && liveHighlight.nearKeys.has(key));
    let status = 'dormant';
    if (won.length || isLiveWinner) status = 'winning';
    else if (isNear) status = 'threat';
    return {
      idx, row, col, key, won, pushed, isLiveWinner, isNear, status,
      xDigit: game.axisX ? game.axisX[col] : null,
      yDigit: game.axisY ? game.axisY[row] : null
    };
  }

  // "TM1 # | # TM2" — the two digits (the actual score that matters) set off
  // in the accent color so they read at a glance against the team abbreviations.
  function coordHtml(game, info) {
    const abbrA = teamAbbr(game.teamA, teamStyle(game, 'A').meta);
    const abbrB = teamAbbr(game.teamB, teamStyle(game, 'B').meta);
    const y = info.yDigit === null ? '–' : info.yDigit;
    const x = info.xDigit === null ? '–' : info.xDigit;
    return `<span class="coord-team">${escapeHtml(abbrA)}</span> `
      + `<span class="coord-num">${escapeHtml(String(y))}</span>`
      + `<span class="coord-sep">|</span>`
      + `<span class="coord-num">${escapeHtml(String(x))}</span> `
      + `<span class="coord-team">${escapeHtml(abbrB)}</span>`;
  }

  const STATUS_META = {
    winning: { tag: 'Winning', cls: 'status-winning' },
    threat: { tag: 'Hot Threat', cls: 'status-threat' },
    dormant: { tag: 'Dormant', cls: 'status-dormant' }
  };

  function squareDesc(info) {
    if (info.status === 'winning') {
      return info.won.length ? `Already won ${info.won.join(', ')}` : 'Holding the current payout window';
    }
    if (info.status === 'threat') return 'One likely score away from flipping your way';
    return 'Needs a bigger swing to get in play';
  }

  // True once the server has (or will) auto-update this game's score — a real
  // ESPN feed found a match, or the host turned on Simulation Mode. When
  // neither is true, the host is typing quarter scores in by hand: there's no
  // live projection to show a "who's winning right now" readout for, and the
  // running score is meaningless (just a stale placeholder) until the actual
  // quarters get entered.
  function isAutoScored(game) {
    return !!(game.simulation || game.liveScore);
  }

  function hasFinalScore(computed) {
    const f = computed.results.final;
    return f.a !== null && f.a !== undefined && f.a !== '' && f.b !== null && f.b !== undefined && f.b !== '';
  }

  // Sum of every quarter this player has actually won so far. A pushed
  // quarter has no winner of its own (its payout just rolls into whichever
  // quarter is scored next — see compute.js), so it's excluded here same as
  // everywhere else winnings are totaled (the TV screen's final summary).
  function computeTotalWon(computed, playerName) {
    if (!playerName) return 0;
    return QUARTERS.reduce((sum, q) => {
      const res = computed.results[q];
      return (res.resolved && !res.pushed && res.winnerName === playerName) ? sum + res.amount : sum;
    }, 0);
  }

  // ---------- Join code: link, share, mini grid (R22, decision 016) ----------

  function joinUrl(game) {
    // A board from before join codes keeps its long link until its owner next reads it.
    return game.joinCode ? `${location.origin}/${game.joinCode}` : `${location.origin}/#player-${game.id}`;
  }

  // Native share sheet where there is one, otherwise copy the link. `note` is a
  // role=status element that says "Link copied".
  async function shareBoard(game, note) {
    const url = joinUrl(game);
    const title = `${game.teamA || 'Team A'} vs ${game.teamB || 'Team B'} squares`;
    const text = 'Join the squares pool.' + (game.joinCode ? ` Code ${game.joinCode}.` : '');
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // closed the sheet: nothing to do
        // Anything else: fall through to copying.
      }
    }
    await copyJoinLink(game, note);
  }

  // The join-code chip in a wide screen's top bar (Game Day and picking): copies the link.
  function joinChip(game) {
    const wrap = el('div', 'gd-chip-wrap');
    const chip = el('button', 'gd-chip',
      `<span class="gd-chip-label">Join</span><span class="gd-chip-code">${escapeHtml(game.joinCode)}</span>${SBS.ui.COPY_ICON}`);
    chip.type = 'button';
    chip.setAttribute('aria-label', `Join code ${game.joinCode.split('').join(' ')}. Copy the join link`);
    const note = el('div', 'gd-chip-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    chip.addEventListener('click', () => SBS.playerView.copyJoinLink(game, note));
    wrap.append(chip, note);
    return wrap;
  }

  // Puts the join link on the clipboard (no share sheet) and says so in `note`, a role=status
  // element. Resolves true when it copied.
  async function copyJoinLink(game, note) {
    const url = joinUrl(game);
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed; top:0; left:0; opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand('copy'); } catch (err) { copied = false; }
      ta.remove();
    }
    if (note) {
      note.textContent = copied ? 'Link copied' : `Copy this link: ${url}`;
      clearTimeout(note._t);
      note._t = setTimeout(() => { note.textContent = ''; }, 6000);
    }
    return copied;
  }

  // A guest passing the link on: text it, share it, or let someone scan it. There is
  // no way to open the board again here; this phone already has it open.
  function showInvite(game) {
    const opener = document.activeElement;
    const url = joinUrl(game);
    const overlay = SBS.ui.overlayEl('0.65');
    const box = el('div', 'card invite-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Invite friends');
    let qr = '';
    try {
      qr = window.QRCode.toSvg(url, 180);
    } catch (err) {
      console.error('QR encode failed', err);
    }
    box.innerHTML = `<h3>Invite friends</h3>
      <p>Send the link, or let them scan the code with their camera.</p>
      ${qr ? `<div class="phone-qr">${qr}</div>` : ''}
      ${game.joinCode ? `<div class="join-code" aria-label="Join code ${escapeHtml(game.joinCode.split('').join(' '))}">${escapeHtml(game.joinCode)}</div>` : ''}
      <div class="join-url">${escapeHtml(url.replace(/^https?:\/\//, ''))}</div>`;

    const actions = el('div', 'invite-actions');
    const note = el('div', 'join-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    const add = (cls, label, onClick) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };
    if (isPhone()) {
      const teams = `${game.teamA || 'Team A'} vs ${game.teamB || 'Team B'}`;
      // "?&body=" is the one form both iPhone and Android read.
      add('', 'Text a friend', () => {
        location.href = `sms:?&body=${encodeURIComponent(`Join our squares pool for ${teams}: ${url}`)}`;
      });
    }
    add(isPhone() ? 'secondary' : '', navigator.share ? 'Share link' : 'Copy link', () => shareBoard(game, note));
    const done = add('secondary', 'Done', close);
    box.appendChild(actions);
    box.appendChild(note);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    actions.firstChild.focus();

    function onKey(e) {
      if (e.key === 'Escape') return close();
      if (e.key !== 'Tab') return;
      const first = actions.firstChild;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); done.focus(); }
      else if (!e.shiftKey && document.activeElement === done) { e.preventDefault(); first.focus(); }
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opener && opener.isConnected) opener.focus();
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    SBS.onLeaveScreen(close);
  }

  // A small 10x10 of the board: claimed squares shaded, the viewer's own
  // highlighted. Never says who has or hasn't paid.
  function miniGrid(game, mine) {
    const wrap = el('div', 'mini-grid');
    const claimed = game.squares.filter(Boolean).length;
    const own = mine ? game.squares.filter(sq => sq && sq.name === mine).length : 0;
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `Board: ${claimed} of 100 squares claimed` + (mine ? `, ${own} of them yours` : ''));
    let html = '<div class="mg-corner"></div>';
    for (let c = 0; c < 10; c++) html += `<div class="mg-axis">${game.axisX ? escapeHtml(String(game.axisX[c])) : ''}</div>`;
    for (let r = 0; r < 10; r++) {
      html += `<div class="mg-axis">${game.axisY ? escapeHtml(String(game.axisY[r])) : ''}</div>`;
      for (let c = 0; c < 10; c++) {
        const sq = game.squares[r * 10 + c];
        const cls = 'mg-cell' + (sq ? ' is-filled' : '') + (sq && mine && sq.name === mine ? ' is-mine' : '');
        html += `<div class="${cls}"></div>`;
      }
    }
    wrap.innerHTML = html;
    return wrap;
  }

  // /<code>: resolve the code, then show the guest view. The address becomes the
  // ordinary deep link so a reload does not need the lookup again.
  function renderJoin(code) {
    const app = SBS.appEl;
    app.innerHTML = '';
    const wrap = el('div', 'player-screen');
    const msg = el('div', 'card player-card', '<p class="player-muted">Opening the board…</p>');
    wrap.appendChild(msg);
    app.appendChild(wrap);
    SBS.api.getJoin(code).then(res => {
      try { history.replaceState(null, '', `/#player-${res.id}`); } catch (e) { /* keep the path */ }
      SBS.go({ screen: 'player', id: res.id });
    }).catch(e => {
      const notFound = e && (e.status === 404 || e.status === 400);
      msg.innerHTML = `<p class="${notFound ? 'player-muted' : 'error-msg'}">${notFound
        ? `No board has the code ${escapeHtml(String(code).toUpperCase())}. Check it with the host and try again.`
        : `Could not open that board: ${escapeHtml(e.message)}`}</p>`;
    });
  }

  // ---------- Guest picks (R28, decision 019) ----------
  // A guest claims and releases their own squares from this phone. The browser keeps a private
  // key in a cookie (set when they tap Pick squares); the server holds only a tag of it. Every
  // call here is raw: a 401 means "no cookie kept" and must never open the host sign-in.

  const COOKIE_MSG = 'Your browser is blocking cookies for this site. Open the link in Safari or Chrome.';

  function guestPickingOn(game) {
    return !!(game && game.status === 'picking' && game.guestPick && game.guestPick.on === true);
  }

  const coordOf = (i) => `R${Math.floor(i / 10) + 1}C${i % 10 + 1}`;
  const localTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ctx: { id, game() -> the board, setGame(g) stores and redraws, remember(name) saves the
  // name the page already keeps, reload() fetches the board again }.
  function createGuestPanel(ctx) {
    const root = el('div', 'guest-panel');
    const miniHolder = el('div');
    const startRow = el('div', 'gp-start');
    const startBtn = el('button', 'gp-start-btn', 'Pick squares');
    startBtn.type = 'button';
    startRow.appendChild(el('p', 'player-muted', 'Claim your squares right here. The host marks you paid.'));
    startRow.appendChild(startBtn);

    const live = el('div', 'gp-live');
    const nameWrap = el('div', 'gp-name');
    nameWrap.innerHTML = '<label for="gp-name-input">Your name</label>';
    const nameInput = el('input', '');
    nameInput.type = 'text';
    nameInput.id = 'gp-name-input';
    nameInput.maxLength = 10;
    nameInput.autocomplete = 'off';
    nameInput.setAttribute('autocapitalize', 'words');
    nameInput.placeholder = 'Name (up to 10)';
    nameWrap.appendChild(nameInput);
    const asLine = el('p', 'gp-as');
    const capLine = el('p', 'gp-cap');
    const boardWrap = el('div', 'gp-board');
    boardWrap.setAttribute('role', 'group');
    const actionBtn = el('button', 'gp-action', '');
    actionBtn.type = 'button';
    const clearBtn = el('button', 'secondary gp-clear', 'Clear selection');
    clearBtn.type = 'button';
    const actionRow = el('div', 'gp-actions');
    actionRow.appendChild(actionBtn);
    actionRow.appendChild(clearBtn);
    const autoWrap = el('div', 'gp-auto');
    autoWrap.innerHTML = '<label for="gp-auto-count">Or let us pick for you: how many?</label>';
    const countInput = el('input', '');
    countInput.type = 'number';
    countInput.id = 'gp-auto-count';
    countInput.min = '1';
    countInput.max = '100';
    countInput.step = '1';
    countInput.value = '1';
    countInput.inputMode = 'numeric';
    const autoBtn = el('button', 'secondary gp-auto-btn', 'Pick for me');
    autoBtn.type = 'button';
    const autoRow = el('div', 'gp-auto-row');
    autoRow.appendChild(countInput);
    autoRow.appendChild(autoBtn);
    autoWrap.appendChild(autoRow);
    const status = el('p', 'gp-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const owed = el('p', 'gp-owed');
    live.append(asLine, nameWrap, capLine, boardWrap, actionRow, autoWrap);
    root.append(startRow, miniHolder, live, status, owed);

    let started = false;
    let name = null;       // the name this phone holds on the board, from the server
    let sel = [];          // open squares chosen to claim
    let rel = [];          // own squares chosen to release
    let busy = false;
    let tapped = null;     // the cell to give focus back to after a redraw

    const game = () => ctx.game();
    const mode = () => game().pickMode || 'both';
    const myIdx = () => (name ? game().squares.map((s, i) => (s && s.name === name ? i : -1)).filter(i => i >= 0) : []);
    const cap = () => window.GameLogic.guestCap(game(), Date.now());
    function say(msg) { status.textContent = msg || ''; }

    function room(have) {
      const c = cap();
      if (c === Infinity) return Infinity;
      return Math.max(0, c - have);
    }
    function overCapMessage(have) {
      const c = cap();
      const left = room(have);
      return left ? `You can pick up to ${c} squares. You have ${have}, so ${left} more.` : `You have all ${c} of your squares. Release one to pick another.`;
    }

    // The cell with focus is rebuilt on every redraw; remember which one to give it back to.
    function rememberFocus() {
      const a = document.activeElement;
      if (a && a.classList && a.classList.contains('gp-cell') && root.contains(a)) tapped = Number(a.dataset.i);
    }

    function render() {
      if (tapped === null) rememberFocus();
      const g = game();
      const own = myIdx();
      // A square taken while it was selected leaves the selection, with a note.
      const gone = sel.filter(i => g.squares[i]);
      if (gone.length) {
        sel = sel.filter(i => !g.squares[i]);
        say(`${gone.length === 1 ? 'A square' : 'Some squares'} you picked ${gone.length === 1 ? 'was' : 'were'} just taken: ${gone.map(coordOf).join(', ')}.`);
      }
      rel = rel.filter(i => g.squares[i] && g.squares[i].name === name);

      miniHolder.innerHTML = '';
      startRow.hidden = started;
      startBtn.disabled = busy;
      live.hidden = !started;
      if (!started) {
        owed.hidden = true;
        miniHolder.appendChild(miniGrid(g, ctx.viewing()));
        return;
      }

      asLine.hidden = !name;
      asLine.textContent = name ? `Picking as ${name}` : '';
      nameWrap.hidden = !!name;

      const c = cap();
      const gp = g.guestPick || {};
      let capText = c === Infinity ? `You have ${own.length}. No limit.` : `You have ${own.length} of ${c}.`;
      if (!gp.lifted && gp.liftAt && Date.parse(gp.liftAt) > Date.now()) capText += ` The limit ends at ${localTime(Date.parse(gp.liftAt))}.`;
      capLine.textContent = capText;

      const m = mode();
      boardWrap.innerHTML = '';
      boardWrap.setAttribute('aria-label', 'Squares. Tap an open square to select it' + (own.length ? ', or one of yours to release it.' : '.'));
      for (let i = 0; i < 100; i++) {
        const sq = g.squares[i];
        const where = `Row ${Math.floor(i / 10) + 1} column ${i % 10 + 1}`;
        const b = el('button', 'gp-cell');
        b.type = 'button';
        b.dataset.i = String(i);
        if (!sq) {
          const picked = sel.indexOf(i) !== -1;
          b.classList.add('is-open');
          if (picked) b.classList.add('is-sel');
          b.setAttribute('aria-label', `${where}, open${picked ? ', selected' : ''}`);
          if (m === 'auto') { b.disabled = true; } else { b.setAttribute('aria-pressed', String(picked)); }
        } else if (name && sq.name === name) {
          const dropping = rel.indexOf(i) !== -1;
          b.classList.add('is-mine');
          if (dropping) b.classList.add('is-rel');
          b.textContent = sq.name;
          b.setAttribute('aria-label', `${where}, ${sq.name}, yours${dropping ? ', to release' : ''}`);
          b.setAttribute('aria-pressed', String(dropping));
        } else {
          b.classList.add('is-other');
          b.textContent = sq.name;
          b.setAttribute('aria-label', `${where}, ${sq.name}`);
          b.disabled = true;
        }
        b.disabled = b.disabled || busy;
        b.addEventListener('click', () => toggle(i));
        boardWrap.appendChild(b);
      }
      if (tapped !== null) {
        const t = boardWrap.querySelector(`[data-i="${tapped}"]`);
        if (t && !t.disabled) t.focus();
        tapped = null;
      }

      const verb = sel.length ? `Claim ${sel.length} square${sel.length === 1 ? '' : 's'}` : rel.length ? `Release ${rel.length} square${rel.length === 1 ? '' : 's'}` : '';
      actionRow.hidden = !verb;
      actionBtn.textContent = verb;
      actionBtn.disabled = busy;
      clearBtn.disabled = busy;
      autoWrap.hidden = m === 'manual';
      autoBtn.disabled = busy;

      const o = window.GameLogic.owedSummary(g)[name];
      if (name && o) {
        owed.hidden = false;
        owed.textContent = (o.owed > 0 ? `${money(o.owed)} owed to the host for ${o.unpaidCount} square${o.unpaidCount === 1 ? '' : 's'}. ` : 'Nothing owed right now. ')
          + 'Pay the host directly. The money goes to the host, not to us.';
      } else {
        owed.hidden = true;
      }
    }

    function toggle(i) {
      if (busy) return;
      const g = game();
      const sq = g.squares[i];
      const have = myIdx().length;
      tapped = i;
      if (!sq) {
        if (mode() === 'auto') return;
        if (rel.length) { say('You are releasing squares. Clear the selection to claim instead.'); return render(); }
        const pos = sel.indexOf(i);
        if (pos >= 0) sel.splice(pos, 1);
        else {
          if (have + sel.length + 1 > cap()) { say(overCapMessage(have)); return render(); }
          sel.push(i);
        }
      } else if (name && sq.name === name) {
        if (sel.length) { say('You are claiming squares. Clear the selection to release instead.'); return render(); }
        const pos = rel.indexOf(i);
        if (pos >= 0) rel.splice(pos, 1); else rel.push(i);
      } else {
        return;
      }
      say('');
      render();
    }

    // The name to claim under: the server's if this phone has one, else the typed one.
    function claimName() {
      if (name) return name;
      const clean = window.GameLogic.cleanGuestName(nameInput.value);
      if (clean.error) { say(clean.error); nameInput.focus(); return null; }
      return clean.name;
    }

    function summary() {
      const own = myIdx();
      return own.length ? `You have ${own.length} square${own.length === 1 ? '' : 's'}: ${own.map(coordOf).join(', ')}.` : 'You have no squares now.';
    }

    async function send(op) {
      busy = true;
      render();
      try {
        const res = await SBS.api.guestOp(ctx.id, op);
        busy = false;
        name = res.name || null;
        ctx.remember(name);
        sel = [];
        rel = [];
        ctx.setGame(res.game);
        say(summary());
      } catch (e) {
        busy = false;
        if (e && e.status === 401) {
          started = false;
          ctx.setGame(game());
          say(COOKIE_MSG);
          return;
        }
        if (e && e.game && e.game.squares) {
          if (e.taken) sel = sel.filter(i => e.taken.indexOf(i) === -1);
          ctx.setGame(e.game);
        } else {
          render();
        }
        say((e && e.message) || 'That did not work. Try again.');
        // The board moved on (closed or switched off): the page has changed under the message.
        if (!guestPickingOn(game())) showAlert((e && e.message) || 'Picking is closed.');
      }
    }

    actionBtn.addEventListener('click', () => {
      if (busy) return;
      if (rel.length) return send({ op: 'release', squares: rel.slice() });
      const nm = claimName();
      if (nm) send({ op: 'claim', name: nm, squares: sel.slice() });
    });
    clearBtn.addEventListener('click', () => { sel = []; rel = []; say(''); render(); });
    autoBtn.addEventListener('click', () => {
      if (busy) return;
      const n = Number(countInput.value);
      if (!Number.isInteger(n) || n < 1 || n > 100) { say('Enter how many squares, from 1 to 100.'); return countInput.focus(); }
      const have = myIdx().length;
      if (have + n > cap()) return say(overCapMessage(have));
      const nm = claimName();
      if (nm) send({ op: 'claim', name: nm, count: n, have });
    });

    // Ask the server who this phone is on this board; it also hands out the key cookie.
    // `quiet`: a reload of a phone that picked before, so nothing is said if it cannot.
    async function start(quiet) {
      if (busy) return;
      busy = true;
      startBtn.disabled = true;
      let res;
      try {
        res = await SBS.api.guestStart(ctx.id);
      } catch (e) {
        busy = false;
        startBtn.disabled = false;
        if (!quiet) say((e && e.message) || 'Could not start.');
        if (e && e.status === 409) ctx.reload();
        return render();
      }
      // The cookie is HttpOnly, so the page cannot look. A name in the answer proves it came
      // back; a new phone with cookies blocked finds out on its first claim (a 401).
      busy = false;
      startBtn.disabled = false;
      started = true;
      name = res.name || null;
      if (!quiet) ctx.markPicker();
      if (name) ctx.remember(name);
      say('');
      render();
      const focusTarget = name ? boardWrap.querySelector('.gp-cell:not(:disabled)') : nameInput;
      if (!quiet && focusTarget) focusTarget.focus();
    }
    startBtn.addEventListener('click', () => start(false));

    // A host rename moves the name; a host removal ends it. When this phone's name has no
    // squares any more, ask again.
    async function followName() {
      if (!started || !name || busy) return;
      if (game().squares.some(s => s && s.name === name)) return;
      try {
        const res = await SBS.api.guestStart(ctx.id);
        name = res.name || null;
        ctx.remember(name);
      } catch (e) { /* the board closed: the page redraws without the panel */ }
      render();
    }

    return { root, render, start, followName };
  }

  // Tabler "layout-grid" and "scoreboard" (MIT, 24 px outline).
  const tabSvg = (paths) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const GRID_ICON = tabSvg('<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/>');
  const SCORE_ICON = tabSvg('<path d="M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M12 5v2"/><path d="M12 10v1"/><path d="M12 14v1"/><path d="M12 18v1"/><path d="M7 3v2"/><path d="M17 3v2"/><path d="M15 10.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0z"/><path d="M6 9h1.5a1.5 1.5 0 0 1 0 3h-.5h.5a1.5 1.5 0 0 1 0 3h-1.5"/>');

  // The helper's side of Player View (decision 025 section 2): a welcome once, then a tab per job.
  // ctx: { id, route, wrap, header, game(), setGame(g), redraw(), selected(), choose(name) }.
  // Opening a tab changes nothing on the server; the jobs come from GET …/role. The first tab is this
  // page as any player sees it, and no job is needed to see it. The name chosen here is display only:
  // a helper need not be playing, and nothing is authorized by a name.
  function createHelperTabs(ctx) {
    const flag = SBS.helpers.phone;
    let role = null;          // the server's last answer, or null
    let tab = 'mine';
    let wanted = ctx.route.tab === 'score' ? 'score' : null; // an old score link
    const maybe = () => ctx.route.helper === true || !!flag.get(ctx.id);

    const pane = el('div', 'helper-pane');
    pane.hidden = true;
    const nav = el('nav', 'helper-tabs');
    nav.setAttribute('aria-label', 'This board');
    nav.hidden = true;
    const note = el('p', 'helper-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    ctx.header.after(note, pane);
    ctx.wrap.appendChild(nav);

    let pad = null; // made the first time it is shown: most phones here are guests'
    const makePad = () => SBS.scorePanel.create({
      getGame: ctx.game,
      setGame: ctx.setGame,
      patch: (gid, op) => SBS.api.patchScore(gid, op, { prompt: false }),
      // 403, not 401, when this phone happens to be signed in as some other host.
      onError: (e) => {
        if (e.status !== 401 && e.status !== 403) return false;
        lost();
        ask();
        return true;
      }
    });

    const isOpen = () => ctx.game().status === 'started' || ctx.game().status === 'finished';
    const jobNames = () => [role && role.canScore ? 'Scorekeeper' : ''].filter(Boolean).join(' and ');

    function say(text) {
      note.textContent = text || '';
      note.hidden = !text;
    }
    function lost() {
      role = null;
      say('You no longer keep score on this board. If that is a mistake, ask the host for a new code.');
      tab = 'mine';
      draw();
      ctx.redraw();
    }

    async function ask() {
      if (!maybe()) return;
      let r;
      try {
        r = await SBS.api.getRole(ctx.id);
      } catch (e) {
        return; // keep what is on screen; the server decides each save
      }
      if (!ctx.wrap.isConnected || !ctx.game()) return;
      const before = role;
      const isHelper = r.canScore !== undefined;
      role = isHelper ? r : null;
      if (isHelper && note.textContent && r.canScore) say('');
      if (!isHelper && flag.get(ctx.id)) {
        flag.forget(ctx.id);
        ctx.route.helper = false;
        say('You no longer help on this board. If that is a mistake, ask the host for a new code.');
      } else if (isHelper && !flag.get(ctx.id)) {
        flag.set(ctx.id, 'new');
      }
      if (wanted && role && role.canScore) { tab = wanted; }
      wanted = null;
      if (before && role && before.canScore && !role.canScore) { role = r; say('The host switched off scorekeeping on this phone.'); }
      if (JSON.stringify(before) !== JSON.stringify(role)) { draw(); ctx.redraw(); }
    }

    function draw() {
      if (!ctx.game()) return;
      if (tab === 'score' && !(role && role.canScore)) tab = 'mine';
      const welcome = !!role && role.canScore && flag.get(ctx.id) === 'new';
      const hasTabs = !!role && role.canScore && !welcome;
      ctx.wrap.classList.toggle('on-job', welcome || (hasTabs && tab !== 'mine'));
      ctx.wrap.classList.toggle('has-tabs', hasTabs);
      nav.hidden = !hasTabs;
      pane.hidden = !(welcome || (hasTabs && tab === 'score'));
      if (welcome) return drawWelcome();
      if (hasTabs) drawNav();
      if (pane.hidden) return pane.replaceChildren();
      if (!isOpen()) {
        const wait = el('div', 'card player-card helper-wait');
        wait.append(textEl('h2', '', "Scoring isn't open yet"), textEl('p', 'player-muted', 'It opens here by itself when the host locks the board and the numbers are drawn.'));
        return pane.replaceChildren(wait);
      }
      if (!pad) pad = makePad();
      if (pane.firstChild !== pad.el) pane.replaceChildren(pad.el);
      pad.update();
    }

    function drawNav() {
      const had = nav.contains(document.activeElement);
      nav.replaceChildren(...[['mine', ctx.selected() ? 'My squares' : 'Board', GRID_ICON], ['score', 'Score', SCORE_ICON]].map(([k, label, icon]) => {
        const b = el('button', 'helper-tab', `${icon}<span>${label}</span>`);
        b.type = 'button';
        if (k === tab) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => {
          if (tab === k) return;
          tab = k;
          draw();
          window.scrollTo(0, 0);
          ask();
        });
        return b;
      }));
      if (had) nav.querySelector('[aria-current]').focus();
    }

    // Once: what they may do, and whose squares are theirs.
    function drawWelcome() {
      if (pane.querySelector('.helper-welcome')) return; // a poll must not close an open list
      const card = el('div', 'card player-card helper-welcome');
      card.appendChild(textEl('h2', '', 'You were asked to help run this board'));
      const duties = [['Keep score', 'Tap what happens. End each quarter.']];
      duties.push(['Your own squares stay here', 'Switch any time with the tabs at the bottom. Not playing? You still see the board.']);
      duties.forEach(([name, text]) => {
        const d = el('div', 'helper-duty');
        d.append(textEl('strong', '', name), textEl('span', '', text));
        card.appendChild(d);
      });
      const names = playerSummaries(ctx.game()).map(p => p.name);
      const label = el('label', 'helper-mine', 'Your squares are under');
      const select = el('select', 'player-select');
      select.appendChild(el('option', '', "I'm not playing")).value = '';
      const same = names.find(n => n.toLowerCase() === String(role.label).toLowerCase());
      const mine = names.includes(ctx.selected()) ? ctx.selected() : same || '';
      names.forEach(n => {
        const o = textEl('option', '', n);
        o.value = n;
        o.selected = n === mine;
        select.appendChild(o);
      });
      label.appendChild(select);
      const go = el('button', '', 'Continue');
      go.type = 'button';
      go.addEventListener('click', () => {
        flag.set(ctx.id, 'ok');
        ctx.choose(select.value || null);
        tab = role && role.canScore && isOpen() ? 'score' : 'mine';
        pane.replaceChildren();
        draw();
        ctx.redraw();
        window.scrollTo(0, 0);
      });
      card.append(label, go, textEl('p', 'player-muted', 'This works on this phone, for this board, until the game is over.'));
      pane.replaceChildren(card);
    }

    return {
      ask, draw,
      maybe,
      onScore: () => tab === 'score' && !pane.hidden,
      busy: () => !!pad && pad.busy(),
      saved: () => { if (pad) pad.clearUndo(); }, // another device saved: what was scored here may not undo cleanly
      line: () => (role && jobNames() ? [ctx.selected(), jobNames()].filter(Boolean).join(' · ') : '')
    };
  }

  function renderPlayer(id, route) {
    const app = SBS.appEl;
    app.innerHTML = '';
    document.body.classList.add('player-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('player-mode'));

    const wrap = el('div', 'player-screen');
    app.appendChild(wrap);

    const header = el('div', 'player-header');
    wrap.appendChild(header);

    const selectRow = el('div', 'player-select-row');
    wrap.appendChild(selectRow);

    const inviteBtn = el('button', 'secondary player-invite-btn', 'Invite friends');
    inviteBtn.type = 'button';
    inviteBtn.hidden = true; // until the board loads
    inviteBtn.addEventListener('click', () => showInvite(game));
    wrap.appendChild(inviteBtn);

    const body = el('div', 'player-body');
    wrap.appendChild(body);
    // R13: the guest-to-host link. Carries this board's join code so a sign-up is attributed to it.
    const hostLink = el('a', 'player-host-link', 'Running your own pool? Host your own board');
    hostLink.target = '_blank';
    hostLink.rel = 'noopener';
    hostLink.hidden = true; // until the board loads
    wrap.appendChild(hostLink);
    wrap.appendChild(SBS.ui.legalLinks());

    let game = null;
    let selectedPlayer = null;
    let panel = null; // the guest-pick panel, kept for the life of the screen
    let helper = null; // the helper's tabs, made once the board has loaded
    let panelCard = null; // the card it sits in, left in place while picking so typing and focus survive
    const panelCtx = {
      id,
      game: () => game,
      setGame: (g) => { game = g; drawAll(); },
      remember: (name) => { selectedPlayer = name; saveSelectedPlayer(name); if (helper) { drawHeader(); helper.draw(); } },
      reload: () => load(false, true),
      viewing: () => selectedPlayer,
      markPicker: () => { try { window.localStorage.setItem(pickerKey(id), '1'); } catch (e) { /* asks again next time */ } }
    };

    function loadSelectedPlayer() {
      try { return window.localStorage.getItem(storageKey(id)); } catch (e) { return null; }
    }
    function saveSelectedPlayer(name) {
      try {
        if (name) window.localStorage.setItem(storageKey(id), name);
        else window.localStorage.removeItem(storageKey(id));
      } catch (e) { /* private browsing etc — selection just won't persist */ }
    }

    function drawHeader() {
      applyTeamColors(game);
      const live = game.liveScore;
      let tickerHtml = '';
      if (game.status === 'picking' || game.status === 'setup') {
        const kickoff = SBS.ui.kickoffNotice(game);
        tickerHtml = `<div class="player-ticker-pending">Squares are being claimed &mdash; the board locks in soon.${kickoff ? ' ' + kickoff : ''}</div>`;
      } else {
        const computed = computeGame(game);
        const auto = isAutoScored(game);
        const hasFinal = hasFinalScore(computed);
        // A manually-scored game has no live feed to fall back on, so there's
        // nothing meaningful to show but a stale "–" until the host actually
        // enters the Final score — better to show nothing at all than a dash
        // that looks like a score but never updates until the very end.
        const scoreA = live && live.a !== undefined && live.a !== null ? live.a
          : hasFinal ? computed.results.final.a
          : auto ? '–' : '';
        const scoreB = live && live.b !== undefined && live.b !== null ? live.b
          : hasFinal ? computed.results.final.b
          : auto ? '–' : '';
        const statusTxt = game.status === 'finished' ? 'FINAL'
          : (live && live.state === 'in') ? [live.period ? (live.period > 4 ? (live.period > 5 ? `${live.period - 4}OT` : 'OT') : `Q${live.period}`) : '', live.clock].filter(Boolean).map(escapeHtml).join(' &middot; ')
          : 'In Progress';
        // Same glowing pill treatment the Home screen's game card uses for a
        // "started" game — a quiet visual cue that this one is live right now.
        const statusCls = 'pt-status' + (game.status === 'started' ? ' is-live' : '');
        tickerHtml = `
          <div class="player-ticker">
            <div class="pt-team badge-fit">
              ${teamBadge(game, 'A', { logoSize: 20, cls: 'team-badge-sm' })}
              <div class="pt-pts">${escapeHtml(scoreA)}</div>
            </div>
            <div class="pt-mid">
              <div class="${statusCls}">${statusTxt}</div>
            </div>
            <div class="pt-team badge-fit">
              ${teamBadge(game, 'B', { logoSize: 20, cls: 'team-badge-sm' })}
              <div class="pt-pts">${escapeHtml(scoreB)}</div>
            </div>
          </div>
        `;
      }

      header.innerHTML = `
        <div class="player-title-row badge-fit">
          <div class="player-title">${guestPickingOn(game) ? 'Pick your squares' : 'Player View'}</div>
        </div>
        ${tickerHtml}
        ${helper && helper.line() ? `<div class="helper-line">${escapeHtml(helper.line())}</div>` : ''}
      `;
      fitTeamBadges(header);
    }

    function drawSelect() {
      // Rebuilding the <select> while the host has it open (mid-poll refresh)
      // collapses the dropdown out from under them — skip the rebuild while
      // it's focused and let the next poll after they finish pick up any changes.
      if (document.activeElement && selectRow.contains(document.activeElement)) return;

      const summaries = playerSummaries(game);
      selectRow.innerHTML = '';
      if (!summaries.length) {
        selectRow.appendChild(el('div', 'player-select-empty', 'No squares have been claimed for this game yet.'));
        return;
      }
      const label = el('label', 'player-select-label', 'Viewing squares for');
      const select = el('select', 'player-select');
      // A helper's name can change later: one who bought squares, or tapped the wrong name.
      select.appendChild(el('option', '', helper && helper.line() ? "I'm not playing" : 'Choose your name…')).value = '';
      summaries.forEach(p => {
        const opt = el('option', '', escapeHtml(p.name));
        opt.value = p.name;
        if (p.name === selectedPlayer) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', (e) => {
        selectedPlayer = e.target.value || null;
        saveSelectedPlayer(selectedPlayer);
        if (helper) { drawHeader(); helper.draw(); }
        drawBody();
      });
      selectRow.appendChild(label);
      selectRow.appendChild(select);
    }

    function drawBody() {
      // While a guest is picking, the panel stays where it is: taking it off the page, even
      // for a moment, closes a phone's keyboard.
      if (panelCard && panelCard.isConnected && guestPickingOn(game)) {
        panelCard.querySelector('.player-card-sub').textContent = `${game.squares.filter(Boolean).length} of 100 claimed`;
        panel.render();
        return;
      }
      body.innerHTML = '';

      if (game.status === 'setup' || game.status === 'picking') {
        const claimed = game.squares.filter(Boolean).length;
        const card = el('div', 'card player-card');
        if (guestPickingOn(game)) {
          if (!panel) panel = createGuestPanel(panelCtx);
          card.innerHTML = `<div class="player-card-head"><span class="player-card-title">Board filling up</span><span class="player-card-sub">${claimed} of 100 claimed</span></div>
            <p class="player-muted">The numbers are drawn when the host locks the board.</p>`;
          card.appendChild(panel.root);
          panelCard = card;
          body.appendChild(card);
          panel.render();
          return;
        }
        card.innerHTML = `<div class="player-card-head"><span class="player-card-title">Board filling up</span><span class="player-card-sub">${claimed} of 100 claimed</span></div>
          <p class="player-muted">The numbers are drawn when the host locks the board. Come back then to see how your squares are doing.</p>`;
        card.appendChild(miniGrid(game, selectedPlayer));
        body.appendChild(card);
        return;
      }

      const computed = computeGame(game);
      const liveHighlight = computeLiveHighlight(game);

      const myIdx = game.squares
        .map((sq, i) => (sq && sq.name === selectedPlayer) ? i : -1)
        .filter(i => i >= 0);
      const infos = myIdx.map(i => squareInfo(game, computed, liveHighlight, i));

      // Squares that still have a realistic shot: already won a quarter, are
      // the live winner right now, or are one likely score from becoming it.
      // A square that needs an unlikely swing just clutters this list.
      const inRunning = infos.filter(i => i.status !== 'dormant');

      // "In the running" / "hot threat" are projections off a live score —
      // meaningless for a game the host is scoring by hand, since there's no
      // feed to project from between quarters actually being entered.
      if (selectedPlayer && isAutoScored(game)) {
        // ---- My Squares Status ----
        const statusCard = el('div', 'card player-card');
        statusCard.innerHTML = `<div class="player-card-head"><span class="player-card-title">My Squares Status</span><span class="player-card-sub">${inRunning.length} in the running</span></div>`;
        if (!infos.length) {
          statusCard.appendChild(el('p', 'player-muted', `No squares found for "${escapeHtml(selectedPlayer)}".`));
        } else if (!inRunning.length) {
          statusCard.appendChild(el('p', 'player-muted', `None of your ${infos.length} square${infos.length === 1 ? '' : 's'} are in the running right now — hang tight for the next score.`));
        } else {
          const list = el('div', 'player-square-list');
          inRunning.slice().sort((a, b) => (a.status === b.status ? 0 : a.status === 'winning' ? -1 : 1))
            .forEach(info => {
              const meta = STATUS_META[info.status];
              const row = el('div', 'player-square-item');
              row.innerHTML = `
                <div>
                  <div class="psi-coord">${coordHtml(game, info)}</div>
                  <div class="psi-desc">${escapeHtml(squareDesc(info))}</div>
                </div>
                <span class="psi-tag ${meta.cls}">${meta.tag}</span>
              `;
              list.appendChild(row);
            });
          statusCard.appendChild(list);
        }
        body.appendChild(statusCard);
      }

      if (selectedPlayer && infos.length) {
        // ---- Portfolio pills ----
        const pillCard = el('div', 'card player-card');
        pillCard.innerHTML = `<div class="player-card-head"><span class="player-card-title">My Grid Portfolio</span></div>`;
        const pillsWrap = el('div', 'player-pills');
        infos.forEach(info => {
          const winCount = info.won.length;
          // Absolutely positioned so it overlays the corner rather than
          // sitting inline — the badge must never push the pill wider/taller
          // or the two-column grid's alignment would drift row to row.
          const badge = winCount > 0 ? `<span class="pill-win-badge" title="Won ${winCount} quarter${winCount === 1 ? '' : 's'}">${winCount}</span>` : '';
          const pillCls = info.status === 'winning' ? ' is-live' : info.status === 'threat' ? ' is-threat' : '';
          const pill = el('span', 'player-pill' + pillCls, coordHtml(game, info) + badge);
          pillsWrap.appendChild(pill);
        });
        pillCard.appendChild(pillsWrap);
        body.appendChild(pillCard);
      }

      // ---- The board, with my squares highlighted ----
      const gridCard = el('div', 'card player-card');
      gridCard.innerHTML = `<div class="player-card-head"><span class="player-card-title">The Board</span></div>`;
      gridCard.appendChild(miniGrid(game, selectedPlayer));
      body.appendChild(gridCard);

      // ---- Game Winners ----
      const archiveCard = el('div', 'card player-card');
      const scoredByHost = window.GameLogic.scoringMode(game) === 'manual'
        ? '<span class="player-card-sub player-scored-by">scored by host</span>' : '';
      archiveCard.innerHTML = `<div class="player-card-head"><span class="player-card-title">Game Winners</span>${scoredByHost}</div>`;
      const rows = el('div', 'player-history');
      QUARTERS.forEach(q => {
        const res = computed.results[q];
        const label = q === 'final' ? 'FINAL' : QLABEL[q];
        let scoreTxt = '– : –';
        if (res.a !== null && res.b !== null) scoreTxt = `${res.a} - ${res.b}`;
        let winnerTxt, winnerCls = '';
        if (res.a === null || res.b === null) {
          winnerTxt = 'Not yet'; winnerCls = 'ph-pending';
        } else if (res.resolved && res.pushed) {
          winnerTxt = 'Push (rolled over)'; winnerCls = 'ph-pending';
        } else if (res.resolved && res.winnerName) {
          const mine = res.winnerName === selectedPlayer;
          winnerTxt = `${escapeHtml(res.winnerName)} &middot; ${money(res.amount)}`;
          if (res.autoResolved) {
            const digits = drawnDigits(game, res);
            if (digits) winnerTxt += ` <span class="ph-drawn">(Drawn ${escapeHtml(digits.y)}-${escapeHtml(digits.x)})</span>`;
          }
          winnerCls = mine ? 'ph-mine' : 'ph-live';
        } else if (q === 'final' && res.needsDraw) {
          winnerTxt = 'Awaiting draw'; winnerCls = 'ph-pending';
        } else {
          winnerTxt = 'In progress'; winnerCls = 'ph-pending';
        }
        const row = el('div', 'player-history-row');
        row.innerHTML = `
          <div class="ph-q">${label}</div>
          <div class="ph-score">${scoreTxt}</div>
          <div class="ph-winner ${winnerCls}">${winnerTxt}</div>
        `;
        rows.appendChild(row);
      });
      archiveCard.appendChild(rows);
      body.appendChild(archiveCard);

      if (selectedPlayer) {
        // ---- Total Won ---- (updates live as quarters resolve, via the poll)
        const totalWon = computeTotalWon(computed, selectedPlayer);
        const totalCard = el('div', 'card player-card player-total-card');
        totalCard.innerHTML = `
          <div class="player-total-label">Total Won</div>
          <div class="player-total-value${totalWon > 0 ? ' has-winnings' : ''}">${money(totalWon)}</div>
        `;
        body.appendChild(totalCard);
      }

      fitTeamBadges(body);
    }

    function drawAll() {
      if (!game) return;
      drawHeader();
      drawSelect();
      inviteBtn.hidden = false;
      if (game.joinCode) { hostLink.href = SBS.referral.url(game.joinCode); hostLink.hidden = false; }
      drawBody();
      if (helper) helper.draw(); // the first tab's label follows the name
    }

    async function load(initial, now) {
      // A score on its way must not be overwritten by an answer from before it.
      if (helper && helper.busy()) return;
      try {
        // A phone that picks must see its own squares after a reload, not a copy from before them.
        const fresh = now || (initial && isPicker(id)) ? await SBS.api.getGame(id) : await SBS.api.pollGame(id, { must: initial });
        if (!fresh || (helper && helper.busy())) return;
        if (initial) {
          game = fresh;
          selectedPlayer = loadSelectedPlayer();
          // A remembered name that no longer has squares (removed by the
          // host) shouldn't silently pin the view to an empty state forever.
          if (selectedPlayer && !Object.keys(playerSummaries(fresh).reduce((m, p) => (m[p.name] = 1, m), {})).includes(selectedPlayer)) {
            selectedPlayer = null;
          }
          drawAll();
          helper = createHelperTabs({
            id, route: route || {}, wrap, header,
            game: () => game,
            setGame: (g) => { game = g; drawHeader(); drawBody(); }, // a later poll finds nothing new to draw
            redraw: () => drawAll(),
            selected: () => selectedPlayer,
            choose: (name) => { selectedPlayer = name; saveSelectedPlayer(name); }
          });
          helper.ask();
          // A phone that picked before opens straight into picking. Its name may have changed
          // since (a host rename), so the server is asked, not the remembered name trusted.
          if (isPicker(id) && panel && guestPickingOn(game)) panel.start(true);
        } else if (!game || SBS.boardKey(fresh) !== SBS.boardKey(game)) {
          const saved = !game || fresh.updatedAt !== game.updatedAt;
          game = fresh;
          if (saved) {
            drawAll();
            if (panel) panel.followName();
          } else {
            // Only the live score moved: leave the name list alone, it may be open.
            drawHeader();
            drawBody();
          }
          if (helper) {
            if (saved) helper.saved();
            helper.draw();
          }
        }
      } catch (e) {
        if (e && e.status === 404) {
          header.innerHTML = `<div class="error-msg">This game no longer exists.</div>`;
          selectRow.innerHTML = '';
          inviteBtn.hidden = true;
          body.innerHTML = '';
          wrap.classList.remove('on-job');
          wrap.querySelectorAll('.helper-pane, .helper-tabs, .helper-note').forEach(n => n.remove());
          return;
        }
        if (initial) header.innerHTML = `<div class="error-msg">Could not load this game: ${escapeHtml(e.message)}</div>`;
      }
    }

    load(true);
    // 15s, not the 6s the host-facing screens use. This view is the one that
    // scales with the size of the party: every guest who scans the QR code
    // holds one open, so its interval — multiplied by 20, 50, however many
    // people are in the room — sets the floor for load on every tier behind
    // it. At 50 viewers, 6s is 500 requests a minute and 15s is 200, and on a
    // read-only "how am I doing" panel nobody can tell the difference.
    // The host's own board and the TV stay fast; there is exactly one of each.
    SBS.setManagedInterval(() => load(false), 15000);
    // A helper keeping score stays in step with the host's screens. Whether the job still stands is
    // asked on load, when the phone is shown again, on a tab tap and after a refusal: never on a timer.
    SBS.setManagedInterval(() => { if (helper && helper.onScore() && !document.hidden) load(false); }, 5000);
    const onShow = () => { if (!document.hidden && helper && helper.maybe()) helper.ask(); };
    document.addEventListener('visibilitychange', onShow);
    SBS.onLeaveScreen(() => document.removeEventListener('visibilitychange', onShow));
  }

  // The host's QR code for the guest view. Guests pass the link on with showInvite.
  // `code` (R22): when the board has a join code, the QR and link use the short
  // /<code> form, the same link the host shares and the TV shows.
  function showPlayerLink(id, code, game) {
    const overlay = SBS.ui.overlayEl('0.65');
    const box = el('div', 'card');
    box.style.cssText = 'max-width:520px; width:100%; box-shadow: var(--shadow-pop);';
    box.innerHTML = `<h3 style="margin-top:0">Scan to view your squares</h3>
      <p style="color:var(--muted)">${guestPickingOn(game)
        ? "Point a phone's camera at this code to open Player View. Players can claim and release their own squares while picking is open, then follow their squares, quarter winners and a live status readout. They can't change anything else."
        : "Point a phone's camera at this code to open the same read-only Player View — your squares, quarter winners, and a live status readout. Nothing here can change the game."}</p>
      <div class="phone-link-list"></div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const list = box.querySelector('.phone-link-list');
    const url = code ? `${location.origin}/${code}` : `${location.origin}${location.pathname}#player-${id}`;
    let qr = '';
    try {
      qr = window.QRCode.toSvg(url, 150);
    } catch (err) {
      console.error('QR encode failed', err);
    }
    list.innerHTML = qr
      ? `<div class="phone-qr-block"><div class="phone-qr">${qr}</div><div class="phone-link">${escapeHtml(url)}</div></div>`
      : `<div class="phone-link">${escapeHtml(url)}</div>`;

    const actions = el('div', 'actions');
    const openHere = el('button', 'secondary', 'Open it on this device');
    openHere.addEventListener('click', () => {
      overlay.remove();
      window.open(`${location.origin}${location.pathname}#player-${id}`, '_blank');
    });
    const close = el('button', '', 'Done');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    actions.appendChild(openHere);
    box.appendChild(actions);
  }

  // ---------- Printed sign (R29) ----------
  // One Letter page to hang up at the party: the join code and a QR of the join link. Built as a
  // print-only element at the end of <body>; @media print (styles.css) hides the app and shows only
  // it, then window.print() opens the browser's own print dialog. Nothing private goes on it: no paid
  // status, no money. Everything that reaches markup is escaped.
  function signDate(game) {
    const raw = game && game.gameDate;
    if (!raw) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(raw + 'T12:00:00') : new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function buildSign(game) {
    const url = joinUrl(game);
    let qr = '';
    try { qr = window.QRCode.toSvg(url, 360); } catch (err) { console.error('QR encode failed', err); }
    const matchup = `${game.teamA || 'Team A'} vs ${game.teamB || 'Team B'}`;
    const date = signDate(game);
    const sign = el('div', 'print-sign');
    sign.setAttribute('aria-hidden', 'true');
    sign.innerHTML = `
      <div class="ps-brand">Big Game Grids</div>
      <h1 class="ps-title">Scan to see your squares</h1>
      <div class="ps-match">${escapeHtml(matchup)}${date ? ' &middot; ' + escapeHtml(date) : ''}</div>
      <div class="ps-qr">${qr}</div>
      <p class="ps-how">Point your phone's camera at the code and tap the link. You'll see your squares, the numbers for each row and column, and who is winning each quarter.</p>
      ${game.joinCode ? `<div class="ps-code-box"><span class="ps-code-help">No camera?<br>Go to <b>${escapeHtml(location.host)}</b><br>and enter the code</span><span class="ps-code">${escapeHtml(game.joinCode)}</span></div>` : ''}
      <div class="ps-foot">Nothing to install. No sign-in.</div>`;
    return sign;
  }

  function printSign(game) {
    const old = document.querySelector('.print-sign');
    if (old) old.remove();
    const sign = buildSign(game);
    document.body.appendChild(sign);
    const after = () => { window.removeEventListener('afterprint', after); sign.remove(); };
    window.addEventListener('afterprint', after);
    try { window.print(); } catch (e) { after(); }
    return sign;
  }

  SBS.screens.player = renderPlayer;
  SBS.screens.join = renderJoin;
  SBS.playerView = { showPlayerLink, joinChip, shareBoard, copyJoinLink, printSign, buildSign, joinUrl };
})();
