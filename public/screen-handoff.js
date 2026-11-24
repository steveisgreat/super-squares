// Scorer-phone hand-off (R24, decision 018). Two halves:
//   * the host's dialog: a one-time QR code that lets one phone enter scores on this board;
//   * the page that code opens on the phone (#handoff-<token>), which spends it on a tap.
// The phone gets score entry on one board for 24 hours. It is never signed in as the host.
(function () {
  'use strict';

  const SBS = window.SBS;
  const { el, escapeHtml } = SBS.ui;

  // Only while the code is on screen: at most 5 minutes, then it stops.
  const POLL_MS = 4000;

  const phones = (n) => (n === 1 ? '1 phone' : `${n} phones`);

  // ---------- Remembering that this phone is a scorer ----------
  // The cookie can't be read from here. This only decides what to say once it has ended.
  const seenKey = (id) => `sbs.scorer.${id}`;
  SBS.scorerPhone = {
    remember(id) { try { window.localStorage.setItem(seenKey(id), '1'); } catch (e) { /* only wording */ } },
    was(id) { try { return !!window.localStorage.getItem(seenKey(id)); } catch (e) { return false; } },
    forget(id) { try { window.localStorage.removeItem(seenKey(id)); } catch (e) { /* only wording */ } }
  };

  // ---------- Host: the QR dialog ----------
  let openDialog = null;

  function open(game, opener) {
    if (openDialog) return;
    const overlay = SBS.ui.overlayEl('0.65');
    const box = el('div', 'card handoff-card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'handoff-title');
    box.innerHTML = `
      <h3 id="handoff-title" class="room-title">Score from another phone</h3>
      <p class="handoff-text">Point the other phone's camera at the code and tap <strong>Start scoring</strong>. That phone can enter scores on this board for 24 hours, and nothing else.</p>
      <div class="handoff-qr" id="handoff-qr"></div>
      <p class="room-status" id="handoff-status" role="status" aria-live="polite"></p>
      <p class="handoff-text" id="handoff-count"></p>
      <div class="actions">
        <button type="button" id="handoff-close">Done</button>
        <button type="button" class="secondary" id="handoff-new" hidden>New code</button>
        <button type="button" class="secondary" id="handoff-remove" hidden>Remove scorer phones</button>
        <button type="button" class="secondary" id="handoff-here">Score on this device</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const qrBox = box.querySelector('#handoff-qr');
    const status = box.querySelector('#handoff-status');
    const count = box.querySelector('#handoff-count');
    const newBtn = box.querySelector('#handoff-new');
    const removeBtn = box.querySelector('#handoff-remove');
    const closeBtn = box.querySelector('#handoff-close');
    let timer = null;
    let round = 0; // a slow answer about an earlier code is ignored

    const stopPolling = () => { clearInterval(timer); timer = null; };
    const say = (text, isError) => {
      status.textContent = text;
      status.classList.toggle('room-error', !!isError);
    };
    function showCount(n) {
      count.textContent = n ? `${phones(n)} can score this board now.` : '';
      removeBtn.hidden = !n;
    }
    function dropCode() {
      stopPolling();
      qrBox.innerHTML = '';
      newBtn.hidden = false;
    }

    async function newCode() {
      const mine = ++round;
      stopPolling();
      newBtn.hidden = true;
      qrBox.innerHTML = '';
      say('Getting a code…');
      let made;
      try {
        made = await SBS.api.createHandoff(game.id);
      } catch (e) {
        if (mine !== round || !box.isConnected) return;
        say(e.message, true);
        newBtn.hidden = false;
        // Full, most likely: show how many so they can be removed.
        try { showCount((await SBS.api.getHandoff(game.id)).scorers); } catch (e2) { /* the message stands */ }
        return;
      }
      if (mine !== round || !box.isConnected) return;
      const before = made.scorers;
      const endsAt = Date.now() + made.expiresInSeconds * 1000;
      try {
        qrBox.innerHTML = window.QRCode.toSvg(`${location.origin}/#handoff-${made.token}`, 220);
        qrBox.firstElementChild.setAttribute('aria-label', 'Scoring code'); // not the link: it is a key
      } catch (e) {
        console.error('QR encode failed', e);
        dropCode();
        say('The code could not be drawn.', true);
        return;
      }
      showCount(before);
      say('Works once, for 5 minutes. Waiting for the phone…');

      let busy = false;
      timer = setInterval(async () => {
        if (!box.isConnected) return stopPolling();
        if (busy) return;
        const over = Date.now() >= endsAt;
        busy = true;
        try {
          const now = await SBS.api.getHandoff(game.id, { prompt: false });
          if (mine !== round || !box.isConnected) return;
          if (now.scorers > before) {
            dropCode();
            showCount(now.scorers);
            say('Phone connected.');
          } else if (over || !now.waiting) {
            dropCode();
            showCount(now.scorers);
            say(over ? 'That code has expired.' : 'That code no longer works. Another device may have made a newer one.');
          }
        } catch (e) {
          // Keep trying until the code is too old to matter.
          if (over && mine === round) { dropCode(); say('That code has expired.'); }
        } finally {
          busy = false;
        }
      }, POLL_MS);
    }

    function close() {
      round++;
      stopPolling();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      openDialog = null;
      if (opener && opener.focus) opener.focus();
    }
    // Escape closes; Tab stays inside the box. A confirm on top of this one keeps its own keys.
    function onKey(e) {
      const top = document.body.lastElementChild;
      if (top !== overlay && top && top.contains(document.activeElement)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll('button')).filter(n => !n.disabled && !n.hidden);
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    openDialog = close;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    closeBtn.addEventListener('click', close);
    newBtn.addEventListener('click', () => { closeBtn.focus(); newCode(); });
    box.querySelector('#handoff-here').addEventListener('click', () => {
      close();
      window.open(`${location.origin}${location.pathname}#score-${game.id}`, '_blank');
    });
    removeBtn.addEventListener('click', async () => {
      if (!(await SBS.ui.showConfirm('Stop every other phone from scoring this board? You can hand it off again with a new code.'))) return;
      try {
        await SBS.api.removeScorers(game.id);
      } catch (e) {
        if (box.isConnected) say(e.message, true);
        return;
      }
      round++;
      if (!box.isConnected) return;
      closeBtn.focus();
      dropCode();
      showCount(0);
      say('Scorer phones removed.');
    });

    closeBtn.focus();
    newCode();
  }

  SBS.handoff = { open };

  // ---------- Phone: the page the code opens ----------
  // Draws with no network call, so a link preview can't spend the code. The token leaves the
  // address bar at once and lives only in this closure.
  SBS.screens.handoff = function (token) {
    const app = SBS.appEl;
    app.innerHTML = '';
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* address bar left as is */ }
    const main = el('main', 'main');
    const card = el('div', 'card handoff-card');
    main.appendChild(card);
    main.appendChild(SBS.ui.legalLinks());
    app.appendChild(main);
    const stale = () => !card.isConnected || SBS.currentScreen() !== 'handoff';

    function show(heading, text, button, isError) {
      card.innerHTML = `<h2 class="room-title">${escapeHtml(heading)}</h2>
        <p class="${isError ? 'error-msg' : 'handoff-text'}"${isError ? ' role="alert"' : ''}>${escapeHtml(text)}</p>`;
      if (!button) return;
      const actions = el('div', 'actions');
      actions.appendChild(button);
      card.appendChild(actions);
      button.focus();
    }

    function ready(errorText) {
      const btn = el('button', '', 'Start scoring');
      btn.type = 'button';
      show('Score this game', errorText || 'The host is handing you score entry for one board. It lasts 24 hours on this phone. No account is needed.', btn, !!errorText);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        let r;
        try {
          r = await SBS.api.useHandoff(token);
        } catch (e) {
          if (stale()) return;
          if (e.status === 401) show('That code does not work', e.message, null, true);
          else ready(e.message); // offline or a server error: the code may still be good
          return;
        }
        SBS.scorerPhone.remember(r.gameId);
        if (stale()) return;
        // So a reload comes back to scoring. The id is public; the cookie is what counts.
        try { history.replaceState(null, '', `${location.pathname}#score-${r.gameId}`); } catch (e) { /* no reload */ }
        SBS.go({ screen: 'phone', id: r.gameId });
      });
    }

    if (token) ready();
    else show('That code does not work', 'Scan the code on the host\'s screen again.', null, true);
  };
})();
