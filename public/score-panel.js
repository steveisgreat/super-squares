// Manual current-score panel, shared by Phone Score Entry and Game Day.
// Every tap sends one operation to PATCH /api/game/:id/score (never the whole
// document). The pure transitions in GameLogic.applyScoreOp run locally first
// so the number moves instantly; the server's answer then replaces the game.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, showAlert, showConfirm, teamBadge, fitTeamBadges } = SBS.ui;
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

  // opts: { getGame(): game, setGame(game): void }. setGame is called with the
  // freshest copy after every optimistic step and every server answer.
  function create(opts) {
    const root = el('section', 'score-panel');
    root.setAttribute('aria-label', 'Current score');
    let chain = Promise.resolve();
    let editing = null; // quarter key being edited, or null
    let pending = 0;

    const game = () => opts.getGame();

    // Serialized: taps queue behind one another so the server sees them in
    // order and a fast double-tap never races itself into a conflict.
    function send(op) {
      const local = GL.applyScoreOp(game(), op);
      if (local.error) { showAlert(local.error); return Promise.resolve(); }
      opts.setGame(local.game);
      draw();
      pending++;
      chain = chain.then(async () => {
        try {
          const saved = await SBS.api.patchScore(local.game.id, op);
          opts.setGame(saved);
        } catch (e) {
          showAlert('Could not save the score: ' + e.message);
          try { opts.setGame(await SBS.api.getGame(local.game.id)); } catch (e2) { /* keep local copy */ }
        }
        pending--;
        draw();
      });
      return chain;
    }

    async function endPeriod(period) {
      const g = game();
      const below = GL.belowEndedQuarter(g);
      if (below && !(await showConfirm(`The current score is below the ${below} score already recorded. End ${periodLabel(period)} anyway?`))) return;
      send({ op: 'end' });
    }

    async function finalNow() {
      const g = game();
      const below = GL.belowEndedQuarter(g);
      const msg = below
        ? `The current score is below the ${below} score already recorded. Make this the final score anyway?`
        : 'Make the current score the final score? You can undo this.';
      if (await showConfirm(msg)) send({ op: 'final' });
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
      (QUICK[g.league] || QUICK.other).forEach(p => {
        const label = p > 0 ? `+${p}` : '−' + Math.abs(p);
        const b = el('button', 'sp-btn' + (p < 0 ? ' sp-minus' : ''), label);
        b.type = 'button';
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
      root.innerHTML = '';
      if (!g || GL.scoringMode(g) !== 'manual' || (g.status !== 'started' && g.status !== 'finished')) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const cur = GL.manualState(g);
      const finished = g.status === 'finished';

      const head = el('div', 'sp-title');
      head.innerHTML = `<h3>Current score</h3><span class="sp-period">${finished ? 'FINAL' : periodLabel(cur.period)}</span>`;
      root.appendChild(head);

      root.appendChild(scoreRow(g, 'a', cur, finished));
      root.appendChild(scoreRow(g, 'b', cur, finished));

      const actions = el('div', 'sp-actions');
      if (!finished) {
        const end = el('button', 'sp-btn sp-primary', endLabel(cur.period));
        end.type = 'button';
        end.setAttribute('data-spkey', 'end');
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
      root.appendChild(actions);

      const ended = GL.QUARTERS.filter(q => g.results && GL.hasResult(g.results[q]));
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
        root.appendChild(list);
      }
      fitTeamBadges(root);
    }

    draw();
    return { el: root, update: draw, busy: () => pending > 0 };
  }

  SBS.scorePanel = { create };
})();
