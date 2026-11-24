// Shared DOM helpers: element building, escaping, money formatting, the modal
// stack, the top bar, and the team colour theming.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function money(n) {
    if (isNaN(n)) n = 0;
    return '$' + Math.round(n).toLocaleString();
  }

  const OVERLAY_CSS = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:1000; padding:20px;';

  function overlayEl(opacity) {
    const overlay = el('div', '');
    overlay.style.cssText = opacity ? OVERLAY_CSS.replace('0.6', opacity) : OVERLAY_CSS;
    return overlay;
  }

  // Native confirm()/alert() are unreliable on iPad and invisible on an
  // AirPlayed TV, so every prompt goes through these.
  //
  // `message` is rendered as HTML, not text — callers rely on that to drop in
  // <br> and inline markup. Anything interpolated into it that came from a
  // person (team names, player names) MUST be run through escapeHtml at the
  // call site.
  function showModal({ message, okText, cancelText }) {
    return new Promise(resolve => {
      const overlay = overlayEl();
      const box = el('div', 'card');
      box.style.cssText = 'max-width:440px; width:100%; box-shadow: var(--shadow-pop);';
      box.appendChild(el('p', '', message));
      const actions = el('div', 'actions');
      const okBtn = el('button', '', okText || 'OK');
      actions.appendChild(okBtn);
      if (cancelText !== null) {
        const cancelBtn = el('button', 'secondary', cancelText || 'Cancel');
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
        actions.appendChild(cancelBtn);
      }
      okBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  const showConfirm = (message) => showModal({ message, okText: 'Confirm', cancelText: 'Cancel' });
  const showAlert = (message) => showModal({ message, okText: 'OK', cancelText: null });

  // Host sign-in prompt. Resolves with the typed password, or null if the
  // host dismissed it — a dismissal is a real answer ("I'm just watching"),
  // not an error, so callers fall back to read-only rather than retrying.
  function showPasswordPrompt(message) {
    return new Promise(resolve => {
      const overlay = overlayEl();
      const box = el('div', 'card');
      box.style.cssText = 'max-width:440px; width:100%; box-shadow: var(--shadow-pop);';
      const intro = message || 'Enter the host password to manage games. Watching the board, or a player view, needs no sign-in.';
      box.innerHTML = `<h3 style="margin-top:0">Host sign-in</h3>
        <p style="color:var(--muted)">${escapeHtml(intro)}</p>`;
      const input = el('input', '');
      input.type = 'password';
      input.autocomplete = 'current-password';
      input.placeholder = 'Host password';
      box.appendChild(input);
      const err = el('div', 'error-msg hidden');
      box.appendChild(err);
      const actions = el('div', 'actions');
      const okBtn = el('button', '', 'Sign in');
      const cancelBtn = el('button', 'secondary', 'Not now');
      const done = (value) => { overlay.remove(); resolve(value); };
      okBtn.addEventListener('click', () => {
        const v = input.value;
        if (!v) {
          err.textContent = 'Please enter the password.';
          err.classList.remove('hidden');
          return;
        }
        done(v);
      });
      cancelBtn.addEventListener('click', () => done(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okBtn.click(); });
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      input.focus();
    });
  }

  // ---------- Email sign-in (accounts mode) ----------
  // One dialog, two steps: ask for an email, then take the 8-digit code. The
  // emailed link does the same job on its own page (#login-<token>). Resolves
  // true once this device is signed in, false if the host dismissed it.
  //
  // What survives a reload is only { requestId, email, expiry }: iOS may kill a
  // home-screen app while the host is in Mail. Never the code or a token.
  const PENDING_KEY = 'sbs-login-pending';
  const PENDING_MS = 15 * 60 * 1000;

  function readPendingLogin() {
    try {
      const v = JSON.parse(localStorage.getItem(PENDING_KEY));
      if (v && typeof v.requestId === 'string' && typeof v.email === 'string' && v.expiry > Date.now()) return v;
      localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* storage blocked or not JSON: start at step 1 */ }
    return null;
  }
  function writePendingLogin(v) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(v)); } catch (e) { /* optional */ }
  }
  function clearPendingLogin() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* optional */ }
  }

  // Set while the prompt is open. Closing it this way keeps the pending sign-in.
  let closeOpenPrompt = null;
  function closeEmailPrompt() {
    if (closeOpenPrompt) closeOpenPrompt();
  }

  function showEmailPrompt() {
    return new Promise(resolve => {
      const opener = document.activeElement;
      const overlay = overlayEl();
      const box = el('div', 'card');
      box.style.cssText = 'max-width:440px; width:100%; box-shadow: var(--shadow-pop);';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'signin-title');
      const title = el('h3', '', 'Host sign-in');
      title.id = 'signin-title';
      title.style.marginTop = '0';
      const body = el('div', '');
      const err = el('div', 'error-msg hidden');
      err.setAttribute('role', 'alert');
      err.style.marginTop = '14px';
      err.style.marginBottom = '0';
      const note = el('p', '');
      note.setAttribute('aria-live', 'polite');
      note.style.cssText = 'color:var(--muted); margin:12px 0 0; font-size:0.9rem;';
      box.append(title, body, err, note);
      overlay.appendChild(box);

      let step = 1;
      let email = '';
      let requestId = '';
      let busy = false;
      let closed = false;
      let checking = false;
      let hintTimer = null;

      const showErr = (text) => { err.textContent = text; err.classList.remove('hidden'); note.textContent = ''; };
      const clearMsgs = () => { err.textContent = ''; err.classList.add('hidden'); note.textContent = ''; };
      const setBusy = (on) => {
        box.querySelectorAll('button[data-lock]').forEach(b => { b.disabled = on; });
      };

      function finish(value) {
        if (closed) return;
        closed = true;
        closeOpenPrompt = null;
        clearTimeout(hintTimer);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('visibilitychange', onVisible);
        overlay.remove();
        if (opener && opener !== document.body && document.contains(opener) && opener.focus) opener.focus();
        resolve(value);
      }
      function dismiss() { clearPendingLogin(); finish(false); }

      // Runs one request: buttons locked, and a hint if the database is waking.
      async function run(task) {
        busy = true;
        clearMsgs();
        setBusy(true);
        hintTimer = setTimeout(() => { if (!closed) note.textContent = 'Still working, waking the database…'; }, 2000);
        try {
          return await task();
        } finally {
          busy = false;
          clearTimeout(hintTimer);
          if (!closed) {
            setBusy(false);
            if (note.textContent.startsWith('Still working')) note.textContent = '';
          }
        }
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
        if (e.key !== 'Tab') return;
        const items = Array.from(box.querySelectorAll('button:not([disabled]), input:not([disabled])'));
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!box.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }

      // Back from Mail after tapping the link in another tab: one check, no timer.
      function onVisible() {
        if (document.visibilityState !== 'visible' || step !== 2 || busy || checking || closed) return;
        checking = true;
        SBS.api.getSession().then(s => {
          if (!closed && s && s.host) { clearPendingLogin(); finish(true); }
        }).catch(() => {}).finally(() => { checking = false; });
      }

      function button(label, cls, type, lock) {
        const b = el('button', cls || '', label);
        b.type = type || 'button';
        if (lock !== false) b.setAttribute('data-lock', '');
        return b;
      }

      function showStep1(prefill) {
        step = 1;
        clearMsgs();
        body.innerHTML = '';
        const form = el('form', '');
        form.noValidate = true;
        form.appendChild(el('p', '', 'We will email you a sign-in link and an 8-digit code. No password needed.'));
        const label = el('label', '', 'Email address');
        label.htmlFor = 'signin-email';
        label.style.marginTop = '0';
        const input = el('input', '');
        input.type = 'email';
        input.id = 'signin-email';
        input.name = 'email';
        input.autocomplete = 'email';
        input.setAttribute('inputmode', 'email');
        input.setAttribute('autocapitalize', 'none');
        input.spellcheck = false;
        input.value = prefill || '';
        const actions = el('div', 'actions');
        const go = button('Email me a code', '', 'submit');
        const no = button('Not now', 'secondary', 'button', false);
        no.addEventListener('click', dismiss);
        actions.append(go, no);
        form.append(label, input, actions);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (busy) return;
          const typed = input.value.trim();
          if (!typed) { showErr('Enter your email address.'); input.focus(); return; }
          try {
            const r = await run(() => SBS.api.requestLoginCode(typed));
            if (closed) return;
            email = typed;
            requestId = r.requestId;
            writePendingLogin({ requestId, email, expiry: Date.now() + PENDING_MS });
            showStep2();
          } catch (e2) {
            if (closed) return;
            showErr(e2.message);
            input.focus();
          }
        });
        body.appendChild(form);
        input.focus();
        if (prefill) input.select();
      }

      function showStep2() {
        step = 2;
        clearMsgs();
        body.innerHTML = '';
        const form = el('form', '');
        form.noValidate = true;
        form.appendChild(el('p', '', `We sent a link and an 8-digit code to <strong style="overflow-wrap:anywhere">${escapeHtml(email)}</strong>. Open the link, or type the code here.`));
        const label = el('label', '', '8-digit code');
        label.htmlFor = 'signin-code';
        label.style.marginTop = '0';
        // No maxlength: the email shows "1234 5678" and a paste keeps the space.
        const input = el('input', 'code-input');
        input.type = 'text';
        input.id = 'signin-code';
        input.name = 'code';
        input.setAttribute('inputmode', 'numeric');
        input.autocomplete = 'one-time-code';
        input.setAttribute('autocapitalize', 'none');
        input.spellcheck = false;
        const actions = el('div', 'actions');
        const go = button('Sign in', '', 'submit');
        const no = button('Not now', 'secondary', 'button', false);
        no.addEventListener('click', dismiss);
        actions.append(go, no);
        const more = el('div', 'actions');
        more.style.marginTop = '12px';
        const again = button('Send a new code', 'ghost small');
        const other = button('Use a different email', 'ghost small');
        more.append(again, other);
        form.append(label, input, actions, more);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (busy) return;
          const digits = input.value.replace(/\D/g, '');
          if (digits.length !== 8) { showErr('Enter the 8-digit code from the email.'); input.focus(); return; }
          try {
            await run(() => SBS.api.verifyLogin({ requestId, code: digits }));
          } catch (e2) {
            if (closed) return;
            showErr(e2.status === 401 ? 'That code is wrong or has expired. Check it, or send a new code.' : e2.message);
            input.focus();
            input.select();
            return;
          }
          clearPendingLogin();
          if (closed) {
            // Dismissed while this was in flight, and it worked: the cookie is
            // set, so redraw Home rather than leave it showing signed out.
            if (SBS.currentScreen && SBS.currentScreen() === 'home') SBS.go({ screen: 'home' });
            return;
          }
          finish(true);
        });
        again.addEventListener('click', async () => {
          if (busy) return;
          try {
            const r = await run(() => SBS.api.requestLoginCode(email));
            if (closed) return;
            requestId = r.requestId;
            writePendingLogin({ requestId, email, expiry: Date.now() + PENDING_MS });
            input.value = '';
            note.textContent = 'We sent a new code. Use the newest email.';
          } catch (e2) {
            if (!closed) showErr(e2.message);
          }
          if (!closed) input.focus();
        });
        other.addEventListener('click', () => {
          if (busy) return;
          clearPendingLogin();
          showStep1(email);
        });
        body.appendChild(form);
        input.focus();
      }

      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('visibilitychange', onVisible);
      closeOpenPrompt = () => finish(false);
      const pending = readPendingLogin();
      if (pending) {
        email = pending.email;
        requestId = pending.requestId;
        showStep2();
      } else {
        showStep1('');
      }
    });
  }

  // Generic multi-button choice modal (used for duplicate-name resolution etc.)
  function showChoice({ message, buttons }) {
    return new Promise(resolve => {
      const overlay = overlayEl();
      const box = el('div', 'card');
      box.style.cssText = 'max-width:480px; width:100%; box-shadow: var(--shadow-pop);';
      box.appendChild(el('p', '', message));
      const actions = el('div', 'actions');
      buttons.forEach(b => {
        const btn = el('button', b.variant || '', b.label);
        btn.addEventListener('click', () => { overlay.remove(); resolve(b.value); });
        actions.appendChild(btn);
      });
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  const HEADER_ICON = `<svg class="header-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="2" y="2" width="9" height="9" rx="2.5" fill="currentColor"/>
    <rect x="13" y="2" width="9" height="9" rx="2.5" fill="currentColor" opacity="0.75"/>
    <rect x="2" y="13" width="9" height="9" rx="2.5" fill="currentColor" opacity="0.75"/>
    <rect x="13" y="13" width="9" height="9" rx="2.5" fill="currentColor" opacity="0.5"/>
  </svg>`;

  const HOME_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M6 10v9a1 1 0 0 0 1 1h3.5v-5.5a1.5 1.5 0 0 1 1.5-1.5v0a1.5 1.5 0 0 1 1.5 1.5V20H17a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const TV_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3" y="5" width="18" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
    <path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
  const PHONE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="7" y="2" width="10" height="20" rx="2" stroke="currentColor" stroke-width="2"/>
    <path d="M11 18h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
  const PEOPLE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="2"/>
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <circle cx="17" cy="9" r="2.5" stroke="currentColor" stroke-width="2"/>
    <path d="M15.5 14.2c2.8.4 5 2.7 5 5.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  // Smart TV browsers (Samsung Tizen, LG webOS, generic HbbTV) identify
  // themselves in the UA string even though they otherwise look like a
  // plain desktop Chrome — Tizen's UA has no "Windows"/"Mac OS X"/"Linux"
  // distro marker recognized below, so detectDeviceInfo() falls through to
  // "Desktop". This is a separate, narrower check just for that.
  function isTvBrowser() {
    return /SMART-TV|SmartTV|Tizen|Web0S|WebOS|HbbTV|NETCAST|BRAVIA|GoogleTV|AFT[A-Z]/i.test(navigator.userAgent || '');
  }

  // Phone vs. tablet/desktop, using the same UA heuristic as
  // detectDeviceInfo()'s "Mobile" classification (iPad/Android-tablet
  // excluded so this only flags actual phone-sized screens).
  function isPhone() {
    const ua = navigator.userAgent || '';
    const isTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    const isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && isTouch);
    return /Mobi|iPhone|Android.*Mobile/.test(ua) && !isIpad;
  }

  // Best-effort device fingerprint for the header icon's hover tooltip —
  // parsed from the UA string, so it's a guess (especially on iPadOS, which
  // reports itself as Mac) rather than a guarantee.
  function detectDeviceInfo() {
    const ua = navigator.userAgent || '';
    const isTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    const isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && isTouch);
    let type = 'Desktop';
    if (/Mobi|iPhone|Android.*Mobile/.test(ua) && !isIpad) type = 'Mobile';
    else if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua) || isIpad) type = 'Tablet';

    let os = 'Unknown OS';
    if (isIpad) os = 'iPadOS';
    else if (/iPhone|iOS/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = 'Unknown Browser';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
    else if (/CriOS\//.test(ua)) browser = 'Chrome (iOS)';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

    const w = (window.screen && window.screen.width) || window.innerWidth;
    const h = (window.screen && window.screen.height) || window.innerHeight;

    return [
      `Device: ${type}`,
      `OS: ${os}`,
      `Browser: ${browser}`,
      `Screen: ${w}×${h}`,
      `Touch: ${isTouch ? 'Yes' : 'No'}`
    ];
  }

  function topbar(title, extraButtons, opts) {
    const bar = el('div', 'topbar');
    let homeBtn = null;
    if (!opts || opts.hideHome !== true) {
      homeBtn = el('button', 'icon-btn home-btn', HOME_ICON);
      homeBtn.type = 'button';
      homeBtn.setAttribute('aria-label', 'Home');
      homeBtn.title = 'Home';
      homeBtn.addEventListener('click', () => SBS.go({ screen: 'home' }));
    }
    if (homeBtn && opts && opts.homeLeft) bar.appendChild(homeBtn);
    const h1Cls = 'badge-fit' + (opts && opts.pill ? ' brand-pill' : '');
    const h1 = el('h1', h1Cls, (opts && opts.hideIcon ? '' : HEADER_ICON) + title);
    const infoLines = detectDeviceInfo();
    h1.title = infoLines.join('\n');
    // Hover tooltips don't work on touch devices (phone/iPad) or TV
    // remotes, so tapping/clicking the icon also surfaces the same info
    // through the existing cross-device modal.
    h1.style.cursor = 'pointer';
    h1.addEventListener('click', () => showAlert(infoLines.map(escapeHtml).join('<br>')));
    bar.appendChild(h1);
    const nav = el('div', 'nav');
    if (homeBtn && !(opts && opts.homeLeft)) nav.appendChild(homeBtn);
    (extraButtons || []).forEach(btn => nav.appendChild(btn));
    bar.appendChild(nav);
    return bar;
  }

  function statusLabel(s) {
    return { setup: 'Setup', picking: 'Picking Squares', started: 'In Progress', finished: 'Finished' }[s] || s;
  }

  // "2026-01-26T18:00Z" -> "Sun, Jan 26 · 1:00 PM" in the viewer's local time.
  function formatKickoffTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // Kickoff time is only meaningful before the game actually gets underway —
  // once status flips to 'started' (or later, 'finished'), the live score /
  // final result tells the real story, so the notice disappears rather than
  // sitting there stale.
  function kickoffNotice(game) {
    if (!game || !game.kickoffTime) return '';
    if (game.status === 'started' || game.status === 'finished') return '';
    const when = formatKickoffTime(game.kickoffTime);
    return when ? `Kickoff: ${escapeHtml(when)}` : '';
  }

  const LEAGUE_LABELS = { nfl: 'NFL', nba: 'NBA', other: 'Other' };
  function leagueLabel(league) { return LEAGUE_LABELS[league] || 'Other'; }

  function leagueBadge(league) {
    const cls = `league-badge league-${league || 'other'}`;
    return `<span class="${cls}">${leagueLabel(league)}</span>`;
  }

  // ---------- Team colours ----------
  // NFL/NBA colors are auto-detected from free-text team names; 'other' has no
  // team database at all, so its colors always come from the host's own
  // color-picker choice on the game (teamAColor/teamBColor).
  const DEFAULT_COLORS = { teamA: '#ff6b6b', teamAAlt: '#ffb3b3', teamB: '#4dabf7', teamBAlt: '#a5d8ff' };

  function teamMeta(name, league) {
    return (window.TeamData && window.TeamData.findTeamMeta(name, league)) || null;
  }

  // Darkens (negative percent) or lightens (positive) a hex color — used to
  // invent a plausible "secondary" shade for a custom 'other'-league color,
  // since the host only picks one color per team.
  function shadeColor(hex, percent) {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    if (isNaN(n)) return hex;
    const clamp = v => Math.max(0, Math.min(255, v));
    const amt = Math.round(2.55 * percent);
    const r = clamp(((n >> 16) & 255) + amt);
    const g = clamp(((n >> 8) & 255) + amt);
    const b = clamp((n & 255) + amt);
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  // Resolves everything needed to render one side ('A' or 'B') of a game's
  // matchup: brand color pair, font, abbreviation, and whether a real team
  // was actually matched (vs. falling back to defaults).
  function teamStyle(game, side) {
    const name = side === 'A' ? game.teamA : game.teamB;
    const league = game && game.league;
    if (league === 'other') {
      const custom = side === 'A' ? game.teamAColor : game.teamBColor;
      const primary = custom || (side === 'B' ? DEFAULT_COLORS.teamB : DEFAULT_COLORS.teamA);
      return { primary, secondary: shadeColor(primary, -22), font: null, abbr: teamAbbr(name, null), matched: false, league };
    }
    const meta = teamMeta(name, league);
    if (meta) {
      return { primary: meta.primary, secondary: meta.secondary, font: meta.font, abbr: meta.abbr.toUpperCase(), matched: true, league, meta };
    }
    return {
      primary: side === 'B' ? DEFAULT_COLORS.teamB : DEFAULT_COLORS.teamA,
      secondary: side === 'B' ? DEFAULT_COLORS.teamBAlt : DEFAULT_COLORS.teamAAlt,
      font: null, abbr: teamAbbr(name, null), matched: false, league
    };
  }

  function applyTeamColors(game) {
    const root = document.documentElement;
    const a = teamStyle(game, 'A');
    const b = teamStyle(game, 'B');
    root.style.setProperty('--teamA', a.primary);
    root.style.setProperty('--teamA-alt', a.secondary);
    root.style.setProperty('--teamB', b.primary);
    root.style.setProperty('--teamB-alt', b.secondary);
    return { styleA: a, styleB: b };
  }

  function resetTeamColors() {
    const root = document.documentElement;
    ['--teamA', '--teamA-alt', '--teamB', '--teamB-alt'].forEach(p => root.style.removeProperty(p));
  }

  // ---------- Team badge (colored pill: team color as background, and
  // an auto-picked readable text color) ----------
  // Every place a team name is displayed uses this, so a dark brand color
  // (navy, purple, black...) never becomes low-contrast text on our dark
  // theme — the color becomes the badge's background instead, paired with
  // whichever of near-white/near-black actually reads against it.
  function relLuminance(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const lin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function readableTextColor(bgHex) {
    const lum = relLuminance(bgHex);
    const contrastWhite = 1.05 / (lum + 0.05);
    const contrastBlack = (lum + 0.05) / 0.05;
    return contrastWhite >= contrastBlack ? '#f4f7fa' : '#12181f';
  }

  function teamColor(game, side) {
    return teamStyle(game, side).primary;
  }

  // A short fallback for team names that don't match a known team (so
  // free-text entries still get something reasonable in the abbreviated view).
  function teamAbbr(name, meta) {
    if (meta) return meta.abbr.toUpperCase();
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
    return String(name || '').slice(0, 3).toUpperCase();
  }

  // Renders full name and abbreviation together; fitTeamBadges() below picks
  // which one is visible based on available space.
  function teamBadge(game, side, opts) {
    opts = opts || {};
    const name = side === 'A' ? game.teamA : game.teamB;
    const style = teamStyle(game, side);
    const bg = style.primary;
    const fg = readableTextColor(bg);
    const cls = 'team-badge' + (opts.cls ? ' ' + opts.cls : '');
    const fontStyle = style.font ? ` font-family:${style.font}, var(--sans);` : '';
    return `<span class="${cls}" style="background:${bg}; color:${fg};"><span class="team-badge-name" style="${fontStyle}"><span class="badge-full">${escapeHtml(name)}</span><span class="badge-abbr">${escapeHtml(style.abbr)}</span></span></span>`;
  }

  function legalLinks() {
    return el('div', 'footer-note footer-links',
      '<a href="terms.html">Terms</a> &middot; <a href="privacy.html">Privacy</a> &middot; <a href="contact.html">Contact</a>');
  }

  // Downgrades team-badge display within each `.badge-fit` container, in
  // order, until its content stops overflowing: full name -> abbreviation.
  // All badges sharing a container downgrade
  // together so e.g. a matchup header reads consistently on both sides.
  // A few px of slack rather than bare `> 0` — sub-pixel layout rounding
  // (varies by browser/OS/DPI) can put a badge that truly just fits a
  // couple of px on the wrong side of an exact comparison. Erring toward
  // abbreviating a hair early is harmless; erring the other way visibly
  // clips the last letter or two of a long name, which is the actual bug
  // this margin exists to avoid.
  //
  // Some layouts (the score-entry team/input row, the player ticker) put
  // team A and team B in their own separate `.badge-fit` wraps side by side
  // instead of one shared wrap, so each side would otherwise measure its own
  // space and could downgrade independently — team A staying "Los Angeles
  // Rams" while team B next to it shrinks to "LAR". Group wraps by their
  // immediate parent so a sibling pair like that is judged as one unit: if
  // either side needs to shrink, both do, at the same step.
  const FIT_SLACK_PX = 4;
  function fitTeamBadges(root) {
    const wraps = Array.from((root || document).querySelectorAll('.badge-fit'));
    const groups = new Map();
    wraps.forEach(wrap => {
      const key = wrap.parentElement || wrap;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(wrap);
    });
    groups.forEach(group => {
      const badges = group.flatMap(wrap => Array.from(wrap.querySelectorAll('.team-badge')));
      if (!badges.length) return;
      badges.forEach(b => b.classList.remove('mode-abbr'));
      const overflows = () => group.some(wrap => wrap.scrollWidth > wrap.clientWidth + FIT_SLACK_PX);
      if (overflows()) {
        badges.forEach(b => b.classList.add('mode-abbr'));
      }
    });
  }

  let fitResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(fitResizeTimer);
    fitResizeTimer = setTimeout(() => fitTeamBadges(document), 120);
  });

  // ---------- Fullscreen ----------
  // iPadOS Safari only exposes the webkit-prefixed calls, and iPhone Safari has
  // no element fullscreen at all — so callers must not depend on this working.
  // The TV view hides its own chrome regardless, which is most of the benefit
  // when the screen is being mirrored to a television anyway.
  const fullscreen = {
    supported() {
      const d = document.documentElement;
      return !!(d.requestFullscreen || d.webkitRequestFullscreen || d.webkitRequestFullScreen);
    },
    active() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement);
    },
    async enter() {
      const d = document.documentElement;
      const fn = d.requestFullscreen || d.webkitRequestFullscreen || d.webkitRequestFullScreen;
      if (!fn) return false;
      try {
        await fn.call(d);
        return true;
      } catch (e) {
        return false;
      }
    },
    async exit() {
      const fn = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      if (!fn) return false;
      try {
        await fn.call(document);
        return true;
      } catch (e) {
        return false;
      }
    },
    onChange(handler) {
      document.addEventListener('fullscreenchange', handler);
      document.addEventListener('webkitfullscreenchange', handler);
      return () => {
        document.removeEventListener('fullscreenchange', handler);
        document.removeEventListener('webkitfullscreenchange', handler);
      };
    }
  };

  // ---------- Screen wake lock ----------
  // The TV grid is meant to sit on screen for hours. If the iPad it is mirrored
  // from auto-locks, AirPlay stops and the television goes dark — so hold a wake
  // lock while the TV view is up, and re-acquire it after the tab is
  // backgrounded (the browser drops the lock on visibility change).
  function keepScreenAwake() {
    if (!('wakeLock' in navigator)) return () => {};
    let lock = null;
    let released = false;

    async function acquire() {
      if (released || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch (e) {
        // Denied (often on battery saver) — nothing to do but carry on.
      }
    }

    const onVisible = () => { if (!lock) acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    acquire();

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) { lock.release().catch(() => {}); lock = null; }
    };
  }

  SBS.ui = {
    el, escapeHtml, money, overlayEl, fullscreen, keepScreenAwake,
    showModal, showConfirm, showAlert, showChoice, showPasswordPrompt, showEmailPrompt, closeEmailPrompt, clearPendingLogin,
    topbar, statusLabel, leagueLabel, leagueBadge, isTvBrowser, isPhone,
    formatKickoffTime, kickoffNotice,
    teamMeta, teamStyle, applyTeamColors, resetTeamColors,
    legalLinks, teamColor, readableTextColor, teamBadge, fitTeamBadges, teamAbbr, shadeColor,
    TV_ICON, PHONE_ICON, PEOPLE_ICON
  };
})();
