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

  const OVERLAY_CSS = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; z-index:1000; padding:calc(20px + var(--sat)) calc(20px + var(--sar)) calc(20px + var(--sab)) calc(20px + var(--sal));';

  function overlayEl(opacity) {
    const overlay = el('div', 'sbs-overlay');
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

  // What goes above each "Sign in" button that finishes a sign-in: the Terms notice and the
  // next-season box (decision 024). `values()` is sent with the sign-in. The box starts unticked,
  // and leaving it so changes nothing for a host who opted in before.
  function signInConsent() {
    const node = el('div', 'signin-consent',
      `<label class="checkbox-label"><input type="checkbox" name="news"> <span>Tell me about next season</span></label>
      <p class="signin-terms">By signing in you agree to the <a href="terms.html" target="_blank" rel="noopener">Terms</a> and <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>`);
    const box = node.querySelector('input');
    return { node, values: () => ({ terms: true, news: box.checked }) };
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
      let consent = null; // step 2's box

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
        const items = Array.from(box.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href]'));
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
          if (closed || !s || !s.host) return;
          // Ticked here, finished there: keep the choice, for the address typed here only.
          if (consent && consent.values().news && s.email === email.toLowerCase()) SBS.api.setNews(true).catch(() => {});
          clearPendingLogin();
          finish(true);
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
        consent = signInConsent();
        form.append(label, input, consent.node, actions, more);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (busy) return;
          const digits = input.value.replace(/\D/g, '');
          if (digits.length !== 8) { showErr('Enter the 8-digit code from the email.'); input.focus(); return; }
          try {
            await run(() => SBS.api.verifyLogin(Object.assign({ requestId, code: digits }, consent.values())));
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

  // Tabler outline "chevron-left" (MIT).
  const BACK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';

  // `title` is HTML: callers escape what they put in it. With opts.back it is a page header: a
  // round Back button in place of Home, and the title beside it.
  function topbar(title, extraButtons, opts) {
    const bar = el('div', 'topbar');
    // Home is always the first thing in the bar, top left.
    if (opts && opts.back) {
      bar.classList.add('page-topbar');
      const backBtn = el('button', 'icon-btn page-back', BACK_ICON);
      backBtn.type = 'button';
      backBtn.setAttribute('aria-label', 'Back');
      backBtn.addEventListener('click', opts.back);
      bar.appendChild(backBtn);
    } else if (!opts || opts.hideHome !== true) {
      const homeBtn = el('button', 'icon-btn home-btn', HOME_ICON);
      homeBtn.type = 'button';
      homeBtn.setAttribute('aria-label', 'Home');
      homeBtn.title = 'Home';
      homeBtn.addEventListener('click', () => SBS.go({ screen: 'home' }));
      bar.appendChild(homeBtn);
    }
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
    (extraButtons || []).forEach(btn => nav.appendChild(btn));
    bar.appendChild(nav);
    return bar;
  }

  function statusLabel(s) {
    return { setup: 'Setup', picking: 'Picking Squares', started: 'In Progress', finished: 'Finished' }[s] || s;
  }

  // "2026-12-05" -> "Sat, Dec 5", parsed as a local date so it never shifts a day off from what
  // the host picked. A year is added only when it is not this year.
  function formatGameDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
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
  // swaps to the helmet. One capturing
  // listener instead of inline onerror= attributes, which the
  // Content-Security-Policy forbids (vercel.json). Image error events don't
  // bubble, so this listens in the capture phase.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('team-logo') && img.src !== HELMET_DATA_URI) {
      img.src = HELMET_DATA_URI;
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

  // A team color close to the dark cards (the Bears' navy) would leave its pill invisible. Those
  // get an outline: the team's second color, or a light one when that is dark too. '' for the rest.
  // The card color is the page's --panel in the current theme (read once per theme, #12171f if it
  // can't be read).
  const CARD_BG_FALLBACK = '#12171f';
  const cardBgCache = {};
  function cardBg() {
    const theme = document.documentElement.dataset.theme || 'classic';
    if (cardBgCache[theme]) return cardBgCache[theme];
    let v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(); } catch (e) { /* use the fallback */ }
    const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : CARD_BG_FALLBACK;
    cardBgCache[theme] = hex;
    return hex;
  }
  function teamEdge(game, side) {
    const cardColor = cardBg();
    const contrast = (hex) => {
      const a = relLuminance(hex) + 0.05, b = relLuminance(cardColor) + 0.05;
      return Math.max(a, b) / Math.min(a, b);
    };
    const style = teamStyle(game, side);
    if (!isColor(style.primary) || contrast(style.primary) >= 1.45) return '';
    return isColor(style.secondary) && contrast(style.secondary) >= 2 ? style.secondary : '#aab4be';
  }

  // The color of a team pill's 2 px outline: the team's first color when it stands out from the dark
  // page, else its second, else a light gray. A thin line needs more contrast than a filled edge did.
  function teamOutline(game, side) {
    const page = cardBg();
    const contrast = (hex) => {
      const a = relLuminance(hex) + 0.05, b = relLuminance(page) + 0.05;
      return Math.max(a, b) / Math.min(a, b);
    };
    const style = teamStyle(game, side);
    if (isColor(style.primary) && contrast(style.primary) >= 2.2) return style.primary;
    if (isColor(style.secondary) && contrast(style.secondary) >= 2.2) return style.secondary;
    return '#aab4be';
  }

  // The capitals of each team font, in em: how far they sit from the middle of their line (positive
  // is low) and how tall they are. Measured once from the font files, so a pill can center the name
  // and draw every team's capitals the same height (at one font size they differ by a third).
  const TEAM_CAPS = {
    'Alfa Slab One': [-0.048, 0.795], 'Anton': [-0.015, 0.875], 'Archivo Black': [0.018, 0.69], 'Bebas Neue': [-0.06, 0.72],
    'Bevan': [-0.045, 0.795], 'Bungee': [-0.01, 0.74], 'Orbitron': [0.022, 0.72], 'Oswald': [0.048, 0.81],
    'Rye': [-0.028, 0.775], 'Share Tech Mono': [-0.037, 0.72], 'Staatliches': [-0.033, 0.715],
    'Stardos Stencil': [-0.063, 0.695], 'Teko': [-0.08, 0.645], 'Zilla Slab': [0.02, 0.65]
  };
  const BODY_CAPS = [0.055, 0.69]; // Exo 2, for a team with no font of its own
  const CAP_HEIGHT = 0.72;

  function teamColor(game, side) {
    return teamStyle(game, side).primary;
  }

  // A short fallback for team names that don't match a known team (so
  // free-text entries still get something reasonable in the abbreviated view).
  // The description to show for a board, or '' when it only repeats the matchup: every screen
  // that shows it also shows the teams. The form's own default ("Chiefs @ Eagles") and anything
  // else naming both teams counts, by full name, nickname, city or capital abbreviation (KC).
  function shownDescription(game) {
    const desc = String((game && game.description) || '').trim();
    if (!desc) return '';
    const words = s => ' ' + String(s || '').toLowerCase().replace(/[!-\/:-@\[-`{-~\s‐-―‘’]+/g, ' ').trim() + ' ';
    const text = words(desc);
    const named = (team) => {
      const meta = teamMeta(team, game.league);
      const names = [team].concat(meta ? meta.names : []).map(words).filter(w => w.trim());
      if (names.some(w => text.indexOf(w) !== -1)) return true;
      return !!meta && new RegExp('(^|[^A-Za-z0-9])' + meta.abbr.toUpperCase() + '($|[^A-Za-z0-9])').test(desc);
    };
    return named(game.teamA) && named(game.teamB) ? '' : desc;
  }

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
    const size = opts.logoSize || 20;
    const logo = teamLogoTag(game, side, size);
    const cls = 'team-badge' + (opts.cls ? ' ' + opts.cls : '');
    // The logo's disc. The pill is outlined in the team color, or its second color where the first
    // would vanish on the dark page (teamEdge), and the outline starts behind the logo (decision 029).
    const disc = size + (/team-badge-sm/.test(cls) ? 4 : 6);
    const outline = teamOutline(game, side);
    const vars = `--outline:${outline}; --disc:${disc}px;`;
    const [off, caps] = (style.font && TEAM_CAPS[style.font.replace(/'/g, '')]) || BODY_CAPS;
    const fontStyle = style.font ? ` font-family:${style.font}, var(--sans);` : '';
    return `<span class="${cls}" style="${vars}">${logo}<span class="team-badge-name" style="--caps:${-off}em; font-size:${(CAP_HEIGHT / caps).toFixed(3)}em;${fontStyle}"><span class="badge-full">${escapeHtml(name)}</span><span class="badge-abbr">${escapeHtml(style.abbr)}</span></span></span>`;
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
  const refitSoon = () => {
    clearTimeout(fitResizeTimer);
    fitResizeTimer = setTimeout(() => fitTeamBadges(document), 120);
  };
  window.addEventListener('resize', refitSoon);
  // A team font that arrives after the first fit is wider than the fallback it replaced, so a
  // matchup that fitted can now overflow (and be cut off): fit again once fonts finish loading.
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', refitSoon);

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

  // Party View adds one history entry, so a phone's Back gesture or a TV remote's Back key leaves
  // Party View (onBack) instead of leaving the site. The entry also carries where Party View was
  // opened from, which the hash alone does not say, so a reload still knows. Returns:
  // from: the remembered origin (or the one given); exit(): leave through history (onBack runs
  // on popstate), false when there is no entry to use and the caller should leave itself.
  function partyHistory(id, from, onBack) {
    let armed = false;
    const st = window.history.state;
    if (!from && st && st.sbsParty && st.id === id) from = st.from;
    try {
      if (!(st && st.sbsParty && st.id === id)) window.history.pushState({ sbsParty: 1, id: id, from: from || '' }, '', location.href);
      armed = true;
    } catch (e) { /* Back leaves the site, as before */ }
    function onPop() {
      if (!armed) return;
      release();
      onBack();
    }
    function release() {
      armed = false;
      window.removeEventListener('popstate', onPop);
    }
    window.addEventListener('popstate', onPop);
    SBS.onLeaveScreen(release);
    return {
      from: from,
      exit: function () {
        const s = window.history.state;
        if (!armed || !(s && s.sbsParty)) return false;
        window.history.back();
        return true;
      }
    };
  }

  // Tabler outline icons (MIT, 24 px): arrows-maximize, copy, printer, qrcode, chevron-right,
  // playlist-add, x.
  const ic = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const MAXIMIZE_ICON = ic('<path d="M16 4l4 0l0 4"/><path d="M14 10l6 -6"/><path d="M8 20l-4 0l0 -4"/><path d="M4 20l6 -6"/><path d="M16 20l4 0l0 -4"/><path d="M14 14l6 6"/><path d="M8 4l-4 0l0 4"/><path d="M4 4l6 6"/>');
  const COPY_ICON = ic('<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>');
  const PRINT_ICON = ic('<path d="M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2"/><path d="M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4"/><path d="M7 13m0 2a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2z"/>');
  const QR_ICON = ic('<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M7 17l0 .01"/><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M7 7l0 .01"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M17 7l0 .01"/><path d="M14 14l3 0"/><path d="M20 14l0 .01"/><path d="M14 14l0 3"/><path d="M14 20l3 0"/><path d="M17 17l3 0"/><path d="M20 17l0 3"/>');
  const CHEVRON_ICON = ic('<path d="M9 6l6 6l-6 6"/>');
  const PASTE_ICON = ic('<path d="M19 8h-14"/><path d="M5 12h9"/><path d="M11 16h-6"/><path d="M15 16h6"/><path d="M18 13v6"/>');
  const CLOSE_ICON = ic('<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>');

  // The one way a dialog closes: an X in its top-right corner (no Done or Close button).
  // Pins the X to `box` and leaves room for it beside the title.
  function addCloseX(box, onClose) {
    const x = el('button', 'icon-btn dialog-x', CLOSE_ICON);
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => onClose());
    box.classList.add('has-dialog-x');
    box.appendChild(x);
    return x;
  }

  // A small dialog on top of everything. `build(box, close)` fills it. Escape and a tap outside
  // close it. Nothing in it has focus unless build says so, so a stray Enter confirms nothing.
  // `opts.closeX` adds the corner X, for a sheet with no Cancel of its own.
  function openSheet(title, build, opts = {}) {
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
      const all = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled && n.offsetParent !== null);
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
    if (opts.closeX) addCloseX(box, close);
    return close;
  }

  // "Where did you hear about us?" (R45c): one optional sheet for a signed-in host the server says
  // to ask (`askHeard` on /api/session). Send and Skip both answer once; Escape sends "skip", and a
  // tap outside closes it without an answer. A failed send closes quietly, so it may ask again next visit.
  const HEARD_CHOICES = [
    ['friend', 'A friend'], ['search', 'Search'], ['video', 'TikTok, Reels or Shorts'],
    ['group', 'A Facebook or Reddit group'], ['ad', 'An ad'], ['other', 'Something else']
  ];
  // Once per page load: Home redraws (and asks the session again) while the answer is still saving.
  let heardShown = false;
  function showHeardSheet() {
    if (heardShown) return;
    heardShown = true;
    const back = document.activeElement;
    const overlay = overlayEl('0.72');
    overlay.classList.add('sp-overlay');
    const box = el('div', 'card sp-sheet heard-sheet');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'heard-title');
    box.tabIndex = -1;
    const title = textEl('h3', '', 'Where did you hear about us?');
    title.id = 'heard-title';
    const hint = textEl('p', 'sp-sheet-small', 'Optional. It only helps us count where hosts come from.');
    const group = el('div', 'heard-choices');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', 'heard-title');
    let picked = '';
    const otherInput = el('input', 'heard-other');
    otherInput.type = 'text';
    otherInput.maxLength = 80;
    otherInput.hidden = true;
    otherInput.setAttribute('aria-label', 'Tell us where (optional)');
    otherInput.placeholder = 'Tell us where (optional)';
    const send = textEl('button', '', 'Send');
    send.type = 'button';
    send.disabled = true;
    const skip = textEl('button', 'secondary', 'Skip');
    skip.type = 'button';
    HEARD_CHOICES.forEach(([key, label]) => {
      const row = el('label', 'checkbox-label heard-choice');
      const radio = el('input', '');
      radio.type = 'radio';
      radio.name = 'heard';
      radio.value = key;
      radio.addEventListener('change', () => {
        picked = key;
        send.disabled = false;
        otherInput.hidden = key !== 'other';
        if (key === 'other') otherInput.focus();
      });
      row.append(radio, textEl('span', '', label));
      group.appendChild(row);
    });
    const actions = el('div', 'actions heard-actions');
    actions.append(send, skip);
    box.append(title, hint, group, otherInput, actions);
    overlay.appendChild(box);

    let done = false;
    function finish(answer, other) {
      if (done) return;
      done = true;
      overlay.remove();
      if (back && document.body.contains(back) && back.focus) back.focus();
      if (answer) SBS.api.sendHeard(answer, other).catch(() => { /* quiet: it may ask again next visit */ });
    }
    send.addEventListener('click', () => {
      if (!picked) return;
      finish(picked, picked === 'other' ? otherInput.value.trim().slice(0, 80) : '');
    });
    skip.addEventListener('click', () => finish('skip'));
    // A tap outside only closes it (easy by accident on a phone): nothing is sent, so it may ask again.
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) finish(null); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('skip'); return; }
      if (e.key === 'Enter' && e.target === otherInput && picked) { e.preventDefault(); send.click(); return; }
      if (e.key !== 'Tab') return;
      const all = Array.from(box.querySelectorAll('button, input')).filter(n => !n.disabled && n.offsetParent !== null);
      // The radios are one Tab stop: the checked one, or the first when none is.
      const first = box.querySelector('input[type=radio]:checked') || all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // No leave-screen hook: Home redraws itself when the games list changes, and that must not
    // skip the question for a host who is still reading it.
    document.body.appendChild(overlay);
    box.focus();
  }

  SBS.ui = {
    showHeardSheet, openSheet, el, textEl, escapeHtml, isColor, money, overlayEl, fullscreen, keepScreenAwake, keepPartyAwake, partyHistory,
    showModal, showConfirm, showAlert, disturbMessage, showChoice, showPasswordPrompt, showEmailPrompt, closeEmailPrompt, clearPendingLogin, signInConsent,
    shownDescription, topbar, HOME_ICON, BACK_ICON, formatGameDate, statusLabel, isTvBrowser, isPhone,
    formatKickoffTime, kickoffNotice,
    teamMeta, teamStyle, applyTeamColors, resetTeamColors, teamLogoTag,
    legalLinks, teamColor, teamEdge, readableTextColor, teamBadge, fitTeamBadges, teamAbbr, shadeColor,
    MAXIMIZE_ICON, COPY_ICON, PRINT_ICON, QR_ICON, CHEVRON_ICON, PASTE_ICON, CLOSE_ICON, addCloseX
  };
})();
