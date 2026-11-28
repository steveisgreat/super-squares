// The Players tab in Player View (R44): everyone A to Z, this phone's name pinned on top, and each
// player's squares with "This is me". A squares manager (R38, decision 025) also gets, in this same
// tab: what is still to collect, add squares for someone, player picks, who has paid, and removing
// squares nobody paid for. After the lock only the paid marks work. Every managing tap is one
// operation the server checks against the board as it is then, and none needs the helper's own name
// or a square of theirs.
(function () {
  'use strict';

  const SBS = window.SBS;
  const { el, textEl, escapeHtml, money, showConfirm, openSheet } = SBS.ui;
  const { playerSummaries, openPaymentBox, payState, PAY_WORD } = SBS.players;
  const { cutoffPassed, guestCap, nameKey, computeGame } = window.GameLogic;
  const SEARCH_PAST = 8; // names

  const sq = (n) => `${n} square${n === 1 ? '' : 's'}`;

  function button(cls, html, onClick) {
    const b = el('button', cls, html);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // opts: { getGame(), setGame(g), patch(op) -> { game, name }, reload() -> newest board or null,
  // onError(e) -> true when it dealt with it, canManage(), me() -> the name this phone shows,
  // elsewhere(name) -> another phone picked it, choose(name) }.
  function create(opts) {
    const root = el('div', 'pm-tab player-pane');
    const status = el('div', 'pm-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const body = el('div', 'pm-body');
    // The search box stays outside the parts that are rebuilt, so typing survives a poll.
    const top = el('div', 'pm-body');
    const search = el('label', 'ph-search', '<span>Find a player</span>');
    const query = el('input', '');
    query.type = 'search';
    query.autocomplete = 'off';
    query.addEventListener('input', () => draw());
    search.appendChild(query);
    root.append(top, search, body, status);

    let filter = 'all';
    let openName = null; // whose panel is open
    let saving = false;
    let sheet = null;    // the last sheet opened: { close, isShown, update }
    let sig = null;

    const isOpen = () => opts.getGame().status === 'picking' && !cutoffPassed(opts.getGame(), Date.now());
    const price = () => parseFloat(opts.getGame().squarePrice) || 0;

    function say(text, undo) {
      status.replaceChildren();
      status.hidden = !text;
      if (!text) return;
      status.appendChild(textEl('span', '', text));
      if (undo) status.appendChild(button('secondary pm-undo', 'Undo', () => run(undo, () => 'Undone.')));
    }

    // One operation. Resolves to null when saved (or dealt with elsewhere), else the message.
    // `done(answer)` gives the words for it, or [words, the operation that undoes it].
    async function run(op, done) {
      if (saving) return 'Still saving. Try again.';
      saving = true;
      say('');
      let refused = null;
      let r = null;
      try {
        r = await opts.patch(op);
      } catch (e) {
        if (opts.onError(e)) {
          saving = false;
          closeSheet();
          return null;
        }
        refused = e.message || 'That could not be saved.';
        // No answer may mean it was saved. A sheet left open would send it again against the fresh
        // board, so it closes and the helper looks first.
        if (!e.status || e.status >= 500) {
          closeSheet();
          refused += ' Check the list before you try again.';
        }
        // The board as it is now: someone else changed it, or the answer was lost on the way.
        const fresh = await opts.reload();
        if (fresh) opts.setGame(fresh);
      }
      saving = false;
      if (r) opts.setGame(r.game);
      if (refused) { say(refused); return refused; }
      const words = done(r);
      if (Array.isArray(words)) say(words[0], words[1]); else say(words);
      return null;
    }

    const paidOp = (p, n) => ({ op: 'paid', name: p.name, paidSquares: n, have: p.count, was: p.paidCount });
    const markPaid = (p, n) => run(paidOp(p, n), () => [
      n === p.count ? `${p.name} is paid up.` : n === 0 ? `${p.name} is marked unpaid.` : `${p.name}: ${n} of ${p.count} paid.`,
      { op: 'paid', name: p.name, paidSquares: p.paidCount, have: p.count, was: n }
    ]);
    const payBox = (p) => openPaymentBox(p, price(), (n) => markPaid(p, n), () => focusKey(`more:${p.name}`));
    const focusKey = (key) => { const n = Array.from(root.querySelectorAll('[data-k]')).find(x => x.dataset.k === key); if (n) n.focus(); };

    async function removeUnpaid(p) {
      if (!(await showConfirm(`Remove ${p.name}'s ${sq(p.unpaidCount)} not paid for? They open up for someone else. ${p.paidCount ? 'Paid squares stay.' : `${p.name} has no other squares.`}`))) return;
      await run({ op: 'removeUnpaid', name: p.name, have: p.count, unpaid: p.unpaidCount }, () => {
        openName = null;
        draw();
        return `${p.name}: ${sq(p.unpaidCount)} removed.`;
      });
      focusKey(`more:${p.name}`);
    }

    // ----- player picks -----
    function pickState() {
      const g = opts.getGame();
      const gp = g.guestPick || { on: false, max: 5 };
      const cap = guestCap(g, Date.now());
      return { on: gp.on === true, max: gp.max, limited: cap !== Infinity,
        text: gp.on !== true ? 'Off. Only the host and you add squares.' : cap === Infinity ? 'On, no limit per person.' : `On, up to ${sq(gp.max)} each.` };
    }
    function togglePicks() {
      const s = pickState();
      run({ op: 'picks', on: !s.on }, () => [s.on ? 'Players can no longer pick their own.' : 'Players can pick their own squares.', { op: 'picks', on: s.on }])
        .then(() => focusKey('picks'));
    }
    function openLimit() {
      const s = pickState();
      let n = s.max;
      let isShown = null;
      const close = openSheet('Limit per person', (box, shut) => {
        isShown = () => box.isConnected;
        const step = stepper('Squares each', () => n, (v) => { n = v; }, 1, () => 100);
        const err = errorLine();
        const save = button('', 'Save', async () => {
          if (n === s.max) return shut();
          const refused = await run({ op: 'picks', max: n }, () => [`Up to ${sq(n)} each.`, { op: 'picks', max: s.max }]);
          if (!refused) { shut(); return focusKey('limit'); }
          err.say(refused);
          box.focus();
        });
        box.append(step.el, err.el, actions(button('secondary', 'Cancel', shut), save));
      });
      sheet = { close, isShown, update() { if (!isOpen()) closeSheet(); } };
    }

    function stepper(label, get, set, min, max) {
      const row = el('div', 'pay-row');
      row.appendChild(textEl('span', '', label));
      const box = el('div', 'pay-step');
      const value = textEl('span', 'pay-count', '');
      value.setAttribute('role', 'status');
      const less = button('secondary', '&minus;', () => { set(get() - 1); sync(); });
      less.setAttribute('aria-label', 'One less');
      const more = button('secondary', '+', () => { set(get() + 1); sync(); });
      more.setAttribute('aria-label', 'One more');
      box.append(less, value, more);
      row.appendChild(box);
      function sync() {
        if (get() > max()) set(Math.max(min, max()));
        value.textContent = String(get());
        less.disabled = get() <= min;
        more.disabled = get() >= max();
      }
      sync();
      return { el: row, sync };
    }
    function errorLine() {
      const p = el('p', 'error-msg');
      p.setAttribute('role', 'alert');
      p.hidden = true;
      return { el: p, say(text) { p.textContent = text || ''; p.hidden = !text; } };
    }
    function actions(...items) {
      const row = el('div', 'pm-actions');
      row.append(...items);
      return row;
    }
    function closeSheet() {
      if (sheet) sheet.close();
      sheet = null;
    }

    // ----- add squares for someone -----
    // `forName` is someone on the board, chosen from the list; without it the name is typed.
    function openAdd(forName) {
      const g0 = opts.getGame();
      const mode = g0.pickMode || 'both';
      let count = 1;
      let picking = false; // the grid is showing
      let chosen = [];
      let isShown = null;
      let sync = null;
      const close = openSheet(forName ? `Add squares for ${forName}` : 'Add squares for someone', (box, shut) => {
        isShown = () => box.isConnected;
        const openSquares = () => opts.getGame().squares.filter(s => !s).length;
        const form = el('div', 'pm-form');
        const grid = el('div', 'pm-form');
        grid.hidden = true;
        const err = errorLine();

        const label = el('label', 'pm-name', 'Name');
        const input = el('input', '');
        input.type = 'text';
        input.maxLength = 10;
        input.autocomplete = 'off';
        input.setAttribute('autocapitalize', 'words');
        label.appendChild(input);
        const who = el('p', 'pm-who');
        who.setAttribute('role', 'status');
        const twins = el('div', 'helpers-people');

        // Who the typed name means on the board as it is now: someone there, or someone new.
        let picked = forName || null; // one of several people with much the same name
        function person() {
          const held = Object.create(null);
          opts.getGame().squares.forEach(s => { if (s) held[s.name] = (held[s.name] || 0) + 1; });
          const typed = forName || input.value.trim().replace(/\s+/g, ' ');
          if (!typed) return { name: '', have: 0, same: [] };
          if (held[typed]) return { name: typed, have: held[typed], same: [] };
          const same = forName ? [] : Object.keys(held).filter(n => nameKey(n) === nameKey(typed)).sort();
          const name = same.length === 1 ? same[0] : same.includes(picked) ? picked : same.length ? '' : typed;
          return { name, have: held[name] || 0, same };
        }

        const step = stepper('How many squares', () => count, (v) => { count = v; }, 1, openSquares);
        const auto = button('', 'Pick for them', () => save({ count }));
        const point = button(mode === 'auto' ? '' : 'secondary', 'Let them point at the grid', () => { picking = true; err.say(''); sync(); });
        form.append(label, who, twins, step.el, ...(mode === 'manual' ? [] : [auto]), ...(mode === 'auto' ? [] : [point]), button('secondary', 'Cancel', shut));
        label.hidden = !!forName;
        if (mode === 'manual') step.el.hidden = true;

        const cells = el('div', 'gp-board');
        cells.setAttribute('role', 'group');
        cells.setAttribute('aria-label', 'Open squares');
        const cellButtons = [];
        for (let i = 0; i < 100; i++) {
          const b = button('gp-cell', '', () => {
            chosen = chosen.includes(i) ? chosen.filter(x => x !== i) : chosen.concat(i);
            sync();
          });
          cellButtons.push(b);
          cells.appendChild(b);
        }
        const addChosen = button('', '', () => save({ squares: chosen.slice() }));
        grid.append(cells, addChosen, button('secondary', 'Back', () => { picking = false; err.say(''); sync(); }));
        box.append(form, grid, err.el);

        async function save(what) {
          const p = person();
          if (!p.name) return;
          lock(true);
          const refused = await run(Object.assign({ op: 'claim', name: p.name, have: p.have }, what), (r) => `${r.name}: ${sq(what.count || what.squares.length)} added.`);
          lock(false);
          if (!refused) { shut(); return focusKey(forName ? `more:${forName}` : 'add'); }
          if (!box.isConnected) return; // the board locked meanwhile: the page says why
          err.say(refused);
          say('');
          sync();
          box.focus(); // the button just tapped was disabled meanwhile
        }
        function lock(on) {
          auto.disabled = point.disabled = addChosen.disabled = on;
        }
        sync = () => {
          const g = opts.getGame();
          const p = person();
          const some = openSquares();
          step.sync();
          who.textContent = p.same.length > 1 && !p.have ? 'Who do you mean?'
            : p.have ? `${p.name} has ${sq(p.have)}. These are added to theirs.${forName ? '' : ' Someone else? Add a last initial.'}` : '';
          who.hidden = !who.textContent;
          twins.replaceChildren(...(p.same.length > 1 ? p.same.map(n => {
            const c = button('helpers-chip', escapeHtml(n), () => { picked = n; sync(); });
            c.setAttribute('aria-pressed', String(n === p.name));
            return c;
          }) : []));
          twins.hidden = p.same.length < 2;
          auto.disabled = saving || !p.name || !some;
          point.disabled = saving || !p.name || !some;
          form.hidden = picking;
          grid.hidden = !picking;
          const lost = chosen.filter(i => g.squares[i] && g.squares[i].name !== p.name);
          chosen = chosen.filter(i => !g.squares[i]);
          if (lost.length) err.say(`${sq(lost.length)} you chose ${lost.length === 1 ? 'was' : 'were'} just taken.`);
          cellButtons.forEach((b, i) => {
            const s = g.squares[i];
            const sel = chosen.includes(i);
            b.className = 'gp-cell ' + (s ? (s.name === p.name ? 'is-mine' : 'is-other') : sel ? 'is-sel' : 'is-open');
            b.disabled = !!s;
            b.setAttribute('aria-pressed', String(sel));
            b.setAttribute('aria-label', `Row ${Math.floor(i / 10) + 1}, column ${i % 10 + 1}, ${s ? s.name : sel ? 'chosen' : 'open'}`);
          });
          addChosen.textContent = chosen.length ? `Add ${sq(chosen.length)} for ${p.name}` : `Tap the squares for ${p.name}`;
          addChosen.disabled = saving || !chosen.length || !p.name;
        };
        input.addEventListener('input', () => { picked = null; err.say(''); sync(); });
        sync();
        if (!forName) input.focus();
      });
      sheet = { close, isShown, update() { if (!isOpen()) { closeSheet(); say('The board was just locked.'); } else sync(); } };
    }

    // ----- the page -----
    function draw() {
      const g = opts.getGame();
      const manage = opts.canManage();
      const open = isOpen();
      const live = g.status === 'started' || g.status === 'finished';
      const all = playerSummaries(g);
      const owing = all.filter(p => p.unpaidCount > 0);
      const owed = all.reduce((t, p) => t + p.owed, 0);
      const taken = all.reduce((t, p) => t + p.count, 0);
      const pick = pickState();
      const me = opts.me();
      if (openName && !all.some(p => p.name === openName)) openName = null;
      // The job was taken away: what only a manager may do closes with it.
      if (!manage && (sheet || status.firstChild)) { filter = 'all'; closeSheet(); say(''); }
      search.hidden = all.length <= SEARCH_PAST;
      const q = search.hidden ? '' : query.value.trim().toLowerCase();
      const computed = live ? computeGame(g) : null;
      const rows = all.map(p => Object.assign({}, p, {
        squares: SBS.playerHome.squaresOf(g, p.name),
        won: computed ? SBS.playerHome.totalWon(computed, p.name) : 0,
        away: opts.elsewhere(p.name)
      }));
      const next = JSON.stringify([manage, open, g.status, g.squarePrice, g.pickMode, g.axisX, g.axisY, filter, openName, pick, rows, me, q]);
      if (next === sig) return;
      sig = next;
      const focused = root.contains(document.activeElement) ? document.activeElement.dataset.k : null;
      const key = (b, k) => { b.dataset.k = k; return b; };
      const head = [];

      if (manage) {
        head.push(el('div', 'money-boxes', `
          <div class="money-box"><span class="lbl">Still to collect</span><span class="val${owed > 0 ? ' is-owed' : ' is-good'}">${escapeHtml(money(owed))}</span></div>
          <div class="money-box"><span class="lbl">Squares taken</span><span class="val">${taken} of 100</span></div>`));
        if (open) {
          const add = key(button('pm-add', 'Add squares for someone', () => openAdd(null)), 'add');
          add.disabled = taken >= 100;
          head.push(add);
          const row = el('div', 'pm-picks');
          const text = el('div', 'pm-picks-text');
          text.append(textEl('strong', '', 'Players pick their own'), textEl('span', '', pick.text));
          row.appendChild(text);
          if (pick.on && pick.limited) {
            const limit = key(button('secondary pm-limit', 'Limit', openLimit), 'limit');
            limit.setAttribute('aria-label', `Limit per person, now ${pick.max}. Change`);
            row.appendChild(limit);
          }
          const sw = key(button('helpers-switch', '<span aria-hidden="true"></span>', togglePicks), 'picks');
          sw.setAttribute('role', 'switch');
          sw.setAttribute('aria-checked', String(pick.on));
          sw.setAttribute('aria-label', 'Players pick their own squares');
          row.appendChild(sw);
          head.push(row);
        } else {
          head.push(textEl('p', 'pm-note', g.status === 'setup' ? "Picking isn't open yet." : "The board is locked, so squares can't move. You can still mark people paid."));
        }
        const tabs = el('div', 'pm-filter choice-strip');
        tabs.setAttribute('role', 'group');
        tabs.setAttribute('aria-label', 'Show');
        [['all', `Everyone (${all.length})`], ['owes', `Owes money (${owing.length})`]].forEach(([k, words]) => {
          const b = key(button('pm-filter-btn', words, () => { filter = k; draw(); }), `show:${k}`);
          b.setAttribute('aria-pressed', String(filter === k));
          tabs.appendChild(b);
        });
        head.push(tabs);
      }
      top.replaceChildren(...head);
      top.hidden = !head.length;

      // This phone's name is pinned on top; everyone else stays A to Z.
      const shown = rows.filter(p => (filter !== 'owes' || p.unpaidCount > 0) && p.name.toLowerCase().includes(q))
        .sort((a, b) => (b.name === me) - (a.name === me));
      const list = el('div', 'pm-list');
      const none = !all.length ? 'No squares picked yet.' : q ? 'No name matches.' : 'Nobody owes money.';
      if (!shown.length) list.appendChild(textEl('p', 'player-muted', none));
      shown.forEach(p => list.appendChild(person(p, { manage, open, live, me }, key)));
      body.replaceChildren(list);
      if (focused) focusKey(focused);
    }

    function person(p, at, key) {
      const { manage, open } = at;
      const isMe = p.name === at.me;
      const card = el('div', 'pm-person' + (isMe ? ' is-me' : ''));
      const row = el('div', 'pm-row');
      const isShown = openName === p.name;
      const line = [sq(p.count)];
      if (at.live) line.push(`${money(p.won)} won`);
      // Money owed and paid is the manager's business only.
      if (manage) line.push(p.unpaidCount ? `owes ${money(p.owed)}` : `${money(p.total)} paid`);
      const info = key(button('pm-info', '', () => { openName = isShown ? null : p.name; draw(); }), `more:${p.name}`);
      const name = textEl('strong', '', p.name);
      if (isMe) name.appendChild(textEl('em', 'pm-you', 'You'));
      info.append(name, textEl('span', '', line.join(', ')));
      if (p.away) info.appendChild(textEl('span', 'pm-away', 'Picked on another phone'));
      info.setAttribute('aria-expanded', String(isShown));
      row.appendChild(info);
      if (manage) {
        const st = payState(p);
        const pill = key(button(`paid-pill is-${st === 'none' ? 'unpaid' : st}`, PAY_WORD[st], () => {
          if (st === 'part') payBox(p); else markPaid(p, st === 'paid' ? 0 : p.count);
        }), `pill:${p.name}`);
        pill.setAttribute('aria-label', st === 'part' ? `${p.name}: part paid, ${p.paidCount} of ${p.count}. Change`
          : `${p.name}: ${st === 'paid' ? 'paid. Mark unpaid' : 'unpaid. Mark paid'}`);
        row.appendChild(pill);
      }
      card.appendChild(row);
      if (!isShown) return card;

      const panel = el('div', 'pm-panel');
      const squares = el('ul', 'pm-squares');
      p.squares.forEach(i => squares.appendChild(el('li', '', SBS.playerHome.squareHtml(opts.getGame(), i))));
      panel.appendChild(squares);
      if (!isMe && !p.away) {
        panel.appendChild(key(button('', 'This is me', () => { opts.choose(p.name); focusKey(`more:${p.name}`); }), `me:${p.name}`));
      }
      card.appendChild(panel);
      if (!manage) return card;

      if (p.count > 1) panel.appendChild(key(button('secondary', 'Part payment', () => payBox(p)), `part:${p.name}`));
      if (open) {
        const add = key(button('secondary', `Add squares for ${escapeHtml(p.name)}`, () => openAdd(p.name)), `add:${p.name}`);
        add.disabled = !opts.getGame().squares.some(s => !s);
        panel.appendChild(add);
      }
      if (open && p.unpaidCount) {
        panel.appendChild(key(button('danger', `Remove ${p.unpaidCount} unpaid`, () => removeUnpaid(p)), `remove:${p.name}`));
        panel.appendChild(textEl('p', 'player-muted', p.paidCount ? 'Paid squares stay.' : 'Their squares open up for someone else.'));
      } else {
        panel.appendChild(textEl('p', 'player-muted', open ? 'Paid squares stay put. Ask the host to move them.' : "Squares can't move after the board is locked."));
      }
      return card;
    }

    return {
      el: root,
      update() { draw(); if (sheet && sheet.isShown()) sheet.update(); },
      busy: () => saving,
      close: closeSheet,
      clearUndo: () => { if (status.querySelector('.pm-undo')) say(''); } // another device saved meanwhile
    };
  }

  SBS.playersTab = { create };
})();
