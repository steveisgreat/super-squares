// Host color themes (R33). Loaded in <head> before styles.css so the page's first paint already
// wears the right theme. It must not depend on window.SBS: nothing else has loaded yet.
//
// The theme is the host's, one per host. A device remembers it in localStorage ('sbs-theme'); a
// board shown to anyone (the TV, Player View) wears its host's theme, cached per
// board in sessionStorage ('sbs-theme-<id>') and refreshed from the server once per page load (see
// core.js). The tokens live in styles.css as [data-theme="…"] blocks.
(function () {
  'use strict';

  var IDS = ['classic', 'cyan', 'blue', 'slate', 'indigo', 'emerald'];
  // Each theme's --chrome-bg, for the browser's address bar color.
  var CHROME = {
    classic: '#050609', cyan: '#060912', blue: '#070a14', slate: '#0a0d11', indigo: '#090813', emerald: '#050d0b'
  };
  var KEY = 'sbs-theme';

  function known(id) { return typeof id === 'string' && IDS.indexOf(id) !== -1; }

  function read(store, key) {
    try { return window[store].getItem(key); } catch (e) { return null; }
  }

  function apply(id) {
    if (!known(id)) id = 'classic';
    var root = document.documentElement;
    if (root.dataset.theme !== id) root.dataset.theme = id;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute('content') !== CHROME[id]) meta.setAttribute('content', CHROME[id]);
    return id;
  }

  function current() {
    var id = document.documentElement.dataset.theme;
    return known(id) ? id : 'classic';
  }

  // This device's host theme: what Home, setup, the pick screen and Game Day wear.
  function host() {
    var id = read('localStorage', KEY);
    return known(id) ? id : known(hostId) ? hostId : 'classic';
  }

  // Kept in memory too: some browsers refuse storage.
  var hostId = null;
  // Goes up at each sign out, so the next host to sign in here is asked about afresh.
  var signOuts = 0;

  // Remembers it without changing what is on screen (a board's screen may be wearing another).
  function rememberHost(id) {
    hostId = known(id) ? id : 'classic';
    try { window.localStorage.setItem(KEY, hostId); } catch (e) { /* this visit only */ }
  }

  function setHost(id) {
    rememberHost(id);
    return apply(hostId);
  }

  // Sign out: this device no longer knows whose theme it was.
  function forgetHost() {
    hostId = null;
    signOuts++;
    try { window.localStorage.removeItem(KEY); } catch (e) { /* nothing to forget */ }
    return apply('classic');
  }

  // Before first paint: a deep link to one board uses that board's cached theme, anything else
  // the host theme this device remembers.
  var first = host();
  var m = /^#(?:tv|mirror|score|player)-([0-9a-f-]{36})/i.exec(window.location.hash || '');
  if (m) {
    var cached = read('sessionStorage', 'sbs-theme-' + m[1].toLowerCase());
    if (known(cached)) first = cached;
  }
  apply(first);

  window.SBSTheme = {
    ids: IDS.slice(),
    known: known,
    apply: apply,
    current: current,
    host: host,
    setHost: setHost,
    rememberHost: rememberHost,
    forgetHost: forgetHost,
    signOuts: function () { return signOuts; }
  };
})();
