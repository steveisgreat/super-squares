// The score pad (decision 025 section 6): the only place a score is entered. Game Day, the Party
// View strip and a helper's Score tab all draw this one. Every tap sends one operation to
// PATCH /api/game/:id/score (never the whole document). The pure transitions in
// GameLogic.applyScoreOp run locally first so the number moves instantly; the server's answer then
// replaces the game. The final's draw is the exception: only the server picks (op 'draw').
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, showAlert, showConfirm, overlayEl, teamBadge, fitTeamBadges, isPhone } = SBS.ui;
  const GL = window.GameLogic;
  const { QUARTERS, QLABEL } = GL;

  // Tabler "arrow-back-up" (MIT, 24 px outline).
  const UNDO_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14l-4 -4l4 -4"></path><path d="M5 10h11a4 4 0 1 1 0 8h-1"></path></svg>';

  const PERIOD = ['1st quarter', '2nd quarter', '3rd quarter', '4th quarter', 'Overtime'];
  const periodWord = (period) => PERIOD[Math.min(Math.max(period || 1, 1), 5) - 1];
  // Inside a sentence: "the 3rd quarter", "overtime".
  const periodIn = (period) => (period >= 5 ? 'overtime' : 'the ' + periodWord(period));
  const quarterOf = (period) => (period <= 3 ? 'q' + Math.max(period || 1, 1) : 'final');
  const qName = (q) => (q === 'final' ? 'Final' : QLABEL[q]);

  // Keyboard scoring (Game Day on a laptop, R25 part b). The switch is remembered per browser.
  const KEYS_STORE = 'sbs.keyscoring';
  const UNDO_DEPTH = 20;
  const WIDE_Q = '(min-width: 1024px)';
  const FINE_Q = '(hover: hover) and (pointer: fine)';
  // Only one pad listens at a time, even if the screen is drawn again without a route change.
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

  // What a quarter's result means, in words. `r` is computeGame(...).results[q].
  function outcomeText(r) {
    if (r.winnerName) return `${r.winnerName} wins ${money(GL.payoutAmount(r))}`;
    if (r.pushed) return `Nobody has that square. ${money(r.amount)} rolls into the next payout.`;
    if (r.needsDraw) return 'That square is empty, so a winner has to be drawn.';
    return '';
  }
  // The same board with a score written for one quarter (null: none), for "who would win".
  function withScore(g, q, a, b) {
    const copy = JSON.parse(JSON.stringify(g));
    if (!copy.results) copy.results = {};
    copy.results[q] = Object.assign({}, copy.results[q], { a, b });
    return copy;
  }

  // A small dialog on top of everything. `build(box, close)` fills it. Escape and a tap outside
  // close it. Nothing in it has focus unless build says so, so a stray Enter confirms nothing.
  function openSheet(title, build) {
    const back = document.activeElement;
    const overlay = overlayEl('0.72');
    overlay.classList.add('sp-overlay');
    const box = el('div', 'card sp-sheet');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    box.tabIndex = -1;
    box.appendChild(textEl('h3', '', title));
    const close = () => {
      if (!overlay.parentNode) return;
      overlay.remove();
      if (back && document.body.contains(back) && back.focus) back.focus();
    };
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const all = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled);
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    SBS.onLeaveScreen(close);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.focus();
    build(box, close);
    return close;
  }
  function sheetButtons(noText, yesText, onNo, onYes) {
    const row = el('div', 'sp-sheet-actions');
    const no = textEl('button', 'sp-btn', noText);
    no.type = 'button';
    no.addEventListener('click', onNo);
    const yes = textEl('button', 'sp-btn sp-primary', yesText);
    yes.type = onYes ? 'button' : 'submit';
    if (onYes) yes.addEventListener('click', onYes);
    row.append(no, yes);
    return { row, yes };
  }

  // opts: { getGame(): game, setGame(game): void, patch(id, op)?, onError(err)?, onDrawn(game)?,
  // keyboard?, quarters?, readOnly? }. setGame is called with the freshest copy after every
  // optimistic step and every server answer. `patch` replaces the API call; `onError` returning
  // true means it dealt with the error; `onDrawn` runs after this screen drew the final's winner.
  // `keyboard` (Game Day only) adds the Keyboard scoring switch and the keys. `quarters: false`
  // leaves out the quarter list (Game Day has its own, with the payouts). `readOnly: false` hides
  // the pad on a board nobody is scoring by hand (the Party View strip).
  function create(opts) {
    const root = el('section', 'score-panel');
    root.setAttribute('aria-label', 'Score');
    const noteEl = el('div', 'sp-note');
    const head = el('div', 'sp-title');
    const teams = el('div', 'sp-teams');
    const lastRow = el('div', 'sp-last');
    // Never rebuilt, so a screen reader hears each change.
    const status = el('span', 'sp-status');
    status.setAttribute('role', 'status');
    const undoBtn = el('button', 'sp-btn sp-undo', UNDO_ICON + '<span>Undo</span>');
    undoBtn.type = 'button';
    undoBtn.addEventListener('click', () => undoLast());
    lastRow.append(status, undoBtn);
    const actions = el('div', 'sp-actions');
    const list = el('ul', 'sp-quarters');
    list.setAttribute('aria-label', 'Quarters');
    root.append(noteEl, head, teams, lastRow, actions, list);

    let chain = Promise.resolve();
    let pending = 0;
    let drawing = false;
    let sig = null;
    let said = ''; // the last thing done here, or why there is nothing to undo
    let hot = null; // the side that just scored a touchdown (its Extra point button is lit)
    let keysOn = opts.keyboard ? readKeysOn() : false;
    const undoStack = []; // { inv, what } for what this screen did, newest last

    const game = () => opts.getGame();
    const keysOffered = () => !!opts.keyboard && !isPhone() && window.matchMedia(WIDE_Q).matches && window.matchMedia(FINE_Q).matches;
    const sideName = (g, side) => (side === 'a' ? g.teamA : g.teamB);
    const open = (g) => !!g && (g.status === 'started' || g.status === 'finished');
    const canScore = (g) => open(g) && GL.manualEntry(g);

    // Serialized: taps queue behind one another so the server sees them in order and a fast
    // double-tap never races itself into a conflict. meta: { what } is the line that says what was
    // done; { undoing: true } keeps an undo off the undo stack; `applied` is set once it shows.
    async function send(op, meta, confirmed) {
      // On a Live board a scoring tap takes the score over from the feed (decision 001 section 6).
      // Fixing a quarter and undoing a fix do not.
      if (GL.scoringMode(game()) === 'live' && ['resume', 'edit'].indexOf(op.op) === -1) op = Object.assign({ override: true }, op);
      const local = GL.applyScoreOp(game(), op);
      if (local.error) { meta.refused = true; showAlert(local.error); return; }
      // A fix or undo that changes a quarter marked paid out warns first (R21).
      const disturbed = GL.paidQuartersDisturbed(game(), local.game);
      if (disturbed.length && !confirmed) {
        if (await showConfirm(SBS.ui.disturbMessage(disturbed))) return send(op, meta, true);
        return;
      }
      hot = null;
      if (!meta.undoing) {
        const inv = GL.inverseScoreOp(op, game(), local.game);
        if (inv) {
          undoStack.push({ inv, what: meta.what });
          if (undoStack.length > UNDO_DEPTH) undoStack.shift();
        } else if (['resume', 'undo', 'set'].indexOf(op.op) !== -1) {
          undoStack.length = 0; // these move the base and are not undone from here
        }
        if (op.op === 'add' && op.points === 6 && game().league === 'nfl') hot = op.side;
      }
      opts.setGame(local.game);
      meta.applied = true;
      said = meta.what;
      draw();
      pending++;
      chain = chain.then(async () => {
        try {
          const saved = await (opts.patch || SBS.api.patchScore)(local.game.id, op);
          // While later taps are queued the screen is ahead of this answer; the last one settles it.
          if (pending === 1) opts.setGame(saved);
        } catch (e) {
          // What was not saved must not be undone later: the stack no longer matches the board.
          undoStack.length = 0;
          hot = null;
          said = 'That was not saved.';
          if (opts.onError && opts.onError(e)) { pending--; return; }
          showAlert('Could not save the score: ' + e.message);
          try { opts.setGame(await SBS.api.getGame(local.game.id)); } catch (e2) { /* keep local copy */ }
        }
        pending--;
        draw();
      });
      return chain;
    }

    // ---- What the pad shows ----
    // The score now: what the host holds, the final, or the feed's. Null scores before a kickoff.
    function now(g) {
      if (g.status === 'finished') {
        const f = g.results && g.results.final;
        if (GL.hasResult(f)) return { a: Number(f.a), b: Number(f.b), period: GL.manualState(g).period };
      }
      if (GL.manualEntry(g)) return GL.manualState(g);
      const ls = g.liveScore;
      if (ls && ls.state !== 'pre' && Number.isFinite(ls.a) && Number.isFinite(ls.b)) return { a: ls.a, b: ls.b, period: ls.period || 1, clock: ls.clock || '' };
      return { a: null, b: null, period: 1 };
    }

    function winningNow(g, cur) {
      if (cur.a === null) return null;
      const q = g.status === 'finished' ? 'final' : quarterOf(cur.period);
      const r = GL.computeGame(g.status === 'finished' ? g : withScore(g, q, cur.a, cur.b)).results[q];
      if (r.winnerName) return `${r.winnerName}, ${money(GL.payoutAmount(r))}`;
      return r.pushed || r.needsDraw ? 'Empty square' : null;
    }

    function keyCap(text) {
      const k = el('span', 'sp-key');
      k.textContent = text;
      k.setAttribute('aria-hidden', 'true');
      return k;
    }

    function teamColumn(g, side, cur, scoring, finished) {
      const name = sideName(g, side);
      const col = el('section', 'sp-team');
      col.setAttribute('aria-label', name);
      const h = el('div', 'sp-head badge-fit');
      h.innerHTML = teamBadge(g, side === 'a' ? 'A' : 'B', { logoSize: 18, cls: 'team-badge-sm' });
      col.appendChild(h);
      const num = cur[side] === null ? '–' : String(cur[side]);
      if (scoring && !finished) {
        const b = textEl('button', 'sp-num', num);
        b.type = 'button';
        b.setAttribute('data-spkey', `num-${side}`);
        b.setAttribute('aria-label', `${name} score, ${num}. Tap to type it`);
        b.addEventListener('click', () => openType(side));
        col.appendChild(b);
      } else {
        col.appendChild(textEl('div', 'sp-num is-static', num));
      }
      if (!scoring || finished) return col;
      const plays = el('div', 'sp-plays');
      const letters = side === 'a' ? 'QWER' : 'UIOP';
      const showKeys = keysOn && keysOffered() && holdsScore(g);
      GL.scorePlays(g.league).forEach((p, i) => {
        const lit = hot === side && p.points === 1 && g.league === 'nfl';
        const b = el('button', 'sp-btn sp-play' + (lit ? ' is-lit' : ''));
        b.type = 'button';
        b.appendChild(textEl('span', 'sp-play-label', p.label));
        const pts = el('span', 'sp-pts');
        pts.appendChild(textEl('span', '', '+' + p.points));
        if (showKeys) { pts.appendChild(keyCap(letters[i])); b.setAttribute('aria-keyshortcuts', letters[i]); }
        b.appendChild(pts);
        b.setAttribute('data-spkey', `p-${side}-${i}`);
        b.setAttribute('aria-label', `${name} ${p.word}, add ${p.points}`);
        b.addEventListener('click', () => addPlay(side, p));
        plays.appendChild(b);
      });
      col.appendChild(plays);
      return col;
    }

    function addPlay(side, play) {
      const g = game();
      const kick = g.league === 'nfl' && play.points === 6 ? ' Kick good? Tap Extra point.' : '';
      return send({ op: 'add', side, points: play.points }, { what: `${sideName(g, side)} ${play.word}, +${play.points}.${kick}` });
    }

    function quarterRows(g) {
      list.innerHTML = '';
      const c = GL.computeGame(g);
      const manual = GL.scoringMode(g) === 'manual';
      QUARTERS.forEach(q => {
        const r = c.results[q];
        const ended = r.a !== null && r.b !== null;
        const li = el('li');
        li.appendChild(textEl('span', 'sp-q', qName(q)));
        li.appendChild(textEl('span', 'sp-val', ended ? `${r.a}–${r.b}` : '–'));
        const who = textEl('span', 'sp-who', '');
        if (ended) {
          who.textContent = r.winnerName ? `${r.winnerName} wins ${money(GL.payoutAmount(r))}` : r.pushed ? 'PUSH' : r.needsDraw ? 'Needs a draw' : '';
          if (!r.winnerName) who.classList.add('is-push');
        }
        li.appendChild(who);
        const slot = el('span', 'sp-fix-slot');
        const b = fixButton(g, q, ended, manual);
        if (b) slot.appendChild(b);
        li.appendChild(slot);
        list.appendChild(li);
      });
    }

    // Fix on an ended quarter. On a board that is not scored by hand a quarter can also be filled in.
    function fixButton(g, q, ended, manual) {
      if (!ended && manual) return null;
      const b = textEl('button', 'sp-fix', ended ? 'Fix' : 'Enter');
      b.type = 'button';
      b.setAttribute('data-spkey', `fix-${q}`);
      b.setAttribute('aria-label', `${ended ? 'Fix' : 'Enter'} the ${qName(q)} score`);
      b.addEventListener('click', () => openFix(q));
      return b;
    }

    // ---- Undo: the last thing done here, else the newest ended quarter on the board ----
    function ended(g, target) {
      if (target === 'final') return 'the final score';
      if (target === 'ot') return 'the start of overtime';
      return `the end of the ${periodWord(Number(target[1]))}`;
    }
    function undoable(g) {
      if (undoStack.length) return true;
      return canScore(g) && !!GL.undoTarget(g);
    }
    async function undoLast() {
      const g = game();
      if (!undoStack.length) {
        const target = canScore(g) ? GL.undoTarget(g) : null;
        if (!target) { said = 'Nothing to undo from this screen.'; draw(); return; }
        const s = GL.manualState(g);
        const name = ended(g, target);
        if (!(await showConfirm(`Undo ${name}? The score stays ${g.teamA} ${s.a}, ${g.teamB} ${s.b}.`))) return;
        await send({ op: 'undo', expect: target }, { what: `Undid ${name}.` });
        return;
      }
      const top = undoStack.pop();
      const meta = { undoing: true, what: 'Undone: ' + top.what.replace(/ Kick good\?.*$/, '') };
      await send(top.inv, meta);
      if (!meta.applied && !meta.refused) undoStack.push(top); // the paid-quarter warning was declined
    }

    // ---- Ending a quarter ----
    function openEnd() {
      const g = game();
      const cur = GL.manualState(g);
      const toOt = cur.period === 4 && cur.a === cur.b;
      const finishes = cur.period >= 4 && !toOt;
      askEnd({ op: 'end' }, toOt ? 'Go to overtime?' : finishes ? 'End the game?' : `End ${periodIn(cur.period)}?`,
        toOt ? 'Overtime' : 'Yes, end it', cur, toOt, finishes ? 'final' : quarterOf(cur.period));
    }
    function openFinal() {
      askEnd({ op: 'final' }, 'Make this the final score?', 'Yes, it is final', GL.manualState(game()), false, 'final');
    }
    function askEnd(op, title, yesText, cur, toOt, q) {
      const g = game();
      const from = { a: cur.a, b: cur.b, period: cur.period };
      const res = toOt ? null : GL.computeGame(withScore(g, q, cur.a, cur.b)).results[q];
      openSheet(title, (box, close) => {
        const score = el('div', 'sp-sheet-score');
        score.append(textEl('span', '', g.teamA), textEl('strong', '', String(cur.a)), textEl('span', 'sp-dash', '–'), textEl('strong', '', String(cur.b)), textEl('span', '', g.teamB));
        box.appendChild(score);
        const note = textEl('p', 'sp-sheet-note', toOt ? 'It is tied, so the game goes on.' : outcomeText(res));
        if (!toOt && !res.winnerName) note.classList.add('is-push');
        box.appendChild(note);
        const below = GL.belowEndedQuarter(g);
        if (below) box.appendChild(textEl('p', 'sp-sheet-warn', `This is below the ${below} score already recorded.`));
        if (q === 'final' && !toOt && cur.a === cur.b) box.appendChild(textEl('p', 'sp-sheet-warn', 'The score is tied.'));
        box.appendChild(textEl('p', 'sp-sheet-small', 'Check it against the TV. You can undo this.'));
        const what = toOt ? 'Tied. Overtime started.'
          : q === 'final' ? `Game over. ${outcomeText(res)}${res.winnerName ? '.' : ''}`
            : `${periodWord(cur.period)} ended. ${outcomeText(res)}${res.winnerName ? '.' : ''}`;
        box.appendChild(sheetButtons('Not yet', yesText, close, () => { close(); send(Object.assign({}, op, { from }), { what }); }).row);
      });
    }

    // ---- Typing a score ----
    // Two boxes, a note that follows what is typed, and Save. `noteFor(a, b)` gets whole numbers
    // or nulls; `save(a, b)` runs once both are whole numbers from 0 to 999.
    function numbersSheet(title, start, focusSide, noteFor, save, extra) {
      const g = game();
      openSheet(title, (box, close) => {
        const form = el('form', 'sp-sheet-form');
        const fields = el('div', 'sp-sheet-nums');
        const inputs = {};
        ['a', 'b'].forEach(side => {
          const lab = textEl('label', '', sideName(g, side));
          const i = el('input');
          i.type = 'text';
          i.inputMode = 'numeric';
          i.autocomplete = 'off';
          i.maxLength = 3;
          i.value = start ? String(start[side]) : '';
          i.name = side;
          lab.appendChild(i);
          fields.appendChild(lab);
          inputs[side] = i;
        });
        const note = textEl('p', 'sp-sheet-small sp-sheet-live', '');
        note.setAttribute('role', 'status');
        const read = (side) => { const v = inputs[side].value.trim(); return /^\d{1,3}$/.test(v) ? parseInt(v, 10) : null; };
        const b = sheetButtons('Cancel', 'Save', close, null);
        const refresh = () => {
          const x = read('a');
          const y = read('b');
          const ok = x !== null && y !== null;
          note.textContent = ok ? noteFor(x, y) : 'Enter both scores as whole numbers.';
          b.yes.disabled = !ok;
        };
        form.addEventListener('input', refresh);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const x = read('a');
          const y = read('b');
          if (x === null || y === null) return;
          close();
          save(x, y);
        });
        form.append(fields, note);
        if (extra) {
          const x = textEl('button', 'sp-link', extra.text);
          x.type = 'button';
          x.addEventListener('click', () => { close(); extra.run(); });
          form.appendChild(x);
        }
        form.appendChild(b.row);
        box.appendChild(form);
        refresh();
        inputs[focusSide || 'a'].focus();
        inputs[focusSide || 'a'].select();
      });
    }

    function openType(side) {
      const cur = GL.manualState(game());
      numbersSheet('Type the score', cur, side, () => 'Use this if the score here does not match the TV.',
        (a, b) => send({ op: 'set', a, b, from: { a: cur.a, b: cur.b } }, { what: `Score set to ${a}–${b}.` }));
    }

    function openFix(q) {
      const g = game();
      const r = g.results && g.results[q];
      const was = GL.hasResult(r) ? { a: Number(r.a), b: Number(r.b) } : null;
      const before = GL.computeGame(g).results[q];
      const who = (res) => (res.winnerName || (res.pushed ? 'nobody (a push)' : res.needsDraw ? 'a draw' : 'nobody'));
      const manual = GL.scoringMode(g) === 'manual';
      const note = (a, b) => {
        const after = GL.computeGame(withScore(g, q, a, b)).results[q];
        const tail = ` Only ${qName(q)} changes, not the score now.`;
        if (!was) return outcomeText(after) + (after.winnerName ? '.' : '');
        if (who(before) === who(after)) return `Winner stays ${who(before)}.` + (q === 'final' ? '' : tail);
        return `Winner changes from ${who(before)} to ${who(after)}.` + (q === 'final' ? '' : tail);
      };
      numbersSheet(`${was ? 'Fix' : 'Enter'} ${qName(q)}`, was, 'a', note,
        (a, b) => send({ op: 'edit', quarter: q, a, b, from: was }, { what: `${qName(q)} ${was ? 'fixed' : 'set'}: ${a}–${b}.` }),
        was && !manual ? { text: 'Clear this score', run: () => send({ op: 'edit', quarter: q, a: null, b: null, from: was }, { what: `${qName(q)} cleared.` }) } : null);
    }

    // ---- The final's draw ----
    async function drawWinner() {
      if (drawing) return;
      drawing = true;
      draw();
      try {
        const saved = await (opts.patch || SBS.api.patchScore)(game().id, { op: 'draw' });
        opts.setGame(saved);
        said = 'The winner was drawn.';
        if (opts.onDrawn) opts.onDrawn(saved);
      } catch (e) {
        if (opts.onError && opts.onError(e)) return;
        showAlert('Could not draw the winner: ' + e.message);
        try { opts.setGame(await SBS.api.getGame(game().id)); } catch (e2) { /* keep what we have */ }
      } finally {
        drawing = false;
        draw();
      }
    }

    // ---- Draw ----
    function draw() {
      const active = document.activeElement;
      const focusKey = active && root.contains(active) ? active.getAttribute('data-spkey') : null;
      drawInner();
      if (focusKey && document.activeElement !== active) {
        const again = root.querySelector(`[data-spkey="${focusKey}"]`);
        if (again && !again.disabled) again.focus();
      }
    }

    function drawInner() {
      const g = game();
      const scoring = canScore(g);
      if (!open(g) || (!scoring && opts.readOnly === false)) {
        root.hidden = true;
        sig = null;
        return;
      }
      root.hidden = false;
      const finished = g.status === 'finished';
      const line = said || (scoring && !finished ? 'Tap what happened. Tap a score to type it.' : '');
      if (status.textContent !== line) status.textContent = line; // said once, not on every poll
      undoBtn.disabled = !undoable(g);
      undoBtn.setAttribute('aria-label', undoStack.length ? 'Undo: ' + undoStack[undoStack.length - 1].what
        : scoring && GL.undoTarget(g) ? `Undo ${ended(g, GL.undoTarget(g))}` : 'Undo');
      lastRow.hidden = !scoring && !undoStack.length && !said;

      // Everything below is rebuilt only when it changes, so a poll never takes a button away
      // from under a finger.
      const next = JSON.stringify([g.status, scoring, g.scoring, g.simulation, g.league, g.teamA, g.teamB, g.liveOverride, g.liveFeed && g.liveFeed.available,
        g.liveScore, g.results, g.paidOut, g.squares, g.axisX, g.axisY, g.squarePrice, g.payouts, g.potOverride, hot, drawing, keysOn && keysOffered(), keysOffered()]);
      if (next === sig) return;
      sig = next;

      const cur = now(g);
      const mode = GL.scoringMode(g);
      drawNote(g, mode, scoring, finished);
      head.innerHTML = '';
      const when = finished ? 'Final' : scoring ? periodWord(cur.period)
        : cur.a === null ? 'Not started' : [periodWord(cur.period), cur.clock].filter(Boolean).join(', ');
      head.appendChild(textEl('h3', '', when));
      const win = winningNow(g, cur);
      if (win) {
        const w = el('div', 'sp-winning');
        w.append(textEl('span', '', finished ? 'Winner' : 'Winning now'), textEl('strong', '', win));
        head.appendChild(w);
      }

      teams.innerHTML = '';
      teams.append(teamColumn(g, 'a', cur, scoring, finished), teamColumn(g, 'b', cur, scoring, finished));

      actions.innerHTML = '';
      if (scoring && !finished) {
        const toOt = cur.period === 4 && cur.a === cur.b;
        const end = textEl('button', 'sp-btn sp-primary sp-end', toOt ? 'Go to overtime' : cur.period >= 4 ? 'End the game' : `End ${periodWord(cur.period)}`);
        end.type = 'button';
        end.setAttribute('data-spkey', 'end');
        if (keysOn && keysOffered() && holdsScore(g)) { end.appendChild(keyCap('Enter')); end.setAttribute('aria-keyshortcuts', 'Enter'); }
        end.addEventListener('click', openEnd);
        actions.appendChild(end);
      }
      if (keysOffered() && scoring) actions.appendChild(keysSwitch());
      if (!scoring && !finished && mode === 'live') {
        const take = textEl('button', 'sp-btn sp-end', 'Enter the score myself');
        take.type = 'button';
        take.setAttribute('data-spkey', 'take');
        // No points: the server starts from its own copy of the feed, newer than this screen's.
        take.addEventListener('click', () => send({ op: 'add', side: 'a', points: 0 }, { what: 'You are keeping score now.' }));
        actions.appendChild(take);
      }
      // Ending the game before the fourth quarter is out of the way on purpose.
      if (scoring && !finished && (cur.period < 4 || cur.a === cur.b)) {
        const fin = textEl('button', 'sp-link', 'Make this the final score');
        fin.type = 'button';
        fin.setAttribute('data-spkey', 'final');
        fin.addEventListener('click', openFinal);
        actions.appendChild(fin);
      }
      if (opts.quarters !== false) {
        quarterRows(g);
        if (GL.computeGame(g).results.final.needsDraw) {
          const li = el('li', 'sp-drawrow');
          li.appendChild(textEl('span', '', 'The final square is empty, so a winner has to be drawn.'));
          li.appendChild(drawButton('sp-btn sp-primary'));
          list.appendChild(li);
        }
      }
      list.hidden = opts.quarters === false;
      fitTeamBadges(root);
    }

    function drawButton(cls) {
      const b = textEl('button', cls, drawing ? 'Drawing…' : 'Draw the winner');
      b.type = 'button';
      b.disabled = drawing;
      b.setAttribute('data-spkey', 'draw');
      b.addEventListener('click', drawWinner);
      return b;
    }

    // Why the pad is here, or why there is nothing to tap.
    function drawNote(g, mode, scoring, finished) {
      noteEl.innerHTML = '';
      noteEl.className = 'sp-note';
      let text = '';
      let back = false;
      if (!finished) {
        if (mode === 'simulation') text = 'This is a practice game with made-up scores. Each quarter fills in on its own.';
        else if (mode === 'live' && !scoring) text = 'Scores are coming in on their own. There is nothing to tap.';
        else if (mode === 'live' && g.liveOverride) { text = 'You are entering the score. Live is paused.'; back = true; }
        else if (mode === 'live') text = 'Live scores have stopped. Enter the score here until they come back.';
        if (scoring && mode === 'live') noteEl.classList.add('is-warn');
      }
      noteEl.hidden = !text;
      if (!text) return;
      noteEl.appendChild(textEl('span', '', text));
      if (back) {
        const b = textEl('button', 'sp-btn', 'Back to live');
        b.type = 'button';
        b.setAttribute('data-spkey', 'resume');
        b.addEventListener('click', () => send({ op: 'resume' }, { what: 'Handed back to the live feed.' }));
        noteEl.appendChild(b);
      }
    }

    // ---- Keyboard scoring (Game Day, wide screens with a mouse) ----
    function keysSwitch() {
      const sw = el('button', 'sp-btn sp-switch', '');
      sw.type = 'button';
      sw.setAttribute('aria-pressed', keysOn ? 'true' : 'false');
      sw.setAttribute('data-spkey', 'kbd-switch');
      sw.innerHTML = '<span class="sp-switch-track" aria-hidden="true"></span><span class="sp-switch-label">Keyboard scoring</span>';
      sw.addEventListener('click', () => {
        keysOn = !keysOn;
        writeKeysOn(keysOn);
        said = keysOn ? 'Keyboard scoring is on.' : 'Keyboard scoring is off.';
        draw();
      });
      // The keys show on the buttons while it is on; the rest is said here, not in a legend.
      sw.title = 'Letters on the buttons add points. Enter ends the quarter (it asks first). ' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd Z' : 'Ctrl Z') + ' undoes what you scored here.';
      return sw;
    }

    // Keys act only while the pad is showing and the host holds the score: a Manual board, or a
    // Live board already taken over. A key never takes a Live board over from the feed.
    const holdsScore = (g) => !!g && (GL.scoringMode(g) === 'manual' || g.liveOverride === true);

    function onKeyDown(e) {
      if (!keysOn || !keysOffered() || root.hidden || !root.isConnected) return;
      if (e.defaultPrevented || e.repeat || document.hidden) return;
      if (typingIn(e.target) || typingIn(document.activeElement) || overlayOpen()) return;
      const g = game();
      if (!holdsScore(g) || !open(g)) return;
      const key = typeof e.key === 'string' ? e.key : '';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
      if (mod || e.altKey || g.status !== 'started') return;
      if (key === 'Enter') {
        if (focusableControl(e.target)) return;
        e.preventDefault();
        openEnd();
        return;
      }
      const op = GL.scoreKeyOp(g.league, key);
      if (!op) return;
      e.preventDefault();
      addPlay(op.side, GL.scorePlays(g.league).find(p => p.points === op.points));
    }

    // A poll brought a change made somewhere else: what was done here may no longer undo cleanly.
    function clearUndo() {
      if (undoStack.length) said = 'The score changed on another device.';
      else said = '';
      undoStack.length = 0;
      hot = null;
      draw();
    }

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

    draw();
    return { el: root, update: draw, busy: () => pending > 0 || drawing, clearUndo, fix: openFix, drawWinner };
  }

  SBS.scorePanel = { create };
})();
