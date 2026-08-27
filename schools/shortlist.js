/* Shortlist, shared by the static pages and the map.
   Stored in localStorage: no account, no server, nothing about the visitor
   leaves their browser. Wrapped in try/catch because private browsing and
   blocked site data both make localStorage throw rather than return null. */
(function () {
  var KEY = 'fas_shortlist';

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); }
    catch (e) { /* nothing we can do; the page still works */ }
  }
  function toggle(id) {
    var list = read(), i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    write(list);
    return list.indexOf(id) >= 0;
  }

  window.Shortlist = { read: read, write: write, toggle: toggle, KEY: KEY };

  function paintNav() {
    var n = read().length;
    var link = document.getElementById('nav-compare');
    if (link) link.textContent = n ? 'Shortlist (' + n + ')' : 'Shortlist';
  }

  document.addEventListener('DOMContentLoaded', function () {
    paintNav();
    document.querySelectorAll('[data-shortlist]').forEach(function (btn) {
      var id = btn.getAttribute('data-shortlist');
      var on = read().indexOf(id) >= 0;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? '★ On your shortlist' : '☆ Add to shortlist';
      btn.addEventListener('click', function () {
        var nowOn = toggle(id);
        btn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
        btn.textContent = nowOn ? '★ On your shortlist' : '☆ Add to shortlist';
        paintNav();
      });
    });
  });
})();
