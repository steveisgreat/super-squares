// Shared DOM helpers: element building, escaping, money formatting, the modal
// stack, the top bar, and the team colour/logo theming.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // For any text that came from a person, a feed or the server.
  function textEl(tag, cls, text) {
    const e = el(tag, cls);
    e.textContent = text;
    return e;
  }

  // Fields that should be colors end up inside style attributes.
  const isColor = window.GameLogic.isColor;

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
  // `message` is text, never HTML, so nothing in it needs escaping (a newline
  // is a line break). Messages carry names and server errors, and one missed
  // escape would be a script in another person's browser.
  function messageEl(message) {
    const p = textEl('p', '', message);
    p.style.whiteSpace = 'pre-line';
    return p;
  }

  function showModal({ message, okText, cancelText }) {
    return new Promise(resolve => {
      const overlay = overlayEl();
      const box = el('div', 'card');
      box.style.cssText = 'max-width:440px; width:100%; box-shadow: var(--shadow-pop);';
      box.appendChild(messageEl(message));
      const actions = el('div', 'actions');
      const okBtn = textEl('button', '', okText || 'OK');
      actions.appendChild(okBtn);
      if (cancelText !== null) {
        const cancelBtn = textEl('button', 'secondary', cancelText || 'Cancel');
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

  // Confirm text before a change that would unsettle quarters marked paid out
  // (R21, decision 015). `labels` comes from GameLogic.paidQuartersDisturbed.
  function disturbMessage(labels) {
    const list = labels.join(' and ');
    return `${list} ${labels.length > 1 ? 'are' : 'is'} marked paid out. This change moves that money, so ${list} will show Needs settling until you sort it out with the players. Continue?`;
  }

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
      box.appendChild(messageEl(message));
      const actions = el('div', 'actions');
      buttons.forEach(b => {
        const btn = textEl('button', b.variant || '', b.label);
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

  // `title` is HTML: callers escape what they put in it.
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
    h1.addEventListener('click', () => showAlert(infoLines.join('\n')));
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
  const leagueKey = (league) => (Object.keys(LEAGUE_LABELS).includes(league) ? league : 'other');
  function leagueLabel(league) { return LEAGUE_LABELS[leagueKey(league)]; }

  // League-level (not team-level) logos, from the same ESPN CDN as the team
  // logos above. 'other' has no logo at all — its badge is just the word.
  const LEAGUE_LOGO_URL = {
    nfl: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
    nba: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png'
  };

  function leagueBadge(league) {
    const key = leagueKey(league);
    const cls = `league-badge league-${key}`;
    const label = leagueLabel(league);
    const logo = LEAGUE_LOGO_URL[key];
    if (!logo) return `<span class="${cls}">${label}</span>`;
    // If the CDN logo 404s, the image-error listener below hides it and
    // reveals the text fallback that's already sitting there — same "never
    // show a broken image" rule the team logos follow.
    return `<span class="${cls}" title="${label}">`
      + `<img src="${logo}" class="league-badge-logo" alt="${label}">`
      + `<span class="league-badge-text" style="display:none;">${label}</span>`
      + `</span>`;
  }

  // ---------- Team colours / logos ----------
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
      const primary = isColor(custom) ? custom : (side === 'B' ? DEFAULT_COLORS.teamB : DEFAULT_COLORS.teamA);
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

  const HELMET_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>
    <ellipse cx='33' cy='28' rx='25' ry='21' fill='%237b8794'/>
    <path d='M9 32 Q7 48 25 53 L26 44 Q15 40 13 30 Z' fill='%237b8794'/>
    <ellipse cx='33' cy='28' rx='25' ry='21' fill='none' stroke='%234a5773' stroke-width='2'/>
    <path d='M29 39 L47 39 M28 45 L45 45 M30 51 L40 51' stroke='%232a3346' stroke-width='3' stroke-linecap='round'/>
  </svg>`;
  const HELMET_DATA_URI = 'data:image/svg+xml,' + HELMET_SVG.replace(/\s+/g, ' ').trim();

  // Logos come from ESPN's CDN at runtime; the helmet is the offline fallback
  // so the TV layout never shows a broken image — and also what renders for a
  // free-text team name that doesn't match a real team (or for the 'other'
  // league, which has no logos at all), so a logo icon is always present
  // rather than sometimes missing.
  function teamLogoTag(game, side, size) {
    const style = teamStyle(game, side);
    const s = size || 28;
    if (!style.matched || !window.TeamData) {
      return `<img src="${HELMET_DATA_URI}" class="team-logo" style="--logo-size:${s}px;" alt="">`;
    }
    const url = window.TeamData.logoUrl(style.meta, style.league);
    const name = side === 'A' ? game.teamA : game.teamB;
    return `<img src="${url}" class="team-logo" style="--logo-size:${s}px;" alt="${escapeHtml(name)}">`;
  }

  // A logo that fails to load (CDN down, unknown abbreviation, offline LAN)
  // swaps to the helmet, or for a league logo to its text. One capturing
  // listener instead of inline onerror= attributes, which the
  // Content-Security-Policy forbids (vercel.json). Image error events don't
  // bubble, so this listens in the capture phase.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('team-logo') && img.src !== HELMET_DATA_URI) {
      img.src = HELMET_DATA_URI;
    } else if (img.classList.contains('league-badge-logo')) {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'inline';
    }
  }, true);

  // ---------- Team badge (colored pill: team color as background, logo, and
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
  // which one is visible (and whether the logo shows) based on available space.
  function teamBadge(game, side, opts) {
    opts = opts || {};
    const name = side === 'A' ? game.teamA : game.teamB;
    const style = teamStyle(game, side);
    const bg = style.primary;
    const fg = readableTextColor(bg);
    const logo = teamLogoTag(game, side, opts.logoSize || 20);
    const cls = 'team-badge' + (opts.cls ? ' ' + opts.cls : '');
    const fontStyle = style.font ? ` font-family:${style.font}, var(--sans);` : '';
    return `<span class="${cls}" style="background:${bg}; color:${fg};">${logo}<span class="team-badge-name" style="${fontStyle}"><span class="badge-full">${escapeHtml(name)}</span><span class="badge-abbr">${escapeHtml(style.abbr)}</span></span></span>`;
  }

  function legalLinks() {
    return el('div', 'footer-note footer-links',
      '<a href="terms.html">Terms</a> &middot; <a href="privacy.html">Privacy</a> &middot; <a href="contact.html">Contact</a>');
  }

  // Downgrades team-badge display within each `.badge-fit` container, in
  // order, until its content stops overflowing: full name -> abbreviation ->
  // abbreviation with no logo. All badges sharing a container downgrade
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
      badges.forEach(b => b.classList.remove('mode-abbr', 'mode-nologo'));
      const overflows = () => group.some(wrap => wrap.scrollWidth > wrap.clientWidth + FIT_SLACK_PX);
      if (overflows()) {
        badges.forEach(b => b.classList.add('mode-abbr'));
      }
      if (overflows()) {
        badges.forEach(b => b.classList.add('mode-nologo'));
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
  // `onUnavailable` (optional) is called once when the lock cannot be held: no API, or the request
  // was refused (Low Power Mode, an older iOS home-screen app). The return value is unchanged.
  function keepScreenAwake(onUnavailable) {
    let told = false;
    function unavailable() {
      if (told || !onUnavailable) return;
      told = true;
      try { onUnavailable(); } catch (e) { /* the caller's tip is best effort */ }
    }
    if (!('wakeLock' in navigator) || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      unavailable();
      return () => {};
    }
    let lock = null;
    let released = false;

    async function acquire() {
      if (released || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch (e) {
        // Denied (often on battery saver): carry on, and let the caller know.
        unavailable();
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

  // Party View keeps the screen awake. On a touch device that cannot (no wake lock, or it was
  // refused) a note says so once per browser: "Your screen may sleep ...". Never on a TV-paired
  // screen and never with a mouse. Returns the release function of keepScreenAwake.
  const SLEEP_TIP_KEY = 'sbs.sleeptip';
  function keepPartyAwake(host, paired) {
    return keepScreenAwake(() => {
      if (paired || !host || !host.isConnected) return;
      if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
      try { if (window.localStorage.getItem(SLEEP_TIP_KEY) === '1') return; } catch (e) { /* ask again next time */ }
      if (host.querySelector('.sleep-tip')) return;
      const tip = el('div', 'sleep-tip');
      tip.setAttribute('role', 'note');
      const text = el('span', '', "Your screen may sleep. Turn off Auto-Lock in Settings while the party's on.");
      const ok = el('button', 'sleep-tip-ok', 'Got it');
      ok.type = 'button';
      ok.addEventListener('click', (e) => {
        e.stopPropagation();
        try { window.localStorage.setItem(SLEEP_TIP_KEY, '1'); } catch (err) { /* hidden for this visit only */ }
        tip.remove();
      });
      tip.append(text, ok);
      host.appendChild(tip);
    });
  }

  // Tabler outline icons (MIT, 24 px): arrows-maximize, copy, printer, chevron-right, x.
  const ic = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const MAXIMIZE_ICON = ic('<path d="M16 4l4 0l0 4"/><path d="M14 10l6 -6"/><path d="M8 20l-4 0l0 -4"/><path d="M4 20l6 -6"/><path d="M16 20l4 0l0 -4"/><path d="M14 14l6 6"/><path d="M8 4l-4 0l0 4"/><path d="M4 4l6 6"/>');
  const COPY_ICON = ic('<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>');
  const PRINT_ICON = ic('<path d="M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2"/><path d="M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4"/><path d="M7 13m0 2a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2z"/>');
  const CHEVRON_ICON = ic('<path d="M9 6l6 6l-6 6"/>');
  const CLOSE_ICON = ic('<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>');

  SBS.ui = {
    el, textEl, escapeHtml, isColor, money, overlayEl, fullscreen, keepScreenAwake, keepPartyAwake,
    showModal, showConfirm, showAlert, disturbMessage, showChoice, showPasswordPrompt, showEmailPrompt, closeEmailPrompt, clearPendingLogin,
    topbar, statusLabel, leagueLabel, leagueBadge, isTvBrowser, isPhone,
    formatKickoffTime, kickoffNotice,
    teamMeta, teamStyle, applyTeamColors, resetTeamColors, teamLogoTag,
    legalLinks, teamColor, readableTextColor, teamBadge, fitTeamBadges, teamAbbr, shadeColor,
    TV_ICON, PHONE_ICON, PEOPLE_ICON, MAXIMIZE_ICON, COPY_ICON, PRINT_ICON, CHEVRON_ICON, CLOSE_ICON
  };
})();
