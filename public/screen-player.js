// Player companion view: what a grid player sees after scanning the QR code
// printed or displayed at the party, as tabs at the bottom (R44): Home, Players, then Picks
// before the lock or Live after it, plus what a helper's jobs add (decision 025). Home is in
// player-home.js and Players in players-tab.js. Polls like the TV/phone screens so it stays
// live without a manual refresh.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, applyTeamColors, teamBadge, fitTeamBadges, isPhone } = SBS.ui;
  const { playerSummaries } = SBS.players;
  const { computeGame, nameKey } = window.GameLogic;

  function storageKey(id) { return `sbs-player-view-${id}`; }
  // Set once this phone has opened picking on the board, so a reload asks the server who it is.
  // Choosing a name just to look never does: looking must not set the pick cookie.
  function pickerKey(id) { return `sbs-guest-picker-${id}`; }
  // The name the server last said this phone holds, and "Just watching".
  function pickedKey(id) { return `sbs-guest-name-${id}`; }
  function skipKey(id) { return `sbs-player-skip-${id}`; }
  function isPicker(id) { try { return window.localStorage.getItem(pickerKey(id)) === '1'; } catch (e) { return false; } }

  // The live score strip at the top of Home and Score, after the lock.
  function tickerHtml(game) {
    const live = game.liveScore;
    const final = computeGame(game).results.final;
    const hasFinal = final.a !== null && final.b !== null;
    const auto = SBS.playerHome.isAutoScored(game);
    // A manually-scored game has no live feed to fall back on, so there's nothing meaningful
    // to show until the host enters the Final score: better nothing than a dash that looks
    // like a score but never updates.
    const score = (side) => (live && live[side] !== undefined && live[side] !== null ? live[side] : hasFinal ? final[side] : auto ? '–' : '');
    const statusTxt = game.status === 'finished' ? 'FINAL'
      : (live && live.state === 'in') ? [live.period ? (live.period > 4 ? (live.period > 5 ? `${live.period - 4}OT` : 'OT') : `Q${live.period}`) : '', live.clock].filter(Boolean).map(escapeHtml).join(' &middot; ')
      : 'In Progress';
    // Same glowing pill treatment the Home screen's game card uses for a "started" game.
    const statusCls = 'pt-status' + (game.status === 'started' ? ' is-live' : '');
    const team = (side, key) => `<div class="pt-team badge-fit">
          ${teamBadge(game, side, { logoSize: 20, cls: 'team-badge-sm' })}
          <div class="pt-pts">${escapeHtml(score(key))}</div>
        </div>`;
    return `<div class="player-ticker">${team('A', 'a')}<div class="pt-mid"><div class="${statusCls}">${statusTxt}</div></div>${team('B', 'b')}</div>`;
  }

  // ---------- Join code: link and share (R22, decision 016) ----------

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

  // ctx: { id, game() -> the board, setGame(g) stores and redraws, remember(name) takes the
  // server's word on this phone's name, reload() fetches the board again, markPicker(),
  // claimed(count) after a claim }.
  function createGuestPanel(ctx) {
    const root = el('div', 'guest-panel');
    const startRow = el('div', 'gp-start');
    const startBtn = el('button', 'gp-start-btn', 'Pick squares');
    startBtn.type = 'button';
    startRow.appendChild(el('p', 'player-muted', 'Claim your squares right here. The host marks you paid.'));
    startRow.appendChild(startBtn);

    const live = el('div', 'gp-live');
    const nameWrap = el('div', 'gp-name');
    nameWrap.innerHTML = '<label for="gp-name-input">First name and last initial</label>';
    const nameInput = el('input', '');
    nameInput.type = 'text';
    nameInput.id = 'gp-name-input';
    nameInput.maxLength = 10;
    nameInput.autocomplete = 'off';
    nameInput.setAttribute('autocapitalize', 'words');
    nameInput.placeholder = 'Up to 10 letters';
    const warn = el('p', 'gp-warn');
    warn.setAttribute('role', 'status');
    nameWrap.append(nameInput, warn);
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
    // On a phone the grid can be pinched larger (pinch-zoom.js); the squares inside are redrawn, the frame is not.
    let boardSlot = boardWrap;
    if (SBS.pinchZoom && SBS.pinchZoom.enabled()) {
      boardSlot = el('div', 'pz-viewport');
      boardSlot.appendChild(boardWrap);
      SBS.pinchZoom.attach(boardSlot, boardWrap, boardSlot);
    }
    live.append(nameWrap, asLine, capLine, boardSlot, autoWrap);
    // The claim bar stays above the tab bar while squares are selected.
    root.append(startRow, live, status, actionRow);

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

      startRow.hidden = started || busy;
      startBtn.disabled = busy;
      live.hidden = !started;
      if (!started) {
        actionRow.hidden = true;
        return;
      }

      asLine.hidden = !name;
      asLine.textContent = name ? `Picking as ${name}` : '';
      nameWrap.hidden = !!name;
      checkName();

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
    }

    // Said while typing: the server refuses a taken name (decision 019 section 2).
    function checkName() {
      const key = nameKey(nameInput.value);
      const taken = !name && !!key && game().squares.some(s => s && nameKey(s.name) === key);
      warn.textContent = taken ? 'That name is taken. Not you? Add your last initial.' : '';
    }
    nameInput.addEventListener('input', checkName);

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
        if (op.op === 'claim') {
          say('');
          ctx.claimed(myIdx().length);
        }
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
    // `focusName`: Join was tapped, so the name box is ready to type in.
    async function start(quiet, focusName) {
      const focusBox = () => { if (focusName) (name ? boardWrap.querySelector('.gp-cell:not(:disabled)') || nameInput : nameInput).focus(); };
      if (started) return focusBox();
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
      ctx.remember(name);
      say('');
      render();
      focusBox();
    }
    startBtn.addEventListener('click', () => start(false, true));

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

  // ---------- The copy kept on the phone (Neon cold start) ----------
  // The last board this phone fetched, so a reopened page paints before the database wakes.
  // Only the few most recent boards are kept.
  const COPY_PREFIX = 'sbs-player-board-';
  const COPY_KEEP = 3;
  function readCopy(id) {
    try {
      const c = JSON.parse(window.localStorage.getItem(COPY_PREFIX + id));
      return c && c.game && Array.isArray(c.game.squares) ? c : null;
    } catch (e) { return null; }
  }
  function writeCopy(id, game, at) {
    try {
      const store = window.localStorage;
      store.setItem(COPY_PREFIX + id, JSON.stringify({ at, game }));
      const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter(k => k.indexOf(COPY_PREFIX) === 0);
      if (keys.length <= COPY_KEEP) return;
      const age = (k) => { try { return JSON.parse(store.getItem(k)).at || 0; } catch (e) { return 0; } };
      keys.sort((a, b) => age(b) - age(a)).slice(COPY_KEEP).forEach(k => store.removeItem(k));
    } catch (e) { /* storage full or off: the next visit waits for the server */ }
  }
  function dropCopy(id) {
    try { window.localStorage.removeItem(COPY_PREFIX + id); } catch (e) { /* nothing kept */ }
  }

  // ---------- You won (R44) ----------
  // Each win is announced once on a phone: its banner stays until dismissed, and it buzzes once.
  // Returns { el, update(game, name, tab, fresh) }.
  function createWinBanner(id, openHome) {
    const root = el('div', 'win-banners');
    root.setAttribute('role', 'status');
    const key = `sbs-player-wins-${id}`;
    let seen = { buzzed: [], gone: [] };
    try { seen = Object.assign(seen, JSON.parse(window.localStorage.getItem(key))); } catch (e) { /* start over */ }
    const save = () => { try { window.localStorage.setItem(key, JSON.stringify(seen)); } catch (e) { /* this visit only */ } };
    let sig = '';
    let last = null;

    function update(game, name, tab, fresh) {
      last = [game, name, tab, fresh];
      const computed = computeGame(game);
      const wins = !name ? [] : window.GameLogic.QUARTERS.map(q => {
        const r = computed.results[q];
        return r.resolved && !r.pushed && r.winnerName === name ? { id: `${q}|${name}`, q, amount: r.amount } : null;
      }).filter(w => w && seen.gone.indexOf(w.id) === -1).reverse(); // newest first
      // Only a board straight from the server, on a page someone can see, buzzes.
      const unfelt = fresh && !document.hidden ? wins.filter(w => seen.buzzed.indexOf(w.id) === -1) : [];
      if (unfelt.length) {
        unfelt.forEach(w => seen.buzzed.push(w.id));
        save();
        try { if (navigator.vibrate) navigator.vibrate(200); } catch (e) { /* no buzz */ }
      }
      const home = tab === 'home';
      const next = JSON.stringify([home, wins]);
      if (next === sig) return;
      sig = next;
      const had = root.contains(document.activeElement);
      // One banner for every win not yet dismissed: "You won Q1 and the half · $500".
      const phrases = wins.slice().reverse().map(w => SBS.playerHome.WON_PHRASE[w.q]);
      const named = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}` : phrases[0];
      const words = `You won ${named} · ${money(wins.reduce((t, w) => t + w.amount, 0))}`;
      const press = (cls, label, onClick) => {
        const b = el('button', cls, label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
      };
      if (!wins.length) {
        root.replaceChildren();
      } else if (home) {
        const card = el('div', 'win-banner');
        const text = el('div', 'win-text');
        text.append(textEl('strong', '', words), textEl('span', '', 'Collect from the host.'));
        card.append(text, press('secondary win-dismiss', 'Dismiss', () => {
          wins.forEach(w => seen.gone.push(w.id));
          save();
          update(...last);
          const b = document.querySelector('.player-tab[aria-current]');
          if (b) b.focus();
        }));
        root.replaceChildren(card);
      } else {
        root.replaceChildren(press('win-slim', escapeHtml(words), openHome));
      }
      if (had && !root.contains(document.activeElement)) { const b = root.querySelector('button'); if (b) b.focus(); }
    }

    return { el: root, update };
  }

  // Tabler "home", "activity", "layout-grid", "scoreboard" and "users" (MIT, 24 px outline).
  const tabSvg = (paths) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const HOME_ICON = tabSvg('<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>');
  const LIVE_ICON = tabSvg('<path d="M3 12h4l3 8l4 -16l3 8h4"/>');
  const PICKS_ICON = tabSvg('<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/>');
  const SCORE_ICON = tabSvg('<path d="M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M12 5v2"/><path d="M12 10v1"/><path d="M12 14v1"/><path d="M12 18v1"/><path d="M7 3v2"/><path d="M17 3v2"/><path d="M15 10.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0z"/><path d="M6 9h1.5a1.5 1.5 0 0 1 0 3h-.5h.5a1.5 1.5 0 0 1 0 3h-1.5"/>');
  const PLAYERS_ICON = tabSvg('<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>');

  // The helper's side of Player View (decision 025 section 2): a welcome once, then what the jobs
  // add. The scorekeeper gets a Score tab; the squares manager gets editing controls in the Players
  // tab. Nothing changes on the server by looking; the jobs come from GET …/role. The name chosen in
  // the welcome is display only: a helper need not be playing, and nothing is authorized by a name.
  // ctx: { id, route, wrap, game(), setGame(g), redraw(), selected(), choose(name), welcomed(tab),
  // lost() }.
  function createHelpers(ctx) {
    const flag = SBS.helpers.phone;
    let role = null;          // the server's last answer, or null
    let wanted = ctx.route.tab === 'score'; // an old score link
    const maybe = () => ctx.route.helper === true || !!flag.get(ctx.id);

    const welcomePane = el('div', 'helper-pane');
    welcomePane.hidden = true;
    const scorePane = el('div', 'helper-pane');
    scorePane.hidden = true;
    const note = el('p', 'helper-note');
    note.setAttribute('role', 'status');
    note.hidden = true;

    let pad = null; // made the first time it is shown: most phones here are guests'
    const makePad = () => SBS.scorePanel.create({
      getGame: ctx.game,
      setGame: ctx.setGame,
      patch: (gid, op) => SBS.api.patchScore(gid, op, { prompt: false }),
      // 403, not 401, when this phone happens to be signed in as some other host.
      onError: (e) => lost(e, 'canScore')
    });

    const isOpen = () => ctx.game().status === 'started' || ctx.game().status === 'finished';
    const JOBS = [
      { key: 'canScore', title: 'Scorekeeper', off: 'scorekeeping', lost: 'keep score',
        duty: ['Keep score', 'Tap what happens. End each quarter.'] },
      { key: 'canSquares', title: 'Squares manager', off: 'managing squares', lost: 'manage squares',
        duty: ['Manage squares', 'In the Players tab: help people pick, and mark who has paid.'] }
    ];
    const held = () => JOBS.filter(j => role && role[j.key]);
    const jobNames = () => held().map(j => j.title).join(' and ');
    const welcoming = () => held().length > 0 && flag.get(ctx.id) === 'new';
    let told = null; // the job the note says is gone

    function say(text) {
      note.textContent = text || '';
      note.hidden = !text;
    }
    // A save was refused: that job is over. 403 when this phone is also signed in as another host.
    // Only its controls go; the server says what is left.
    function lost(e, job) {
      if (e.status !== 401 && e.status !== 403) return false;
      if (role) role = Object.assign({}, role, { [job]: false });
      told = job;
      say(`You no longer ${JOBS.find(j => j.key === job).lost} on this board. If that is a mistake, ask the host for a new code.`);
      ctx.redraw();
      ask();
      return true;
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
      if (isHelper && told && (told === 'all' ? held().length : r[told])) { told = null; say(''); }
      if (!isHelper && flag.get(ctx.id)) {
        flag.forget(ctx.id);
        ctx.route.helper = false;
        told = 'all';
        say('You no longer help on this board. If that is a mistake, ask the host for a new code.');
      } else if (isHelper && !flag.get(ctx.id)) {
        flag.set(ctx.id, 'new');
      }
      const open = wanted && role && role.canScore;
      wanted = false;
      const gone = before && role ? JOBS.filter(j => before[j.key] && !role[j.key]) : [];
      if (gone.length) {
        told = gone.length > 1 ? 'all' : gone[0].key;
        say(`The host switched off ${gone.map(j => j.off).join(' and ')} on this phone.`);
      }
      if (open) ctx.welcomed('score');
      else if (JSON.stringify(before) !== JSON.stringify(role)) ctx.redraw();
    }

    // The Score tab, while it is the one shown.
    function drawScore() {
      if (!isOpen()) {
        const wait = el('div', 'card player-card helper-wait');
        wait.append(textEl('h2', '', "Scoring isn't open yet"), textEl('p', 'player-muted', 'It opens here by itself when the host locks the board and the numbers are drawn.'));
        return scorePane.replaceChildren(wait);
      }
      if (!pad) pad = makePad();
      if (scorePane.firstChild !== pad.el) scorePane.replaceChildren(pad.el);
      pad.update();
    }

    // Once: what they may do, and whose squares are theirs.
    function drawWelcome() {
      const shown = welcomePane.querySelector('.helper-welcome');
      if (shown && shown.dataset.jobs === jobNames()) return; // a poll must not close an open list
      const card = el('div', 'card player-card helper-welcome');
      card.dataset.jobs = jobNames();
      card.appendChild(textEl('h2', '', 'You were asked to help run this board'));
      const duties = held().map(j => j.duty);
      duties.push(['Your own squares stay on Home', 'Switch any time with the tabs at the bottom. Not playing? You still see the board.']);
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
        welcomePane.replaceChildren();
        ctx.welcomed(role && role.canScore && isOpen() ? 'score' : role && role.canSquares ? 'players' : 'home');
      });
      card.append(label, go, textEl('p', 'player-muted', 'This works on this phone, for this board, until the game is over.'));
      welcomePane.replaceChildren(card);
    }

    return {
      ask, maybe, lost, welcoming, drawWelcome, drawScore, note, welcomePane, scorePane,
      can: (key) => !!(role && role[key]),
      busy: () => !!pad && pad.busy(),
      // Another device saved: what was done here may not undo cleanly.
      saved: () => { if (pad) pad.clearUndo(); },
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
    header.innerHTML = '<div class="player-muted">Opening the board…</div>';
    wrap.appendChild(header);

    let game = null;
    let tab = 'home';     // everyone lands on Home
    let panel = null;     // the guest-pick panel, kept for the life of the screen
    let parts = null;     // the panes and the tab bar, made once the board has loaded
    let closedNote = ''; // what Home is about to say because picking closed
    let stale = false;   // what is on screen is the phone's copy, not yet the server's
    let fetchedAt = 0;
    let saved = '';      // the board already kept on the phone

    // ----- who this phone is (decision 019) -----
    // `chosen`: a name picked from a list, kept on this phone only; it changes only what this phone
    // shows. `picked`: the server's answer to this phone's pick key, kept so it still reads "You"
    // after the lock, when the server no longer says. Only that name is shown money owed.
    const read = (key) => { try { return window.localStorage.getItem(key); } catch (e) { return null; } };
    const write = (key, value) => {
      try {
        if (value) window.localStorage.setItem(key, value);
        else window.localStorage.removeItem(key);
      } catch (e) { /* private browsing etc — it just won't persist */ }
    };
    let chosen = read(storageKey(id));
    let picked = read(pickedKey(id));
    let skipped = read(skipKey(id)) === '1';

    const hasSquares = (name) => !!name && game.squares.some(s => s && s.name === name);
    const tagged = (name) => !!(game.players && Object.prototype.hasOwnProperty.call(game.players, name) && game.players[name] && game.players[name].g);
    // A name with no squares left (removed by the host) shows as nobody.
    const keyName = () => (hasSquares(picked) && tagged(picked) ? picked : null);
    const me = () => shownName(game);
    const elsewhere = (name) => tagged(name) && name !== keyName();
    function choose(name) {
      chosen = name || null;
      write(storageKey(id), chosen);
      if (chosen) skip(false);
      drawAll();
    }
    function skip(on) {
      skipped = !!on;
      write(skipKey(id), on ? '1' : null);
    }
    // The server's word on which name this phone holds, or null for none.
    function remember(name) {
      const was = picked;
      picked = name || null;
      write(pickedKey(id), picked);
      if (picked) { chosen = picked; skip(false); }
      else if (was && chosen === was) chosen = null;
      write(storageKey(id), chosen);
    }

    const panelCtx = {
      id,
      game: () => game,
      setGame: (g) => { game = g; drawAll(); },
      remember: (name) => { remember(name); drawAll(); },
      reload: () => load(false, true),
      markPicker: () => { write(pickerKey(id), '1'); },
      // A claim goes back to Home and says what this phone holds now.
      claimed: (n) => { show('home'); parts.home.say(`You have ${n} square${n === 1 ? '' : 's'}.`); parts.home.focusNote(); window.scrollTo(0, 0); }
    };

    const pickingOn = () => guestPickingOn(game);
    const locked = () => game.status === 'started' || game.status === 'finished';

    // The tab bar: Home, Players, then Picks or Live, then a helper's Score.
    function tabs() {
      const list = [['home', 'Home', HOME_ICON], ['players', 'Players', PLAYERS_ICON]];
      if (locked()) list.push(['live', 'Live', LIVE_ICON]);
      else if (pickingOn()) list.push(['picks', 'Picks', PICKS_ICON]);
      if (parts.helper.can('canScore')) list.push(['score', 'Score', SCORE_ICON]);
      return list;
    }

    function show(next) {
      if (next !== tab) parts.home.say('');
      if (next !== 'home') parts.home.reset();
      tab = next;
      drawAll();
    }

    function openPicks(focusName) {
      show('picks');
      window.scrollTo(0, 0);
      if (panel) panel.start(false, focusName);
    }

    function build() {
      const helper = createHelpers({
        id, route: route || {}, wrap,
        game: () => game,
        setGame: (g) => { game = g; drawAll(); }, // a later poll finds nothing new to draw
        redraw: () => drawAll(),
        selected: () => me(),
        choose,
        welcomed: (next) => { show(next); window.scrollTo(0, 0); }
      });
      const home = SBS.playerHome.create({
        game: () => game, me, keyName, elsewhere, choose, pickingOn,
        names: () => playerSummaries(game).map(p => p.name),
        skipped: () => skipped,
        skip,
        join: () => openPicks(true),
        openPicks: () => openPicks(false),
        invite: () => showInvite(game),
        // The board full screen, read-only; Exit and Back come back here.
        openBoard: () => SBS.go({
          screen: 'mirror', id, from: 'player',
          guest: { game, nameFor: shownName, back: { screen: 'player', id, helper: route && route.helper, focus: 'board' } }
        })
      });
      const wins = createWinBanner(id, () => { show('home'); window.scrollTo(0, 0); parts.nav.querySelector('[aria-current]').focus(); });
      const people = SBS.playersTab.create({
        getGame: () => game,
        // Names and squares may have changed, so the whole page follows.
        setGame: (g) => { game = g; drawAll(); helper.saved(); if (panel) panel.followName(); },
        patch: (op) => SBS.api.patchSquares(id, op),
        reload: () => SBS.api.getGame(id).catch(() => null),
        onError: (e) => helper.lost(e, 'canSquares'),
        canManage: () => helper.can('canSquares'),
        me, keyName, elsewhere, choose
      });
      const picksPane = el('div', 'player-pane');
      const livePane = el('div', 'player-pane');
      const nav = el('nav', 'player-tabs');
      nav.setAttribute('aria-label', 'This board');
      wrap.append(helper.note, wins.el, helper.welcomePane, home.el, picksPane, livePane, people.el, helper.scorePane, nav);
      parts = { helper, home, people, picksPane, livePane, nav, wins };
    }

    function drawHeader() {
      applyTeamColors(game);
      const title = parts.helper.welcoming() ? 'Player View'
        : { home: 'Player View', players: 'Players', picks: 'Pick your squares', live: 'Live', score: 'Score' }[tab];
      const line = parts.helper.line();
      header.innerHTML = `
        <div class="player-title-row badge-fit"><div class="player-title">${title}</div></div>
        ${locked() && (tab === 'home' || tab === 'score' || tab === 'live') ? tickerHtml(game) : ''}
        ${line && (tab === 'home' || tab === 'score') ? `<div class="helper-line">${escapeHtml(line)}</div>` : ''}
      `;
      fitTeamBadges(header);
    }

    function drawNav() {
      const { nav } = parts;
      const list = tabs();
      const sig = JSON.stringify([tab, list.map(t => t[0])]);
      if (nav.dataset.sig === sig) return;
      nav.dataset.sig = sig;
      const had = nav.contains(document.activeElement);
      nav.replaceChildren(...list.map(([k, label, icon]) => {
        const b = el('button', 'player-tab', `${icon}<span>${label}</span>`);
        b.type = 'button';
        if (k === tab) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => {
          if (tab === k) return;
          if (k === 'picks') openPicks(false);
          else { show(k); window.scrollTo(0, 0); }
          if (!stale) parts.helper.ask();
        });
        return b;
      }));
      if (had) nav.querySelector('[aria-current]').focus();
    }

    function drawAll() {
      if (!game || !parts) return;
      const { helper, home, people, picksPane, livePane } = parts;
      if (pickingOn() && !panel) {
        panel = createGuestPanel(panelCtx);
        picksPane.appendChild(el('div', 'card player-card')).appendChild(panel.root);
      }
      // The tab on screen may be gone: picking closed or locked, or a job was taken away.
      if (!tabs().some(t => t[0] === tab)) {
        if (tab === 'picks') {
          const mine = SBS.playerHome.squaresOf(game, me());
          closedNote = `Picking just closed. ${mine.length ? `You have ${mine.length} square${mine.length === 1 ? '' : 's'}.` : 'You have no squares.'}`;
        }
        tab = 'home';
      }

      const welcome = helper.welcoming();
      const on = (k) => !welcome && tab === k;
      helper.welcomePane.hidden = !welcome;
      home.el.hidden = !on('home');
      picksPane.hidden = !on('picks');
      livePane.hidden = !on('live');
      people.el.hidden = !on('players');
      helper.scorePane.hidden = !on('score');
      parts.nav.hidden = welcome;
      drawHeader();
      if (welcome) helper.drawWelcome(); else drawNav();
      home.update();
      if (panel && pickingOn()) panel.render();
      livePane.replaceChildren(...(locked() ? SBS.playerHome.liveCards(game, me()) : []));
      parts.wins.el.hidden = welcome;
      if (!welcome) parts.wins.update(game, me(), tab, !stale);
      keepCopy();
      if (on('players')) people.update(); else people.close();
      if (on('score')) helper.drawScore();
      // Said once Home is on screen, so keyboard focus can follow it there.
      if (closedNote) { home.say(closedNote); home.focusNote(); closedNote = ''; window.scrollTo(0, 0); }
    }

    // The name this phone shows on a given copy of the board (the full-screen board asks too).
    function shownName(g) {
      const on = (name) => !!name && g.squares.some(s => s && s.name === name);
      if (on(chosen)) return chosen;
      return on(picked) && g.players && g.players[picked] && g.players[picked].g ? picked : null;
    }

    // The copy's age is what "Updated N ago" shows next time, so it is refreshed each minute
    // even when nothing changed.
    function keepCopy() {
      if (stale || !game) return;
      const next = `${Math.floor(fetchedAt / 60000)} ${SBS.boardKey(game)}`;
      if (next === saved) return;
      saved = next;
      writeCopy(id, game, fetchedAt || Date.now());
    }

    const busy = () => !!parts && (parts.helper.busy() || parts.people.busy());

    // The first board from the server, whether or not the phone's copy drew first.
    function arrived(fresh) {
      game = fresh;
      stale = false;
      if (!parts) build();
      parts.home.fetched();
      drawAll();
      if (route && route.focus === 'board') { delete route.focus; parts.home.focusBoard(); }
      parts.helper.ask();
      // A phone that picked before asks who it is. Its name may have changed since (a host
      // rename), so the server is asked, not the remembered name trusted.
      if (isPicker(id) && panel && pickingOn()) panel.start(true);
    }

    async function load(initial, now) {
      // A score on its way must not be overwritten by an answer from before it.
      if (busy()) return;
      try {
        // A phone that picks must see its own squares after a reload, not a copy from before them.
        const first = !parts || stale;
        const fresh = now || (first && isPicker(id)) ? await SBS.api.getGame(id) : await SBS.api.pollGame(id, { must: first });
        if (busy()) return;
        if (!fresh) { if (parts && !stale) parts.home.fetched(); return; }
        fetchedAt = Date.now();
        if (first) return arrived(fresh);
        parts.home.fetched();
        keepCopy();
        if (!game || SBS.boardKey(fresh) !== SBS.boardKey(game)) {
          const saved = !game || fresh.updatedAt !== game.updatedAt;
          game = fresh;
          drawAll();
          if (saved) {
            if (panel) panel.followName();
            parts.helper.saved();
            parts.people.clearUndo();
          }
        }
      } catch (e) {
        if (e && e.status === 404) {
          dropCopy(id);
          header.innerHTML = '<div class="error-msg">This game no longer exists.</div>';
          while (header.nextSibling) header.nextSibling.remove();
          parts = null;
          game = null;
          return;
        }
        // With a copy on screen, its age says it is old and the poll keeps trying.
        if (initial && !parts) header.innerHTML = `<div class="error-msg">Could not load this game: ${escapeHtml(e.message)}</div>`;
      }
    }

    // Paint the phone's copy at once, then ask the server.
    const copy = readCopy(id);
    if (copy) {
      game = copy.game;
      stale = true;
      build();
      parts.home.fetched(copy.at);
      drawAll();
      if (route && route.focus === 'board') { delete route.focus; parts.home.focusBoard(); }
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
    // A helper at work stays in step with the host's screens. Whether the job still stands is
    // asked on load, when the phone is shown again, on a tab tap and after a refusal: never on a timer.
    SBS.setManagedInterval(() => {
      if (!parts || document.hidden || parts.helper.welcoming()) return;
      if ((tab === 'score' && parts.helper.can('canScore')) || (tab === 'players' && parts.helper.can('canSquares'))) load(false);
    }, 5000);
    // The countdown and "Updated N s ago", from what is already here: no request.
    SBS.setManagedInterval(() => { if (parts && tab === 'home' && !document.hidden) parts.home.tick(); }, 1000);
    const onShow = () => {
      if (document.hidden || !parts || stale) return;
      drawAll(); // a win that arrived while the phone was away buzzes now
      if (parts.helper.maybe()) parts.helper.ask();
    };
    document.addEventListener('visibilitychange', onShow);
    SBS.onLeaveScreen(() => document.removeEventListener('visibilitychange', onShow));
  }

  // The host's QR window for the guest view, opened by View QR in Connect, with Print for the
  // sign below. Guests pass the link on with showInvite.
  // `code` (R22): when the board has a join code, the QR and link use the short
  // /<code> form, the same link the host shares and the TV shows.
  // It sits above the Connect layer, which leaves the keyboard alone while a .qr-layer is open.
  // `opener` gets the focus back on close.
  function showPlayerLink(id, code, game, opener) {
    const overlay = SBS.ui.overlayEl('0.65');
    overlay.classList.add('qr-layer');
    const box = el('div', 'card');
    box.style.cssText = 'max-width:520px; width:100%; box-shadow: var(--shadow-pop);';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'qr-title');
    box.innerHTML = `<h3 id="qr-title" style="margin-top:0">Scan to view your squares</h3>
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
      close();
      window.open(`${location.origin}${location.pathname}#player-${id}`, '_blank');
    });
    const print = el('button', 'secondary qr-print', `${SBS.ui.PRINT_ICON}<span>Print</span>`);
    print.type = 'button';
    print.addEventListener('click', () => printSign(game));
    const done = el('button', '', 'Done');
    done.addEventListener('click', () => close());
    actions.appendChild(done);
    actions.appendChild(print);
    actions.appendChild(openHere);
    box.appendChild(actions);

    function close() {
      if (!overlay.parentNode) return;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (opener && document.body.contains(opener)) opener.focus();
    }
    // Escape closes; Tab stays inside the window.
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll('button'));
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    SBS.onLeaveScreen(close);
    done.focus();
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
