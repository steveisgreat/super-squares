// Player View's Home tab (R44), and the pieces beside it: what a square shows, the quarter
// winners, the Live tab and the rules sheet. screen-player.js owns the tabs, the poll and who
// this phone says it is; nothing here talks to the server or changes the board.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, escapeHtml, money, openSheet, teamAbbr, teamStyle, formatKickoffTime } = SBS.ui;
  const { QUARTERS, QLABEL, computeGame, computeLiveHighlight, drawnDigits, owedSummary, guestCap, scoringMode } = window.GameLogic;

  const WON_WORD = { q1: 'Q1', q2: 'Half', q3: 'Q3', final: 'Final' };
  // A quarter in a sentence: "You won the half".
  const WON_PHRASE = { q1: 'Q1', q2: 'the half', q3: 'Q3', final: 'the Final' };
  const sq = (n) => `${n} square${n === 1 ? '' : 's'}`;
  const isLocked = (game) => game.status === 'started' || game.status === 'finished';

  // True once the server has (or will) auto-update this game's score — a real
  // ESPN feed found a match, or the host turned on Simulation Mode. When
  // neither is true, the host is typing quarter scores in by hand.
  function isAutoScored(game) {
    return !!(game.simulation || game.liveScore);
  }

  // The host is the one entering the score, so there is no live play to follow.
  function scoredByHand(game) {
    return scoringMode(game) === 'manual' || !isAutoScored(game) || !!(game.liveScore && game.liveScore.manual);
  }

  // Every quarter this player has won so far. A pushed quarter has no winner of its own
  // (its payout rolls into whichever quarter is scored next, see compute.js).
  function totalWon(computed, name) {
    if (!name) return 0;
    return QUARTERS.reduce((sum, q) => {
      const res = computed.results[q];
      return (res.resolved && !res.pushed && res.winnerName === name) ? sum + res.amount : sum;
    }, 0);
  }

  function squaresOf(game, name) {
    return game.squares.map((s, i) => (name && s && s.name === name ? i : -1)).filter(i => i >= 0);
  }

  // "TM1 # | # TM2" — the two digits (the actual score that matters) set off
  // in the accent color so they read at a glance against the team abbreviations.
  function coordHtml(game, idx) {
    const row = Math.floor(idx / 10), col = idx % 10;
    const abbrA = teamAbbr(game.teamA, teamStyle(game, 'A').meta);
    const abbrB = teamAbbr(game.teamB, teamStyle(game, 'B').meta);
    const y = game.axisY ? game.axisY[row] : '–';
    const x = game.axisX ? game.axisX[col] : '–';
    return `<span class="coord-team">${escapeHtml(abbrA)}</span> `
      + `<span class="coord-num">${escapeHtml(String(y))}</span>`
      + `<span class="coord-sep">|</span>`
      + `<span class="coord-num">${escapeHtml(String(x))}</span> `
      + `<span class="coord-team">${escapeHtml(abbrB)}</span>`;
  }

  // A square as a list shows it: where it is before the lock, its digit pair after.
  function squareHtml(game, idx) {
    return isLocked(game) ? coordHtml(game, idx) : `Row ${Math.floor(idx / 10) + 1} &middot; Column ${idx % 10 + 1}`;
  }

  // One word for a square after the lock, or none when there is nothing to say yet (before
  // the first score, or between quarters on a board scored by hand).
  function squareWord(game, computed, live, idx) {
    const key = `${Math.floor(idx / 10)}-${idx % 10}`;
    if (live && live.winnerKey === key) return { text: 'Winning', cls: 'status-winning' };
    const won = QUARTERS.filter(q => {
      const r = computed.results[q];
      return r.resolved && !r.pushed && r.winnerName && r.row * 10 + r.col === idx;
    });
    if (won.length) return { text: `Won ${won.map(q => WON_WORD[q]).join(', ')}`, cls: 'status-winning' };
    if (live && live.nearKeys.has(key)) return { text: 'Close', cls: 'status-threat' };
    if (live || game.status === 'finished') return { text: 'Out', cls: 'status-dormant' };
    return null;
  }

  // `opts`: title; payouts: say what a quarter still to come will pay.
  function winnersCard(game, computed, me, opts) {
    const o = opts || {};
    const card = el('div', 'card player-card');
    const scoredByHost = scoringMode(game) === 'manual' ? '<span class="player-card-sub player-scored-by">scored by host</span>' : '';
    card.innerHTML = `<div class="player-card-head"><span class="player-card-title">${o.title || 'Game Winners'}</span>${scoredByHost}</div>`;
    const rows = el('div', 'player-history');
    QUARTERS.forEach(q => {
      const res = computed.results[q];
      const label = q === 'final' ? 'FINAL' : QLABEL[q];
      let scoreTxt = '– : –';
      if (res.a !== null && res.b !== null) scoreTxt = `${res.a} - ${res.b}`;
      let winnerTxt, winnerCls = '';
      if (res.a === null || res.b === null) {
        winnerTxt = 'Not yet'; winnerCls = 'ph-pending';
      } else if (res.resolved && res.pushed) {
        winnerTxt = SBS.board.pushText(computed.results, q); winnerCls = 'ph-push';
      } else if (res.resolved && res.winnerName) {
        const mine = res.winnerName === me;
        winnerTxt = `${escapeHtml(res.winnerName)} &middot; ${money(res.amount)}`;
        if (res.autoResolved) {
          const digits = drawnDigits(game, res);
          if (digits) winnerTxt += ` <span class="ph-drawn">(Drawn ${escapeHtml(digits.y)}-${escapeHtml(digits.x)})</span>`;
        }
        winnerCls = mine ? 'ph-mine' : 'ph-live';
      } else if (q === 'final' && res.needsDraw) {
        winnerTxt = 'Awaiting draw'; winnerCls = 'ph-pending';
      } else {
        winnerTxt = 'In progress'; winnerCls = 'ph-pending';
      }
      if (o.payouts && !res.resolved) winnerTxt += ` &middot; pays ${money(res.amount)}`;
      rows.appendChild(el('div', 'player-history-row', `
        <div class="ph-q">${label}</div>
        <div class="ph-score">${scoreTxt}</div>
        <div class="ph-winner ${winnerCls}">${winnerTxt}</div>`));
    });
    card.appendChild(rows);
    return card;
  }

  // ----- the Live tab -----
  // Who would be paid if the quarter ended now, who is one likely score away, then every quarter.
  // A board scored by hand shows the quarters only.
  function liveCards(game, me) {
    const computed = computeGame(game);
    const cards = [];
    const live = scoredByHand(game) ? null : computeLiveHighlight(game);
    const q = QUARTERS.find(k => computed.results[k].a === null || computed.results[k].b === null);
    const at = (key) => {
      const [row, col] = key.split('-').map(Number);
      const idx = row * 10 + col;
      return { idx, name: game.squares[idx] ? game.squares[idx].name : null };
    };
    const rowHtml = (key) => {
      const s = at(key);
      const mine = !!me && s.name === me;
      return `<div class="player-square-item pl-row${mine ? ' is-mine' : ''}">
        <div class="pl-who"><strong>${s.name ? escapeHtml(s.name) : 'Open square'}</strong>${mine ? ' <span class="pl-you">Yours</span>' : ''}</div>
        <div class="psi-coord">${coordHtml(game, s.idx)}</div></div>`;
    };
    if (live && q) {
      const res = computed.results[q];
      const empty = !at(live.winnerKey).name;
      const label = q === 'final' ? 'The Final' : WON_PHRASE[q].replace(/^the half$/, 'The half');
      const pays = !empty ? `${label} would pay ${money(res.amount)} if it ended now.`
        : q === 'final' ? `Nobody holds it: if the game ended now, the winner of ${money(res.amount)} would be drawn.`
          : `Nobody holds it: if ${WON_PHRASE[q]} ended now, ${money(res.amount)} would roll over.`;
      cards.push(el('div', 'card player-card pl-now', `<div class="player-card-head"><span class="player-card-title">Winning now</span></div>
        <div class="player-square-list">${rowHtml(live.winnerKey)}</div><p class="pl-pays">${pays}</p>`));
      if (live.nearKeys.size) {
        cards.push(el('div', 'card player-card pl-near', `<div class="player-card-head"><span class="player-card-title">One score away</span></div>
          <div class="player-square-list">${Array.from(live.nearKeys).map(rowHtml).join('')}</div>`));
      }
    }
    cards.push(winnersCard(game, computed, me, { title: 'Quarters', payouts: true }));
    return cards;
  }

  // ----- rules and payouts -----
  function openRules(game) {
    openSheet('Rules and payouts', (box, shut) => {
      box.classList.add('ph-rules');
      const computed = computeGame(game);
      const price = parseFloat(game.squarePrice) || 0;
      const claimed = game.squares.filter(Boolean).length;
      const edited = game.potOverride !== null && game.potOverride !== undefined && game.potOverride !== '';
      const pct = game.payouts || { q1: 25, q2: 25, q3: 25, final: 25 };
      box.appendChild(textEl('p', '', `${money(price)} a square. Pot: ${money(computed.pot)}, with ${claimed} of 100 squares claimed.`
        + (!isLocked(game) && !edited ? ` A full board is ${money(price * 100)}; payouts grow as squares are claimed.` : '')));
      const list = el('dl', 'ph-split');
      QUARTERS.forEach(q => {
        const share = q === 'final' && edited ? 'the rest of the pot' : `${parseFloat(pct[q]) || 0}%`;
        list.append(textEl('dt', '', `${q === 'q2' ? 'Half' : WON_WORD[q]} · ${share}`), textEl('dd', '', money(computed.results[q].baseAmount)));
      });
      box.append(list,
        textEl('p', '', 'The last digit of each team’s score picks the winning square. The Final score includes overtime.'),
        textEl('p', '', 'If nobody holds the winning square for Q1, the half or Q3, that payout rolls over to the next quarter scored. If nobody holds the Final square, the host draws a winner at random from the claimed squares.'),
        textEl('p', 'ph-host-pays', 'The host collects and pays, never the app.'),
        button('', 'Done', shut));
    });
  }

  // "Kickoff in 3 days 4 hours"; redrawn by the page's one-second clock.
  function countdownText(game) {
    const at = Date.parse(game.kickoffTime || '');
    if (isNaN(at)) return 'The board locks in soon.';
    const mins = Math.ceil((at - Date.now()) / 60000);
    if (mins <= 0) return 'Kickoff time. Waiting for the host to lock the board.';
    const d = Math.floor(mins / 1440), h = Math.floor(mins % 1440 / 60), m = mins % 60;
    const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = d ? [part(d, 'day'), part(h, 'hour')] : h ? [part(h, 'hour'), part(m, 'minute')] : [part(m, 'minute')];
    return `Kickoff in ${parts.join(' ')}`;
  }

  function button(cls, html, onClick) {
    const b = el('button', cls, html);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ctx: { game(), me() -> the name this phone shows, or null; keyName() -> the name the server
  // says this phone holds; names() -> every name on the board; elsewhere(name) -> another phone's;
  // choose(name|null); skipped(), skip(on); pickingOn(); join(); openPicks(); invite(); openBoard() }.
  function create(ctx) {
    const root = el('div', 'player-pane ph-home');
    const slot = (cls) => { const n = el('div', 'ph-slot' + (cls ? ` ${cls}` : '')); root.appendChild(n); return n; };
    const note = textEl('p', 'ph-note', '');
    note.tabIndex = -1;
    note.setAttribute('role', 'status');
    root.appendChild(note);
    const statusSlot = slot();
    const finalSlot = slot();
    const who = slot();           // kept between polls: a search being typed must survive
    const squaresSlot = slot();

    const links = slot();
    const boardBtn = button('secondary ph-link', 'View the board', () => ctx.openBoard());
    const rulesBtn = button('secondary ph-link', 'Rules and payouts', () => openRules(ctx.game()));
    links.append(boardBtn, rulesBtn);

    const updated = textEl('p', 'ph-updated', '');
    root.appendChild(updated);
    const inviteBtn = button('secondary player-invite-btn', 'Invite friends', () => ctx.invite());
    // R13: the guest-to-host link. Carries this board's join code so a sign-up is attributed to it.
    const hostLink = el('a', 'player-host-link', 'Running your own pool? Host your own board');
    hostLink.target = '_blank';
    hostLink.rel = 'noopener';
    const hostSlot = slot();      // the bottom, or up top once the game is final
    const bottom = slot();
    bottom.append(inviteBtn, SBS.ui.legalLinks());

    let finding = false;          // the name list is open (Find my name, or Change)
    let whoSig = null;
    let fetchedAt = null;

    // ----- who you are -----
    let finderSync = null;
    function finder(box) {
      const label = el('label', 'ph-search', '<span>Find your name</span>');
      const input = el('input', '');
      input.type = 'search';
      input.autocomplete = 'off';
      label.appendChild(input);
      const list = el('div', 'ph-names');
      box.append(label, list);
      let sig = null;
      finderSync = () => {
        const q = input.value.trim().toLowerCase();
        const all = ctx.names();
        const next = JSON.stringify([q, all.map(n => [n, ctx.elsewhere(n)])]);
        if (next === sig) return;
        sig = next;
        const focused = list.contains(document.activeElement) ? document.activeElement.dataset.n : null;
        const shown = all.filter(n => n.toLowerCase().includes(q));
        list.replaceChildren(...shown.map(n => {
          const away = ctx.elsewhere(n);
          const b = button('secondary ph-name', `<strong>${escapeHtml(n)}</strong>${away ? '<span>Picked on another phone</span>' : ''}`, () => {
            finding = false;
            ctx.choose(n);
            const change = who.querySelector('button');
            if (change) change.focus();
          });
          b.dataset.n = n;
          b.disabled = away;
          if (n === focused) setTimeout(() => b.focus(), 0);
          return b;
        }));
        if (!shown.length) list.appendChild(textEl('p', 'player-muted', all.length ? 'No name matches.' : 'No squares have been claimed yet.'));
      };
      input.addEventListener('input', () => finderSync());
      finderSync();
      return input;
    }

    function drawWho() {
      const me = ctx.me();
      const picking = ctx.pickingOn();
      const state = me ? (finding ? 'change' : 'known') : ctx.skipped() ? 'skipped' : picking && !finding ? 'join' : 'find';
      const next = JSON.stringify([state, me, ctx.keyName(), picking]);
      if (next !== whoSig) {
        whoSig = next;
        finderSync = null;
        const had = who.contains(document.activeElement);
        who.replaceChildren();
        const open = () => { finding = true; ctx.skip(false); update(); const i = who.querySelector('input'); if (i) i.focus(); };
        if (state === 'known') {
          const line = el('div', 'ph-who-line', `<span>You are <strong>${escapeHtml(me)}</strong></span>`);
          line.appendChild(button('secondary', 'Change', open));
          who.appendChild(line);
        } else if (state === 'skipped') {
          const line = el('div', 'ph-who-line', '<span>Just watching</span>');
          line.appendChild(button('secondary', picking ? 'Join or find my name' : 'Find my name', () => { finding = false; ctx.skip(false); update(); who.querySelector('button, input').focus(); }));
          who.appendChild(line);
        } else {
          const card = el('div', 'card player-card ph-who');
          if (state === 'join') {
            card.appendChild(textEl('h2', '', 'Playing?'));
            card.append(button('', 'Join and pick squares', () => ctx.join()), button('secondary', 'Find my name', open));
          } else {
            card.appendChild(textEl('h2', '', state === 'change' ? `You are ${me}` : 'Which squares are yours?'));
            finder(card);
          }
          if (state === 'change') {
            if (me !== ctx.keyName()) card.appendChild(button('secondary', `Not you? Forget ${escapeHtml(me)}`, () => { finding = false; ctx.choose(null); }));
            card.appendChild(button('secondary', 'Cancel', () => { finding = false; update(); who.querySelector('button').focus(); }));
          } else {
            if (state === 'find' && picking) card.appendChild(button('secondary', 'Back', () => { finding = false; update(); who.querySelector('button').focus(); }));
            card.appendChild(button('ph-skip', 'Just watching? Skip this.', () => { finding = false; ctx.skip(true); update(); who.querySelector('button').focus(); }));
          }
          who.appendChild(card);
        }
        if (had && !who.contains(document.activeElement)) { const b = who.querySelector('button'); if (b) b.focus(); }
      }
      if (finderSync) finderSync();
    }

    // ----- my squares -----
    function drawSquares(game, computed) {
      squaresSlot.replaceChildren();
      const me = ctx.me();
      const mine = squaresOf(game, me);
      const locked = isLocked(game);
      // Money owed shows before the lock only, and only on the phone that picked.
      const own = !locked && me && me === ctx.keyName();
      if (!me) return;
      const card = el('div', 'card player-card');
      card.innerHTML = `<div class="player-card-head"><span class="player-card-title">Your squares</span><span class="player-card-sub">${mine.length}</span></div>`;
      if (!mine.length) card.appendChild(textEl('p', 'player-muted', 'No squares yet.'));
      const live = locked ? computeLiveHighlight(game) : null;
      const list = el('div', 'player-square-list');
      mine.forEach(idx => {
        const word = locked ? squareWord(game, computed, live, idx) : null;
        list.appendChild(el('div', 'player-square-item', `<div class="psi-coord">${squareHtml(game, idx)}</div>`
          + (word ? `<span class="psi-tag ${word.cls}">${escapeHtml(word.text)}</span>` : '')));
      });
      card.appendChild(list);
      if (locked && game.status !== 'finished') {
        const won = totalWon(computed, me);
        card.appendChild(el('p', 'ph-won', `Won so far <strong${won > 0 ? ' class="has-winnings"' : ''}>${money(won)}</strong>`));
      }
      if (own) {
        const o = owedSummary(game)[me];
        if (o) {
          card.appendChild(textEl('p', 'ph-owed', o.owed > 0
            ? `${money(o.owed)} owed for ${sq(o.unpaidCount)}. Pay the host directly; the money goes to the host, not to us.`
            : 'Nothing owed right now.'));
        }
        if (ctx.pickingOn()) {
          const cap = guestCap(game, Date.now());
          const left = cap === Infinity ? Infinity : Math.max(0, cap - mine.length);
          if (left > 0 && game.squares.some(s => !s)) {
            card.appendChild(button('ph-more', left === Infinity ? 'You can pick more' : `You can pick ${left} more`, () => ctx.openPicks()));
          }
        }
      }
      squaresSlot.appendChild(card);
    }

    function update() {
      const game = ctx.game();
      if (!game) return;
      const locked = isLocked(game);
      const final = game.status === 'finished';
      const computed = computeGame(game);

      statusSlot.replaceChildren();
      if (!locked) {
        const when = formatKickoffTime(game.kickoffTime);
        const card = el('div', 'player-ticker-pending ph-countdown');
        card.append(textEl('strong', '', countdownText(game)));
        if (when) card.appendChild(textEl('span', '', when));
        card.appendChild(textEl('span', '', `${game.squares.filter(Boolean).length} of 100 squares claimed. Numbers are drawn at the lock.`));
        statusSlot.appendChild(card);
      }

      finalSlot.replaceChildren();
      if (final) {
        const me = ctx.me();
        if (me) {
          const won = totalWon(computed, me);
          finalSlot.appendChild(el('div', 'card player-card player-total-card',
            `<div class="player-total-label">You won</div><div class="player-total-value${won > 0 ? ' has-winnings' : ''}">${money(won)}</div>`));
        }
        finalSlot.appendChild(winnersCard(game, computed, me));
      }

      drawWho();
      drawSquares(game, computed);

      const home = final ? finalSlot : hostSlot;
      if (game.joinCode) {
        hostLink.href = SBS.referral.url(game.joinCode);
        if (hostLink.parentNode !== home) home.appendChild(hostLink);
      } else hostLink.remove();
      // Invite friends while the game is still ahead.
      const underway = (game.liveScore && game.liveScore.state === 'in') || computed.results.q1.a !== null;
      inviteBtn.hidden = final || (locked && underway);
      tick();
    }

    function tick() {
      const game = ctx.game();
      if (!game) return;
      const strong = statusSlot.querySelector('.ph-countdown strong');
      if (strong) strong.textContent = countdownText(game);
      if (fetchedAt === null) return;
      const secs = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
      const age = secs < 120 ? `${secs} s` : `${Math.floor(secs / 60)} min`;
      const source = !isLocked(game) ? '' : scoredByHand(game) ? ' · scored by host' : ' · live score';
      updated.textContent = `Updated ${age} ago${source}`;
    }

    return {
      el: root,
      update,
      tick,
      // `at`: when a copy kept on the phone was fetched.
      fetched(at) { fetchedAt = at || Date.now(); tick(); },
      // Back from the full-screen board.
      focusBoard() { boardBtn.focus(); },
      say(text) { note.textContent = text || ''; },
      // The control that was tapped is gone (a claim moves here): keyboard focus lands on the note.
      focusNote() { note.focus(); },
      // Leaving Home closes an open name list.
      reset() { finding = false; whoSig = null; }
    };
  }

  SBS.playerHome = { create, isAutoScored, totalWon, squaresOf, squareHtml, liveCards, WON_PHRASE };
})();
