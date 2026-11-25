// Manual current-score panel, shared by Phone Score Entry and Game Day.
// Every tap sends one operation to PATCH /api/game/:id/score (never the whole
// document). The pure transitions in GameLogic.applyScoreOp run locally first
// so the number moves instantly; the server's answer then replaces the game.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, showAlert, showConfirm, teamBadge, fitTeamBadges, isPhone } = SBS.ui;
  const GL = window.GameLogic;

  const QUICK = {
    nfl: [7, 6, 3, 2, 1, -1],
    nba: [1, 2, 3, -1],
    other: [1, -1]
  };

  function periodLabel(period) {
    return period >= 5 ? 'OT' : `Q${period}`;
  }

  function endLabel(period) {
    if (period === 2) return 'End Q2 (Halftime)';
    if (period >= 5) return 'End OT';
    return `End Q${period}`;
  }

  // Keyboard scoring (Game Day on a laptop, R25 part b). The switch is remembered per browser.
  const KEYS_STORE = 'sbs.keyscoring';
  const UNDO_DEPTH = 20;
  const WIDE_Q = '(min-width: 1024px)';
  const FINE_Q = '(hover: hover) and (pointer: fine)';
  // Only one panel listens at a time, even if the screen is drawn again without a route change.
  let activeTeardown = null;

  function readKeysOn() {
    try { return window.localStorage.getItem(KEYS_STORE) === '1'; } catch (e) { return false; }
  }
  function writeKeysOn(on) {
    try { window.localStorage.setItem(KEYS_STORE, on ? '1' : '0'); } catch (e) { /* kept for this visit only */ }
  }
  function typingIn(t) {
    return !!t && (t.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  }
  // A control that Enter would press: the key must go to it, not end the quarter.
  function focusableControl(t) {
    if (!t || t === document.body || t === document.documentElement || !t.matches) return false;
    return t.matches('button, a[href], summary, input, select, textarea, [contenteditable], [role=button], [role=link], [role=tab], [tabindex]:not([tabindex="-1"])');
  }
  // Any dialog or overlay: a confirm, Manage Players, the room chooser, the winner reveal.
  function overlayOpen() {
    if (document.querySelector('[role=dialog], [aria-modal=true], .manage-modal, .draw-reveal-overlay')) return true;
    return Array.prototype.some.call(document.body.children, n => n.tagName === 'DIV' && n.id !== 'app' && n.style.position === 'fixed');
  }

  // opts: { getGame(): game, setGame(game): void, patch(id, op)?, onError(err)?, keyboard? }. setGame
  // is called with the freshest copy after every optimistic step and every server answer.
  // `patch` replaces the API call; `onError` returning true means it dealt with the error.
  // `keyboard` (Game Day only) adds the Keyboard scoring switch and the keys.
  function create(opts) {
    const root = el('section', 'score-panel');
    root.setAttribute('aria-label', 'Current score');
    // With the keys on offer the panel keeps one polite status line that is never rebuilt, so a
    // screen reader hears each change. Everything else is drawn inside `body`.
    const body = opts.keyboard ? el('div', 'sp-content') : root;
    const live = opts.keyboard ? el('p', 'sr-only') : null;
    if (live) { live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); root.append(body, live); }
    let chain = Promise.resolve();
    let editing = null; // quarter key being edited, or null
    let pending = 0;
    let keysOn = opts.keyboard ? readKeysOn() : false;
    const undoStack = []; // inverses of what this screen scored, newest last

    const game = () => opts.getGame();
    const say = (text) => { if (live) live.textContent = text; };
    const keysOffered = () => !!opts.keyboard && !isPhone() && window.matchMedia(WIDE_Q).matches && window.matchMedia(FINE_Q).matches;
    // Game Day from 1024 px (R35): the panel sits in the left-hand tabbed panel. Its quarters list
    // is the screen's own, so the panel leaves out its ended list and shows only what is now.
    const wideNow = () => !!opts.keyboard && !isPhone() && window.matchMedia(WIDE_Q).matches;

    // Serialized: taps queue behind one another so the server sees them in
    // order and a fast double-tap never races itself into a conflict.
    // meta (optional): { noRecord: true } keeps an undo off the undo stack; { say(before, after) }
    // announces what happened; `applied` is set once the change shows on screen.
    async function send(op, confirmed, meta) {
      // On a Live board the host's tap takes the score over from the feed (section 6).
      if (GL.scoringMode(game()) === 'live' && op.op !== 'resume') op = Object.assign({ override: true }, op);
      const local = GL.applyScoreOp(game(), op);
      if (local.error) { showAlert(local.error); return; }
      // An edit or undo that changes a quarter marked paid out warns first (R21).
      const disturbed = GL.paidQuartersDisturbed(game(), local.game);
      if (disturbed.length && !confirmed) {
        if (await showConfirm(SBS.ui.disturbMessage(disturbed))) return send(op, true, meta);
        return;
      }
      if (opts.keyboard && !(meta && meta.noRecord)) {
        const inv = GL.inverseScoreOp(op, game(), local.game);
        if (inv) {
          undoStack.push(inv);
          if (undoStack.length > UNDO_DEPTH) undoStack.shift();
        } else if (['set', 'edit', 'resume', 'undo'].indexOf(op.op) !== -1) {
          undoStack.length = 0; // those cannot be undone from the keyboard, and they move the base
        }
      }
      // setGame changes the shared game in place, so a copy is kept for the announcement.
      const before = meta && meta.say ? JSON.parse(JSON.stringify(game())) : null;
      opts.setGame(local.game);
      if (meta) meta.applied = true;
      draw();
      if (meta && meta.say) say(meta.say(before, local.game));
      pending++;
      chain = chain.then(async () => {
        try {
          const saved = await (opts.patch || SBS.api.patchScore)(local.game.id, op);
          opts.setGame(saved);
        } catch (e) {
          // What was not saved must not be undone later: the stack no longer matches the board.
          undoStack.length = 0;
          if (opts.onError && opts.onError(e)) { pending--; return; }
          showAlert('Could not save the score: ' + e.message);
          try { opts.setGame(await SBS.api.getGame(local.game.id)); } catch (e2) { /* keep local copy */ }
        }
        pending--;
        draw();
      });
      return chain;
    }

    // `named` (the Enter key): always ask first, naming the score. The below-an-earlier-quarter
    // question stands in for it, never both.
    async function endPeriod(period, named, meta) {
      const g = game();
      const below = GL.belowEndedQuarter(g);
      const cur = GL.manualState(g);
      let msg = null;
      if (below) msg = `The current score is below the ${below} score already recorded. End ${periodLabel(period)} anyway?`;
      else if (named) {
        const finishes = period >= 5 || (period === 4 && cur.a !== cur.b);
        msg = `End ${periodLabel(period)} at ${g.teamA} ${cur.a} - ${g.teamB} ${cur.b}?` + (finishes ? ' That makes it the final score.' : '');
      }
      if (msg && !(await showConfirm(msg))) return;
      if (named) {
        // The score may have moved while the question was open (a poll, another tap).
        const now = GL.manualState(game());
        if (now.a !== cur.a || now.b !== cur.b || now.period !== cur.period) { say('The score changed. Press Enter again to end the quarter.'); return; }
      }
      send({ op: 'end' }, false, meta);
    }

    async function finalNow() {
      const g = game();
      const below = GL.belowEndedQuarter(g);
      const msg = below
        ? `The current score is below the ${below} score already recorded. Make this the final score anyway?`
        : 'Make the current score the final score? You can undo this.';
      if (await showConfirm(msg)) send({ op: 'final' });
    }

    // The key that adds `points` for this side (Game Day with the switch on), or ''.
    function keyLetter(g, side, points) {
      const letters = side === 'a' ? 'qwe' : 'poi';
      const hit = letters.split('').find(k => { const op = GL.scoreKeyOp(g.league, k); return op && op.points === points; });
      return hit ? hit.toUpperCase() : '';
    }
    function keyCap(text) {
      const k = el('span', 'sp-key');
      k.textContent = text;
      k.setAttribute('aria-hidden', 'true');
      return k;
    }

    function scoreRow(g, side, cur, finished) {
      const row = el('div', 'sp-team');
      const name = side === 'a' ? g.teamA : g.teamB;
      const head = el('div', 'sp-head badge-fit');
      head.innerHTML = teamBadge(g, side === 'a' ? 'A' : 'B', { logoSize: 18, cls: 'team-badge-sm' });
      row.appendChild(head);

      const input = el('input', 'sp-input');
      input.type = 'number';
      input.min = '0';
      input.max = '999';
      input.inputMode = 'numeric';
      input.value = String(cur[side]);
      input.disabled = finished;
      input.setAttribute('data-spkey', `in-${side}`);
      input.setAttribute('aria-label', `${name} score`);
      input.addEventListener('change', () => {
        const n = parseInt(input.value, 10);
        if (!Number.isInteger(n) || n < 0 || n > 999) { input.value = String(cur[side]); return; }
        send({ op: 'set', a: side === 'a' ? n : cur.a, b: side === 'b' ? n : cur.b });
      });
      row.appendChild(input);

      const quick = el('div', 'sp-quick');
      const buttons = QUICK[g.league] || QUICK.other;
      quick.style.setProperty('--n', String(buttons.length));
      const showKeys = keysOn && keysOffered();
      buttons.forEach(p => {
        const label = p > 0 ? `+${p}` : '−' + Math.abs(p);
        const b = el('button', 'sp-btn' + (p < 0 ? ' sp-minus' : ''), label);
        b.type = 'button';
        const letter = showKeys && p > 0 ? keyLetter(g, side, p) : '';
        if (letter) { b.appendChild(keyCap(letter)); b.setAttribute('aria-keyshortcuts', letter); }
        b.disabled = finished;
        b.setAttribute('data-spkey', `q-${side}-${p}`);
        b.setAttribute('aria-label', `${p > 0 ? 'Add' : 'Subtract'} ${Math.abs(p)} ${p > 0 ? 'to' : 'from'} ${name}`);
        b.addEventListener('click', () => send({ op: 'add', side, points: p }));
        quick.appendChild(b);
      });
      row.appendChild(quick);
      return row;
    }

    function editForm(g, q) {
      const r = g.results[q];
      const form = el('form', 'sp-edit');
      form.innerHTML = `
        <label>${escapeHtml(g.teamA)} <input type="number" min="0" max="999" name="a" value="${Number(r.a)}"></label>
        <label>${escapeHtml(g.teamB)} <input type="number" min="0" max="999" name="b" value="${Number(r.b)}"></label>`;
      const save = el('button', 'sp-btn sp-primary', 'Save');
      save.type = 'submit';
      const cancel = el('button', 'sp-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { editing = null; draw(); });
      form.append(save, cancel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const a = parseInt(form.elements.a.value, 10);
        const b = parseInt(form.elements.b.value, 10);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 999 || b > 999) {
          showAlert('Scores must be whole numbers from 0 to 999.');
          return;
        }
        editing = null;
        send({ op: 'edit', quarter: q, a, b });
      });
      return form;
    }

    function draw() {
      const active = document.activeElement;
      const focusKey = active && root.contains(active) ? active.getAttribute('data-spkey') : null;
      drawInner();
      if (focusKey) {
        const again = root.querySelector(`[data-spkey="${focusKey}"]`);
        if (again && !again.disabled) again.focus();
      }
    }

    function drawInner() {
      const g = game();
      body.innerHTML = '';
      if (!g || !GL.manualEntry(g) || (g.status !== 'started' && g.status !== 'finished')) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const cur = GL.manualState(g);
      const finished = g.status === 'finished';

      const wide = wideNow();
      const head = el('div', 'sp-title');
      // Wide and over: a one-line summary with Undo, since the quarters list shows the rest.
      if (wide && finished) {
        const fin = GL.hasResult(g.results && g.results.final) ? { a: Number(g.results.final.a), b: Number(g.results.final.b) } : cur;
        head.innerHTML = '<h3>Final score</h3>';
        const sum = el('span', 'sp-period sp-final');
        sum.textContent = `${g.teamA} ${fin.a} – ${fin.b} ${g.teamB}`;
        head.appendChild(sum);
        const undo = el('button', 'sp-btn sp-undo', 'Undo');
        undo.type = 'button';
        undo.setAttribute('data-spkey', 'undo');
        undo.setAttribute('aria-label', 'Undo final score');
        undo.addEventListener('click', () => send({ op: 'undo' }));
        head.appendChild(undo);
        body.appendChild(head);
        return;
      }
      head.innerHTML = `<h3>Current score</h3><span class="sp-period">${finished ? 'FINAL' : escapeHtml(periodLabel(cur.period))}</span>`;
      body.appendChild(head);
      // Wide: the switch shares the title's line; on the way down it keeps its own.
      if (keysOffered()) (wide ? head : body).appendChild(keysRow(g));

      // A Live board: say why the panel is here, and offer the way back to the feed.
      if (GL.scoringMode(g) === 'live') {
        const note = el('div', 'sp-note');
        if (g.liveOverride) {
          note.textContent = 'You are entering the score. The live feed is paused.';
          if (!finished) {
            const resume = el('button', 'sp-btn', 'Resume live feed');
            resume.type = 'button';
            resume.setAttribute('data-spkey', 'resume');
            resume.addEventListener('click', () => send({ op: 'resume' }));
            note.appendChild(resume);
          }
        } else {
          note.textContent = 'Live feed unavailable. Enter the score here until it comes back.';
        }
        body.appendChild(note);
      }

      body.appendChild(scoreRow(g, 'a', cur, finished));
      body.appendChild(scoreRow(g, 'b', cur, finished));

      const actions = el('div', 'sp-actions');
      if (!finished) {
        const end = textEl('button', 'sp-btn sp-primary', endLabel(cur.period));
        end.type = 'button';
        end.setAttribute('data-spkey', 'end');
        if (keysOn && keysOffered()) { end.appendChild(keyCap('Enter')); end.setAttribute('aria-keyshortcuts', 'Enter'); }
        end.addEventListener('click', () => endPeriod(cur.period));
        actions.appendChild(end);
        const fin = el('button', 'sp-btn', 'Final');
        fin.type = 'button';
        fin.setAttribute('data-spkey', 'final');
        fin.addEventListener('click', finalNow);
        actions.appendChild(fin);
      }
      const anyEnded = GL.QUARTERS.some(q => g.results && GL.hasResult(g.results[q])) || cur.period === 5;
      if (anyEnded) {
        const undo = el('button', 'sp-btn', finished ? 'Undo final' : 'Undo end of quarter');
        undo.type = 'button';
        undo.setAttribute('data-spkey', 'undo');
        undo.addEventListener('click', () => send({ op: 'undo' }));
        actions.appendChild(undo);
      }
      body.appendChild(actions);

      const ended = wide ? [] : GL.QUARTERS.filter(q => g.results && GL.hasResult(g.results[q]));
      if (ended.length) {
        const list = el('ul', 'sp-ended');
        ended.forEach(q => {
          const r = g.results[q];
          const li = el('li');
          if (editing === q) {
            li.appendChild(el('span', 'sp-q', GL.QLABEL[q]));
            li.appendChild(editForm(g, q));
          } else {
            li.innerHTML = `<span class="sp-q">${GL.QLABEL[q]}</span><span class="sp-val">${Number(r.a)}–${Number(r.b)}</span>`;
            const edit = el('button', 'sp-btn sp-small', 'Edit score');
            edit.type = 'button';
            edit.setAttribute('data-spkey', `edit-${q}`);
            edit.setAttribute('aria-label', `Edit ${GL.QLABEL[q]} score`);
            edit.addEventListener('click', () => { editing = q; draw(); });
            li.appendChild(edit);
          }
          list.appendChild(li);
        });
        body.appendChild(list);
      }
      fitTeamBadges(body);
    }

    // ---- Keyboard scoring (Game Day, wide screens with a mouse) ----
    function keysRow(g) {
      const wrap = el('div', 'sp-keys');
      const sw = el('button', 'sp-btn sp-switch', '');
      sw.type = 'button';
      sw.setAttribute('aria-pressed', keysOn ? 'true' : 'false');
      sw.setAttribute('data-spkey', 'kbd-switch');
      sw.innerHTML = '<span class="sp-switch-track" aria-hidden="true"></span><span class="sp-switch-label">Keyboard scoring</span>';
      sw.addEventListener('click', () => {
        keysOn = !keysOn;
        writeKeysOn(keysOn);
        say(keysOn ? 'Keyboard scoring is on.' : 'Keyboard scoring is off.');
        draw();
      });
      // The keys show on the buttons while it is on; the rest is said here, not in a legend.
      sw.title = 'Letters on the buttons add points. Enter ends the quarter (it asks first). ' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd Z' : 'Ctrl Z') + ' undoes what you scored here.';
      wrap.appendChild(sw);
      return wrap;
    }

    // Keys act only while the panel is showing and the host holds the score: a Manual board, or a
    // Live board already taken over. A key never takes a Live board over from the feed.
    const holdsScore = (g) => !!g && (GL.scoringMode(g) === 'manual' || g.liveOverride === true);
    const sideName = (g, side) => (side === 'a' ? g.teamA : g.teamB);
    const sign = (n) => (n < 0 ? '−' : '+') + Math.abs(n);

    function keyAdd(op) {
      send(op, false, {
        say: (before, after) => {
          const s = GL.manualState(after);
          const other = op.side === 'a' ? 'b' : 'a';
          return `${sideName(after, op.side)} ${sign(op.points)}: ${s[op.side]} to ${s[other]}`;
        }
      });
    }

    async function keyUndo() {
      if (!undoStack.length) { say('Nothing to undo from this screen.'); return; }
      const inv = undoStack.pop();
      // The 'undo' op takes away the newest result on the server. Another device (the scorer
      // phone) may have ended a quarter since the last poll: then it is not ours to undo.
      if (inv.op === 'undo') {
        let fresh = null;
        try { fresh = await SBS.api.getGame(game().id); } catch (e) { fresh = null; }
        if (!fresh || fresh.updatedAt !== game().updatedAt) {
          undoStack.length = 0;
          say('The score changed on another device. Nothing to undo from this screen.');
          return;
        }
      }
      const meta = {
        noRecord: true,
        say: (before, after) => {
          if (inv.op === 'undo') return before.status === 'finished' ? 'Undid the final score.' : 'Undid the end of the quarter.';
          const s = GL.manualState(after);
          return `Undid the last score. ${after.teamA} ${s.a}, ${after.teamB} ${s.b}.`;
        }
      };
      await send(inv, false, meta);
      if (!meta.applied) undoStack.push(inv); // the paid-quarter warning was declined, or it was refused
    }

    function onKeyDown(e) {
      if (!keysOn || !keysOffered() || root.hidden || !root.isConnected) return;
      if (e.defaultPrevented || e.repeat || document.hidden) return;
      if (typingIn(e.target) || typingIn(document.activeElement) || overlayOpen()) return;
      const g = game();
      if (!holdsScore(g) || (g.status !== 'started' && g.status !== 'finished')) return;
      const key = typeof e.key === 'string' ? e.key : '';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === 'z') { e.preventDefault(); keyUndo(); return; }
      if (mod || e.altKey || g.status !== 'started') return;
      if (key === 'Enter') {
        if (focusableControl(e.target)) return;
        e.preventDefault();
        endPeriod(GL.manualState(g).period, true, { say: (before) => `Ended ${periodLabel(GL.manualState(before).period)}.` });
        return;
      }
      const op = GL.scoreKeyOp(g.league, key);
      if (!op) return;
      e.preventDefault();
      keyAdd(op);
    }

    // A poll brought a change made somewhere else: what was scored here no longer undoes cleanly.
    function clearUndo() { undoStack.length = 0; }

    if (opts.keyboard) {
      if (activeTeardown) activeTeardown();
      const mqs = [window.matchMedia(WIDE_Q), window.matchMedia(FINE_Q)];
      const redraw = () => draw();
      document.addEventListener('keydown', onKeyDown);
      // (addListener: older Safari has no addEventListener on a media query)
      mqs.forEach(m => { if (m.addEventListener) m.addEventListener('change', redraw); else m.addListener(redraw); });
      const teardown = () => {
        document.removeEventListener('keydown', onKeyDown);
        mqs.forEach(m => { if (m.removeEventListener) m.removeEventListener('change', redraw); else m.removeListener(redraw); });
        if (activeTeardown === teardown) activeTeardown = null;
      };
      activeTeardown = teardown;
      SBS.onLeaveScreen(teardown);
    }

    // Saves a corrected quarter score (Game Day's quarters list): the same guarded 'edit' op as
    // the panel's own Edit score form. The caller has checked the numbers are whole, 0 to 999.
    function edit(q, a, b) { editing = null; return send({ op: 'edit', quarter: q, a, b }); }

    draw();
    return { el: root, update: draw, busy: () => pending > 0, clearUndo, edit };
  }

  SBS.scorePanel = { create };
})();
