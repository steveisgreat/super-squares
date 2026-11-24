// Why this exists is in index.html, where it is loaded. A file of its own
// because the Content-Security-Policy refuses inline scripts.
(function () {
  function nudgeScroll() {
    if (window.scrollY !== 0) return;
    var docEl = document.documentElement;
    var originalHeight = docEl.style.height;
    docEl.style.height = (window.innerHeight + 100) + 'px';
    window.scrollTo(0, 50);
    setTimeout(function () {
      window.scrollTo(0, 0);
      docEl.style.height = originalHeight;
    }, 0);
  }
  window.addEventListener('load', nudgeScroll);
  window.addEventListener('pageshow', nudgeScroll);
})();
