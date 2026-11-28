// The admin usage page (#admin, R45b, decision 027): draws GET /api/admin/stats. Nothing links
// here, and the server decides who may read it. Counts and masked emails only; a full email is
// asked for one at a time and lives in the page's markup alone. No polling: it fetches when
// opened, on a range change and on Refresh.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, textEl, topbar, formatGameDate, resetTeamColors } = SBS.ui;

  const RANGES = [
    { id: '7d', name: 'Last 7 days', phrase: 'last 7 days' },
    { id: '30d', name: 'Last 30 days', phrase: 'last 30 days' },
    { id: 'season', name: 'Season', phrase: 'this season' }
  ];

  const HOST_STAGES = { none: 'No board yet', created: 'Created a board', locked: 'Locked one', finished: 'Finished a game' };

  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0) + '%';

  // "2026-11-20" -> "Nov 20", read as a local date so it never shifts a day.
  function shortDay(day) {
    const d = new Date(day + 'T00:00:00');
    return isNaN(d.getTime()) ? String(day) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function when(iso, never) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return never;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function day(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function add(parent, ...children) {
    children.forEach(c => parent.appendChild(c));
    return parent;
  }

  const empty = (text) => textEl('p', 'adm-empty', text);
  const note = (text) => textEl('p', 'adm-note', text);

  // Big numbers with a label and an optional second line.
  function tiles(list) {
    const ul = el('ul', 'adm-tiles');
    list.forEach(([label, value, sub]) => {
      const li = add(el('li', 'adm-tile'), textEl('span', 'adm-tile-label', label), textEl('span', 'adm-tile-value', value));
      if (sub) li.appendChild(textEl('span', 'adm-tile-sub', sub));
      ul.appendChild(li);
    });
    return ul;
  }

  // One row each: label, a bar for part of whole, and the value as text.
  function bars(list) {
    const ul = el('ul', 'adm-bars');
    list.forEach(([label, part, whole, text]) => {
      const track = el('span', 'adm-bar-track', '<span class="adm-bar-fill"></span>');
      track.setAttribute('aria-hidden', 'true');
      track.firstChild.style.width = (whole ? Math.min(100, (part / whole) * 100) : 0) + '%';
      ul.appendChild(add(el('li', 'adm-bar'), textEl('span', 'adm-bar-label', label), track, textEl('span', 'adm-bar-value', text)));
    });
    return ul;
  }

  function facts(list) {
    const dl = el('dl', 'adm-facts');
    list.forEach(([label, value]) => dl.appendChild(add(el('div'), textEl('dt', '', label), textEl('dd', '', value))));
    return dl;
  }

  function table(caption, heads, rows) {
    const t = el('table', 'adm-table');
    t.appendChild(textEl('caption', 'sr-only', caption));
    const headRow = el('tr');
    heads.forEach(h => { const th = textEl('th', '', h); th.scope = 'col'; headRow.appendChild(th); });
    t.appendChild(add(el('thead'), headRow));
    const body = el('tbody');
    rows.forEach(({ cells, cls }) => {
      const tr = el('tr', cls || '');
      cells.forEach((c, i) => {
        const cell = textEl(i ? 'td' : 'th', '', c);
        if (!i) cell.scope = 'row';
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }

  // A small bar chart of one count per day. The picture is hidden from screen readers, which get
  // the table drawn beside it.
  function dayChart(days, key, name) {
    const NS = 'http://www.w3.org/2000/svg';
    const peak = Math.max(0, ...days.map(d => d[key]));
    const total = days.reduce((t, d) => t + d[key], 0);
    const box = el('div', 'adm-chart');
    box.appendChild(textEl('p', 'adm-chart-head', `${name}: ${num(total)} (most in a day: ${num(peak)})`));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'adm-chart-svg adm-chart-' + key);
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, days.length) * 10} 100`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    days.forEach((d, i) => {
      if (!d[key]) return;
      const h = Math.max(3, (d[key] / peak) * 100);
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', i * 10 + 1);
      r.setAttribute('y', 100 - h);
      r.setAttribute('width', 8);
      r.setAttribute('height', h);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${shortDay(d.day)}: ${num(d[key])}`;
      r.appendChild(title);
      svg.appendChild(r);
    });
    box.appendChild(svg);
    return box;
  }

  // ---------- The cards ----------
  // [id, heading, width, draw(body, data, ctx)]. A card with `fixed` needs no data.
  const CARDS = [
    ['headline', 'Headline counts', 'full', (body, d, ctx) => {
      const h = d.headline;
      body.appendChild(tiles([
        ['Hosts', num(h.hosts), `+${num(h.hostsNewWeek)} new this week`],
        ['Boards created', num(h.boardsCreated), ctx.range.phrase],
        ['Boards locked', num(h.boardsLocked), ctx.range.phrase],
        ['Players on boards', num(h.players), ctx.range.phrase],
        ['Live now', num(h.liveNow)],
        ['TVs paired', num(h.tvsPaired)]
      ]));
    }],
    ['daily', 'Signups and new boards per day', 'full', (body, d) => {
      const days = d.perDay;
      if (!days.some(x => x.signups || x.boards)) { body.appendChild(empty('No signups or new boards in this range yet.')); return; }
      add(body, dayChart(days, 'signups', 'Signups'), dayChart(days, 'boards', 'New boards'));
      const axis = add(el('div', 'adm-axis'), textEl('span', '', shortDay(days[0].day)), textEl('span', '', shortDay(days[days.length - 1].day)));
      axis.setAttribute('aria-hidden', 'true');
      body.appendChild(axis);
      body.appendChild(add(el('div', 'sr-only'), table('Signups and new boards per day', ['Day', 'Signups', 'New boards'],
        days.map(x => ({ cells: [shortDay(x.day), num(x.signups), num(x.boards)] })))));
    }],
    ['funnel', 'Host funnel', 'half', (body, d, ctx) => {
      const f = d.funnel;
      if (!f.signedUp) { body.appendChild(empty('No hosts signed up in this range yet.')); return; }
      body.appendChild(note(`Hosts who signed up in the ${ctx.range.phrase.replace(/^this /, '')}, and the share of them at each step.`));
      body.appendChild(bars([
        ['Signed up', f.signedUp],
        ['Created a board', f.createdBoard],
        ['Locked one', f.locked],
        ['Finished a game', f.finished],
        ['Second board', f.secondBoard]
      ].map(([label, n]) => [label, n, f.signedUp, `${num(n)} · ${pct(n, f.signedUp)}`])));
    }],
    ['growth', 'Growth loop', 'half', (body, d, ctx) => {
      const g = d.growth;
      body.appendChild(facts([
        [`Hosts from boards, ${ctx.range.phrase}`, num(g.fromBoards)],
        ['Next-season opt-ins, all hosts', num(g.newsOptIns)]
      ]));
      body.appendChild(textEl('h3', '', 'Terms versions accepted'));
      body.appendChild(g.terms.length
        ? table('Terms versions accepted', ['Version', 'Hosts'], g.terms.map(t => ({ cells: [t.version, num(t.hosts)] })))
        : empty('No hosts have accepted the Terms yet.'));
      body.appendChild(textEl('h3', '', 'Top referring boards'));
      body.appendChild(g.topReferrers.length
        ? table('Top referring boards', ['Board code', 'Hosts'], g.topReferrers.map(r => ({ cells: [r.code, num(r.hosts)] })))
        : empty('No referrals in this range yet.'));
    }],
    ['heard', 'Where hosts heard about us', 'full', (body, d) => {
      const h = d.heard;
      if (!h) { body.appendChild(empty('No answers yet.')); return; }
      const answered = h.answers.reduce((t, a) => t + (a.hosts || 0), 0);
      const total = answered + (h.skipped || 0) + (h.fromBoard || 0) + (h.notAsked || 0);
      body.appendChild(note('Asked once, after a host signs in. The answer is optional.'));
      body.appendChild(bars(h.answers.map(a => [HEARD_LABELS[a.answer] || a.answer, a.hosts, total, num(a.hosts)])));
      body.appendChild(facts([
        ['Skipped', num(h.skipped)],
        ["From a friend's board", num(h.fromBoard)],
        ['Not asked yet', num(h.notAsked)]
      ]));
      body.appendChild(textEl('h3', '', 'Tagged links'));
      const tags = (h.tagged || []).slice(0, 10);
      body.appendChild(tags.length
        ? table('Tagged links', ['Tag', 'Hosts'], tags.map(t => ({ cells: [t.src, num(t.hosts)] })))
        : empty('No hosts came in by a tagged link yet.'));
      body.appendChild(textEl('h3', '', 'Latest "something else"'));
      const o = h.latestOther;
      body.appendChild(o && o.text
        ? add(el('p', 'adm-other'), textEl('span', '', '“' + o.text + '”'), textEl('span', 'adm-note', ' ' + when(o.at, '—')))
        : empty('None yet.'));
    }],
    ['games', 'Hosts by game', 'full', (body, d) => {
      if (!d.byGame.length) { body.appendChild(empty('No boards in this range yet.')); return; }
      const head = el('div', 'adm-game-head');
      head.setAttribute('aria-hidden', 'true');
      ['Game', 'Date', 'Hosts', 'Boards', 'Guests', 'Locked'].forEach(h => head.appendChild(textEl('span', '', h)));
      body.appendChild(head);
      const list = el('ul', 'adm-games');
      d.byGame.forEach((g, i) => {
        const btn = el('button', 'adm-game');
        btn.type = 'button';
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', 'adm-stages-' + i);
        const league = g.league ? ` (${String(g.league).toUpperCase()})` : '';
        btn.appendChild(textEl('span', 'adm-game-name', g.label + league));
        btn.appendChild(textEl('span', 'adm-game-date', g.gameDate ? formatGameDate(g.gameDate) : '—'));
        [['Hosts', num(g.hosts)], ['Boards', num(g.boards)], ['Guests', num(g.guests)], ['Locked', Math.round(g.lockedShare * 100) + '%']]
          .forEach(([label, v]) => btn.appendChild(add(el('span', 'adm-game-stat'),
            textEl('span', 'adm-game-label', label + ' '), textEl('span', '', v))));
        const stages = facts([
          ['Setup', num(g.stages.setup)], ['Picking', num(g.stages.picking)],
          ['Locked', num(g.stages.started)], ['Finished', num(g.stages.finished)]
        ]);
        stages.classList.add('adm-stages');
        stages.id = 'adm-stages-' + i;
        stages.hidden = true;
        btn.addEventListener('click', () => {
          stages.hidden = !stages.hidden;
          btn.setAttribute('aria-expanded', String(!stages.hidden));
        });
        list.appendChild(add(el('li'), btn, stages));
      });
      body.appendChild(list);
    }],
    ['guests', 'Guests per host', 'half', (body, d, ctx) => {
      const g = d.guestsPerHost;
      if (!g.hosts) { body.appendChild(empty('No boards in this range yet.')); return; }
      body.appendChild(tiles([
        ['Median', num(g.median)], ['Average', num(g.average)], ['Most', num(g.most)],
        ['Phones picking', num(g.phones), 'player-picks boards']
      ]));
      body.appendChild(textEl('h3', '', 'Hosts by guest count'));
      const most = Math.max(0, ...g.buckets.map(b => b.hosts));
      body.appendChild(bars(g.buckets.map(b => [`${b.label} guests`, b.hosts, most, `${num(b.hosts)} ${b.hosts === 1 ? 'host' : 'hosts'}`])));
      body.appendChild(textEl('h3', '', 'Top hosts'));
      const list = el('ul', 'adm-hosts');
      g.top.forEach(h => list.appendChild(add(el('li', 'adm-top'), ctx.email(h),
        textEl('span', 'adm-note', `${num(h.guests)} ${h.guests === 1 ? 'guest' : 'guests'} · ${num(h.boards)} ${h.boards === 1 ? 'board' : 'boards'}`))));
      body.appendChild(list);
    }],
    ['run', 'How boards are run', 'half', (body, d, ctx) => {
      const r = d.howRun;
      if (!r.boards) { body.appendChild(empty('No boards in this range yet.')); return; }
      body.appendChild(note(`${num(r.boards)} ${r.boards === 1 ? 'board' : 'boards'} created, ${ctx.range.phrase}. Average squares sold: ${num(r.averageSold)}.`));
      const group = (title, list) => {
        body.appendChild(textEl('h3', '', title));
        body.appendChild(bars(list.map(([label, n]) => [label, n, r.boards, `${num(n)} · ${pct(n, r.boards)}`])));
      };
      group('Scoring mode', [['Live', r.scoring.live], ['Manual', r.scoring.manual], ['Simulation', r.scoring.simulation]]);
      group('League', [['NFL', r.league.nfl], ['NBA', r.league.nba], ['Other', r.league.other]]);
      group('Features', [['Player picks on', r.playerPicks], ['A helper', r.helper], ['Shown on a TV', r.onTv]]);
    }],
    ['services', 'Services', 'full', (body, d) => {
      const s = d.services;
      const feeds = add(el('div', 'adm-service'), textEl('h3', '', 'Score feeds'));
      feeds.appendChild(s.feeds.length
        ? table('Score feeds', ['Provider', 'Calls', 'Failed', 'Peak a minute'], s.feeds.map(f => {
          const over = f.peakMinute > s.peakTarget;
          return { cls: over ? 'is-over' : '', cells: [f.provider, num(f.calls), num(f.failed), num(f.peakMinute) + (over ? ' (over target)' : '')] };
        }))
        : empty('No score-feed calls in this range yet.'));
      feeds.appendChild(note(`Target: no more than ${num(s.peakTarget)} calls a minute.`));
      feeds.appendChild(facts([
        ['Fell back to the backup feed', `${num(s.fallback.times)} times, about ${num(s.fallback.minutes)} minutes`],
        ['Last fallback', when(s.fallback.lastAt, 'None in this range')],
        ['Feed fully down', `${num(s.down.times)} times`],
        ['Last time down', when(s.down.lastAt, 'None in this range')]
      ]));
      const mail = add(el('div', 'adm-service'), textEl('h3', '', 'Resend email'));
      const m = s.mail;
      mail.appendChild(bars([
        ['Sent today', m.today, m.perDay, `${num(m.today)} of ${num(m.perDay)}`],
        ['Sent this month', m.month, m.perMonth, `${num(m.month)} of ${num(m.perMonth)}`]
      ]));
      mail.appendChild(facts([
        ['Failures', num(m.failed)],
        ['Refused by our limit', num(m.refused)],
        ['Sign-ins by code', num(s.logins.code)],
        ['Sign-ins by link', num(s.logins.link)]
      ]));
      body.appendChild(add(el('div', 'adm-services'), feeds, mail));
    }],
    ['database', 'Database', 'half', (body, d) => {
      const db = d.database || {};
      const n = db.neon;
      if (n && n.ok) {
        body.appendChild(facts([
          ['Compute hours', hours(n.computeHours)],
          ['Active hours', hours(n.activeHours)],
          ['Data transferred', bytes(n.transferBytes)],
          ['Data written', bytes(n.writtenBytes)],
          ['Storage', bytes(n.storageBytes)],
          ['Period', n.periodStart && n.periodEnd ? `${day(n.periodStart)} to ${day(n.periodEnd)}` : '—'],
          ['Last active', when(n.lastActive, '—')]
        ]));
      }
      const t = db.tables;
      if (t && t.length) {
        body.appendChild(textEl('h3', '', 'Rows'));
        body.appendChild(table('Rows per table', ['Table', 'Rows'], t.map(r => ({ cells: [r.table, num(r.rows)] }))));
      }
      dashboard(body, 'Neon', 'https://console.neon.tech/', n);
    }],
    ['hosting', 'Hosting', 'half', (body, d) => {
      const v = (d.hosting || {}).vercel;
      if (v && v.ok) {
        const dep = v.deploy;
        body.appendChild(dep
          ? facts([
            ['Latest deploy', dep.state || '—'],
            ['Deployed', when(dep.createdAt, '—')],
            ['Commit', dep.commit ? String(dep.commit).slice(0, 7) : '—'],
            ['Message', dep.message || '—']
          ])
          : empty('No deploy found.'));
      }
      dashboard(body, 'Vercel', 'https://vercel.com/dashboard', v);
    }],
    ['recent', 'Recent hosts', 'full', (body, d, ctx) => {
      if (!d.recentHosts.length) { body.appendChild(empty('No hosts yet.')); return; }
      const list = el('ul', 'adm-hosts');
      d.recentHosts.forEach(h => {
        const info = facts([
          ['Joined', when(h.joined, '—')],
          ['Boards', num(h.boards)],
          ['Stage', HOST_STAGES[h.stage] || h.stage],
          ['Last sign-in', when(h.lastSignIn, 'Never')],
          ['From', from(h.from)]
        ]);
        info.classList.add('adm-recent-facts');
        list.appendChild(add(el('li', 'adm-recent'), ctx.email(h), info));
      });
      body.appendChild(list);
    }]
  ];

  const HEARD_LABELS = {
    friend: 'A friend', search: 'Search', video: 'TikTok, Reels or Shorts',
    group: 'A Facebook or Reddit group', ad: 'An ad', other: 'Something else', skip: 'Skipped'
  };
  const hours = (n) => (n == null ? '—' : Number(n).toFixed(1));
  function bytes(n) {
    if (n == null) return '—';
    const gb = Number(n) / 1e9;
    return gb >= 1 ? gb.toFixed(2) + ' GB' : (Number(n) / 1e6).toFixed(1) + ' MB';
  }
  function from(f) {
    if (f === 'board') return 'a board';
    if (typeof f === 'string' && f.startsWith('link:')) return 'link ' + f.slice(5);
    return HEARD_LABELS[f] || '—';
  }

  // `state`: null = no key set here, {ok:false} = could not reach it, {ok:true} = numbers drawn above.
  function dashboard(body, name, href, state) {
    if (!state) body.appendChild(note(`${name} numbers are not shown here yet.`));
    else if (!state.ok) body.appendChild(note(`Couldn't reach ${name}.`));
    const a = textEl('a', 'adm-link', 'Open dashboard');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', `Open the ${name} dashboard in a new tab`);
    body.appendChild(a);
  }

  function renderAdmin() {
    const app = SBS.appEl;
    resetTeamColors();
    app.innerHTML = '';
    const goHome = () => {
      // The address bar still says #admin: a reload should not come back here.
      try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); } catch (e) { /* stays */ }
      SBS.go({ screen: 'home' });
    };
    app.appendChild(topbar('Admin', [], { hideIcon: true, back: goHome }));
    const main = el('div', 'main adm-main');
    app.appendChild(main);

    const tools = el('div', 'adm-tools');
    const picker = el('div', 'adm-ranges choice-strip');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Range');
    const refresh = textEl('button', 'secondary adm-refresh', 'Refresh');
    refresh.type = 'button';
    const updated = el('span', 'adm-updated');
    add(tools, picker, add(el('div', 'adm-fresh'), updated, refresh));
    const status = el('p', 'adm-status');
    status.setAttribute('role', 'status');
    const grid = el('div', 'adm-grid');
    add(main, tools, status, grid);

    let range = RANGES[0];
    let asked = 0;     // only the newest stats request may draw
    let hint = null;
    let shown = null;  // the one email on screen in full: { button, masked }
    let revealAsked = 0;
    const onScreen = () => SBS.currentScreen() === 'admin' && main.isConnected;
    SBS.onLeaveScreen(() => clearTimeout(hint));

    const say = (text, isError) => {
      status.textContent = text;
      status.classList.toggle('is-error', !!isError);
    };

    // Signed out, not the admin, or sign-in not set up: the same plain answer for all of them.
    function refuse() {
      asked += 1;
      revealAsked += 1;
      shown = null;
      clearTimeout(hint);
      const home = textEl('a', 'adm-link', 'Home');
      home.href = '/';
      home.addEventListener('click', (e) => { e.preventDefault(); goHome(); });
      main.innerHTML = '';
      const msg = textEl('p', 'adm-refusal-text', 'This page is for the site admin.');
      msg.setAttribute('role', 'alert');
      main.appendChild(add(el('div', 'card adm-refusal'), msg, home));
    }
    const refused = (e) => e && (e.status === 401 || e.status === 403 || e.status === 503);

    function remask() {
      if (!shown) return;
      shown.button.firstChild.textContent = shown.masked;
      shown.button.setAttribute('aria-pressed', 'false');
      shown = null;
    }

    // A masked address as a button. Tapping shows that one in full; tapping again hides it.
    function emailButton(host) {
      const b = el('button', 'adm-email');
      b.type = 'button';
      b.title = 'Show or hide the full email';
      b.setAttribute('aria-pressed', 'false');
      b.appendChild(textEl('span', '', host.email));
      b.addEventListener('click', async () => {
        const mine = ++revealAsked;
        const again = shown && shown.button === b;
        remask();
        say('');
        if (again) return;
        try {
          const r = await SBS.api.revealHostEmail(host.id);
          if (mine !== revealAsked || !onScreen() || !b.isConnected) return;
          if (!r || !r.email) throw new Error('No email');
          b.firstChild.textContent = r.email;
          b.setAttribute('aria-pressed', 'true');
          shown = { button: b, masked: host.email };
        } catch (e) {
          if (!onScreen()) return;
          if (refused(e)) { refuse(); return; }
          if (mine === revealAsked) say('Could not show that email. Try again.', true);
        }
      });
      return b;
    }

    // Every card with its heading; `data` null draws the placeholders.
    function draw(data) {
      const ctx = { range, email: emailButton };
      const cards = CARDS.map(([id, title, width, fill, fixed]) => {
        const card = el('section', `card adm-card adm-${width}`);
        card.id = 'adm-' + id;
        const heading = textEl('h2', '', title);
        heading.id = `adm-${id}-title`;
        card.setAttribute('aria-labelledby', heading.id);
        card.appendChild(heading);
        if (data || fixed) fill(card, data, ctx);
        else card.appendChild(el('div', 'adm-skel', '<span></span><span></span><span></span>')).setAttribute('aria-hidden', 'true');
        return card;
      });
      grid.innerHTML = '';
      add(grid, ...cards);
    }

    async function load() {
      const mine = ++asked;
      revealAsked += 1;
      shown = null;
      clearTimeout(hint);
      updated.textContent = '';
      say('');
      grid.setAttribute('aria-busy', 'true');
      draw(null);
      hint = setTimeout(() => { if (mine === asked && onScreen()) say('Waking the database…'); }, 2000);
      try {
        const data = await SBS.api.getAdminStats(range.id);
        if (mine !== asked || !onScreen()) return;
        draw(data);
        const at = new Date(data.generatedAt);
        updated.textContent = 'Updated ' + at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        say('');
      } catch (e) {
        if (mine !== asked || !onScreen()) return;
        if (refused(e)) { refuse(); return; }
        console.error('Could not load the admin numbers', e);
        grid.innerHTML = '';
        say('Could not load the numbers. Tap Refresh to try again.', true);
      }
      clearTimeout(hint);
      grid.removeAttribute('aria-busy');
    }

    RANGES.forEach(r => {
      const b = textEl('button', 'adm-range', r.name);
      b.type = 'button';
      b.setAttribute('data-range', r.id);
      b.setAttribute('aria-pressed', String(r === range));
      b.addEventListener('click', () => {
        if (r === range) return;
        range = r;
        picker.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        load();
      });
      picker.appendChild(b);
    });
    refresh.addEventListener('click', load);
    load();
  }

  SBS.screens.admin = renderAdmin;
})();
