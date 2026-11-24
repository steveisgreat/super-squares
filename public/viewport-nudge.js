// Why this exists is in index.html, where it is loaded. A file of its own
// because the Content-Security-Policy refuses inline scripts.
(function () {
  function nudgeScroll() {
    if (window.scrollY !== 0) return;
    var docEl = document.documentElement;
    docEl.style.height = (window.innerHeight + 100) + 'px';
    window.scrollTo(0, 50);
    setTimeout(function () {
      window.scrollTo(0, 0);
      // Always back to the stylesheet's height. load and pageshow both run this, and remembering
      // "the height before" could remember the other one's extra 100 px and leave it for good.
      docEl.style.height = '';
    }, 0);
  }
  window.addEventListener('load', nudgeScroll);
  window.addEventListener('pageshow', nudgeScroll);
})();
