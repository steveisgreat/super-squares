// Present on a TV over HDMI (R25 part b). From a laptop (a wide screen with a mouse) the host
// opens the TV view in a window of its own, puts it on the second screen when the browser can,
// and keeps this window as the console. Two places offer it: a card in the Game Day panel and a
// choice in "What's in the room?". Both are views of the same state kept here.
//
// The window reference lives at module level, per game id, so a re-render (a save, a poll, a
// resize) never loses it. A window the host closes by hand is noticed on the 8 s Game Day poll
// and when this window is focused again: no timer of its own.
(function () {
  'use strict';

  const SBS = window.SBS = window.SBS || {};
  const { el } = SBS.ui;

  // Tabler "screen-share" (MIT, 24 px outline).
  const PRESENT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12v3a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10a1 1 0 0 1 1 -1h9"/><path d="M7 20l10 0"/><path d="M9 16l0 4"/><path d="M15 16l0 4"/><path d="M17 4h4v4"/><path d="M16 9l5 -5"/></svg>';

  const DRAG_NOTE = 'Drag the new window to the TV, then press Fullscreen on it.';
  const BLOCKED_NOTE = 'Your browser blocked the window. Allow pop-ups for this site, then try again.';
  const OPEN_NOTE = 'The TV is showing the board. This screen stays your console.';

  const wins = {};     // game id -> the TV window we opened
  const notes = {};    // game id -> 'drag' (no second screen found) | 'blocked'
  const pending = {};  // game id -> true while the screen permission is being asked
  let listeners = [];

  // A wide screen with a mouse: where a host plugs in a TV. Phones and touch tablets are not.
  function eligible() {
    if (SBS.ui.isPhone()) return false;
    return window.matchMedia('(min-width: 1024px)').matches
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }

  function notify() { listeners.slice().forEach(fn => { try { fn(); } catch (e) { /* a view that is gone */ } }); }

  // Forgets windows that were closed (by hand, or by the TV's own Exit).
  function refresh() {
    let changed = false;
    Object.keys(wins).forEach(id => {
      let gone = false;
      try { gone = !wins[id] || wins[id].closed; } catch (e) { gone = true; }
      if (gone) { delete wins[id]; delete notes[id]; changed = true; }
    });
    if (changed) notify();
    return changed;
  }
  window.addEventListener('focus', refresh);

  function isOpen(id) { refresh(); return !!wins[id]; }

  function tvUrl(id) { return `${location.origin}${location.pathname}#tv-${id}`; }
  function winName(id) { return `sbs-tv-${id}`; }

  // Opens (or brings forward) the TV window. Call it straight from a click. Resolves 'open' or
  // 'blocked'. Asking for the second screen can take the click's permission to open a window with
  // it, so a null from window.open is reported as blocked and the host tries again (the screen
  // permission is already given by then, so the second try is instant).
  async function open(id) {
    refresh();
    if (wins[id]) { try { wins[id].focus(); } catch (e) { /* not ours any more */ } return 'open'; }
    if (pending[id]) return 'pending';
    pending[id] = true;
    notify();
    try {
      let screen = null;
      if (typeof window.getScreenDetails === 'function') {
        try {
          const d = await window.getScreenDetails();
          const list = d.screens || [];
          const cur = d.currentScreen;
          if (list.length > 1 && cur) {
            screen = list.find(s => s.left !== cur.left || s.top !== cur.top) || null;
          }
        } catch (e) { screen = null; } // refused, or not allowed here: a normal window
      }
      const features = screen
        ? `popup=yes,left=${screen.left},top=${screen.top},width=${screen.width},height=${screen.height},fullscreen=yes`
        : 'popup=yes,width=1280,height=720';
      let w = null;
      try { w = window.open(tvUrl(id), winName(id), features); } catch (e) { w = null; }
      if (!w) { notes[id] = 'blocked'; return 'blocked'; }
      wins[id] = w;
      if (screen) delete notes[id]; else notes[id] = 'drag';
      return 'open';
    } finally {
      delete pending[id];
      notify();
    }
  }

  function stop(id) {
    const w = wins[id];
    delete wins[id];
    delete notes[id];
    try { if (w) w.close(); } catch (e) { /* already gone */ }
    notify();
  }

  // The words and buttons for one game, drawn into a box that stays in the page: `update()` redraws
  // it from the shared state. The status line is one element that keeps its place, so a screen
  // reader hears each change.
  function view(id, opts) {
    const root = el('div', 'present-view');
    const status = el('p', 'present-status');
    status.setAttribute('role', 'status');
    const actions = el('div', 'actions present-actions');
    root.append(status, actions);

    function button(label, cls, onClick, withIcon) {
      const b = el('button', cls, '');
      b.type = 'button';
      if (withIcon) b.innerHTML = PRESENT_ICON + '<span></span>';
      (b.querySelector('span') || b).textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    // After a click the button the host pressed is gone, so focus goes to the one that replaced it.
    function focusAction() {
      const b = actions.querySelector('button');
      if (b) b.focus();
    }

    async function present() {
      await open(id);
      update();
      focusAction();
    }

    function update() {
      const openNow = isOpen(id);
      const note = notes[id];
      actions.innerHTML = '';
      if (pending[id]) {
        status.textContent = 'Opening the TV window…';
        const b = button('Opening…', '', () => {}, true);
        b.disabled = true;
        actions.appendChild(b);
        return;
      }
      if (openNow) {
        status.textContent = OPEN_NOTE + (note === 'drag' ? ' ' + DRAG_NOTE : '');
        actions.appendChild(button('Stop', 'secondary', () => { stop(id); update(); focusAction(); }));
      } else if (note === 'blocked') {
        status.textContent = BLOCKED_NOTE;
        actions.appendChild(button('Try again', '', present, true));
      } else {
        status.textContent = (opts && opts.idle) || 'Show the board on a TV plugged into this computer by HDMI.';
        const b = button('Present on an HDMI TV', '', present, true);
        b.classList.add('present-btn');
        actions.appendChild(b);
      }
    }

    update();
    const off = subscribe(update);
    return { el: root, update, destroy: off };
  }

  // The Game Day panel card. Its Stop and Present buttons are the same as the chooser's.
  function card(id) {
    const c = el('div', 'card present-card');
    c.appendChild(el('h3', '', 'Present on a TV'));
    const v = view(id);
    c.appendChild(v.el);
    return { el: c, update: v.update, destroy: v.destroy };
  }

  function subscribe(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter(f => f !== fn); };
  }

  SBS.present = { eligible, open, stop, isOpen, refresh, view, card, subscribe, PRESENT_ICON };
})();
