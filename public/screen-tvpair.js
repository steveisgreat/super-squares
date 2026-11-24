// TV pairing (R23). Two halves of one feature:
//   * the /tv screen a television shows: a big code, polled until a host pairs it, then
//     the read-only TV view. It holds a random token in its own storage and nothing else:
//     no session, no cookie, nothing a write route accepts.
//   * the host's "What's in the room?" chooser on Game Day, where the code is typed.
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
      <p class="tvp-steps">On your phone, open your locked board, tap <strong>In the room</strong>, choose <strong>Show on a TV</strong> and enter</p>
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

  // ---------- Host: "What's in the room?" ----------
  let openChooser = null;
  // The board this host's TVs were last moved to from this tab, so returning to an
  // earlier board moves them back (a Set would skip it).
  let lastFollowed = null;

  function seenKey(id) { return `sbs.room.${id}`; }

  function open(game, opener, opts) {
    if (openChooser) return;
    const overlay = SBS.ui.overlayEl();
    const box = el('div', 'card room-card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'room-title');
    const tvUrl = `${location.origin}/tv`;
    box.innerHTML = `
      <h3 id="room-title" class="room-title">What's in the room?</h3>
      <section class="room-opt" aria-labelledby="room-tv-h">
        <h4 id="room-tv-h">Show on a TV</h4>
        <p>On the TV, open <strong class="room-url">${escapeHtml(tvUrl)}</strong> and type the code it shows.</p>
        <form class="room-pair" id="room-form" novalidate>
          <label for="room-code" class="room-label">TV code</label>
          <div class="room-row">
            <input id="room-code" class="room-code" type="text" maxlength="6" size="8" autocomplete="off"
              autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="go">
            <button type="submit" id="room-pair">Pair</button>
          </div>
        </form>
        <p class="room-status" id="room-status" role="status" aria-live="polite"></p>
      </section>
      <section class="room-opt room-present" aria-labelledby="room-present-h" hidden>
        <h4 id="room-present-h">Present on an HDMI TV</h4>
      </section>
      <section class="room-opt" aria-labelledby="room-score-h">
        <h4 id="room-score-h">Score from another phone</h4>
        <p>Hand score entry for this board to one phone. It scans a code; no sign-in.</p>
        <div class="room-row"><button type="button" id="room-score">Show the scoring code</button></div>
      </section>
      <section class="room-opt" aria-labelledby="room-invite-h">
        <h4 id="room-invite-h">Invite players</h4>
        <p>Players join with code <strong class="room-url">${escapeHtml(game.joinCode || '')}</strong> at ${escapeHtml(location.origin)}.</p>
        <div class="room-row"></div>
      </section>
      <div class="actions"><button type="button" class="secondary" id="room-close">Close</button></div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // On a laptop with a mouse: show the board on a TV plugged in by HDMI (R25 part b).
    let presentView = null;
    const presentSection = box.querySelector('.room-present');
    if (SBS.present && SBS.present.eligible()) {
      presentView = SBS.present.view(game.id, { idle: 'Open the TV view in its own window, on the second screen when this browser can find one. This screen stays your console.' });
      presentSection.appendChild(presentView.el);
      presentSection.hidden = false;
    }

    const form = box.querySelector('#room-form');
    const input = box.querySelector('#room-code');
    const status = box.querySelector('#room-status');
    const pairBtn = box.querySelector('#room-pair');

    box.querySelector('#room-score').addEventListener('click', () => {
      close();
      SBS.handoff.open(game, opener);
    });

    const inviteRow = box.querySelector('.room-opt:last-of-type .room-row');
    if (game.joinCode) {
      const share = el('button', '', 'Share join link');
      share.type = 'button';
      share.addEventListener('click', () => SBS.playerView.shareBoard(game));
      const qr = el('button', 'secondary', 'Show QR code');
      qr.type = 'button';
      qr.addEventListener('click', () => SBS.playerView.showPlayerLink(game.id, game.joinCode, game));
      inviteRow.appendChild(share);
      inviteRow.appendChild(qr);
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (presentView) presentView.destroy();
      overlay.remove();
      openChooser = null;
      if (opener && opener.focus) opener.focus();
    }
    // Escape closes; Tab stays inside the box.
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    openChooser = close;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    box.querySelector('#room-close').addEventListener('click', close);

    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try { input.setSelectionRange(pos, pos); } catch (e) { /* not needed */ }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim().toUpperCase();
      status.className = 'room-status';
      if (code.length !== 6) {
        status.textContent = 'The code has six letters and numbers. Look at the TV.';
        status.classList.add('room-error');
        input.focus();
        return;
      }
      pairBtn.disabled = true;
      status.textContent = 'Pairing…';
      try {
        await SBS.api.pairTv(code, game.id);
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
    if (opts && opts.auto && SBS.ui.isPhone()) box.querySelector('#room-close').focus();
    else input.focus();
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
