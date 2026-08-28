/* The homepage map.
 *
 * Deliberately NOT app.js. The full map is a working tool -- filters, transport
 * eligibility, boundary layers, a sidebar -- and it is coupled to markup that
 * exists only on map.html. Loading it here would drag the whole application
 * onto the front door and break on the first missing element.
 *
 * This is the smaller thing the homepage actually needs: show that the data is
 * real and national, let someone find their own area in one gesture, and hand
 * them off to a school page or to the full map.
 *
 * Nothing here runs until the map scrolls into view. Leaflet, markercluster and
 * the 4,234-row index together are most of a megabyte, and a visitor who came
 * from a search engine to read one paragraph should not pay for a map they
 * never look at. On the homepage the map is high enough that this usually fires
 * immediately -- the point is that it is the browser's decision, not ours.
 */
(function () {
  var host = document.getElementById('home-map');
  if (!host || !('IntersectionObserver' in window)) { return; }

  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var CLUSTER_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css';
  var CLUSTER_DEF = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css';
  var CLUSTER_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js';

  var COLOUR = {
    primary:   '#2F5D8A',
    secondary: '#6B4A7D',
    special:   '#A9552F',
    preschool: '#2E7D6B'
  };

  function css(href) {
    return new Promise(function (res) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res;
      document.head.appendChild(l);
    });
  }
  function js(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = false; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  var started = false;
  function start() {
    if (started) { return; }
    started = true;
    var status = document.getElementById('home-map-status');

    Promise.all([css(LEAFLET_CSS), css(CLUSTER_CSS), css(CLUSTER_DEF)])
      .then(function () { return js(LEAFLET_JS); })
      .then(function () { return js(CLUSTER_JS); })
      .then(function () { return fetch('/map-index.json'); })
      .then(function (r) {
        if (!r.ok) { throw new Error('index ' + r.status); }
        return r.json();
      })
      .then(function (rows) { draw(rows, status); })
      .catch(function () {
        if (status) {
          status.innerHTML = 'The map could not load just now. ' +
            '<a href="/map.html">Open the full map</a> or ' +
            '<a href="/schools/">browse by county</a> instead.';
          status.hidden = false;
        }
      });
  }

  function draw(rows, status) {
    if (status) { status.remove(); }
    host.classList.add('ready');

    // CARTO's light_all, the same basemap the full map uses. The key is
    // domain-scoped and travels in every tile URL a browser requests, so it is
    // public by nature -- the same class of thing as a Google Maps browser
    // key. It also lives in app.js; change both together.
    var CARTO_KEY = 'cb1_2g3f_1_4aa7b5e61a8c427fbd78ee9a';
    var layers = CARTO_KEY
      ? [L.tileLayer(
          'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY,
          { attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
            subdomains: 'abcd', maxZoom: 18, detectRetina: true })]
      : [L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
          { maxNativeZoom: 16, maxZoom: 18, zIndex: 1,
            attribution: '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
         L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
          { maxNativeZoom: 16, maxZoom: 18, zIndex: 2 })];

    var map = L.map(host, {
      center: [53.42, -7.95], zoom: 7, scrollWheelZoom: false,
      layers: layers
    });
    // Scroll-wheel zoom is off until the map is clicked. A map that swallows
    // the page scroll on the way past is the single most irritating thing an
    // embedded map can do.
    map.once('click', function () { map.scrollWheelZoom.enable(); });

    var cluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 55, showCoverageOnHover: false,
      // Same rule as the full map: a cluster is a count, so it grows rather
      // than changing colour. Colour on this map means what kind of school
      // something is, and markercluster's default green/amber/red would say
      // "few / some / many" in exactly the palette we use for meaning.
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        var size = n < 10 ? 30 : n < 100 ? 36 : n < 1000 ? 42 : 48;
        return L.divIcon({
          html: '<div class="cl">' + (n > 999 ? (n / 1000).toFixed(1) + 'k' : n) + '</div>',
          className: 'hm-cluster', iconSize: L.point(size, size)
        });
      }
    });

    rows.forEach(function (s) {
      var m = L.circleMarker([s.la, s.ln], {
        radius: 5, weight: 1.5, color: '#fff', opacity: 1,
        fillColor: COLOUR[s.t] || '#64748b', fillOpacity: 0.95
      });
      var bits = [];
      if (s.a) { bits.push(esc(s.a)); }
      if (s.e) { bits.push(esc(s.e)); }
      if (s.p) { bits.push(s.p.toLocaleString() + ' pupils'); }
      var extra = s.r
        ? '<span class="hm-ratio">' + s.r + ' applicants per place</span>'
        : (s.sc ? '<span class="hm-sc">' + s.sc + ' special class' +
                  (s.sc > 1 ? 'es' : '') + '</span>' : '');
      m.bindPopup(
        '<a class="hm-name" href="' + s.u + '">' + esc(s.n) + '</a>' +
        '<span class="hm-meta">' + bits.join(' &middot; ') + '</span>' + extra);
      cluster.addLayer(m);
    });
    map.addLayer(cluster);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  new IntersectionObserver(function (entries, obs) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { obs.disconnect(); start(); }
    });
  }, { rootMargin: '200px' }).observe(host);
})();
