// Helpers (R37, decision 025). Three pieces:
//   * the host's Helpers panel: who helps on this board, their jobs, and the one-time code or link
//     that connects one phone (a dialog from Connect and Home, a tab on wide Game Day);
//   * the page that code opens on the phone (#helper-<token>), which spends it on a tap;
//   * where an old #score-<id> link goes.
// What a helper does is in Player View (screen-player.js). A helper is never signed in as the host.
(function () {
  'use strict';

  const SBS = window.SBS;
  const { el, textEl, escapeHtml, showConfirm, isPhone, CLOSE_ICON } = SBS.ui;

  // Tabler "user-plus", "chevron-left" and "message" (MIT, 24 px outline).
  const svg = (paths) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const USER_PLUS_ICON = svg('<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M16 19h6"/><path d="M19 16v6"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4"/>');
  const BACK_ICON = svg('<path d="M15 6l-6 6l6 6"/>');
  const MESSAGE_ICON = svg('<path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/>');

  // Only while a QR code is on screen: at most 5 minutes, then it stops.
  const POLL_MS = 4000;
  const NAME_MAX = 10;

  // The jobs on offer. Each is a tab in Player View.
  const JOBS = [
    { key: 'canScore', label: 'Keep score', words: 'keep score', text: 'Tap scores, end quarters, fix mistakes.' },
    { key: 'canSquares', label: 'Manage squares', words: 'manage squares', text: 'Add squares, mark who has paid, remove unpaid squares before the board locks.' }
  ];

  // ---------- Remembering that this phone is a helper ----------
  // The cookie can't be read from here. This only decides whether Player View asks the server
  // which jobs this phone holds: 'new' until the helper has said whose squares are theirs, then 'ok'.
  const seenKey = (id) => `sbs.helper.${String(id).toLowerCase()}`;
  const phone = {
    get(id) { try { return window.localStorage.getItem(seenKey(id)); } catch (e) { return null; } },
    set(id, value) { try { window.localStorage.setItem(seenKey(id), value); } catch (e) { /* asks again next time */ } },
    forget(id) { try { window.localStorage.removeItem(seenKey(id)); } catch (e) { /* asks again next time */ } }
  };

  const button = (cls, html, onClick) => {
    const b = el('button', cls, html);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // ---------- Host: the panel ----------
  // opts: { setHead(title, onBack | null), onDone? }. Returns { el, show, stop }.
  function createPanel(game, opts) {
    const root = el('div', 'helpers-panel');
    let helpers = [];
    let timer = null;
    let round = 0; // a slow answer about an earlier view is ignored

    const stop = () => { round++; clearInterval(timer); timer = null; };
    const live = (mine) => mine === round && root.isConnected;

    function statusLine() {
      const p = el('p', 'helpers-status');
      p.setAttribute('role', 'status');
      p.setAttribute('aria-live', 'polite');
      return Object.assign(p, { say(text, kind) { p.textContent = text || ''; p.className = 'helpers-status' + (kind ? ` is-${kind}` : ''); } });
    }

    // ----- the list -----
    const focusAdd = () => { const b = root.querySelector('.helpers-add'); if (b) b.focus(); };

    async function showList(back) {
      stop();
      const mine = round;
      opts.setHead('Helpers', null);
      const status = statusLine();
      root.replaceChildren(textEl('p', 'helpers-text', "Give someone a job on this board. They keep their own squares and don't need an account."), status);
      status.say('Loading…');
      try {
        helpers = (await SBS.api.getHelpers(game.id)).helpers;
      } catch (e) {
        if (live(mine)) status.say(e.message, 'error');
        return;
      }
      if (!live(mine)) return;
      drawList();
      if (back === true) focusAdd();
    }

    function drawList(message, kind) {
      const status = statusLine();
      const list = el('div', 'helpers-list');
      helpers.forEach(h => list.appendChild(helperCard(h, status)));
      const add = button('helpers-add', `${USER_PLUS_ICON}<span>Add a helper</span>`, () => showAdd());
      root.replaceChildren(
        textEl('p', 'helpers-text', "Give someone a job on this board. They keep their own squares and don't need an account."),
        list, status, add);
      status.say(message, kind);
    }

    function helperCard(h, status) {
      const card = el('section', 'helpers-item');
      card.setAttribute('aria-label', h.label);
      const head = el('div', 'helpers-item-head');
      const who = el('div', 'helpers-who');
      who.append(textEl('strong', '', h.label), textEl('span', h.connected ? 'is-on' : 'is-off',
        h.connected ? (h.waiting ? 'Phone connected, new code waiting' : 'Phone connected')
          : h.waiting ? 'Waiting for their phone' : 'Not connected'));
      const remove = button('helpers-link is-danger', 'Remove', async () => {
        if (!(await showConfirm(`Remove ${h.label}? Their phone stops helping on this board at once.`))) return;
        const mine = round;
        try {
          helpers = (await SBS.api.removeHelper(game.id, h.id)).helpers;
          if (live(mine)) { drawList(`${h.label} was removed.`); focusAdd(); }
        } catch (e) {
          if (live(mine)) status.say(e.message, 'error');
        }
      });
      remove.setAttribute('aria-label', `Remove ${h.label}`);
      head.append(who, remove);
      card.appendChild(head);

      JOBS.forEach(job => {
        const row = el('div', 'helpers-job');
        const sw = button('helpers-switch', '<span aria-hidden="true"></span>', async () => {
          const mine = round;
          const want = { canScore: h.canScore, canSquares: h.canSquares, [job.key]: !h[job.key] };
          sw.disabled = true;
          try {
            helpers = (await SBS.api.setHelperJobs(game.id, h.id, want)).helpers;
            if (!live(mine)) return;
            drawList();
            const again = root.querySelector(`[data-sw="${h.id}-${job.key}"]`);
            if (again) again.focus();
          } catch (e) {
            if (!live(mine)) return;
            sw.disabled = false;
            status.say(e.message, 'error');
          }
        });
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!!h[job.key]));
        sw.setAttribute('aria-label', `${h.label}: ${job.label}`);
        sw.dataset.sw = `${h.id}-${job.key}`;
        row.append(textEl('span', '', job.label), sw);
        card.appendChild(row);
      });

      const code = button('helpers-link', 'Show a new code', () => showCode(h, null));
      code.setAttribute('aria-label', `Show a new code for ${h.label}`);
      card.appendChild(code);
      return card;
    }

    // ----- add one -----
    function showAdd() {
      stop();
      opts.setHead('Add a helper', () => showList(true));
      const cut = (name) => Array.from(name).slice(0, NAME_MAX).join('').trim();
      const taken = helpers.map(h => h.label.toLowerCase());
      const names = SBS.players.playerSummaries(game).map(p => p.name).filter(n => !taken.includes(cut(n).toLowerCase()));
      // A name, or '' for someone else: a helper need not be playing, and may come before any player.
      let picked = names.length ? null : '';
      const jobs = { canScore: true, canSquares: false };
      const status = statusLine();

      const people = el('div', 'helpers-people');
      people.setAttribute('role', 'group');
      people.setAttribute('aria-label', 'Who is helping?');
      const chips = [...names, ''].map(name => {
        const chip = button('helpers-chip', escapeHtml(name || 'Someone else'), () => { picked = name; sync(); if (!name) other.focus(); });
        chip.setAttribute('aria-pressed', 'false');
        people.appendChild(chip);
        return { name, chip };
      });
      const otherRow = el('div', 'helpers-other');
      otherRow.innerHTML = '<label for="helpers-name">Their name</label>';
      const other = el('input', '');
      other.type = 'text';
      other.id = 'helpers-name';
      other.maxLength = NAME_MAX;
      other.autocomplete = 'off';
      other.setAttribute('autocapitalize', 'words');
      other.addEventListener('input', () => sync());
      otherRow.appendChild(other);

      const jobList = el('div', 'helpers-jobs');
      jobList.setAttribute('role', 'group');
      jobList.setAttribute('aria-label', 'What can they do?');
      JOBS.forEach(job => {
        const b = button('helpers-choice', `<span class="helpers-tick" aria-hidden="true"></span><span><strong>${escapeHtml(job.label)}</strong><br>${escapeHtml(job.text)}</span>`,
          () => { jobs[job.key] = !jobs[job.key]; sync(); });
        b.setAttribute('role', 'checkbox');
        b.dataset.job = job.key;
        jobList.appendChild(b);
      });

      const next = button('', '', async () => {
        const label = who();
        const mine = round;
        next.disabled = true;
        status.say('Getting a code…');
        try {
          const made = await SBS.api.addHelper(game.id, Object.assign({ label }, jobs));
          if (live(mine)) showCode(Object.assign({ id: made.id, label }, jobs), made);
        } catch (e) {
          if (!live(mine)) return;
          status.say(e.message, 'error');
          next.disabled = false;
        }
      });
      const who = () => (picked === null ? '' : picked ? cut(picked) : other.value.trim());
      function sync() {
        chips.forEach(c => c.chip.setAttribute('aria-pressed', String(c.name === picked)));
        otherRow.hidden = picked !== '';
        jobList.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(jobs[b.dataset.job])));
        const anyJob = JOBS.some(j => jobs[j.key]);
        next.disabled = !who() || !anyJob;
        next.textContent = picked === null ? 'Pick a person' : !who() ? 'Type their name' : anyJob ? `Show the code for ${who()}` : 'Pick a job';
      }
      root.replaceChildren(textEl('h4', '', 'Who is helping?'), people, otherRow, textEl('h4', '', 'What can they do?'), jobList,
        textEl('p', 'helpers-text', 'Only you can lock the board, change the pot or payouts, mark winners paid, add helpers or delete the board.'),
        status, next);
      sync();
      if (picked === null) chips[0].chip.focus(); else other.focus();
    }

    // ----- the code -----
    // `made` is a code just created with the helper; null asks for a new one.
    async function showCode(h, made) {
      stop();
      let mine = round;
      opts.setHead(`Code for ${h.label}`, () => showList(true));
      const status = statusLine();
      const title = textEl('h4', 'helpers-code-title', `Have ${h.label} point their phone camera here`);
      const qrBox = el('div', 'helpers-qr');
      const jobWords = JOBS.filter(j => h[j.key]).map(j => j.words).join(' and ');
      const text = textEl('p', 'helpers-text', jobWords ? `It lets one phone ${jobWords} on this board until the game is over.` : 'They have no job yet. Switch one on in the list.');
      const actions = el('div', 'helpers-actions');
      const again = button('secondary', 'New code', () => showCode(h, null));
      again.hidden = true;
      const textBtn = button('secondary helpers-text-btn', `${MESSAGE_ICON}<span>Text them a link instead</span>`, makeLink);
      const done = button('', 'Done', () => showList(true));
      actions.append(textBtn, again, done);
      root.replaceChildren(title, qrBox, status, text, actions);
      done.focus();

      function drop(words, kind) {
        clearInterval(timer);
        timer = null;
        qrBox.replaceChildren();
        title.hidden = true;
        again.hidden = false;
        status.say(words, kind);
      }
      const linkOf = (token) => `${location.origin}/#helper-${token}`;

      if (!made) {
        status.say('Getting a code…');
        try {
          made = await SBS.api.newHelperCode(game.id, h.id, false);
        } catch (e) {
          if (live(mine)) drop(e.message, 'error');
          return;
        }
        if (!live(mine)) return;
      }
      try {
        qrBox.innerHTML = window.QRCode.toSvg(linkOf(made.token), 220);
        qrBox.firstElementChild.setAttribute('aria-label', 'Code for the helper'); // not the link: it is a key
      } catch (e) {
        console.error('QR encode failed', e);
        drop('The code could not be drawn.', 'error');
        return;
      }
      status.say('Works once, for 5 minutes. Waiting for the phone…');
      watch(Date.now() + made.expiresInSeconds * 1000);

      // Looks for the scan. A spent code stops waiting; so does one replaced or removed elsewhere.
      // It stops a little early: the server's clock ended the code before this one notices, and an
      // already connected helper with an expired code looks like a fresh scan.
      function watch(codeEnds) {
        const endsAt = codeEnds - 3000;
        const ours = mine;
        let busy = false;
        timer = setInterval(async () => {
          if (!root.isConnected) return stop();
          if (busy) return;
          const over = Date.now() >= endsAt;
          busy = true;
          try {
            const list = (await SBS.api.getHelpers(game.id, { prompt: false })).helpers;
            if (!live(ours)) return;
            helpers = list;
            const now = list.find(x => x.id === h.id);
            if (!now) drop(`${h.label} was removed.`);
            else if (now.connected && !now.waiting && !over) { drop('Phone connected.', 'ok'); textBtn.hidden = true; }
            else if (over || !now.waiting) drop('That code no longer works.');
          } catch (e) {
            if (over && live(ours)) drop('That code no longer works.');
          } finally {
            busy = false;
          }
        }, POLL_MS);
      }

      async function makeLink() {
        stop();
        mine = round;
        textBtn.disabled = true;
        status.say('Getting a link…');
        let link;
        try {
          link = linkOf((await SBS.api.newHelperCode(game.id, h.id, true)).token);
        } catch (e) {
          if (live(mine)) { textBtn.disabled = false; drop(e.message, 'error'); }
          return;
        }
        if (!live(mine)) return;
        drop(`The link is ready. It works once, for 24 hours. Send it only to ${h.label}. To cancel it, remove ${h.label} from the list.`);
        again.hidden = true;
        textBtn.remove();
        done.className = 'secondary';
        const send = [];
        const words = `Help run our squares board: ${link}`;
        // "?&body=" is the one form both iPhone and Android read.
        if (isPhone()) send.push(button('', 'Text the link', () => { location.href = `sms:?&body=${encodeURIComponent(words)}`; }));
        if (navigator.share) send.push(button('secondary', 'Share the link', () => { navigator.share({ text: words }).catch(() => { /* closed the sheet */ }); }));
        send.push(button('secondary', 'Copy the link', async () => {
          try {
            await navigator.clipboard.writeText(link);
            status.say('Link copied.', 'ok');
          } catch (e) {
            status.say('This browser would not copy the link. Use the code instead.', 'error');
            again.hidden = false;
          }
        }));
        actions.prepend(...send);
        send[0].focus();
      }
    }

    return { el: root, show: () => showList(), stop };
  }

  // ---------- Host: the dialog (Connect, and Home's menu) ----------
  let openDialog = null;

  function open(game, opener) {
    if (openDialog) return;
    const overlay = SBS.ui.overlayEl('0.72');
    overlay.classList.add('helpers-overlay');
    const box = el('div', 'card helpers-card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'helpers-title');
    const head = el('div', 'helpers-head');
    const title = textEl('h3', '', 'Helpers');
    title.id = 'helpers-title';
    const back = button('icon-btn helpers-back', BACK_ICON, () => onBack && onBack());
    back.setAttribute('aria-label', 'Back to helpers');
    const closeBtn = button('icon-btn', CLOSE_ICON, () => close());
    closeBtn.setAttribute('aria-label', 'Close');
    let onBack = null;
    head.append(back, title, closeBtn);
    const panel = createPanel(game, {
      setHead(text, backTo) { title.textContent = text; onBack = backTo; back.hidden = !backTo; }
    });
    box.append(head, panel.el);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Escape closes; Tab stays inside the box. A confirm on top of this one keeps its own keys.
    function onKey(e) {
      const top = document.body.lastElementChild;
      if (top !== overlay && top && top.contains(document.activeElement)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled && n.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() {
      if (!openDialog) return;
      openDialog = null;
      panel.stop();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (opener && opener.isConnected && opener.focus) opener.focus();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    SBS.onLeaveScreen(close);
    openDialog = close;
    panel.show();
    closeBtn.focus();
  }

  // ---------- Host: the wide Game Day tab ----------
  function tab(game) {
    const root = el('div', 'helpers-tab');
    const head = el('div', 'helpers-head');
    const title = textEl('h3', '', '');
    let onBack = null;
    const back = button('icon-btn helpers-back', BACK_ICON, () => onBack && onBack());
    back.setAttribute('aria-label', 'Back to helpers');
    head.append(back, title);
    const panel = createPanel(game, {
      // The tab already says Helpers.
      setHead(text, backTo) { title.textContent = text; onBack = backTo; head.hidden = !backTo; }
    });
    root.append(head, panel.el);
    SBS.onLeaveScreen(panel.stop);
    return { el: root, show: panel.show, stop: panel.stop };
  }

  SBS.helpers = { open, tab, phone };

  // ---------- Phone: the page the code opens ----------
  // Draws with no network call, so a link preview can't spend the code. The token leaves the
  // address bar at once and lives only in this closure. `old` is a link from before R37.
  SBS.screens.helper = function (token, old) {
    const app = SBS.appEl;
    app.innerHTML = '';
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* address bar left as is */ }
    const main = el('main', 'main');
    const card = el('div', 'card helpers-card');
    main.append(card, SBS.ui.legalLinks());
    app.appendChild(main);
    const stale = () => !card.isConnected || SBS.currentScreen() !== 'helper';

    function show(heading, text, btn, isError) {
      card.replaceChildren(textEl('h2', 'room-title', heading));
      const p = textEl('p', isError ? 'error-msg' : 'helpers-text', text);
      if (isError) p.setAttribute('role', 'alert');
      card.appendChild(p);
      if (!btn) return;
      const actions = el('div', 'actions');
      actions.appendChild(btn);
      card.appendChild(actions);
      btn.focus();
    }

    function ready(errorText) {
      const btn = button('', 'Start helping', async () => {
        btn.disabled = true;
        let r;
        try {
          r = await SBS.api.useHelperCode(token);
        } catch (e) {
          if (stale()) return;
          if (e.status === 401) show('That code does not work', e.message, null, true);
          else ready(e.message); // offline or a server error: the code may still be good
          return;
        }
        phone.set(r.gameId, 'new');
        if (stale()) return;
        // So a reload comes back here. The id is public; the cookie is what counts.
        try { history.replaceState(null, '', `${location.pathname}#player-${r.gameId}`); } catch (e) { /* no reload */ }
        SBS.go({ screen: 'player', id: r.gameId, helper: true });
      });
      show('Help run a board', errorText || 'The host asked you to help on one board. Your own squares stay on this phone. No account is needed.', btn, !!errorText);
    }

    if (token) ready();
    else if (old) show('That code no longer works', 'Ask the host to open Helpers and show you a new code.', null, true);
    else show('That code does not work', "Scan the code on the host's screen again.", null, true);
  };

  // ---------- Old #score-<id> links ----------
  // The host gets the board; a scorekeeper gets their Score tab; anyone else Player View.
  SBS.screens.scoreLink = async function (id) {
    SBS.appEl.innerHTML = '';
    let role = null;
    let game = null;
    try {
      role = (await SBS.api.getRole(id)).role;
      if (role === 'host') game = await SBS.api.getGame(id);
    } catch (e) { /* Player View says what went wrong */ }
    if (SBS.currentScreen() !== 'scoreLink') return;
    if (game) SBS.openGame(game);
    else SBS.go({ screen: 'player', id, helper: true, tab: 'score' });
  };
})();
