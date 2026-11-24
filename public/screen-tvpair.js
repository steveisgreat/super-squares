// TV pairing (R23). Two halves of one feature:
//   * the /tv screen a television shows: a big code, polled until a host pairs it, then
//     the read-only TV view. It holds a random token in its own storage and nothing else:
//     no session, no cookie, nothing a write route accepts.
//   * the host's Connect box on Game Day (was "What's in the room?"), where the code is typed.
(function () {
  'use strict';

  const SBS = window.SBS;
  const { el, escapeHtml } = SBS.ui;

  // Same cadence as the TV view's own board poll.
  const POLL_MS = 4000;
  const TOKEN_KEY = 'sbs.tv.token';

  // ---------- The TV's token (localStorage, memory if a TV browser blocks it) ----------
  let memoryToken = null;
  SBS.tvToken = {
    get() {
      try { return window.localStorage.getItem(TOKEN_KEY) || memoryToken; } catch (e) { return memoryToken; }
    },
    set(token) {
      memoryToken = token;
      try { window.localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* kept in memory */ }
    },
    clear() {
      memoryToken = null;
      try { window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* nothing to clear */ }
    }
  };

  // ---------- /tv: the pairing screen ----------
  function renderTvPair() {
    const app = SBS.appEl;
    app.innerHTML = '';
    document.body.classList.add('tv-mode');
    SBS.onLeaveScreen(() => document.body.classList.remove('tv-mode'));

    const screenEl = el('main', 'tvp-screen');
    screenEl.innerHTML = `
      <h1 class="tvp-title">Pair this TV</h1>
      <p class="tvp-steps">On your phone, open your locked board, tap <strong>Connect</strong>, find <strong>Show on a smart TV</strong> and enter</p>
      <div class="tvp-code" id="tvp-code" aria-live="polite">······</div>
      <p class="tvp-status" id="tvp-status" role="status">Getting a code…</p>
      <button type="button" class="tvp-unpair" id="tvp-unpair">Unpair</button>`;
    app.appendChild(screenEl);
    const codeEl = screenEl.querySelector('#tvp-code');
    const statusEl = screenEl.querySelector('#tvp-status');
    let busy = false;
    let closed = false;
    SBS.onLeaveScreen(() => { closed = true; });

    function showCode(code) {
      codeEl.textContent = code;
      codeEl.setAttribute('aria-label', `Code ${code.split('').join(' ')}`);
      statusEl.textContent = 'Waiting for the host to pair this TV…';
    }

    async function startNew() {
      const r = await SBS.api.createTv();
      SBS.tvToken.set(r.token);
      showCode(r.code);
    }

    // One step of the loop: look at the stored token, or get a new one.
    async function step() {
      if (busy || closed) return;
      busy = true;
      try {
        const token = SBS.tvToken.get();
        if (!token) {
          await startNew();
        } else {
          let r;
          try {
            r = await SBS.api.getTv(token);
          } catch (e) {
            if (e.status !== 404) throw e;
            // Unknown or expired: forget it and ask for a fresh code.
            SBS.tvToken.clear();
            if (!closed) await startNew();
            return;
          }
          if (closed) return;
          if (r.state === 'paired') {
            SBS.go({ screen: 'tv', id: r.gameId, paired: true });
            return;
          }
          showCode(r.code);
        }
      } catch (e) {
        if (!closed) statusEl.textContent = e && e.status === 503 ? e.message : 'Cannot reach the server. Trying again…';
      } finally {
        busy = false;
      }
    }

    screenEl.querySelector('#tvp-unpair').addEventListener('click', () => {
      SBS.tvToken.clear();
      codeEl.textContent = '······';
      statusEl.textContent = 'Getting a code…';
      step();
    });

    step();
    SBS.setManagedInterval(step, POLL_MS);
  }

  // ---------- Host: Connect (was "What's in the room?") ----------
  // One box with three sections: Players (code, link, QR, print), TV (smart TV pairing, Present on
  // an HDMI TV, Mirror this phone) and Scoring (hand score entry to another phone). A bottom sheet on
  // a phone, a popover under the Connect button on a wide screen. Party View is its own top-bar
  // button, so there is no "open it here" row.
  let openChooser = null;
  // The board this host's TVs were last moved to from this tab, so returning to an
  // earlier board moves them back (a Set would skip it).
  let lastFollowed = null;

  function seenKey(id) { return `sbs.room.${id}`; }

  function open(game, opener, opts) {
    if (openChooser) return;
    const phone = SBS.ui.isPhone();
    const { CLOSE_ICON, PRINT_ICON } = SBS.ui;
    const overlay = el('div', 'connect-layer ' + (phone ? 'connect-layer-sheet' : 'connect-layer-pop'));
    const box = el('div', 'card room-card connect-card ' + (phone ? 'connect-sheet' : 'connect-pop'));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'room-title');
    const tvUrl = `${location.origin}/tv`;
    const code = game.joinCode || '';
    const shortUrl = game.joinCode ? `${location.host}/${game.joinCode}` : '';
    box.innerHTML = `
      ${phone ? '<div class="connect-grab" aria-hidden="true"></div>' : ''}
      <div class="connect-head">
        <h3 id="room-title" class="room-title">Connect</h3>
        <button type="button" class="icon-btn connect-x" id="room-close" aria-label="Close">${CLOSE_ICON}</button>
      </div>
      <section class="room-opt connect-players" aria-labelledby="room-players-h">
        <h4 id="room-players-h">Players</h4>
        ${code ? `<div class="connect-code-row">
          <div><div class="connect-label">Join code</div>
          <div class="connect-code" aria-label="Join code ${escapeHtml(code.split('').join(' '))}">${escapeHtml(code)}</div></div>
          <div class="connect-url">${escapeHtml(shortUrl)}</div></div>` : ''}
        <div class="room-row connect-players-row"></div>
        <p class="room-status connect-note" id="room-link-note" role="status" aria-live="polite"></p>
        <p>Players open the link or scan the code to see their squares.</p>
      </section>
      <section class="room-opt" aria-labelledby="room-tv-h">
        <h4 id="room-tv-h">TV</h4>
        <p><strong>Show on a smart TV.</strong> On the TV, open <strong class="room-url">${escapeHtml(tvUrl)}</strong> and type the code it shows.</p>
        <form class="room-pair" id="room-form" novalidate>
          <label for="room-code" class="room-label">TV code</label>
          <div class="room-row">
            <input id="room-code" class="room-code" type="text" maxlength="6" size="8" autocomplete="off"
              autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="go">
            <button type="submit" id="room-pair">Pair</button>
          </div>
        </form>
        <p class="room-status" id="room-status" role="status" aria-live="polite"></p>
        <div class="room-present" aria-label="Present on an HDMI TV" hidden></div>
        <div class="room-mirror" aria-labelledby="room-mirror-h" hidden>
          <h5 id="room-mirror-h">Mirror this phone</h5>
          <p>AirPlay or Cast, then opens Party View.</p>
          <p class="room-mirror-note" id="room-mirror-note" hidden>It opens once the numbers are drawn.</p>
          <div class="room-row"><button type="button" id="room-mirror">Mirror this phone</button></div>
        </div>
      </section>
      <section class="room-opt" aria-labelledby="room-score-h">
        <h4 id="room-score-h">Scoring</h4>
        <p><strong>Score from another phone.</strong> Hand score entry for this board to one phone. It scans a code; no sign-in.</p>
        <div class="room-row"><button type="button" id="room-score">Show the scoring code</button></div>
      </section>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Where the popover sits: right-aligned under the Connect button.
    function place() {
      if (phone) return;
      const r = opener && opener.getBoundingClientRect ? opener.getBoundingClientRect() : null;
      const top = r ? Math.round(r.bottom + 8) : 72;
      box.style.top = top + 'px';
      box.style.right = (r ? Math.max(8, Math.round(window.innerWidth - r.right)) : 20) + 'px';
      box.style.maxHeight = `calc(100vh - ${top + 12}px)`;
    }
    place();
    window.addEventListener('resize', place);

    // Players: Share link on a phone (the share sheet), Copy link on a wide screen, Show QR on a phone, Print.
    const linkNote = box.querySelector('#room-link-note');
    const playersRow = box.querySelector('.connect-players-row');
    if (game.joinCode) {
      const link = el('button', '', phone ? 'Share link' : 'Copy link');
      link.type = 'button';
      link.addEventListener('click', () => {
        if (phone) SBS.playerView.shareBoard(game, linkNote);
        else SBS.playerView.copyJoinLink(game, linkNote);
      });
      playersRow.appendChild(link);
      if (phone) {
        const qr = el('button', 'secondary', 'Show QR');
        qr.type = 'button';
        qr.addEventListener('click', () => SBS.playerView.showPlayerLink(game.id, game.joinCode, game));
        playersRow.appendChild(qr);
      }
      const print = el('button', 'secondary connect-print', `${PRINT_ICON}<span>Print</span>`);
      print.type = 'button';
      print.addEventListener('click', () => SBS.playerView.printSign(game));
      playersRow.appendChild(print);
    }

    // On a laptop with a mouse: show the board on a TV plugged in by HDMI (R25 part b).
    let presentView = null;
    const presentSection = box.querySelector('.room-present');
    if (SBS.present && SBS.present.eligible()) {
      presentView = SBS.present.view(game.id, { idle: 'Open Party View in its own window, on the second screen when this browser can find one. This screen stays your console.' });
      presentSection.appendChild(presentView.el);
      presentSection.hidden = false;
    }

    // On a phone with no second device: the screen mirrored to the TV (R26). Wide screens have Present.
    if (phone) {
      const mirrorSection = box.querySelector('.room-mirror');
      const mirrorBtn = box.querySelector('#room-mirror');
      mirrorSection.hidden = false;
      if (game.status === 'started' || game.status === 'finished') {
        mirrorBtn.addEventListener('click', () => {
          close(true);
          SBS.go({ screen: 'mirror', id: game.id, from: 'board' });
        });
      } else {
        mirrorBtn.disabled = true;
        box.querySelector('#room-mirror-note').hidden = false;
      }
    }

    const form = box.querySelector('#room-form');
    const input = box.querySelector('#room-code');
    const status = box.querySelector('#room-status');
    const pairBtn = box.querySelector('#room-pair');

    box.querySelector('#room-score').addEventListener('click', () => {
      close();
      SBS.handoff.open(game, opener);
    });

    // `leaving` skips returning focus to the opener when the screen is about to change.
    function close(leaving) {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      if (presentView) presentView.destroy();
      overlay.remove();
      openChooser = null;
      if (leaving !== true && opener && opener.focus) opener.focus();
    }
    // Escape closes; Tab stays inside the box.
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled && !n.closest('[hidden]'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    openChooser = close;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    box.querySelector('#room-close').addEventListener('click', () => close());

    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try { input.setSelectionRange(pos, pos); } catch (e) { /* not needed */ }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tvCode = input.value.trim().toUpperCase();
      status.className = 'room-status';
      if (tvCode.length !== 6) {
        status.textContent = 'The code has six letters and numbers. Look at the TV.';
        status.classList.add('room-error');
        input.focus();
        return;
      }
      pairBtn.disabled = true;
      status.textContent = 'Pairing…';
      try {
        await SBS.api.pairTv(tvCode, game.id);
        // Every TV of this host shows the board that is open, so say how many that is.
        let count = 1;
        try { count = (await SBS.api.followTv(game.id)).count || 1; } catch (err) { /* the pair itself worked */ }
        lastFollowed = game.id;
        status.textContent = `TV paired. ${count} ${count === 1 ? 'TV follows' : 'TVs follow'} this board.`;
        input.value = '';
      } catch (err) {
        status.textContent = err.status === 404
          ? 'That code is not waiting. It may have expired, or it was typed wrong. Check the TV for the code on screen.'
          : err.message;
        status.classList.add('room-error');
        input.focus();
      } finally {
        pairBtn.disabled = false;
      }
    });

    // Opened by itself on a phone: don't raise the keyboard over the choices.
    const firstBtn = playersRow.querySelector('button');
    if (opts && opts.auto && phone) box.querySelector('#room-close').focus();
    else if (firstBtn) firstBtn.focus();
    else box.querySelector('#room-close').focus();
  }

  // Called by Game Day when it renders. Once a board is live (locked, not finished): the
  // host's paired TVs move to it (silent for anyone who is not its owner), and the chooser
  // opens one time per board. A finished board never pulls TVs off a live game.
  function onGameDay(game, opener) {
    if (game.status !== 'started') return;
    if (lastFollowed !== game.id) {
      lastFollowed = game.id;
      SBS.api.followTv(game.id, { prompt: false }).catch(() => { /* not the owner, or signed out */ });
    }
    let seen = true;
    try { seen = !!window.localStorage.getItem(seenKey(game.id)); } catch (e) { seen = true; }
    if (seen) return;
    try { window.localStorage.setItem(seenKey(game.id), '1'); } catch (e) { return; }
    open(game, opener, { auto: true });
  }

  SBS.deviceChooser = { open, onGameDay };
  SBS.screens.tvPair = renderTvPair;
})();
