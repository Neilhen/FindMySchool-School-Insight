/* Site search over a static index.
   4,234 schools is small enough to search entirely in the browser, so there is
   no backend, no API and nothing to go down. The index is fetched lazily on the
   first keystroke rather than on page load: most visitors arrive from a search
   engine, read one page and leave, and should not pay for a file they never use. */
(function () {
  var input = document.getElementById('q');
  var panel = document.getElementById('q-results');
  if (!input || !panel) return;

  var index = null, loading = null, activeIdx = -1, current = [];

  function load() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;
    loading = fetch('/search-index.json')
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        index = rows.map(function (r) {
          return { n: r.n, a: r.a || '', c: r.c || '', t: r.t, u: r.u,
                   hay: (r.n + ' ' + (r.a || '') + ' ' + (r.c || '')).toLowerCase() };
        });
        return index;
      })
      .catch(function () { index = []; return index; });
    return loading;
  }

  function score(row, q) {
    var pos = row.hay.indexOf(q);
    if (pos < 0) return -1;
    // A name that starts with the query beats one that merely contains it,
    // and a hit in the name beats a hit in the area.
    var inName = row.n.toLowerCase().indexOf(q);
    if (inName === 0) return 0;
    if (inName > 0) return 1;
    return 2 + (pos > 12 ? 1 : 0);
  }

  function render(rows, q) {
    current = rows; activeIdx = -1;
    if (!q) { panel.innerHTML = ''; panel.classList.remove('open'); return; }
    if (!rows.length) {
      panel.innerHTML = '<div class="q-none">No school matches “' +
        q.replace(/[<>&]/g, '') + '”</div>';
      panel.classList.add('open');
      return;
    }
    panel.innerHTML = rows.map(function (r, i) {
      return '<a class="q-hit" role="option" data-i="' + i + '" href="' + r.u + '">' +
        '<span class="q-name">' + r.n + '</span>' +
        '<span class="q-meta">' + [r.t, r.a, r.c].filter(Boolean).join(' · ') + '</span></a>';
    }).join('');
    panel.classList.add('open');
  }

  function search() {
    var q = input.value.trim().toLowerCase();
    if (q.length < 2) { render([], ''); return; }
    load().then(function (rows) {
      var hits = [];
      for (var i = 0; i < rows.length; i++) {
        var s = score(rows[i], q);
        if (s >= 0) hits.push([s, rows[i]]);
        if (hits.length > 400) break;      // plenty to rank from
      }
      hits.sort(function (a, b) { return a[0] - b[0] || a[1].n.length - b[1].n.length; });
      render(hits.slice(0, 8).map(function (h) { return h[1]; }), q);
    });
  }

  var timer;
  input.addEventListener('input', function () {
    clearTimeout(timer); timer = setTimeout(search, 90);
  });
  input.addEventListener('focus', load);

  input.addEventListener('keydown', function (e) {
    var hits = panel.querySelectorAll('.q-hit');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      activeIdx += (e.key === 'ArrowDown' ? 1 : -1);
      if (activeIdx < 0) activeIdx = hits.length - 1;
      if (activeIdx >= hits.length) activeIdx = 0;
      hits.forEach(function (h, i) { h.classList.toggle('on', i === activeIdx); });
      hits[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && hits[activeIdx]) { e.preventDefault(); location.href = hits[activeIdx].href; }
      else if (current.length) { e.preventDefault(); location.href = current[0].u; }
    } else if (e.key === 'Escape') {
      input.value = ''; render([], '');
    }
  });

  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== input) {
      panel.classList.remove('open');
    }
  });
})();
