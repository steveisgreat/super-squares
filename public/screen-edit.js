// Edit game (R41, decision 026): the host's settings form at every stage, as its own screen and,
// on a wide Game Day, as the panel beside the board. Every save is one `edit` operation. The form
// holds only what the host changed, each with the value their screen showed, so a stale form can
// never put back another device's change. What is blocked, and why, is asked of the same rules the
// server judges the save with (GameLogic.applySettingsOp).
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, openSheet, showConfirm, applyTeamColors, formatKickoffTime } = SBS.ui;
  const GL = window.GameLogic;
  const { QUARTERS, computeGame, potOf, actualPotOf, paidQuartersDisturbed, paidSquareCount } = GL;

  const ALL_WARNINGS = ['team', 'liveGame', 'swap', 'kickoff', 'cutoffPast', 'money', 'pot', 'scoring'];
  // A picked live game sets these together, so a conflict over one is settled for all of them.
  const GAME_GROUP = ['teamA', 'teamB', 'league', 'gameDate', 'kickoffTime', 'teamAColor', 'teamBColor'];
  const LABEL = {
    description: 'description', teamA: 'Team A name', teamB: 'Team B name', teamAColor: 'Team A color', teamBColor: 'Team B color',
    swap: 'teams', league: 'league', gameDate: 'date', kickoffTime: 'kickoff', autoCutoffEnabled: 'auto cutoff', autoCutoffTime: 'cutoff time',
    squarePrice: 'square price', payouts: 'payout split', potOverride: 'total pot', pickMode: 'pick mode', guestPick: 'player picks',
    scoring: 'scoring', game: 'game'
  };
  const SCORING = { manual: 'Manual', live: 'Live', simulation: 'Simulation' };
  const LEAGUE = { nfl: 'NFL', nba: 'NBA', other: 'Other' };
  const PICK_MODE = { manual: 'Manual only', auto: 'Auto only', both: 'Both' };
  const QUARTER_NAME = { q1: 'Q1', q2: 'Q2', q3: 'Q3', final: 'Final' };
  const COLORS = { teamAColor: '#ff6b6b', teamBColor: '#4dabf7' };

  const LOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"></path><path d="M8 11v-4a4 4 0 1 1 8 0v4"></path></svg>';
  const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const canon = (v) => {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  };
  const same = (a, b) => canon(a) === canon(b);

  // A setting as it reads: a missing key or '' is the same as its default (as the server compares).
  function valueOf(game, k) {
    const v = game[k];
    if (k === 'scoring') return GL.scoringMode(game);
    if (k === 'autoCutoffEnabled') return v === true;
    if (k === 'pickMode') return v || 'both';
    if (k === 'guestPick') return Object.assign({ on: false, max: GL.DEFAULT_GUEST_MAX, liftAt: null, lifted: false }, v);
    return v === undefined || v === '' ? null : v;
  }

  // The live feed's reading as this screen last got it, for the stage (the server uses its own).
  function feedOf(game) {
    const l = game.liveScore;
    const f = game.liveFeed;
    if (GL.scoringMode(game) !== 'live' || !f || !f.available || !f.fetchedAt || !l || !l.state || l.manual) return null;
    return { state: l.state, at: Date.parse(f.fetchedAt) };
  }
  const context = (game) => ({
    now: Date.now(),
    feed: feedOf(game),
    teamKey: (name, league) => { const m = SBS.ui.teamMeta(name, league); return m ? m.abbr : null; }
  });

  // ISO instant -> the local "YYYY-MM-DDTHH:MM" a datetime-local input takes.
  function toLocalInput(iso) {
    const d = new Date(iso || '');
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // With its zone, so the server's clock agrees with the host's (issue #4).
  function fromLocalInput(v) {
    const d = new Date(v || '');
    return v && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  function dayText(date) {
    const d = new Date(`${date}T12:00:00`);
    return isNaN(d.getTime()) ? String(date || '') : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const whenText = (kickoff, date) => formatKickoffTime(kickoff) || dayText(date);
  const split = (p) => QUARTERS.map(q => p[q]).join(' / ');
  const guestText = (g) => (!g.on ? 'Off' : `On, up to ${g.max} each${g.liftAt ? ` until ${formatKickoffTime(g.liftAt)}` : ''}`);

  function shownValue(k, v) {
    if (k === 'squarePrice') return '$' + v;
    if (k === 'payouts') return split(v);
    if (k === 'potOverride') return v === null ? 'Squares sold × price' : money(v);
    if (k === 'scoring') return SCORING[v];
    if (k === 'league') return LEAGUE[v] || v;
    if (k === 'pickMode') return PICK_MODE[v] || v;
    if (k === 'guestPick') return guestText(v);
    if (k === 'autoCutoffEnabled') return v ? 'On' : 'Off';
    if (k === 'kickoffTime' || k === 'autoCutoffTime') return v ? formatKickoffTime(v) : '(none)';
    if (k === 'gameDate') return dayText(v);
    return v === null ? '(none)' : String(v);
  }

  // What one form holds: the board as last seen, and the host's changes { field: { value, saw } }.
  function newState(game) {
    return { base: clone(game), draft: {}, message: '', error: '' };
  }

  // opts: { state, onSaved(game), onClose(), panel }.
  function create(opts) {
    const state = opts.state;
    const draft = state.draft;
    const root = el('section', 'eg' + (opts.panel ? ' eg-panel' : ''));
    root.setAttribute('aria-label', 'Edit game');
    const head = el('header', 'eg-head');
    const body = el('div', 'eg-body');
    const foot = el('footer', 'eg-foot');
    root.append(head, body, foot);
    let busy = false;
    let refreshers = []; // update derived text while the host types, without rebuilding inputs

    const base = () => state.base;
    const stage = () => GL.settingsStage(base(), Date.now(), feedOf(base()));
    const cur = (k) => (draft[k] ? draft[k].value : valueOf(base(), k));
    const changedKeys = () => Object.keys(draft).filter(k => k === 'swap' || !same(draft[k].value, valueOf(base(), k)));

    // ---------- The draft ----------
    function set(k, value) {
      const saw = draft[k] ? draft[k].saw : valueOf(base(), k);
      if (same(value, saw)) delete draft[k];
      else draft[k] = Object.assign({}, draft[k], { value, saw });
      state.message = '';
      state.error = '';
    }
    function setSwap(on) {
      if (on) draft.swap = { value: true, saw: { teamA: valueOf(base(), 'teamA'), teamB: valueOf(base(), 'teamB') } };
      else delete draft.swap;
      state.message = '';
      state.error = '';
    }

    // The edit as the server takes it. A swap is judged on the team names the host saw.
    function operation(seen) {
      const setOut = {};
      const saw = {};
      changedKeys().forEach(k => {
        if (k === 'swap') {
          setOut.swap = true;
          Object.assign(saw, seen ? draft.swap.saw : { teamA: valueOf(base(), 'teamA'), teamB: valueOf(base(), 'teamB') });
          return;
        }
        let value = clone(draft[k].value);
        // "Lift the limit" belongs to the picking screen: keep the board's.
        if (k === 'guestPick') value.lifted = valueOf(base(), k).lifted;
        setOut[k] = value;
        saw[k] = seen ? draft[k].saw : valueOf(base(), k);
      });
      return { op: 'edit', set: setOut, saw };
    }

    // The rules run here as the server will run them, to say what is blocked and what to confirm.
    function judge(op) {
      return GL.applySettingsOp(base(), Object.assign({ ack: ALL_WARNINGS, marks: 'keep' }, op), context(base()));
    }
    // Why a field can't change at this stage, in the rules' words, or null.
    function blocked(k, to) {
      const b = base();
      const probe = (setIn) => {
        const saw = {};
        Object.keys(setIn).forEach(key => {
          if (key === 'swap') Object.assign(saw, { teamA: valueOf(b, 'teamA'), teamB: valueOf(b, 'teamB') });
          else saw[key] = valueOf(b, key);
        });
        const r = judge({ op: 'edit', set: setIn, saw });
        return r.code === 'illegal' ? r.error : null;
      };
      const price = Number(b.squarePrice) || 0;
      switch (k) {
        case 'teamA': case 'teamB': case 'league': case 'gameDate':
          return valueOf(b, 'scoring') === 'live' ? probe({ teamA: b.teamA === 'Probe A' ? 'Probe B' : 'Probe A' }) : null;
        case 'kickoffTime': return probe({ kickoffTime: '2000-01-01T00:00:00.000Z' });
        case 'swap': return probe({ swap: true });
        case 'squarePrice': case 'payouts': {
          // Both ways: one cent the wrong way can drop a quarter below zero on a board with a
          // small total pot, which is that amount's refusal, not the stage's.
          const up = probe({ squarePrice: Math.round((price + 0.01) * 100) / 100 });
          if (!up || price < 0.01) return up;
          return probe({ squarePrice: Math.round((price - 0.01) * 100) / 100 });
        }
        case 'potOverride': return probe({ potOverride: Math.round(potOf(b)) + 1000000 });
        case 'autoCutoffEnabled': case 'autoCutoffTime': return probe({ autoCutoffEnabled: !valueOf(b, 'autoCutoffEnabled') });
        case 'pickMode': return probe({ pickMode: valueOf(b, 'pickMode') === 'auto' ? 'both' : 'auto' });
        case 'guestPick': return probe({ guestPick: Object.assign(valueOf(b, 'guestPick'), { on: !valueOf(b, 'guestPick').on }) });
        case 'scoring': return to === valueOf(b, 'scoring') ? null : probe({ scoring: to });
        default: return null;
      }
    }

    // The board moved under the form. Edits it no longer allows are dropped, and said so.
    function takeBase(game) {
      state.base = clone(game);
      const lost = [];
      Object.keys(draft).forEach(k => {
        if (!draft[k]) return;
        const why = blocked(k, k === 'scoring' ? draft[k].value : undefined);
        if (!why) return;
        delete draft[k];
        if (lost.indexOf(why) === -1) lost.push(why);
      });
      return lost.length ? `Not saved: ${lost.join(' ')} Your other changes are kept.` : '';
    }

    // The board with the draft laid over it, for the amounts shown while editing.
    function merged() {
      const g = clone(base());
      Object.keys(draft).forEach(k => { if (k !== 'swap') g[k] = clone(draft[k].value); });
      return g;
    }
    const paidSquares = () => new Set(base().squares.filter(Boolean).map(s => s.name));
    const paidCount = () => Array.from(paidSquares()).reduce((n, name) => n + paidSquareCount(base(), name), 0);

    // { empty } | { error } | { after, warnings, needsMarks, disturbed }
    function preview() {
      if (!changedKeys().length) return { empty: true };
      const m = merged();
      if (draft.payouts) {
        const total = QUARTERS.reduce((t, q) => t + (Number(m.payouts[q]) || 0), 0);
        if (Math.abs(total - 100) > 0.01) return { error: `Payouts add up to ${total}%. They must be 100%.` };
      }
      if (m.autoCutoffEnabled && !m.autoCutoffTime && (draft.autoCutoffEnabled || draft.autoCutoffTime)) {
        return { error: 'Choose a cutoff date and time, or turn auto cutoff off.' };
      }
      if (draft.guestPick && m.guestPick.on) {
        const max = m.guestPick.max;
        if (!Number.isInteger(max) || max < 1 || max > 100) return { error: 'Most squares per person must be a whole number from 1 to 100.' };
      }
      const r = judge(operation(false));
      if (r.error) return { error: r.error };
      return {
        after: r.game,
        warnings: r.warnings,
        needsMarks: !!draft.squarePrice && changedKeys().indexOf('squarePrice') !== -1 && paidCount() > 0,
        disturbed: paidQuartersDisturbed(base(), r.game)
      };
    }

    // The changes as the host reads them: one row each, a picked game as one.
    function changeRows(after) {
      const b = base();
      const keys = changedKeys();
      const rows = [];
      const add = (title, fields, from, to) => rows.push({ title, fields, from, to, notes: [] });
      const grouped = keys.filter(k => draft[k].group);
      if (grouped.length) {
        const line = (g) => `${g.teamA} @ ${g.teamB}, ${whenText(g.kickoffTime, g.gameDate)}`;
        add('Game', grouped, line(b), line(after));
      }
      if (draft.autoCutoffEnabled || draft.autoCutoffTime) {
        const fields = keys.filter(k => k === 'autoCutoffEnabled' || k === 'autoCutoffTime');
        const line = (g) => (g.autoCutoffEnabled ? formatKickoffTime(g.autoCutoffTime) : 'Off');
        if (fields.length) add('Auto cutoff', fields, line(b), line(after));
      }
      keys.filter(k => !draft[k].group && k !== 'autoCutoffEnabled' && k !== 'autoCutoffTime').forEach(k => {
        const title = LABEL[k].charAt(0).toUpperCase() + LABEL[k].slice(1);
        if (k === 'swap') {
          add('Rows and columns', [k], `${b.teamA} down, ${b.teamB} across`, `${after.teamA} down, ${after.teamB} across`);
        } else if (k === 'potOverride') {
          add('Total pot', [k], money(potOf(b)), money(potOf(after)));
        } else {
          add(title, [k], shownValue(k, valueOf(b, k)), shownValue(k, valueOf(after, k)));
        }
      });
      return rows;
    }

    // ---------- Saving ----------
    function submit() {
      if (busy) return;
      const p = preview();
      if (p.empty || p.error) return;
      if (p.warnings.length || p.needsMarks || p.disturbed.length) review(p);
      else send([], null);
    }

    // `again` carries what the server asked for when it saw more than this screen did.
    function review(p, again) {
      const warnings = p.warnings.slice();
      ((again && again.warnings) || []).forEach(w => {
        const i = warnings.findIndex(x => x.code === w.code);
        if (i === -1) warnings.push(w); else warnings[i] = w;
      });
      const needsMarks = p.needsMarks || !!(again && again.marks);
      const rows = changeRows(p.after);
      const loose = [];
      warnings.forEach(w => {
        const row = rows.find(r => r.fields.indexOf(w.field) !== -1);
        if (row) row.notes.push(w.text); else loose.push(w.text);
      });
      if (p.disturbed.length) {
        const list = p.disturbed.join(' and ');
        const note = `${list} ${p.disturbed.length > 1 ? 'are' : 'is'} marked paid out. This change moves that money, so ${list} will show Needs settling.`;
        const row = rows.find(r => ['squarePrice', 'payouts', 'potOverride'].some(k => r.fields.indexOf(k) !== -1));
        if (row) row.notes.push(note); else loose.push(note);
      }
      openSheet(rows.length === 1 ? 'Check this change' : 'Check these changes', (box, shut) => {
        box.classList.add('eg-sheet');
        let marks = null;
        const save = textEl('button', 'eg-primary', '');
        save.type = 'button';
        const label = () => {
          const need = needsMarks && !marks;
          save.disabled = need;
          save.textContent = need ? 'Choose about the paid marks' : rows.length === 1 ? 'Save this change' : `Save ${rows.length} changes`;
        };
        rows.forEach(r => {
          const item = el('div', 'eg-change');
          item.appendChild(textEl('strong', '', r.title));
          const line = el('span', 'eg-fromto');
          line.append(textEl('span', '', r.from), textEl('span', 'eg-arrow', ' → '), textEl('strong', '', r.to));
          item.appendChild(line);
          r.notes.forEach(n => item.appendChild(textEl('span', 'eg-warn', n)));
          if (needsMarks && r.fields.indexOf('squarePrice') !== -1) {
            const group = el('div', 'eg-marks');
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', 'Paid marks');
            const old = Number(base().squarePrice) || 0;
            const diff = Math.round(Math.abs((Number(p.after.squarePrice) || 0) - old) * 100) / 100;
            const up = p.after.squarePrice > old;
            [['keep', up ? `Keep them marked paid. I’ll collect the extra $${diff} a square myself.` : `Keep them marked paid. I’ll give back $${diff} a square myself.`],
              ['clear', 'Mark everyone unpaid and collect again.']].forEach(([key, text]) => {
              const btn = textEl('button', 'eg-choice', text);
              btn.type = 'button';
              btn.dataset.marks = key;
              btn.setAttribute('aria-pressed', 'false');
              btn.addEventListener('click', () => {
                marks = key;
                group.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
                label();
              });
              group.appendChild(btn);
            });
            item.appendChild(group);
          }
          box.appendChild(item);
        });
        loose.forEach(t => box.appendChild(textEl('p', 'eg-warn', t)));
        label();
        save.addEventListener('click', () => { shut(); send(warnings.map(w => w.code), marks); });
        const keep = textEl('button', 'secondary eg-secondary', 'Keep editing');
        keep.type = 'button';
        keep.addEventListener('click', shut);
        box.append(save, keep);
      });
    }

    // Another device changed a field the host changed here: theirs or mine, for that field only.
    function conflict(field, message) {
      const swapped = draft.swap && (field === 'teamA' || field === 'teamB');
      const key = swapped ? 'swap' : field;
      // Nothing here to choose between: say why the save stopped rather than nothing at all.
      if (!key || !draft[key]) {
        state.error = message || 'This game was changed on another device. Check it and try again.';
        return draw();
      }
      const group = draft[key].group;
      const keys = group ? Object.keys(draft).filter(k => draft[k].group) : [key];
      const name = LABEL[group ? 'game' : key];
      const b = base();
      const gameLine = (g) => `${g.teamA} @ ${g.teamB}, ${whenText(g.kickoffTime, g.gameDate)}`;
      const sides = (g) => `${g.teamA} down, ${g.teamB} across`;
      const theirs = group ? gameLine(b) : swapped ? sides(b) : shownValue(key, valueOf(b, key));
      const mine = group ? gameLine(merged())
        : swapped ? `${draft.swap.saw.teamB} down, ${draft.swap.saw.teamA} across`
          : shownValue(key, draft[key].value);
      openSheet(`The ${name} ${name === 'teams' || name === 'player picks' ? 'were' : 'was'} changed on another device`, (box, shut) => {
        box.classList.add('eg-sheet');
        box.appendChild(textEl('p', '', `It changed while this form was open. Your other changes are kept.`));
        const pair = el('div', 'eg-pair');
        const choice = (title, value, onPick) => {
          const btn = el('button', 'eg-choice eg-side');
          btn.type = 'button';
          btn.append(textEl('span', '', title), textEl('strong', '', value));
          btn.addEventListener('click', () => { shut(); onPick(); });
          pair.appendChild(btn);
        };
        choice('Keep theirs', theirs, () => {
          keys.forEach(k => delete draft[k]);
          state.message = `Kept the ${name} from the other device: ${theirs}.`;
          draw();
        });
        choice('Use mine', mine, () => {
          keys.forEach(k => {
            if (k === 'swap') draft.swap.saw = { teamA: valueOf(base(), 'teamA'), teamB: valueOf(base(), 'teamB') };
            else draft[k].saw = valueOf(base(), k);
          });
          draw();
          submit();
        });
        box.appendChild(pair);
      });
    }

    async function send(ack, marks) {
      if (busy) return;
      const op = Object.assign(operation(true), { ack });
      if (marks) op.marks = marks;
      busy = true;
      state.error = '';
      state.message = '';
      drawFoot();
      let saved;
      try {
        saved = await SBS.api.patchSettings(base().id, op);
      } catch (e) {
        busy = false;
        if (!root.isConnected) return;
        await refused(e);
        return;
      }
      busy = false;
      if (root.isConnected) opts.onSaved(saved);
    }

    async function refused(e) {
      if (e.forbidden) {
        await SBS.handleForbidden(e, base().id);
        return opts.onClose();
      }
      if (e.status === 404) return SBS.go({ screen: 'home' });
      if (!e.game || !e.code) {
        state.error = 'Could not save: ' + e.message;
        return draw();
      }
      const lost = takeBase(e.game);
      state.message = lost;
      if (e.code === 'illegal') state.error = lost ? '' : e.message;
      else if (e.code !== 'conflict' && e.code !== 'unacked' && e.code !== 'marks') state.error = e.message;
      draw();
      if (lost) return;
      if (e.code === 'conflict') return conflict(e.field, e.message);
      if (e.code === 'unacked' || e.code === 'marks') {
        const p = preview();
        if (!p.empty && !p.error) review(p, { warnings: e.warnings, marks: e.code === 'marks' });
      }
    }

    async function close() {
      if (changedKeys().length && !(await showConfirm('Leave without saving your changes?'))) return;
      opts.onClose();
    }

    // ---------- The form ----------
    function section(title) {
      const s = el('section', 'eg-sec');
      s.appendChild(textEl('h2', '', title));
      body.appendChild(s);
      return s;
    }
    function reason(parent, text) {
      const p = el('p', 'eg-why', LOCK);
      p.appendChild(textEl('span', '', text));
      parent.appendChild(p);
    }
    function field(parent, key, label, type, value, onInput, attrs) {
      const wrap = textEl('label', 'eg-field', '');
      wrap.appendChild(textEl('span', '', label));
      const input = el('input', '');
      input.type = type;
      input.dataset.eg = key;
      Object.keys(attrs || {}).forEach(a => input.setAttribute(a, attrs[a]));
      input.value = value === null || value === undefined ? '' : String(value);
      input.addEventListener('input', () => { onInput(input.value); update(); });
      wrap.appendChild(input);
      parent.appendChild(wrap);
      return wrap;
    }
    function pills(parent, key, label, choices, selected, onPick) {
      const group = el('div', 'eg-pills');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      choices.forEach(([value, text]) => {
        const btn = textEl('button', 'eg-pill', text);
        btn.type = 'button';
        btn.dataset.eg = `${key}-${value}`;
        btn.setAttribute('aria-pressed', String(value === selected));
        btn.addEventListener('click', () => { onPick(value); draw(); });
        group.appendChild(btn);
      });
      parent.appendChild(group);
    }
    function summary(parent, label, lines) {
      const row = el('div', 'eg-summary');
      const text = el('div', '');
      text.appendChild(textEl('span', 'eg-lbl', label));
      lines.filter(Boolean).forEach((l, i) => text.appendChild(textEl('span', i ? 'eg-sub' : 'eg-val', l)));
      row.appendChild(text);
      parent.appendChild(row);
      return row;
    }
    function rowButton(row, key, text, onClick) {
      const btn = textEl('button', 'eg-pill', text);
      btn.type = 'button';
      btn.dataset.eg = key;
      btn.addEventListener('click', onClick);
      row.appendChild(btn);
      return btn;
    }

    function drawHead() {
      head.innerHTML = '';
      const back = el('button', 'icon-btn eg-back', BACK);
      back.type = 'button';
      back.setAttribute('aria-label', 'Back');
      back.addEventListener('click', close);
      const s = stage();
      const chip = { picking: 'Picking', locked: 'Locked', underWay: 'Started', over: 'Final' }[s];
      head.append(back, textEl('h1', '', 'Edit game'), textEl('span', 'eg-chip is-' + s, chip));
    }

    function drawNote() {
      const b = base();
      const s = stage();
      let title;
      let text;
      if (s === 'picking') { title = 'Squares are still open.'; text = 'Everything can change.'; }
      else if (s === 'locked') {
        title = b.kickoffTime && Date.parse(b.kickoffTime) > Date.now() ? `Kickoff is ${formatKickoffTime(b.kickoffTime)}.` : 'The numbers are drawn.';
        text = GL.scoringMode(b) === 'simulation' ? 'You can change most things until then.' : 'You can change most things until the game starts.';
      } else if (s === 'underWay') {
        const q1 = GL.firstQuarterEnded(b);
        title = q1 ? 'The first quarter is over.' : 'The game has started.';
        text = q1 ? 'Price, payouts, numbers and squares are fixed. Scores are fixed on the score pad.' : 'You can still correct the money until Q1 ends.';
      } else { title = 'The game is over.'; text = 'Only a few things can still change.'; }
      const p = el('p', 'eg-note is-' + s);
      p.append(textEl('strong', '', title), document.createTextNode(' ' + text));
      body.appendChild(p);
    }

    function drawGame() {
      const b = base();
      const s = stage();
      const sec = section('Game');
      field(sec, 'description', 'Description', 'text', cur('description'), v => set('description', v.trim() || null), { maxlength: '80' });
      const mode = cur('scoring');
      const fixed = blocked('teamA');
      if (mode === 'live') {
        const row = summary(sec, 'Live game', [`${cur('teamA') || '?'} @ ${cur('teamB') || '?'}`, `${LEAGUE[cur('league')] || ''} · ${whenText(cur('kickoffTime'), cur('gameDate'))}`]);
        if (fixed) reason(sec, fixed);
        else rowButton(row, 'pick-game', 'Change', pickGame).setAttribute('aria-haspopup', 'dialog');
      } else if (fixed) {
        summary(sec, 'Game', [`${b.teamA} @ ${b.teamB}`, `${LEAGUE[b.league] || ''} · ${dayText(b.gameDate)}`]);
        reason(sec, fixed);
      } else {
        const lg = textEl('div', 'eg-field', '');
        lg.appendChild(textEl('span', '', 'League'));
        pills(lg, 'league', 'League', Object.entries(LEAGUE), cur('league'), (v) => {
          set('league', v);
          // Colors are the host's only for "Other"; a listed league takes the team's own.
          Object.keys(COLORS).forEach(k => set(k, v === 'other' ? (valueOf(base(), k) || COLORS[k]) : null));
        });
        sec.appendChild(lg);
        field(sec, 'gameDate', 'Date', 'date', cur('gameDate'), v => { if (v) set('gameDate', v); });
        const two = el('div', 'eg-two');
        [['teamA', 'teamAColor', 'Team A (rows, left side)'], ['teamB', 'teamBColor', 'Team B (columns, top)']].forEach(([k, color, label]) => {
          const box = el('div', '');
          const input = field(box, k, label, 'text', cur(k), v => set(k, v.trim() || (k === 'teamA' ? 'Team A' : 'Team B')), { maxlength: '80' }).querySelector('input');
          input.disabled = !!draft.swap;
          if (cur('league') === 'other') field(box, color, `${k === 'teamA' ? 'Team A' : 'Team B'} color`, 'color', cur(color) || COLORS[color], v => set(color, v)).querySelector('input').disabled = !!draft.swap;
          two.appendChild(box);
        });
        sec.appendChild(two);
      }

      const swapWhy = blocked('swap');
      const a = draft.swap ? cur('teamB') : cur('teamA');
      const z = draft.swap ? cur('teamA') : cur('teamB');
      const row = summary(sec, 'Rows and columns', [`${a} down, ${z} across`]);
      if (swapWhy) reason(sec, swapWhy);
      else if (s !== 'over') {
        const btn = rowButton(row, 'swap', 'Swap', () => { setSwap(!draft.swap); draw(); });
        btn.setAttribute('aria-pressed', String(!!draft.swap));
        // A swap and a change of teams can't be one save.
        btn.disabled = !draft.swap && ['teamA', 'teamB', 'teamAColor', 'teamBColor'].some(k => draft[k]);
      }
    }

    function drawMoney() {
      const s = stage();
      const sec = section('Money');
      const why = blocked('squarePrice');
      if (!why) {
        field(sec, 'squarePrice', 'Square price ($)', 'number', cur('squarePrice'), v => set('squarePrice', parseFloat(v) || 0), { min: '0', step: '0.01', inputmode: 'decimal' });
        const wrap = el('div', 'eg-field');
        wrap.appendChild(textEl('span', '', 'Payouts (% of the pot)'));
        const grid = el('div', 'eg-four');
        const pays = {};
        QUARTERS.forEach(q => {
          const box = field(grid, 'payouts-' + q, QUARTER_NAME[q], 'number', cur('payouts')[q], v => {
            const p = Object.assign({}, cur('payouts'), { [q]: parseFloat(v) || 0 });
            set('payouts', p);
          }, { min: '0', max: '100', inputmode: 'numeric' });
          pays[q] = textEl('span', 'eg-pays', '');
          box.appendChild(pays[q]);
        });
        const total = textEl('span', 'eg-total', '');
        total.setAttribute('role', 'status');
        wrap.append(grid, total);
        sec.appendChild(wrap);
        refreshers.push(() => {
          const m = merged();
          const c = computeGame(m);
          QUARTERS.forEach(q => { pays[q].textContent = money(c.results[q].baseAmount); });
          const sum = QUARTERS.reduce((t, q) => t + (Number(m.payouts[q]) || 0), 0);
          total.textContent = `Total ${sum}%`;
          total.classList.toggle('is-bad', Math.abs(sum - 100) > 0.01);
        });
      } else {
        const c = computeGame(base());
        const grid = el('dl', 'eg-fixed');
        [['Price', '$' + base().squarePrice]].concat(QUARTERS.map(q => [QUARTER_NAME[q], money(c.results[q].baseAmount)])).forEach(([k, v]) => {
          const box = el('div', '');
          box.append(textEl('dt', '', k), textEl('dd', '', v));
          grid.appendChild(box);
        });
        sec.appendChild(grid);
        reason(sec, why);
      }
      // Total pot is set once the board is locked.
      if (s === 'picking') return;
      const potWhy = blocked('potOverride');
      if (potWhy) { summary(sec, 'Total pot', [money(potOf(base()))]); reason(sec, potWhy); return; }
      const shown = cur('potOverride') === null ? Math.round(actualPotOf(merged())) : cur('potOverride');
      const wrap = field(sec, 'potOverride', 'Total pot ($)', 'number', shown, v => {
        const n = Math.round(parseFloat(v));
        // Blank, or the squares sold × price, means no override.
        set('potOverride', Number.isFinite(n) && n >= 0 && n !== Math.round(actualPotOf(merged())) ? n : null);
      }, { min: '0', step: '1', inputmode: 'numeric' });
      const hint = textEl('span', 'eg-hint', '');
      wrap.appendChild(hint);
      const input = wrap.querySelector('input');
      refreshers.push(() => {
        const m = merged();
        hint.textContent = `Only the Final changes. Final pays ${money(computeGame(m).results.final.baseAmount)}.`;
        // A price change moves a pot that follows the squares.
        if (cur('potOverride') === null && document.activeElement !== input) input.value = String(Math.round(actualPotOf(m)));
      });
    }

    function drawScoring() {
      const b = base();
      const s = stage();
      const sec = section('Scoring');
      const now = valueOf(b, 'scoring');
      const whys = {};
      Object.keys(SCORING).forEach(m => { whys[m] = blocked('scoring', m); });
      const open = Object.entries(SCORING).filter(([m]) => !whys[m]);
      if (open.length > 1) {
        pills(sec, 'scoring', 'Scoring', open, cur('scoring'), v => set('scoring', v));
        const shut = [...new Set(Object.values(whys).filter(Boolean))];
        shut.forEach(t => reason(sec, t));
      } else {
        summary(sec, 'Scoring', [SCORING[now]]);
        const why = whys[now === 'live' ? 'manual' : 'live'] || whys.simulation;
        if (why) reason(sec, why);
      }
      const mode = cur('scoring');
      if (mode === 'live' && now !== 'live') sec.appendChild(textEl('p', 'eg-hint', 'Check the live game above: Change picks it from the schedule.'));
      if (mode !== 'manual' || s === 'over') return;
      const why = now === 'manual' ? blocked('kickoffTime') : null;
      if (why) {
        summary(sec, 'Kickoff', [shownValue('kickoffTime', valueOf(b, 'kickoffTime'))]);
        reason(sec, why);
        return;
      }
      const wrap = field(sec, 'kickoffTime', 'Kickoff', 'datetime-local', toLocalInput(cur('kickoffTime')), v => {
        const seen = draft.kickoffTime ? draft.kickoffTime.saw : valueOf(base(), 'kickoffTime');
        // The same minute is the same kickoff: the input drops seconds.
        set('kickoffTime', v === toLocalInput(seen) ? seen : fromLocalInput(v));
      }, { step: '60' });
      wrap.appendChild(textEl('span', 'eg-hint', 'The game counts as started at this time, or at your first score.'));
    }

    function drawPicking() {
      const sec = section('Picking');
      const pm = textEl('div', 'eg-field', '');
      pm.appendChild(textEl('span', '', 'Square pick mode'));
      pills(pm, 'pickMode', 'Square pick mode', Object.entries(PICK_MODE), cur('pickMode'), v => set('pickMode', v));
      sec.appendChild(pm);

      const cut = textEl('div', 'eg-field', '');
      cut.appendChild(textEl('span', '', 'Auto cutoff'));
      pills(cut, 'autoCutoffEnabled', 'Auto cutoff', [[true, 'On'], [false, 'Off']], cur('autoCutoffEnabled'), on => {
        set('autoCutoffEnabled', on);
        if (on && !cur('autoCutoffTime')) set('autoCutoffTime', fromLocalInput(`${cur('gameDate')}T18:45`));
      });
      sec.appendChild(cut);
      if (cur('autoCutoffEnabled')) {
        const wrap = field(sec, 'autoCutoffTime', 'Cutoff date and time', 'datetime-local', toLocalInput(cur('autoCutoffTime')), v => {
          const seen = draft.autoCutoffTime ? draft.autoCutoffTime.saw : valueOf(base(), 'autoCutoffTime');
          set('autoCutoffTime', v === toLocalInput(seen) ? seen : fromLocalInput(v));
        }, { step: '60' });
        wrap.appendChild(textEl('span', 'eg-hint', 'At this time the board locks and the numbers are drawn.'));
      }

      const guest = () => cur('guestPick');
      const setGuest = (patch) => set('guestPick', Object.assign({}, guest(), patch));
      const check = el('label', 'checkbox-label', '<input type="checkbox"> <span>Allow picks in Player View</span>');
      const box = check.querySelector('input');
      box.dataset.eg = 'guest-on';
      box.checked = guest().on;
      box.addEventListener('change', () => { setGuest({ on: box.checked }); draw(); });
      sec.appendChild(check);
      if (!guest().on) return;
      field(sec, 'guest-max', 'Most squares per person', 'number', guest().max, v => setGuest({ max: Number(v) }), { min: '1', max: '100', step: '1' });
      field(sec, 'guest-lift', 'Limit ends at (optional)', 'datetime-local', toLocalInput(guest().liftAt), v => setGuest({ liftAt: fromLocalInput(v) }), { step: '60' });
    }

    function drawSquares() {
      const sec = section('Squares and numbers');
      const sold = base().squares.filter(Boolean).length;
      sec.appendChild(textEl('p', 'eg-text', `${sold} of 100 squares sold. The numbers are drawn.`));
      sec.appendChild(textEl('p', 'eg-hint', stage() === 'locked'
        ? 'Squares can’t be added, and pick settings are closed. Move or remove squares in Players.'
        : 'Pick settings are closed, and the numbers stay as they are.'));
    }

    // The games on a date: picking one sets the teams, league, date and kickoff together.
    function pickGame() {
      openSheet('Which game?', (box, shut) => {
        box.classList.add('eg-sheet');
        let league = cur('league') === 'nba' ? 'nba' : 'nfl';
        let games = [];
        let picked = -1;
        let seq = 0;
        const leagues = el('div', 'eg-pills');
        leagues.setAttribute('role', 'group');
        leagues.setAttribute('aria-label', 'League');
        const dateWrap = el('label', 'eg-field', '<span>Date</span><input type="date">');
        const date = dateWrap.querySelector('input');
        date.value = cur('gameDate') || '';
        const msg = textEl('p', 'eg-hint', '');
        msg.setAttribute('role', 'status');
        const list = el('div', 'eg-games');
        const use = textEl('button', 'eg-primary', 'Pick a game');
        use.type = 'button';
        use.disabled = true;
        const cancel = textEl('button', 'secondary eg-secondary', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', shut);
        ['nfl', 'nba'].forEach(v => {
          const btn = textEl('button', 'eg-pill', LEAGUE[v]);
          btn.type = 'button';
          btn.setAttribute('aria-pressed', String(v === league));
          btn.addEventListener('click', () => {
            league = v;
            leagues.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
            load();
          });
          leagues.appendChild(btn);
        });
        date.addEventListener('change', load);
        box.append(leagues, dateWrap, msg, list,
          textEl('p', 'eg-warn', 'Squares stay as they are. The score will come from the game you pick.'), use, cancel);

        async function load() {
          const mine = ++seq;
          picked = -1;
          games = [];
          list.innerHTML = '';
          use.disabled = true;
          use.textContent = 'Pick a game';
          if (!date.value) { msg.textContent = 'Choose a date.'; return; }
          msg.textContent = 'Looking for games…';
          let found;
          try {
            found = (await SBS.api.getTodaysGames(date.value, league)).games || [];
          } catch (e) {
            if (mine === seq) msg.textContent = 'The score feed is not available right now.';
            return;
          }
          if (mine !== seq) return;
          games = found;
          msg.textContent = games.length ? '' : `There are no ${LEAGUE[league]} games on this date.`;
          games.forEach((g, i) => {
            const btn = el('button', 'eg-choice');
            btn.type = 'button';
            const linked = g.teamA === base().teamA && g.teamB === base().teamB && date.value === base().gameDate;
            btn.append(textEl('strong', '', `${g.teamA} @ ${g.teamB}`), textEl('span', 'eg-sub', whenText(g.date, date.value) + (linked ? ', linked now' : '')));
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', () => {
              picked = i;
              list.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
              use.disabled = false;
              use.textContent = 'Use this game';
            });
            list.appendChild(btn);
          });
        }

        use.addEventListener('click', () => {
          const g = games[picked];
          if (!g) return;
          const oldAuto = `${cur('teamA')} @ ${cur('teamB')}`;
          const followed = cur('description') === oldAuto;
          setSwap(false);
          const values = { teamA: g.teamA, teamB: g.teamB, league, gameDate: date.value, kickoffTime: g.date || null, teamAColor: null, teamBColor: null };
          GAME_GROUP.forEach(k => { set(k, values[k]); if (draft[k]) draft[k].group = true; });
          if (followed) set('description', `${g.teamA} @ ${g.teamB}`);
          if (stage() === 'picking') {
            set('scoring', 'live');
            // The board locks at kickoff unless the host says otherwise.
            if (g.date && Date.parse(g.date) > Date.now()) { set('autoCutoffEnabled', true); set('autoCutoffTime', new Date(g.date).toISOString()); }
          }
          shut();
          draw();
        });
        load();
      });
    }

    function drawFoot() {
      const p = preview();
      const had = foot.contains(document.activeElement);
      foot.innerHTML = '';
      const error = state.error || p.error;
      if (error) {
        const e = textEl('p', 'eg-error', error);
        e.setAttribute('role', 'alert');
        foot.appendChild(e);
      }
      if (state.message) {
        const m = textEl('p', 'eg-message', state.message);
        m.setAttribute('role', 'status');
        foot.appendChild(m);
      }
      let label = 'No changes yet';
      if (!p.empty) {
        const n = p.after ? changeRows(p.after).length : 0;
        label = busy ? 'Saving…' : p.after && (p.warnings.length || p.needsMarks || p.disturbed.length) ? (n === 1 ? 'Review 1 change' : `Review ${n} changes`) : 'Save';
      }
      const btn = textEl('button', 'eg-primary', label);
      btn.type = 'button';
      btn.dataset.eg = 'submit';
      btn.disabled = busy || !!p.empty || !!p.error;
      btn.addEventListener('click', submit);
      foot.appendChild(btn);
      if (had && !btn.disabled) btn.focus();
    }

    // While the host types: the amounts and the button, never the inputs themselves.
    function update() {
      refreshers.forEach(fn => fn());
      drawFoot();
    }

    function draw() {
      const act = document.activeElement;
      const key = act && root.contains(act) ? act.dataset.eg : null;
      const top = body.scrollTop;
      const y = window.scrollY;
      refreshers = [];
      body.innerHTML = '';
      drawHead();
      drawNote();
      drawGame();
      drawMoney();
      drawScoring();
      if (stage() === 'picking') drawPicking(); else drawSquares();
      update();
      body.scrollTop = top;
      if (!opts.panel) window.scrollTo(0, y);
      const again = key && root.querySelector(`[data-eg="${key}"]`);
      if (again) again.focus({ preventScroll: true });
    }

    draw();
    return { el: root, close };
  }

  // Opens the form on the board as it is now. `from` is where saving and Back return to.
  async function open(id, from) {
    let game;
    try {
      game = await SBS.api.getGame(id);
    } catch (e) {
      SBS.ui.showAlert('Could not open Edit game: ' + e.message);
      return;
    }
    SBS.go({ screen: 'editGame', game, from });
  }

  function renderEdit(route) {
    const app = SBS.appEl;
    if (!route.state) route.state = newState(route.game);
    applyTeamColors(route.state.base);
    app.innerHTML = '';
    app.classList.remove('fit-screen');
    const home = () => SBS.go({ screen: 'home' });
    const form = create({
      state: route.state,
      onSaved: (game) => (route.from === 'home' ? home() : SBS.openGame(game)),
      onClose: async () => {
        if (route.from === 'home') return home();
        try { SBS.openGame(await SBS.api.getGame(route.game.id)); } catch (e) { home(); }
      }
    });
    app.appendChild(form.el);
  }

  const PENCIL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"></path><path d="M13.5 6.5l4 4"></path></svg>';

  // The "Edit game" button in a board screen's top bar.
  function barButton(iconOnly, onClick) {
    const b = el('button', 'gd-bar-btn gd-edit' + (iconOnly ? ' gd-icon-only' : ''), PENCIL + (iconOnly ? '' : '<span>Edit game</span>'));
    b.type = 'button';
    b.title = 'Edit game';
    b.setAttribute('aria-label', 'Edit game');
    b.addEventListener('click', onClick);
    return b;
  }

  SBS.editForm = { create, newState, open, barButton };
  SBS.screens.editGame = renderEdit;
})();
