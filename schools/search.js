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

  // An Eircode, or something with a house number in it, is an address rather
  // than a school name. These pages hold no geocoder -- they are static files
  // -- so the address row hands off to the map, which does.
  var EIRCODE = /^[AC-FHKNPRTV-Y][0-9]{2}\s?[0-9AC-FHKNPRTV-Y]{4}$/i;
  function looksLikeAddress(s) {
    s = s.trim();
    return EIRCODE.test(s) || /^\d+[a-z]?[\s,]/i.test(s) || (/,/.test(s) && /\d/.test(s));
  }
  function addressRow(q) {
    return '<a class="q-hit q-addr" role="option" href="/map.html#addr=' +
      encodeURIComponent(q) + '">' +
      '<span class="q-name">Find schools near “' + q.replace(/[<>&]/g, '') + '”</span>' +
      '<span class="q-meta">Opens the map, drops a pin and lists the nearest schools</span></a>';
  }

  // `q` is lowercased for matching; `raw` is what the person actually typed and
  // is the only thing that should ever be shown back to them or handed to the
  // map. Using q here turned "D02 X285" into "d02 x285" in the suggestion and
  // in the link.
  function render(rows, q, raw) {
    current = rows; activeIdx = -1;
    raw = raw || q;
    if (!q) { panel.innerHTML = ''; panel.classList.remove('open'); return; }
    var addressy = looksLikeAddress(raw);
    // Eircodes are conventionally written in capitals.
    if (EIRCODE.test(raw)) { raw = raw.toUpperCase(); }
    var html = rows.map(function (r, i) {
      return '<a class="q-hit" role="option" data-i="' + i + '" href="' + r.u + '">' +
        '<span class="q-name">' + r.n + '</span>' +
        '<span class="q-meta">' + [r.t, r.a, r.c].filter(Boolean).join(' · ') + '</span></a>';
    }).join('');
    if (addressy) {
      html = addressRow(raw) + html;
    } else if (!rows.length) {
      html = '<div class="q-none">No school matches “' + raw.replace(/[<>&]/g, '') +
             '”</div>' + addressRow(raw);
    } else {
      html = html + addressRow(raw);
    }
    panel.innerHTML = html;
    panel.classList.add('open');
  }

  function search() {
    var raw = input.value.trim();
    var q = raw.toLowerCase();
    if (q.length < 2) { render([], '', ''); return; }
    load().then(function (rows) {
      var hits = [];
      for (var i = 0; i < rows.length; i++) {
        var s = score(rows[i], q);
        if (s >= 0) hits.push([s, rows[i]]);
        if (hits.length > 400) break;      // plenty to rank from
      }
      hits.sort(function (a, b) { return a[0] - b[0] || a[1].n.length - b[1].n.length; });
      render(hits.slice(0, 8).map(function (h) { return h[1]; }), q, raw);
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
      input.value = ''; render([], '', '');
    }
  });

  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== input) {
      panel.classList.remove('open');
    }
  });
})();
