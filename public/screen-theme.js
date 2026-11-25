// The Theme page (R33): the host picks one of six color themes. One theme per host, used on all
// their boards on every device, including Player View and Party View. Each card is a real radio
// button wearing its own theme, so what it shows is what the choice looks like.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el, escapeHtml, topbar, teamBadge, resetTeamColors } = SBS.ui;

  // Tabler outline "check" (MIT, 24 px, pinned 3.19.0).
  const CHECK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>';

  const THEMES = [
    { id: 'classic', name: 'Neon', desc: 'The original: bright cyan on near-black.' },
    { id: 'cyan', name: 'Deep Cyan', desc: 'Navy with sky cyan.' },
    { id: 'blue', name: 'Stadium Blue', desc: 'Navy with a true blue.' },
    { id: 'slate', name: 'Ice Slate', desc: 'Quiet gray; teams stand out.' },
    { id: 'indigo', name: 'Indigo Night', desc: 'Deep indigo with periwinkle.' },
    { id: 'emerald', name: 'Emerald Field', desc: 'Dark green with mint.' }
  ];

  // Two teams that read well on every theme, for the miniature's pills.
  const SAMPLE = { league: 'nfl', teamA: 'Chiefs', teamB: 'Eagles' };

  // The last choice the server confirmed, the one on screen, and whether a save is running. They
  // outlive one drawing of the page, so a save that is still running when the host leaves finishes.
  let confirmed = null;
  let wanted = null;
  let saving = false;

  // 5 x 3 squares; two of them hold a name in a player color.
  function miniGrid() {
    const names = { 1: ['Ava', '#ff6b6b'], 8: ['Ben', '#4dabf7'] };
    let html = '';
    for (let i = 0; i < 15; i++) {
      const n = names[i];
      html += n
        ? `<span class="theme-mini-cell is-filled"><span class="name-txt" style="--nc:${n[1]};">${n[0]}</span></span>`
        : '<span class="theme-mini-cell"></span>';
    }
    return html;
  }

  function card(t) {
    const label = el('label', 'theme-card');
    label.setAttribute('data-theme', t.id);
    label.innerHTML = `
      <input type="radio" class="theme-radio" name="theme" value="${t.id}" aria-describedby="theme-desc-${t.id}">
      <span class="theme-face">
        <span class="theme-head">
          <span class="theme-name">${escapeHtml(t.name)}</span>
          <span class="theme-check" aria-hidden="true">${CHECK_ICON}</span>
        </span>
        <span class="theme-desc" id="theme-desc-${t.id}">${escapeHtml(t.desc)}</span>
        <span class="theme-mini" aria-hidden="true">
          <span class="theme-mini-row">
            <span class="home-chip chip-pick"><span class="home-chip-dot"></span>Picking squares</span>
            <span class="theme-btn">Primary</span>
          </span>
          <span class="theme-mini-row theme-mini-teams">${teamBadge(SAMPLE, 'A', { logoSize: 16, cls: 'team-badge-sm' })}<span class="vs-sep">vs</span>${teamBadge(SAMPLE, 'B', { logoSize: 16, cls: 'team-badge-sm' })}</span>
          <span class="theme-mini-grid">${miniGrid()}</span>
          <span class="theme-mini-row">
            <span class="theme-pill is-paid">Paid</span>
            <span class="theme-pill is-part">Partial</span>
            <span class="theme-pill is-unpaid">Unpaid</span>
          </span>
        </span>
      </span>`;
    return label;
  }

  function renderTheme() {
    const app = SBS.appEl;
    const T = window.SBSTheme;
    resetTeamColors();
    app.innerHTML = '';
    const bar = topbar('Theme', [], { hideIcon: true });
    bar.classList.add('setup-topbar');
    app.appendChild(bar);
    const main = el('div', 'main theme-main');
    app.appendChild(main);

    main.appendChild(el('p', 'theme-intro', 'Your theme is used on all your boards, on every device, including Player View and Party View.'));
    const group = el('div', 'theme-grid');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Theme');
    main.appendChild(group);
    const status = el('p', 'theme-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    main.appendChild(status);

    const shown = THEMES.filter(t => !window.GameLogic || !window.GameLogic.THEMES || window.GameLogic.THEMES.indexOf(t.id) !== -1);
    shown.forEach(t => group.appendChild(card(t)));

    // The cached choice at once; the saved one replaces it when the server answers.
    if (!saving) { wanted = confirmed = T.host(); }
    const inputs = Array.from(group.querySelectorAll('input.theme-radio'));
    const mark = (id) => inputs.forEach(i => {
      i.checked = i.value === id;
      i.parentNode.classList.toggle('is-chosen', i.checked); // a class: iPads before Safari 15.4 have no :has()
    });
    mark(wanted);
    const say = (text, isError) => {
      status.textContent = text;
      status.classList.toggle('is-error', !!isError);
    };
    const onScreen = () => SBS.currentScreen() === 'theme' && main.isConnected;

    async function flush() {
      if (saving) return;
      saving = true;
      say('Saving…');
      while (wanted !== confirmed) {
        const target = wanted;
        try {
          await SBS.api.setTheme(target);
          confirmed = target;
        } catch (e) {
          // Back to what the server has, and say why.
          wanted = confirmed;
          saving = false;
          T.rememberHost(confirmed);
          if (SBS.currentScreen() === 'theme') SBS.render(); // the page may have been opened again meanwhile
          const line = document.querySelector('.theme-status');
          if (line) { line.textContent = 'Could not save your theme: ' + e.message; line.classList.add('is-error'); }
          return;
        }
      }
      saving = false;
      const line = SBS.currentScreen() === 'theme' ? document.querySelector('.theme-status') : null;
      if (line) { line.textContent = 'Saved.'; line.classList.remove('is-error'); }
    }

    inputs.forEach(i => i.addEventListener('change', () => {
      if (!i.checked || i.value === wanted) return;
      // Optimistic: wear it now. Saves go one at a time, so the server ends on the last choice and
      // an older answer can never undo a newer one.
      wanted = i.value;
      mark(wanted);
      T.setHost(wanted);
      flush();
    }));

    // Load the saved theme. After about 2 s with no answer, say the database may be waking.
    const started = wanted;
    const hint = setTimeout(() => { if (onScreen() && !status.textContent) say('Still working, waking the database…'); }, 2000);
    SBS.api.getTheme().then((r) => {
      if (!onScreen() || !r || !T.known(r.theme)) return;
      // The host has already chosen something here: that choice is newer than this answer.
      if (wanted !== started || saving) return;
      if (r.theme !== wanted) {
        wanted = confirmed = r.theme;
        T.setHost(r.theme);
        mark(r.theme);
      }
    }).catch((e) => {
      if (onScreen() && !saving) say('Could not load your saved theme: ' + e.message, true);
    }).finally(() => {
      clearTimeout(hint);
      if (onScreen() && status.textContent.startsWith('Still working')) say('');
    });
  }

  SBS.screens.theme = renderTheme;
})();
