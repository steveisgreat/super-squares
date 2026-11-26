// Pinch-to-zoom for the phone grids (R47): the host's Grid tab, phone Game Day and the player's pick
// board. SBS.pinchZoom.attach(viewport, content, store) scales `content` from 1x to 3x with a CSS
// transform; `viewport` clips it and keeps its layout size. `store` is a long-lived object (the
// grid's holder) that remembers { s, x, y } across redraws, so a poll or a tap that rebuilds the
// grid keeps the zoom and the pan. Two fingers pinch, one finger pans while zoomed, the "Fit" pill
// resets (not a double tap: its first tap would claim or free a square). A pinch or a drag never fires the square's click.
(function () {
  const SBS = window.SBS = window.SBS || {};

  const MAX = 3;
  const SNAP = 1.05;      // below this a pinch lands on 1x
  const DRAG_PX = 8;      // a finger that moves further than this is a drag, not a tap

  // Only a touch phone, portrait or sideways. Desktop, iPad and wide layouts are left alone.
  function enabled() {
    const isPhone = SBS.ui && SBS.ui.isPhone && SBS.ui.isPhone();
    const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    return !!isPhone && touch && Math.min(window.innerWidth, window.innerHeight) < 600;
  }

  function attach(viewport, content, store) {
    const st = store._pz || (store._pz = { s: 1, x: 0, y: 0 });
    viewport.classList.add('pz-viewport');
    content.classList.add('pz-content');

    const fit = document.createElement('button');
    fit.type = 'button';
    fit.className = 'pz-fit secondary';
    fit.textContent = 'Fit';
    fit.setAttribute('aria-label', 'Zoom out to fit the grid');
    fit.hidden = true;
    viewport.appendChild(fit);

    // The content's resting place inside the viewport, from layout (a transform doesn't change it).
    const home = () => ({ ox: content.offsetLeft, oy: content.offsetTop, w: content.offsetWidth, h: content.offsetHeight });

    // Keep the grid's edges inside its frame: the scaled grid always covers its resting rectangle.
    function clamp() {
      const { w, h } = home();
      st.x = Math.min(0, Math.max(w - w * st.s, st.x));
      st.y = Math.min(0, Math.max(h - h * st.s, st.y));
    }

    function apply() {
      // A viewport that a redraw replaced, or one hidden behind a tab, has no size: leave the shared state alone.
      if (!viewport.isConnected || !content.offsetWidth) return;
      if (st.s <= 1) { st.s = 1; st.x = 0; st.y = 0; }
      else clamp();
      const zoomed = st.s > 1;
      content.style.transformOrigin = '0 0';
      content.style.transform = zoomed ? `translate(${st.x}px, ${st.y}px) scale(${st.s})` : '';
      viewport.style.touchAction = zoomed ? 'none' : 'pan-y';
      fit.hidden = !zoomed;
    }

    function reset() { st.s = 1; st.x = 0; st.y = 0; apply(); }

    // Scale to `s` keeping the viewport point (px, py) on the same spot of the grid.
    function zoomAt(s, px, py) {
      const { ox, oy } = home();
      const ns = Math.min(MAX, Math.max(1, s));
      const k = ns / st.s;
      st.x = (px - ox) - (px - ox - st.x) * k;
      st.y = (py - oy) - (py - oy - st.y) * k;
      st.s = ns;
    }

    const local = (t) => { const r = viewport.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => local({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });

    let pinch = null;       // { d, s } at the start of a two-finger gesture
    let last = null;        // the previous midpoint or finger position
    let start = null;       // where the single finger began
    let moved = false;      // this touch sequence was a pinch or a drag
    let muteUntil = 0;      // clicks before this time are the end of a gesture

    viewport.addEventListener('touchstart', (e) => {
      if (e.target.closest && e.target.closest('.pz-fit')) return;
      if (e.touches.length >= 2) {
        const [a, b] = e.touches;
        pinch = { d: dist(a, b) || 1, s: st.s };
        last = mid(a, b);
        moved = true;
        e.preventDefault();
      } else {
        pinch = null;
        moved = false;
        const t = e.touches[0];
        start = { x: t.clientX, y: t.clientY };
        last = local(t);
      }
    }, { passive: false });

    viewport.addEventListener('touchmove', (e) => {
      if (e.target.closest && e.target.closest('.pz-fit')) return;
      if (e.touches.length >= 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        if (!pinch) { pinch = { d: dist(a, b) || 1, s: st.s }; last = mid(a, b); }
        const m = mid(a, b);
        zoomAt(pinch.s * dist(a, b) / pinch.d, m.x, m.y);
        st.x += m.x - last.x; st.y += m.y - last.y; // the fingers' own drift pans too
        last = m;
        moved = true;
        apply();
        return;
      }
      const t = e.touches[0];
      if (!start) return;
      if (!moved && Math.hypot(t.clientX - start.x, t.clientY - start.y) > DRAG_PX) moved = true;
      if (st.s > 1) {
        e.preventDefault();
        if (pinch) { pinch = null; last = local(t); return; } // one finger lifted: carry on from here
        const p = local(t);
        if (moved) { st.x += p.x - last.x; st.y += p.y - last.y; apply(); }
        last = p;
      }
    }, { passive: false });

    function end(e) {
      if (e.touches.length === 1) { // one finger of a pinch is still down: it pans from here
        pinch = null;
        last = local(e.touches[0]);
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return;
      }
      if (e.touches.length) return;
      pinch = null;
      if (st.s < SNAP) reset();
      if (moved) muteUntil = Date.now() + 350;
      start = null;
    }
    viewport.addEventListener('touchend', end);
    viewport.addEventListener('touchcancel', end);

    // The end of a pinch or a drag is not a tap on whatever square is under the finger.
    viewport.addEventListener('click', (e) => {
      if (Date.now() < muteUntil && !(e.target.closest && e.target.closest('.pz-fit'))) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // iOS Safari reports its own page pinch as gesture events: keep it from zooming the page.
    const stopGesture = (e) => e.preventDefault();
    viewport.addEventListener('gesturestart', stopGesture);
    viewport.addEventListener('gesturechange', stopGesture);

    fit.addEventListener('click', reset);
    // One observer per store: a redraw's new viewport replaces the last one's.
    if (window.ResizeObserver) {
      if (store._pzRO) store._pzRO.disconnect();
      store._pzRO = new ResizeObserver(apply);
      store._pzRO.observe(viewport);
    }

    apply();
  }

  SBS.pinchZoom = { enabled, attach };
})();
