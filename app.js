// ============================================================
// BASEMAPS & INIT
// ============================================================
// The default basemap was CARTO's light_all until CARTO put their free
// basemaps behind an API key: the tiles kept serving, but every one of them
// now arrives with "API KEY REQUIRED / carto.com/basemaps/apikey" stamped
// diagonally across it. A watermark on a map about children's schooling reads
// as a broken or unlicensed site, so it had to go.
//
// Esri's Light Gray Canvas is the closest match to the look we had, needs no
// key, and is already the host behind the satellite layer below, so it adds no
// new dependency. It ships as two layers by design -- a label-free base, and a
// separate reference layer carrying place names -- which is why this is a
// LayerGroup rather than a single tileLayer. Labels on top means school pins
// never sit underneath a town name.
//
// maxNativeZoom matters here. This service has no tiles beyond zoom 16, and a
// parent looking at one school will zoom past that. Without it Leaflet asks
// for a zoom-19 tile, gets nothing, and the map goes blank at exactly the
// moment someone is looking closely. With it, Leaflet upscales the zoom-16
// tile instead: slightly soft, but a map.
const ESRI_CANVAS = {
  maxNativeZoom: 16, maxZoom: 19,
  attribution: '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'
};
// CARTO, if and when you have a key.
//
// CARTO's light_all was the original basemap and is still the nicest-looking
// of the free options. They now require a key: request one at
// carto.com/basemaps/apikey -- email, domain, one line on what you are
// building, no account, key back by return. Free tier is 5 million tile
// requests a month and the CARTO + OpenStreetMap attribution must stay
// visible, which it does below.
//
// Paste the key here and CARTO becomes the default basemap; leave it empty and
// the Esri canvas is used. The key is not a secret -- it is domain-scoped and
// travels in every tile URL a visitor's browser requests, exactly like a
// Google Maps browser key -- so it belongs in the code rather than in .env.
const CARTO_KEY = '';

const cartoLight = CARTO_KEY ? L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY, {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd', maxZoom: 19
}) : null;

const lightBase = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  { ...ESRI_CANVAS, zIndex: 1 });
const lightLabels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  { ...ESRI_CANVAS, attribution: '', zIndex: 2 });
// CARTO when a key is set, the Esri canvas otherwise. One line to switch.
const lightMap = cartoLight || L.layerGroup([lightBase, lightLabels]);
const streetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
});
const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community', maxZoom: 19
});

const map = L.map('map', { 
  center: [53.4, -8.0], 
  zoom: 7,
  layers: [lightMap],
  zoomControl: false // Move to right side
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

const baseMaps = {
  "Light Minimal": lightMap,
  "Detailed Street": streetMap,
  "Satellite": satelliteMap
};
const layerControl = L.control.layers(baseMaps, null, { position: 'bottomright' }).addTo(map);

// ============================================================
// PARISH BOUNDARIES (from GeoJSON)
// ============================================================



let parishData = null;
let schools = [];
let parishLayer = null;
let loadedSchoolIds = new Set();
const feederMap = {};
const secondaryToPrimaryMap = {};

// A school's level(s). US K-12 schools genuinely belong to two levels at once,
// so the data carries a `levels` array; Irish rows only ever have one, and fall
// back to `type`. Filtering on the array is what makes a K-12 school show up
// for a family with both a 5-year-old and a 15-year-old.

// The Department's planning-area names are machine-shaped
// ("Sallynoggin_Killiney_DLR"). The underscores separate real places, so they
// become " / " rather than being swallowed, and run-together words are split on
// the lowercase-to-uppercase boundary ("CorkCity" -> "Cork City"). Display
// only: the raw value is what the data and the page URLs use.
function prettyArea(name) {
  if (!name) return name;
  return String(name).split('_')
    .map(tok => tok.replace(/(?<=[a-z])(?=[A-Z])/g, ' '))
    .filter(Boolean).join(' / ');
}

function schoolLevels(s) {
  if (Array.isArray(s.levels) && s.levels.length) return s.levels;
  return [s.type];
}

// The denomination dropdown. '' means no filter; '__other' means anything
// outside the five common values, which is how minority-faith schools stay
// findable without giving each one its own menu entry.
let ethosFilter = '';
const COMMON_ETHOS = ['Catholic', 'Multi-denominational', 'Inter-denominational',
                      'Church of Ireland', 'Nonsectarian'];

function passesFilters(s) {
  // A school that has closed must not sit on the map looking like an option.
  if (s.closed && !activeFilters.closed) return false;

  // Restrictive filters: only bite when switched on.
  if (activeFilters.hasSpecialClass && !s.specialClasses) return false;
  if (activeFilters.newSpecialClass && !s.specialClassesNew) return false;
  if (activeFilters.oversubscribed && !s.oversubscribed) return false;

  const irishOk = s.irish ? activeFilters.irish : true;
  const charterOk = s.charter ? activeFilters.charter : true;
  // Same shape as the Irish-medium toggle: turning "Boarding" off hides
  // schools that take boarders, it does not restrict the map to them.
  const takesBoarders = s.attendanceType === 'Boarding' || s.attendanceType === 'Mixed';
  const boardingOk = takesBoarders ? activeFilters.boarding : true;

  // US sector buttons only bite on US rows.
  if (s.country === 'US' && s.sector) {
    if (s.sector === 'public' && !activeFilters.public) return false;
    if (s.sector === 'private' && !activeFilters.private) return false;
  }

  if (ethosFilter) {
    const e = s.ethos || '';
    if (ethosFilter === '__other') {
      if (!e || COMMON_ETHOS.includes(e)) return false;
    } else if (e !== ethosFilter) {
      return false;
    }
  }

  if (s.type === 'preschool') return activeFilters.preschool && irishOk && charterOk;

  // gender may legitimately be null on US public rows where NCES publishes no
  // counts -- an unknown must not be silently dropped from every view.
  const genderOk = s.gender ? activeFilters[s.gender] : true;
  const levelOk = schoolLevels(s).some(l => activeFilters[l]);
  return levelOk && genderOk && activeFilters[s.fees] && irishOk && charterOk && boardingOk;
}

async function initApp() {
  // Schools are the whole point of the map, so start fetching them immediately.
  // We deliberately do NOT await this yet - it runs alongside the parish
  // download below instead of queueing behind it.
  const schoolsLoading = fetchSchoolsInBounds();

  // Parish boundaries are a nice-to-have: they stay invisible until you click a
  // school. If this file is slow or fails, the map must still work, so the
  // whole block is wrapped and any error is swallowed rather than returned on.
  try {
    const pRes = await fetch("parish_data.json");
    if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
    parishData = await pRes.json();

    parishLayer = L.geoJSON(parishData, {
      style: function () {
        return { color: "transparent", weight: 0, opacity: 0, fillColor: "transparent", fillOpacity: 0 };
      }
    }).addTo(map);
    layerControl.addOverlay(parishLayer, "Parish Boundaries");
  } catch (e) {
    // Non-fatal: without this layer we simply can't highlight a parish.
    console.error("Parish boundaries unavailable (map still works):", e);
  }

  await schoolsLoading;
}

// PostgREST caps any single response at 1,000 rows no matter what .limit()
// says. The table now holds 126,000 schools, so in a dense view (New York has
// 2,287 inside one screen) a single request silently returned an arbitrary
// 1,000 of them and the rest simply were not on the map. For a tool someone
// uses to pick a school that is a correctness bug, not a performance one, so we
// page through the results and say so plainly when a view is too dense to load
// in full.
const PAGE_SIZE = 1000;
const MAX_PAGES = 4;          // 4,000 schools per view

function setDensityNotice(text) {
  let el = document.getElementById('density-notice');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'density-notice';
    el.style.cssText = 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);' +
      'z-index:1200;background:#fff8e1;border:1px solid #ffe082;color:#7a5b00;' +
      'padding:6px 12px;border-radius:16px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.15)';
    document.getElementById('map').appendChild(el);
  }
  el.textContent = text;
}

async function fetchSchoolsInBounds() {
  const bounds = map.getBounds();
  const south = bounds.getSouthWest().lat - 0.05;
  const north = bounds.getNorthEast().lat + 0.05;
  const west = bounds.getSouthWest().lng - 0.05;
  const east = bounds.getNorthEast().lng + 0.05;

  const query = () => window.supabaseClient
    .from('schools')
    .select('*')
    .gte('lat', south).lte('lat', north)
    .gte('lng', west).lte('lng', east);

  let data = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: rows, error } = await query()
      .order('id')
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      console.error("Supabase error:", error);
      return;
    }
    data = data.concat(rows);
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  setDensityNotice(truncated
    ? `Showing ${data.length.toLocaleString()} schools — zoom in to see them all`
    : '');

  data.forEach(s => {
    if (!loadedSchoolIds.has(s.id)) {
      loadedSchoolIds.add(s.id);
      schools.push(s);
      
      // Update feeders
      if (s.feeders) {
        feederMap[s.id] = s.feeders;
        s.feeders.forEach(secId => {
          if (!secondaryToPrimaryMap[secId]) secondaryToPrimaryMap[secId] = [];
          if (!secondaryToPrimaryMap[secId].includes(s.id)) secondaryToPrimaryMap[secId].push(s.id);
        });
      }
      
      // Add Marker
      const m = L.marker([s.lat, s.lng], { icon: createIcon(s) });
      m._schoolData = s;
      m.on('click', function() {
        drawFeederLines(this._schoolData);
        openSidebar(this._schoolData);
        map.setView([s.lat, s.lng], Math.max(map.getZoom(), 14));
      });
      allMarkers.push(m);
      markerMap[s.id] = m;
      if (passesFilters(s)) {
        markersGroup.addLayer(m);
      }
    }
  });
  // Schools stream in as the map is panned, so the count has to be refreshed
  // here as well as on a filter change -- otherwise it reads blank until the
  // first time someone touches a filter, which is exactly when they least need
  // to be told how many schools there are.
  if (typeof updateCount === 'function') {
    updateCount(allMarkers.filter(m => passesFilters(m._schoolData)).length,
                allMarkers.length);
  }
}

map.on('moveend', fetchSchoolsInBounds);
map.on('zoomend', fetchSchoolsInBounds);


// ============================================================
// COLOUR SCHEME
// ============================================================
// Pins encode ONE thing: what kind of school it is.
//
// They used to encode two at once -- gender crossed with fee status -- in
// seven colours: navy boys-feepaying, light-blue boys-free, crimson
// girls-feepaying, pink girls-free, purple coed-feepaying, lilac coed-free,
// green preschool. Nobody can hold that key in their head, and both of those
// dimensions already have their own filters, so the colour was spending the
// map's whole colour budget restating things you could switch on and off.
//
// Level is the one dimension people actually scan for, it is the same
// dimension the homepage map uses, and it is now the same four colours as the
// dots on the Level filter chips -- so the key is on screen at all times
// instead of being something you have to learn.
const COLORS = {
  preschool: { fill:'#2E7D6B', stroke:'#215D50' },
  primary:   { fill:'#2F5D8A', stroke:'#234769' },
  secondary: { fill:'#6B4A7D', stroke:'#513960' },
  special:   { fill:'#A9552F', stroke:'#7F3F23' },
};

function createIcon(school) {
  const c = COLORS[school.type] || COLORS.primary;
  const isPreschool = school.type === 'preschool';
  const isSpecial = school.type === 'special';
  const size = school.type === 'secondary' ? 20 : isPreschool ? 13 : 15;
  // Shape carries a second, coarser distinction so the map is still readable
  // in greyscale and to anyone who cannot separate these hues: the two
  // non-mainstream types are squares, mainstream schools are circles.
  const shape = (isPreschool || isSpecial) ? 'border-radius:3px' : 'border-radius:50%';
  const star = school.irish
    ? '<div class="pin-star">\u2605</div>'
    : '';
  return L.divIcon({
    html: `<div class="pin-wrap" style="width:${size}px;height:${size}px">
      <div style="width:${size}px;height:${size}px;${shape};background:${c.fill};border:2px solid ${c.stroke};box-shadow:0 1px 3px rgba(28,26,23,.35)"></div>
      ${star}
    </div>`,
    className: '', iconSize: [size, size], iconAnchor: [size/2, size/2]
  });
}

// ============================================================
// CLUSTERING & MARKERS
// ============================================================
const markersGroup = L.markerClusterGroup({
  maxClusterRadius: 40,
  iconCreateFunction: function(cluster) {
    // A cluster is a count, not a category, so it gets no colour of its own --
    // it grows instead. Solid dark circles at a fixed size read as heavier
    // than the individual pins they stand for, which is backwards.
    const n = cluster.getChildCount();
    const size = n < 10 ? 30 : n < 100 ? 36 : n < 1000 ? 42 : 48;
    return L.divIcon({
      html: '<div class="cl">' + (n > 999 ? (n / 1000).toFixed(1) + 'k' : n) + '</div>',
      className: 'custom-cluster', iconSize: L.point(size, size)
    });
  }
});

const allMarkers = [];
const markerMap = {};
let activeLines = [];
let activeRadiusCircle = null;
let highlightedParishLayer = null;

function clearLines() { 
  activeLines.forEach(l => map.removeLayer(l)); 
  activeLines = [];
  if (activeRadiusCircle) { map.removeLayer(activeRadiusCircle); activeRadiusCircle = null; } 
}

function clearParishes() {
  if (!parishLayer) return;
  parishLayer.eachLayer(layer => {
    parishLayer.resetStyle(layer);
  });
}

function drawLine(p1, p2, color) {
  const line = L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], { color: color, weight: 3, opacity: 0.7, dashArray: '6, 6' }).addTo(map);
  line.bringToFront();
  activeLines.push(line);
}

function highlightParish(parishId) {
  clearParishes();
  if (!parishId || !parishLayer) return;
  parishLayer.eachLayer(layer => {
    if (layer.feature && layer.feature.properties && layer.feature.properties.parishid === parishId) {
      layer.setStyle({ fillColor: '#FFF59D', fillOpacity: 0.2, color: '#FBC02D', weight: 2, opacity: 0.7 });
      layer.bringToBack();
    }
  });
}

// Sidebar references
const sb = document.getElementById('sidebar');
const sbName = document.getElementById('sb-name');
const sbBadges = document.getElementById('sb-badges');
const sbFee = document.getElementById('sb-fee');
const sbLoc = document.getElementById('sb-location');
const sbNotes = document.getElementById('sb-notes');
const sbFeederSec = document.getElementById('sb-feeder-section');
const sbFeederTitle = document.getElementById('sb-feeder-title');
const sbFeederList = document.getElementById('sb-feeder-list');

document.getElementById('close-sidebar').addEventListener('click', () => {
  sb.classList.remove('open');
  clearLines();
  clearParishes();
  if (activeRadiusCircle) { map.removeLayer(activeRadiusCircle); activeRadiusCircle = null; }
});

function openSidebar(data) {
  sbName.textContent = data.name;
  const gLabel = data.gender === 'boys' ? 'Boys' : data.gender === 'girls' ? 'Girls' : 'Co-ed';
  const gClass = data.gender === 'boys' ? 'b-boy' : data.gender === 'girls' ? 'b-grl' : 'b-coe';
  
  let badgesHTML = `
    <span class="badge ${data.type==='preschool'?'b-pre':data.type==='primary'?'b-pri':'b-sec'}">${data.type==='preschool'?'Pre-school':data.type==='primary'?'Primary':data.type==='special'?'Special':'Secondary'}</span>
    <span class="badge ${gClass}">${gLabel}</span>
    <span class="badge ${data.fees==='feepaying'?'b-fee':'b-fre'}">${data.fees==='feepaying'?'Fee-paying':'Free'}</span>
  `;
  if(data.ethos && data.ethos !== 'Unknown' && data.ethos !== 'Other/Unknown') badgesHTML += `<span class="badge" style="background:#FFF3E0;color:#E65100;">${data.ethos}</span>`;
  if(data.irish) badgesHTML += `<span class="badge b-iri">★ Irish-medium</span>`;
  if(data.charter) badgesHTML += `<span class="badge" style="background:#FFF3E0;color:#E65100;">★ Charter</span>`;
  if(data.deis) badgesHTML += `<span class="badge" style="background:#E8F5E9;color:#2E7D32;font-weight:700;">✓ DEIS</span>`;
  // A K-12 school is both primary and secondary; say so rather than making the
  // reader guess from a single "Primary" badge.
  if (Array.isArray(data.levels) && data.levels.length > 1)
    badgesHTML += `<span class="badge" style="background:#EDE7F6;color:#4527A0;">Primary + Secondary</span>`;
  if (data.sector === 'private') badgesHTML += `<span class="badge" style="background:#FFF3E0;color:#E65100;">Private</span>`;
  if (data.sector === 'public') badgesHTML += `<span class="badge" style="background:#E3F2FD;color:#0D47A1;">Public</span>`;
  if (data.attendanceType === 'Boarding') badgesHTML += `<span class="badge" style="background:#E0F2F1;color:#00695C;">Boarding</span>`;
  if (data.attendanceType === 'Mixed') badgesHTML += `<span class="badge" style="background:#E0F2F1;color:#00695C;">Day + boarding</span>`;
  if (data.gaeltacht) badgesHTML += `<span class="badge" style="background:#F1F8E9;color:#33691E;">Gaeltacht</span>`;
  if (data.island) badgesHTML += `<span class="badge" style="background:#E1F5FE;color:#01579B;">Island school</span>`;
  if (data.specialClasses) badgesHTML += `<span class="badge" style="background:#EDE7F6;color:#4527A0;font-weight:700;">${data.specialClasses} special class${data.specialClasses > 1 ? 'es' : ''}</span>`;
  if (data.specialClassesNew) badgesHTML += `<span class="badge" style="background:#E8F5E9;color:#1B5E20;font-weight:700;">+${data.specialClassesNew} new ${data.specialClassYear || ''}</span>`;
  if (data.applicationsPerPlace)
    badgesHTML += `<span class="badge" style="background:#FFEBEE;color:#B71C1C;font-weight:700;">${data.applicationsPerPlace}× applicants per place</span>`;
  else if (data.oversubscribed)
    badgesHTML += `<span class="badge" style="background:#FDF3E3;color:#7a5410;font-weight:700;">Oversubscribed</span>`;
  if (data.closed) badgesHTML += `<span class="badge" style="background:#FFEBEE;color:#B71C1C;font-weight:700;">⚠ CLOSED</span>`;
  sbBadges.innerHTML = badgesHTML;
  
  // Fees carry their provenance. A figure without a year and a link is not
  // shown as a figure -- this map gets used for property decisions, and an
  // undated number of unknown origin is worse than an honest blank.
  let feeHTML;
  if (data.fees !== 'feepaying') {
    feeHTML = data.country === 'US'
      ? 'Free — US public schools charge no tuition'
      : 'Free';
  } else if (data.annualFee) {
    feeHTML = `€${data.annualFee.toLocaleString()} / year`;
    if (data.feeYear) feeHTML += ` <span style="color:#555;font-weight:400">(${data.feeYear})</span>`;
    if (data.feeSource && /^https?:/.test(data.feeSource))
      feeHTML += ` <a href="${data.feeSource}" target="_blank" rel="noopener" style="font-size:11px">source ↗</a>`;
    else if (data.feeSource)
      feeHTML += ` <span style="font-size:11px;color:#777">${data.feeSource}</span>`;
  } else {
    feeHTML = 'Fee-paying — amount not confirmed';
  }
  if (data.feeNote)
    feeHTML += `<div style="font-size:11px;color:#E65100;font-weight:400;margin-top:3px">${data.feeNote}</div>`;
  if (data.feeConfidence && data.annualFee)
    feeHTML += `<div style="font-size:10px;color:#888;font-weight:400">Confidence: ${data.feeConfidence}</div>`;
  if (data.feeLegacyAmount && !data.annualFee)
    feeHTML += `<div style="font-size:10px;color:#888;font-weight:400">An older uncited figure of €${data.feeLegacyAmount.toLocaleString()} was on file; it is not shown because it could not be traced to a published page.</div>`;
  sbFee.innerHTML = feeHTML;

  // Shortlist toggle. The same localStorage list the static school pages and
  // the compare view use, so a school added here shows up there and vice versa.
  if (typeof Shortlist !== 'undefined') {
    const onList = Shortlist.read().indexOf(data.id) >= 0;
    sbFee.insertAdjacentHTML('afterend',
      `<div class="sb-actions">
         <button id="sb-shortlist" class="filter-btn${onList ? ' on' : ''}">
           ${onList ? 'On your shortlist' : 'Add to shortlist'}</button>
         <a class="filter-btn" href="/compare.html">Compare shortlist</a>
       </div>`);
    document.getElementById('sb-shortlist').onclick = function () {
      const nowOn = Shortlist.toggle(data.id);
      this.textContent = nowOn ? 'On your shortlist' : 'Add to shortlist';
      this.classList.toggle('on', nowOn);
      const nav = document.getElementById('nav-compare');
      const n = Shortlist.read().length;
      if (nav) nav.textContent = n ? `Shortlist (${n})` : 'Shortlist';
    };
  }
  
  let locHTML = data.area || '';
  if (data.address) locHTML += `<br><span style="color:#666">${data.address}</span>`;
  if (data.eircode) locHTML += ` <span style="color:#999">${data.eircode}</span>`;
  if(data.parish) locHTML += `<br><strong style="color:#6A1B9A;margin-top:6px;display:inline-block;">📍 Parish: ${data.parish}</strong>`;
  if(data.parishNote) locHTML += `<br><span style="color:#E65100;font-size:11px;">⚠ ${data.parishNote}</span>`;
  // distance from the home pin, if one is set
  if (typeof homePin !== 'undefined' && homePin) {
    const d = pinDistKm(data.lat, data.lng);
    locHTML += `<br><strong style="color:var(--ink)">${d.toFixed(1)} km from your pin</strong>`;
    const rule = RADIUS_RULES[data.id];
    if (rule) {
      if (rule.km) {
        const ok = d <= rule.km;
        locHTML += `<br><span style="font-size:11px; font-weight:700; color:${ok ? '#2E7D32' : '#C62828'};">
          ${ok ? '✓ Within' : '✗ Outside'} this school's ${rule.km} km admissions radius (${rule.label})</span>`;
      } else {
        locHTML += `<br><span style="font-size:11px; color:#E65100; font-weight:600;">${rule.label}</span>`;
      }
    }
    // Would a bus place for THIS school be an eligible application or a
    // concessionary one? You are only eligible for transport to your nearest
    // suitable school; anywhere else is spare-capacity-only.
    if (lastTransport && data.country !== 'US') {
      const levels = schoolLevels(data).filter(l => TRANSPORT_RULES[l]);
      for (const level of levels) {
        const buckets = lastTransport.byLevel[level];
        if (!buckets) continue;
        const hit = Object.entries(buckets)
          .find(([, v]) => v && v.school.id === data.id);
        if (hit && hit[1].eligible) {
          locHTML += `<br><span style="font-size:11px;color:#2E7D32;font-weight:700;">
            🚌 Eligible for school transport here — it is your nearest
            ${hit[0] === 'any' ? '' : hit[0] + ' '}${TRANSPORT_RULES[level].label.toLowerCase()} school
            and ${hit[1].km.toFixed(1)} km away</span>`;
        } else if (hit) {
          locHTML += `<br><span style="font-size:11px;color:#777;">
            🚌 Nearest ${TRANSPORT_RULES[level].label.toLowerCase()} school, but only
            ${hit[1].km.toFixed(1)} km away — under the ${TRANSPORT_RULES[level].km} km
            threshold, so no transport eligibility</span>`;
        } else {
          locHTML += `<br><span style="font-size:11px;color:#E65100;">
            🚌 Not your nearest suitable ${TRANSPORT_RULES[level].label.toLowerCase()} school —
            a bus place here would be concessionary only (spare seats, not guaranteed)</span>`;
        }
      }
      // Children with special educational needs travel under a SEPARATE scheme
      // whose rules are not distance-based in the same way. Now that the map
      // shows special classes, a parent could easily read the line above as
      // applying to their child. It does not.
      if (data.specialClasses) {
        locHTML += `<br><span style="font-size:11px;color:#4527A0;">
          ℹ️ A child attending a special class travels under the separate
          special educational needs transport scheme, which is not decided by
          these distances. Check with the school and the NCSE.</span>`;
      }
    }
  }
  sbLoc.innerHTML = locHTML;
  
  // ---- Area context: planning area / district / deprivation ---------------
  const areaSec = document.getElementById('sb-area-section');
  const areaDiv = document.getElementById('sb-area');
  const areaBits = [];
  if (data.planningArea) {
    areaBits.push(`<strong>School Planning Area:</strong> ${prettyArea(data.planningArea)}` +
      `<div style="font-size:11px;color:#777">How the Department plans capacity. ` +
      `<em>Not a catchment</em> — in Ireland you may apply to any school.</div>`);
  }
  if (data.localAuthority) areaBits.push(`<strong>Local authority:</strong> ${data.localAuthority}`);
  if (data.district_name && data.country === 'US') {
    areaBits.push(`<strong>School district:</strong> ${data.district_name}` +
      `<div style="font-size:11px;color:#777">A district, <em>not an attendance zone</em>. ` +
      `NCES has published no national attendance boundaries since 2015-16.</div>`);
  }
  if (data.medianPrice) {
    const chg = data.medianPriceChangePct;
    areaBits.push(
      `<strong>Local house prices:</strong> median ` +
      `€${Number(data.medianPrice).toLocaleString()} (${data.medianPriceYear})` +
      (chg != null
        ? ` <span style="color:${chg >= 0 ? '#2E7D32' : '#C62828'};font-weight:600">` +
          `${chg >= 0 ? '+' : ''}${chg}% since ${data.medianPriceEarlierYear}</span>`
        : '') +
      `<div style="font-size:11px;color:#777">Eircode area ${data.priceRoutingKey}` +
      `${data.priceAreaName ? ' (' + data.priceAreaName + ')' : ''}` +
      `${data.salesVolume ? ', ' + Number(data.salesVolume).toLocaleString() + ' sales' : ''}. ` +
      `CSO stamp-duty filings for the whole Eircode district — not the streets ` +
      `beside the school, and not a claim that the school moves the price.</div>`);
  }
  if (data.deprivationScore !== null && data.deprivationScore !== undefined) {
    const s = Number(data.deprivationScore);
    const col = s >= 10 ? '#2E7D32' : s <= -10 ? '#C62828' : '#555';
    areaBits.push(
      `<strong>Pobal deprivation index (2022):</strong> ` +
      `<span style="color:${col};font-weight:700">${s.toFixed(1)}</span> — ${data.deprivationLabel || ''}` +
      `<div style="font-size:11px;color:#777">Electoral Division ${data.edName || ''}` +
      (data.edPopulation ? `, pop. ${Number(data.edPopulation).toLocaleString()}` : '') +
      `. 0 is the national average. This describes the <em>area</em>, not the school.</div>` +
      (data.edThirdLevelPct !== null && data.edThirdLevelPct !== undefined
        ? `<div style="font-size:11px;color:#777">Third-level educated: ${Number(data.edThirdLevelPct).toFixed(0)}%` +
          (data.edLoneParentPct !== null && data.edLoneParentPct !== undefined
            ? ` · lone-parent households: ${Number(data.edLoneParentPct).toFixed(0)}%` : '') + `</div>`
        : '') +
      (data.deprivationNote ? `<div style="font-size:11px;color:#E65100">⚠ ${data.deprivationNote}</div>` : ''));
  }
  if (areaBits.length) {
    areaDiv.innerHTML = areaBits.join('<div style="height:8px"></div>');
    areaSec.style.display = 'block';
  } else {
    areaSec.style.display = 'none';
  }

  // ---- Getting in ----------------------------------------------------------
  // The only question that actually decides a place in a country with no
  // catchments. Read from the school's own Annual Admission Notice, and always
  // shown with a link back to it.
  if (data.admissionsNoticeUrl) {
    const denom = data.placesLastYear || data.placesOffered;
    const bits = [];
    if (data.applicationsPerPlace && data.applicationsLastYear && denom) {
      const r = data.applicationsPerPlace;
      const label = r >= 3 ? 'Very hard' : r >= 1.8 ? 'Hard' : r > 1 ? 'Competitive' : 'Not oversubscribed';
      const col = r >= 1.8 ? '#B71C1C' : r > 1 ? '#7a5410' : '#1B5E20';
      bits.push(`<strong style="color:${col}">${label}.</strong> ` +
        `${data.applicationsLastYear.toLocaleString()} applications for ${denom.toLocaleString()} places` +
        (data.waitingList ? `, ${data.waitingList.toLocaleString()} on the waiting list` : '') + '.');
    } else if (data.oversubscribed) {
      bits.push('<strong style="color:#7a5410">Oversubscribed last year.</strong>');
    } else if (data.placesOffered) {
      bits.push('<strong style="color:#1B5E20">Not oversubscribed last year.</strong>');
    }
    if (data.admissionsClosesOn)
      bits.push(`<strong>Applications close ${data.admissionsClosesOn}</strong>` +
                (data.admissionsOpensOn ? ` (open from ${data.admissionsOpensOn})` : ''));
    bits.push(`<a href="${data.admissionsNoticeUrl}" target="_blank" rel="noopener nofollow">Annual Admission Notice ↗</a>`);
    areaBits.push('<strong>Getting in</strong><div style="font-size:12px;line-height:1.5">' +
                  bits.join('<br>') + '</div>');
  }

  // ---- Contact -------------------------------------------------------------
  const contactSec = document.getElementById('sb-contact-section');
  const contactDiv = document.getElementById('sb-contact');
  const contactBits = [];
  if (data.principal) contactBits.push(`Principal: ${data.principal}`);
  if (data.phone) contactBits.push(`<a href="tel:${String(data.phone).replace(/[^0-9+]/g,'')}">${data.phone}</a>`);
  if (data.email) contactBits.push(`<a href="mailto:${data.email}">${data.email}</a>`);
  if (data.website) contactBits.push(`<a href="${/^https?:/.test(data.website) ? data.website : 'https://' + data.website}" target="_blank" rel="noopener">School website ↗</a>`);
  if (contactBits.length) {
    contactDiv.innerHTML = contactBits.join('<br>');
    contactSec.style.display = 'block';
  } else {
    contactSec.style.display = 'none';
  }

  let notesHTML = data.notes || '';
  const facts = [];
  if (data.enrolment) {
    let e = `Enrolment: ${Number(data.enrolment).toLocaleString()}`;
    if (data.enrolmentYear) e += ` (${data.enrolmentYear})`;
    // The male/female split is what actually answers "is this a boys' school?"
    if (data.maleEnrolment !== null && data.maleEnrolment !== undefined &&
        data.femaleEnrolment !== null && data.femaleEnrolment !== undefined)
      e += ` — ${data.maleEnrolment} boys / ${data.femaleEnrolment} girls`;
    facts.push(e);
  }
  if (data.specialClassTypes && Object.keys(data.specialClassTypes).length) {
    const types = Object.entries(data.specialClassTypes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n}× ${k}`).join(', ');
    facts.push(`Special classes ${data.specialClassYear || ''}: ${types}`);
    if (data.specialClassesPrevYear === 0 && data.specialClasses)
      facts.push('First special class at this school');
    else if (data.specialClassesPrevYear && data.specialClasses > data.specialClassesPrevYear)
      facts.push(`Growing from ${data.specialClassesPrevYear} last year`);
  }
  if (data.gradeLow && data.gradeHigh) facts.push(`Grades: ${data.gradeLow}–${data.gradeHigh}`);
  if (data.languageMedium && data.languageMedium !== 'English Medium School') facts.push(data.languageMedium);
  if (data.schoolTypeDetail && data.schoolTypeDetail !== 'NA') facts.push(data.schoolTypeDetail);
  if (data.ethosDetail) facts.push(data.ethosDetail);
  if (data.diocese) facts.push(`Diocese code: ${data.diocese}`);
  if (data.teacherFte) facts.push(`Teachers (FTE): ${data.teacherFte}`);
  if (data.freeLunch !== null && data.freeLunch !== undefined && data.enrolment)
    facts.push(`Free lunch: ${data.freeLunch} of ${data.enrolment}`);
  if (data.patron) facts.push(`Patron: ${data.patron}`);
  if (!data.id.startsWith('PRIV-') && !data.id.startsWith('PRE-') && !data.id.startsWith('US-')) facts.push(`Roll no: ${data.id}`);
  if (data.id.startsWith('US-')) facts.push(`NCES ID: ${data.nces_id}`);
  if (facts.length) notesHTML += `<br><span style="color:#555;font-size:12px">${facts.join(' · ')}</span>`;
  if (data.approxLocation) notesHTML += `<br><span style="color:#E65100;font-size:11px;font-weight:600">📍 Approximate location — run geocode_preschools.py or check the address</span>`;
  if (data.closed)
    notesHTML += `<br><span style="color:#B71C1C;font-size:11px;font-weight:700">⚠ This roll number is not in the Department's 2026 register — the school has closed or amalgamated. Shown for reference only.</span>`;
  else if (data.registerStatus)
    notesHTML += `<br><span style="color:#E65100;font-size:11px;font-weight:600">${data.registerStatus}</span>`;
  if (data.verifiedSource)
    notesHTML += `<br><span style="color:#2E7D32;font-size:11px;font-weight:600">✓ ${data.verifiedSource}${data.verifiedDate ? ' — checked ' + data.verifiedDate : ''}</span>`;
  if (data.genderSource && data.country === 'US')
    notesHTML += `<br><span style="color:#777;font-size:10px">Gender: ${data.genderSource}</span>`;
  if (data.ethosNote)
    notesHTML += `<br><span style="color:#777;font-size:10px">${data.ethosNote}</span>`;
  sbNotes.innerHTML = notesHTML;
  
  // Feeders
  sbFeederList.innerHTML = '';
  let relatedSchools = [];
  if (data.type === 'primary' && data.feeders) {
    relatedSchools = data.feeders.map(id => schools.find(sc => sc.id === id)).filter(Boolean);
    sbFeederTitle.textContent = "Feeds to Secondary Schools:";
  } else if (data.type === 'secondary' && secondaryToPrimaryMap[data.id]) {
    relatedSchools = secondaryToPrimaryMap[data.id].map(id => schools.find(sc => sc.id === id)).filter(Boolean);
    sbFeederTitle.textContent = "Feeder Primary Schools:";
  }
  
  if (relatedSchools.length > 0) {
    sbFeederSec.style.display = 'block';
    relatedSchools.forEach(rs => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${rs.name}</strong> <span>📍 ${rs.area}</span>`;
      li.onclick = () => {
        map.setView([rs.lat, rs.lng], 15);
        openSidebar(rs);
        drawFeederLines(rs);
      };
      sbFeederList.appendChild(li);
    });
  } else {
    sbFeederSec.style.display = 'none';
  }
  
  // Admissions section
  const admSec = document.getElementById('sb-admissions-section');
  const admDiv = document.getElementById('sb-admissions');
  if (data.admissions) {
    let a = data.admissions;
    let ah = '<ol style="margin-left:16px">' + a.criteria.map(c =>
      `<li style="margin-bottom:3px">${c.replace(/^\d+\.\s*/, '')}</li>`).join('') + '</ol>';
    if (a.stats) ah += `<div style="margin-top:6px;color:#555;font-size:12px">${a.stats}</div>`;
    if (a.policyUrl) ah += `<div style="margin-top:6px"><a href="${a.policyUrl}" target="_blank" rel="noopener">Full admissions policy →</a></div>`;
    if (a.lastVerified) ah += `<div style="color:#999;font-size:10px">Verified ${a.lastVerified}</div>`;
    admDiv.innerHTML = ah;
    admSec.style.display = 'block';
  } else {
    admSec.style.display = 'none';
  }

  // Resource Links
  const linksList = document.getElementById('sb-links-list');
  linksList.innerHTML = '';
  const rollNum = data.id;
  const schoolName = encodeURIComponent(data.name);
  const links = [
    { label: '🔍 Inspection Reports (gov.ie)', url: `https://www.gov.ie/en/publication/?q=${rollNum}&collection=school-inspection-reports` },
    { label: '🌐 Find School Website', url: `https://www.google.com/search?q=${schoolName}+school+Ireland+official+website` },
    { label: '👕 Uniform Policy', url: `https://www.google.com/search?q=${schoolName}+school+Ireland+uniform+policy` },
    { label: '📋 School Self-Evaluation Report', url: `https://www.google.com/search?q=${schoolName}+school+Ireland+self+evaluation+report+SSE` },
  ];
  links.forEach(link => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${link.url}" target="_blank" rel="noopener">${link.label}</a>`;
    linksList.appendChild(li);
  });

  highlightParish(data.parish_id);
  if (activeRadiusCircle) { map.removeLayer(activeRadiusCircle); activeRadiusCircle = null; }
  const rule = RADIUS_RULES[data.id];
  if (rule && rule.km) {
    activeRadiusCircle = L.circle([data.lat, data.lng], {
      radius: rule.km * 1000, color: '#E65100', weight: 2, fillOpacity: 0.05, dashArray: '4, 4'
    }).addTo(map);
  }
  sb.classList.add('open');
}

function drawFeederLines(data) {
  clearLines();
  if (data.type === 'primary' && data.feeders) {
    data.feeders.forEach(secId => {
      const secSchool = schools.find(sc => sc.id === secId);
      if (secSchool && markerMap[secId]) drawLine(data, secSchool, '#1565C0');
    });
  } else if (data.type === 'secondary' && secondaryToPrimaryMap[data.id]) {
    secondaryToPrimaryMap[data.id].forEach(priId => {
      const priSchool = schools.find(sc => sc.id === priId);
      if (priSchool && markerMap[priId]) drawLine(data, priSchool, '#2E7D32');
    });
  }
}

// Markers are now added dynamically in fetchSchoolsInBounds
map.addLayer(markersGroup);

map.on('click', function(e) {
  // If clicking on map background (not a marker), close sidebar
  if (pinDropMode) return; // pin drop handled separately
  if (!e.originalEvent.target.closest('.leaflet-marker-icon')) {
    sb.classList.remove('open');
    clearLines();
    clearParishes();
  }
});

// ============================================================
// SEARCH LOGIC
// ============================================================
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

let searchTimeout;
searchInput.addEventListener('input', function() {
  const q = this.value.toLowerCase().trim();
  searchResults.innerHTML = '';
  if (q.length < 3) {
    searchResults.style.display = 'none';
    return;
  }
  
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const { data, error } = await window.supabaseClient
      .from('schools')
      .select('*')
      .ilike('name', `%${q}%`)
      .limit(8);
      
    if (error || !data.length) {
      searchResults.style.display = 'none';
      return;
    }
    
    // Add to global cache so clicking works without panning
    data.forEach(s => {
      if (!loadedSchoolIds.has(s.id)) {
        loadedSchoolIds.add(s.id);
        schools.push(s);
        // Add to secondary map logic, but don't force render on map yet
        if (s.feeders) {
          feederMap[s.id] = s.feeders;
          s.feeders.forEach(secId => {
            if (!secondaryToPrimaryMap[secId]) secondaryToPrimaryMap[secId] = [];
            if (!secondaryToPrimaryMap[secId].includes(s.id)) secondaryToPrimaryMap[secId].push(s.id);
          });
        }
      }
    });

    searchResults.style.display = 'block';
    data.forEach(match => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${match.name}</strong> <span style="color:#888;font-size:10px">(${match.area || match.state})</span>`;
      li.onclick = () => {
        map.setView([match.lat, match.lng], 16);
        openSidebar(match);
        drawFeederLines(match);
        searchInput.value = '';
        searchResults.style.display = 'none';
      };
      searchResults.appendChild(li);
    });
  }, 300);
});

// ============================================================
// FILTER LOGIC
// ============================================================
// The filters used to live behind a "Filters & Layers ▼" collapsible. That
// header is gone: hiding the filter list is the opposite of letting someone
// see what the map offers, and the list now scrolls inside the panel instead.
//
// It is worth recording why this mattered more than it looks. When the header
// was removed from the markup, this block still bound a click handler to it
// unguarded, threw on a null element, and killed every line of script after
// it -- so no filter was painted, no marker was drawn and the map came up
// empty. A missing element must never be able to do that, which is why every
// lookup added since is guarded.

const activeFilters = {
  preschool:true, primary:true, secondary:true, special:true,
  boys:true, girls:true, coed:true,
  feepaying:true, free:true, irish:true, charter:true,
  boarding:true, public:true, private:true,
  closed:false,           // closed schools are hidden until asked for
  // These two are RESTRICTIVE rather than permissive: off means "don't care",
  // on means "only show schools that have this". That is the opposite of the
  // buttons above, so they start off.
  hasSpecialClass:false, newSpecialClass:false, oversubscribed:false
};
// Frozen copy of the starting state, so "Clear filters" restores the defaults
// rather than turning everything on -- which for the three restrictive filters
// would be the opposite of clearing them.
const DEFAULT_FILTERS = Object.freeze({ ...activeFilters });
// Filter buttons used to be painted from a seventeen-entry colour table --
// green Pre-school, blue Primary, purple Secondary, orange Special, crimson
// Girls, gold Irish-medium, and so on. None of it encoded anything the label
// did not already say, and all of it competed with the pins on the map, which
// use colour to mean something. The state is now carried by one class, and the
// look lives in the stylesheet where it belongs.
// Two kinds of filter, and they need opposite treatments.
//
// Most start ON and mean "show these" -- every level, both fee statuses, all
// three genders. Painting all fourteen of those dark on load produced a wall
// of black chips in which nothing stood out, and it was also the wrong signal:
// nothing has been chosen yet. For these, the state worth showing is the one
// that is UNUSUAL, so an excluded option goes muted and struck through, and
// the default panel is calm.
//
// A few start OFF and mean "only show schools with this" -- oversubscribed,
// has a special class, show closed. Those genuinely are a constraint the
// person added, so they get the solid dark fill.
function paintFilter(key) {
  const btn = document.getElementById('f-' + key);
  if (!btn) return;
  const active = !!activeFilters[key];
  const restrictive = DEFAULT_FILTERS[key] === false;
  btn.classList.toggle('on', restrictive && active);
  btn.classList.toggle('off', !restrictive && !active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}
Object.keys(activeFilters).forEach(paintFilter);

const clearBtn = document.getElementById('clear-filters');
if (clearBtn) { clearBtn.addEventListener('click', window.clearAllFilters); }

// Denomination dropdown -- one control rather than eleven buttons, because the
// ethos values are now normalised (they used to be split by capitalisation,
// so any count or filter on them was wrong by roughly 12%).
const ethosSelect = document.getElementById('f-ethos');
if (ethosSelect) {
  ethosSelect.addEventListener('change', function () {
    ethosFilter = this.value;
    refreshMarkers();
  });
}

function refreshMarkers() {
  markersGroup.clearLayers();
  const shown = allMarkers.filter(m => passesFilters(m._schoolData));
  markersGroup.addLayers(shown);
  clearLines();
  clearParishes();
  updateCount(shown.length, allMarkers.length);
}

// "What is available" was previously answerable only by counting pins. This
// says it in words, and -- just as usefully -- says when a filter is hiding
// things, which is the state people get stuck in and cannot see.
function updateCount(shown, total) {
  const box = document.getElementById('result-count');
  if (!box) return;
  const filtered = shown !== total;
  box.querySelector('strong').textContent = shown.toLocaleString();
  box.querySelector('span').textContent = filtered
    ? 'of ' + total.toLocaleString() + ' schools shown'
    : (shown === 1 ? 'school' : 'schools');
  const clear = document.getElementById('clear-filters');
  if (clear) { clear.hidden = !filtered; }
}

window.clearAllFilters = function () {
  Object.keys(activeFilters).forEach(function (k) {
    activeFilters[k] = DEFAULT_FILTERS[k];
    paintFilter(k);
  });
  const es = document.getElementById('f-ethos');
  if (es) { es.value = ''; }
  ethosFilter = '';
  refreshMarkers();
};

window.toggleFilter = function(key) {
  activeFilters[key] = !activeFilters[key];
  paintFilter(key);
  refreshMarkers();
  sb.classList.remove('open');
};


// ============================================================
// ADDRESS PIN & NEAREST SCHOOLS
// ============================================================
let homePin = null;
let pinDropMode = false;

// schools whose published admissions criteria involve distance from home
const RADIUS_RULES = {
  '60140F': { km: 10, label: 'priority category 6: within 10 km' },
  '81001I': { km: 10, label: 'criterion 8: national schools within 10 km' },
  '60050E': { km: null, label: 'distance breaks ties within each category' }
};


// OSRM's public demo server is rate-limited and sometimes simply does not
// answer. Without a bound, the "Calculating driving times..." placeholder can
// sit there forever. Every call to it goes through this.
async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pinDistKm(lat, lng) {
  const dx = (homePin.getLatLng().lat - lat) * 111.32;
  const dy = (homePin.getLatLng().lng - lng) * 111.32 * Math.cos(53.3 * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

function setPin(lat, lng, label) {
  if (homePin) map.removeLayer(homePin);
  homePin = L.marker([lat, lng], {
    draggable: true,
    icon: L.divIcon({
      html: '<div style="font-size:30px; line-height:30px; text-shadow:0 2px 4px rgba(0,0,0,.4)">📍</div>',
      className: '', iconSize: [30, 30], iconAnchor: [15, 30]
    })
  }).addTo(map);
  homePin.on('dragend', () => refreshNearest());
  document.getElementById('pin-clear').style.display = '';
  document.getElementById('pin-status').textContent = label || '';
  map.setView([lat, lng], Math.max(map.getZoom(), 14));
  refreshNearest();
}

function clearPin() {
  if (homePin) map.removeLayer(homePin);
  homePin = null;
  lastTransport = null;
  document.getElementById('pin-results').innerHTML = '';
  document.getElementById('pin-status').textContent = '';
  document.getElementById('pin-clear').style.display = 'none';
}

async function refreshNearest() {
  if (!homePin) return;
  const div = document.getElementById('pin-results');
  div.innerHTML = '<div style="padding:10px;text-align:center;color:#666;">Calculating driving times...</div>';
  
  const groups = { preschool: 'Pre-school / Montessori', primary: 'Primary', secondary: 'Secondary', special: 'Special' };
  let groupCands = {};
  let allCands = [];
  
  // 1. Get top 6 nearest by straight line for each group to shortlist
  Object.keys(groups).forEach(t => {
    let cands = schools
      .filter(s => s.lat && s.lng && schoolLevels(s).includes(t))
      .filter(passesFilters)
      .map(s => ({ d: pinDistKm(s.lat, s.lng), s: s }))
      // The client-side cache keeps every school loaded since the page opened,
      // so without a cap a rural pin offers "nearest" special schools 650 km
      // away in Dublin, left over from an earlier pan. Nothing beyond an hour's
      // drive is a real option for a daily school run.
      .filter(c => c.d <= 60)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
    groupCands[t] = cands;
    allCands = allCands.concat(cands);
  });

  if (allCands.length === 0) {
    div.innerHTML = '<em>No schools match the current filters.</em>';
    return;
  }

  // 2. Fetch OSRM driving times
  try {
    const pinLl = homePin.getLatLng();
    let coordsStr = `${pinLl.lng},${pinLl.lat}`;
    allCands.forEach(c => coordsStr += `;${c.s.lng},${c.s.lat}`);
    
    // index 0 is pin. index 1..N are schools
    let dests = allCands.map((_, i) => i + 1).join(',');
    const url = `https://router.project-osrm.org/table/v1/driving/${coordsStr}?sources=0&destinations=${dests}`;
    
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    
    if (data.code === 'Ok' && data.durations && data.durations[0]) {
      allCands.forEach((c, i) => {
        const seconds = data.durations[0][i];
        c.driveMins = seconds ? Math.round(seconds / 60) : null;
      });
    }
  } catch(e) {
    // Falling back to straight-line distance is fine; leaving the user staring
    // at a spinner is not.
    console.warn("OSRM unavailable, ordering by straight-line distance", e.name);
  }

  // 3. Render
  let out = '';
  Object.keys(groups).forEach(t => {
    let cands = groupCands[t];
    if (!cands || cands.length === 0) return;
    
    // Sort by driving time if available, otherwise distance
    cands.sort((a, b) => {
      if (a.driveMins !== undefined && b.driveMins !== undefined) return a.driveMins - b.driveMins;
      return a.d - b.d;
    });
    
    cands = cands.slice(0, 5); // Keep top 5 after sorting
    
    out += `<div style="font-weight:700; color:#444; margin:8px 0 3px; text-transform:uppercase; font-size:10px;">${groups[t]}</div>`;
    cands.forEach((c) => {
      const distStr = (c.driveMins !== undefined && c.driveMins !== null) 
          ? `🚗 ${c.driveMins} min` 
          : `${c.d.toFixed(1)} km`;
      out += `<div class="pin-hit" data-sid="${c.s.id}" style="padding:4px 6px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; gap:6px;">
        <span>${c.s.name}</span><span style="color:#888; white-space:nowrap;">${distStr}</span></div>`;
    });
  });

  div.innerHTML = out;
  div.querySelectorAll('.pin-hit').forEach(el => {
    el.onmouseenter = () => el.style.background = 'var(--sunk)';
    el.onmouseleave = () => el.style.background = '';
    el.onclick = () => {
      const s = schools.find(x => x.id === el.dataset.sid);
      map.setView([s.lat, s.lng], 15);
      openSidebar(s);
      drawFeederLines(s);
    };
  });

  // School transport is Irish-scheme-specific, and it is computed from the
  // database rather than from the markers currently on screen, so it runs
  // after the list rather than as part of it.
  const ll = homePin.getLatLng();
  if (ll.lat > 51 && ll.lat < 56 && ll.lng > -11 && ll.lng < -5) {
    try {
      const t = await computeTransport(ll.lat, ll.lng);
      div.insertAdjacentHTML('beforeend', renderTransport(t));
    } catch (e) {
      console.error('transport eligibility failed', e);
    }
  }
}

async function geocodePin() {
  const q = document.getElementById('pin-input').value.trim();
  if (!q) return;
  const st = document.getElementById('pin-status');
  st.textContent = 'Searching…';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ie&q='
      + encodeURIComponent(q));
    const data = await r.json();
    if (data.length) {
      setPin(parseFloat(data[0].lat), parseFloat(data[0].lon), data[0].display_name);
    } else {
      st.textContent = 'Address not found — try adding the area, or use "Drop pin on map".';
    }
  } catch (e) {
    st.textContent = 'Lookup failed — use "Drop pin on map" instead.';
  }
}

// Guarded: see the note above the filter section. One missing element used to
// take the whole page down with it.
const on = (id, ev, fn) => {
  const el = document.getElementById(id);
  if (el) { el.addEventListener(ev, fn); }
};
on('pin-go', 'click', geocodePin);
on('pin-input', 'keydown', e => { if (e.key === 'Enter') geocodePin(); });
on('pin-clear', 'click', clearPin);
document.getElementById('pin-drop').addEventListener('click', () => {
  pinDropMode = true;
  document.getElementById('pin-status').textContent = 'Now click anywhere on the map…';
});
map.on('click', function (e) {
  if (pinDropMode) {
    pinDropMode = false;
    setPin(e.latlng.lat, e.latlng.lng, 'Pin dropped — drag it to adjust.');
  }
});

window.setRegion = function(region) {
  const btnIe = document.getElementById('region-ie');
  const btnUs = document.getElementById('region-us');
  const ieFilters = document.getElementById('ie-filters');
  const usFilters = document.getElementById('us-filters');
  
  if (region === 'US') {
    // The tabs are a segmented control now; the selected half is expressed
    // with aria-selected, which is both the accessible state and the hook the
    // stylesheet uses. No inline colours.
    btnUs.setAttribute('aria-selected', 'true');
    btnIe.setAttribute('aria-selected', 'false');
    if (ieFilters) ieFilters.style.display = 'none';
    if (usFilters) usFilters.style.display = 'block';
    map.setView([39.8, -98.5], 4);
    if (parishLayer && map.hasLayer(parishLayer)) map.removeLayer(parishLayer);
    // The Irish planning-area layer is meaningless over the US: drop it.
    if (spaLayer && map.hasLayer(spaLayer)) map.removeLayer(spaLayer);
    boundaryOn.spa = false;
    setLayerButton('f-layer-spa', false, '#00695C');
  } else {
    btnIe.setAttribute('aria-selected', 'true');
    btnUs.setAttribute('aria-selected', 'false');
    if (usFilters) usFilters.style.display = 'none';
    if (ieFilters) ieFilters.style.display = 'block';
    map.setView([53.4, -8.0], 7);
    if (parishLayer && !map.hasLayer(parishLayer)) map.addLayer(parishLayer);
    // ...and US district outlines are meaningless over Ireland.
    Object.values(districtLayers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    boundaryOn.district = false;
    setLayerButton('f-layer-district', false, '#00695C');
  }
};


// ============================================================
// BOUNDARY LAYERS  (planning areas IE, school districts US)
// ============================================================
//
// Both of these are loaded ON DEMAND. The planning-area file is 2.1 MB and the
// US district files add up to ~40 MB, so nothing is fetched until the button
// is pressed, and the US files are fetched one state at a time based on what
// is actually on screen.
//
// The wording throughout is deliberate. Neither layer is a catchment:
//   * Ireland has no catchment areas in law. Under the Education (Admission to
//     Schools) Act 2018 every school sets its own oversubscription criteria and
//     a child may apply anywhere. School Planning Areas are how the Department
//     decides where to BUILD capacity.
//   * The US had attendance boundaries, but NCES closed the survey after
//     2015-16 with no successor. What exists now is district boundaries, which
//     for most families are not the same thing as the school they are zoned for.
// Getting this wrong on a map someone buys a house from would be the single
// most expensive mistake this project could make.

let spaLayer = null;
let spaLoading = null;
const districtLayers = {};      // state code -> L.geoJSON
const districtLoading = {};
const boundaryOn = { spa: false, district: false };

// Boundary-layer toggles are filters too, so they look and behave like the
// rest. The colour argument is ignored and kept only so the existing call
// sites do not all have to change; the state lives in the class.
function setLayerButton(id, on) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.toggle('on', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
setLayerButton('f-layer-spa', false, '#00695C');
setLayerButton('f-layer-district', false, '#00695C');

async function loadPlanningAreas() {
  if (spaLayer) return spaLayer;
  if (spaLoading) return spaLoading;
  spaLoading = (async () => {
    const res = await fetch('school_planning_areas.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gj = await res.json();
    spaLayer = L.geoJSON(gj, {
      style: () => ({ color: '#00695C', weight: 1.2, opacity: 0.8,
                      fillColor: '#00695C', fillOpacity: 0.05 }),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.bindTooltip(
          `<strong>${p.SPA}</strong><br>${p.Schools || 0} schools` +
          (p.Coed_Preference ? `<br>Parents wanting co-ed: ${p.Coed_Preference}` : '') +
          (p.Denominational_Preference ? `<br>Wanting denominational: ${p.Denominational_Preference}` : '') +
          `<br><em>Planning area — not a catchment</em>`,
          { sticky: true });
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.18, weight: 2 }));
        layer.on('mouseout', () => layer.setStyle({ fillOpacity: 0.05, weight: 1.2 }));
      }
    });
    return spaLayer;
  })();
  return spaLoading;
}

// Which US states are currently on screen, judged from the school rows we have
// already loaded for this view. Cheap, and avoids a state-boundary lookup.
function statesInView() {
  const b = map.getBounds();
  const seen = new Set();
  schools.forEach(s => {
    if (s.country === 'US' && s.state && s.lat && s.lng &&
        b.contains([s.lat, s.lng])) seen.add(s.state);
  });
  return [...seen];
}

async function loadDistrictsFor(state) {
  if (districtLayers[state]) return districtLayers[state];
  if (districtLoading[state]) return districtLoading[state];
  districtLoading[state] = (async () => {
    const res = await fetch(`us_districts/${state}.geojson`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gj = await res.json();
    const layer = L.geoJSON(gj, {
      style: () => ({ color: '#00695C', weight: 1.2, opacity: 0.8,
                      fillColor: '#00695C', fillOpacity: 0.04 }),
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        l.bindTooltip(
          `<strong>${p.name}</strong><br>${p.kind} district` +
          (p.gradeLow ? `<br>Grades ${p.gradeLow}–${p.gradeHigh}` : '') +
          `<br><em>District boundary — not an attendance zone</em>`,
          { sticky: true });
      }
    });
    districtLayers[state] = layer;
    return layer;
  })();
  return districtLoading[state];
}

async function refreshDistrictLayers() {
  if (!boundaryOn.district) return;
  for (const st of statesInView()) {
    try {
      const layer = await loadDistrictsFor(st);
      if (!map.hasLayer(layer)) layer.addTo(map).bringToBack();
    } catch (e) {
      console.warn(`District boundaries unavailable for ${st}:`, e.message);
    }
  }
}

window.toggleBoundaryLayer = async function (which) {
  boundaryOn[which] = !boundaryOn[which];
  if (which === 'spa') {
    setLayerButton('f-layer-spa', boundaryOn.spa, '#00695C');
    if (boundaryOn.spa) {
      try {
        const layer = await loadPlanningAreas();
        layer.addTo(map).bringToBack();
      } catch (e) {
        console.error('Planning areas unavailable:', e);
        boundaryOn.spa = false;
        setLayerButton('f-layer-spa', false, '#00695C');
      }
    } else if (spaLayer && map.hasLayer(spaLayer)) {
      map.removeLayer(spaLayer);
    }
  } else {
    setLayerButton('f-layer-district', boundaryOn.district, '#00695C');
    if (boundaryOn.district) {
      await refreshDistrictLayers();
    } else {
      Object.values(districtLayers).forEach(l => {
        if (map.hasLayer(l)) map.removeLayer(l);
      });
    }
  }
};

map.on('moveend', refreshDistrictLayers);

window.showBoundaryExplainer = function () {
  const existing = document.getElementById('boundary-explainer');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.id = 'boundary-explainer';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:4000;' +
    'display:flex;align-items:center;justify-content:center;padding:20px';
  div.innerHTML = `
    <div style="background:#fff;max-width:560px;max-height:80vh;overflow:auto;border-radius:8px;padding:22px;font-size:13px;line-height:1.55">
      <h3 style="margin:0 0 10px">Why there are no catchment areas on this map</h3>
      <p><strong>Ireland does not have them.</strong> Not "hard to find" — they do not
      exist in law. Under the Education (Admission to Schools) Act 2018 each school
      publishes its own oversubscription criteria, and a child may apply to any
      school in the country. What the Department of Education does use is
      <strong>314 School Planning Areas</strong>, which govern where it builds
      capacity, not who gets a place. Those are the polygons in the "Planning
      areas" layer.</p>
      <p>What actually decides an Irish place is the school's own admissions
      criteria — siblings, parish, feeder school, distance, date of application.
      Where this map has them, they are in the school's sidebar.</p>
      <p><strong>The United States stopped publishing them.</strong> NCES ran the
      School Attendance Boundary Survey until 2015–16 and then closed it with no
      successor; it only ever covered the ~600 largest districts and excluded
      charters and magnets. The academic alternative, SABINS, stops at 2011–12.
      The only current national school geography is the <strong>school
      district</strong> boundary, which is what the "School districts" layer
      shows. For most American families the district they live in and the school
      they are zoned for are different things.</p>
      <p style="color:#B71C1C"><strong>So:</strong> do not read either layer as
      "living here gets my child into that school". Neither one means that.</p>
      <button onclick="document.getElementById('boundary-explainer').remove()"
        class="btn-solid" style="margin-top:8px">
        Got it</button>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
};


// ============================================================
// SCHOOL TRANSPORT ELIGIBILITY  (Republic of Ireland)
// ============================================================
//
// The School Transport Scheme is one of the few things about Irish school
// choice that IS decided by distance, which makes it computable from data we
// already hold — every school's coordinates plus the address pin.
//
// The rule: a child is ELIGIBLE if they live at least 3.2 km (primary) or
// 4.8 km (post-primary) from their NEAREST SUITABLE school, and attend that
// school. "Suitable" takes account of ethos and language of instruction, so a
// family who want an Irish-medium or a minority-denomination school are
// measured against the nearest school of that kind, not the nearest school
// outright. Anyone attending a school that is not their nearest suitable one
// can only apply for a concessionary seat — spare capacity, never guaranteed.
//
// Two honest limits, both stated in the UI rather than buried here:
//   * Bus Éireann measures by ROAD. We shortlist on straight-line distance and
//     then ask OSRM for the road distance, which is closer to their method but
//     is still not their measurement.
//   * Eligible does not mean seated. Seats depend on capacity, an application
//     by the deadline, and the annual charge.
//
// Sources: Citizens Information, primary and post-primary school transport
// schemes; Department of Education School Transport Scheme.

const TRANSPORT_RULES = {
  primary:   { km: 3.2, label: 'Primary' },
  secondary: { km: 4.8, label: 'Post-primary' },
};

// Ethos groupings the scheme's "nearest suitable school" test can turn on.
const ETHOS_CATEGORIES = [
  { key: 'catholic',  label: 'Catholic',             match: e => e === 'Catholic' },
  { key: 'minority',  label: 'Minority denomination', match: e => ['Church of Ireland','Presbyterian','Methodist','Quaker','Jewish','Muslim'].includes(e) },
  { key: 'multi',     label: 'Multi-denominational',  match: e => e === 'Multi-denominational' || e === 'Inter-denominational' },
];

let lastTransport = null;   // cached so the sidebar can read it synchronously

// Straight-line distance, km.
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Candidate schools near the pin, straight from the database. Deliberately
// ignores the user's filters: whether you are eligible for a bus is a fact
// about geography, not about which pins you have chosen to display.
async function schoolsNearPin(lat, lng) {
  const pad = 0.14;                       // ~15 km north-south, ~9 km east-west
  const { data, error } = await window.supabaseClient
    .from('schools')
    .select('id,name,type,levels,lat,lng,ethos,languageMedium,irish,closed,address,area')
    .eq('country', 'IE')
    .gte('lat', lat - pad).lte('lat', lat + pad)
    .gte('lng', lng - pad * 1.7).lte('lng', lng + pad * 1.7)
    .limit(1000);
  if (error) { console.error('transport lookup failed', error); return []; }
  return data.filter(s => !s.closed && s.lat && s.lng && s.type !== 'preschool');
}

// Ask OSRM for road distance to a handful of candidates. Bus Éireann measures
// by road, so this is the closer approximation; if OSRM is unavailable we fall
// back to straight line and say so.
async function roadDistances(lat, lng, candidates) {
  if (!candidates.length) return false;
  try {
    let coords = `${lng},${lat}`;
    candidates.forEach(c => { coords += `;${c.s.lng},${c.s.lat}`; });
    const dests = candidates.map((_, i) => i + 1).join(',');
    const res = await fetchWithTimeout(
      `https://router.project-osrm.org/table/v1/driving/${coords}` +
      `?sources=0&destinations=${dests}&annotations=distance`);
    const d = await res.json();
    if (d.code === 'Ok' && d.distances && d.distances[0]) {
      candidates.forEach((c, i) => {
        const m = d.distances[0][i];
        if (m != null) c.roadKm = m / 1000;
      });
      return true;
    }
  } catch (e) {
    console.warn('OSRM road distance unavailable, using straight line', e);
  }
  return false;
}

async function computeTransport(lat, lng) {
  const pool = await schoolsNearPin(lat, lng);
  if (!pool.length) return null;

  const result = { byLevel: {}, roadUsed: false, checkedAt: Date.now() };

  // Shortlist the nearest few in every category we might need, then price them
  // all through OSRM in a single request.
  const shortlist = [];
  for (const level of Object.keys(TRANSPORT_RULES)) {
    const atLevel = pool
      .filter(s => (Array.isArray(s.levels) && s.levels.length ? s.levels : [s.type]).includes(level))
      .map(s => ({ s, straightKm: haversineKm(lat, lng, s.lat, s.lng) }))
      .sort((a, b) => a.straightKm - b.straightKm);

    const buckets = { any: atLevel.slice(0, 3) };
    buckets.english = atLevel.filter(c => c.s.languageMedium !== 'Irish Medium School' && !c.s.irish).slice(0, 2);
    buckets.irish   = atLevel.filter(c => c.s.languageMedium === 'Irish Medium School' || c.s.irish).slice(0, 2);
    ETHOS_CATEGORIES.forEach(cat => {
      buckets[cat.key] = atLevel.filter(c => cat.match(c.s.ethos)).slice(0, 2);
    });
    result.byLevel[level] = buckets;
    Object.values(buckets).forEach(list => list.forEach(c => {
      if (!shortlist.includes(c)) shortlist.push(c);
    }));
  }

  result.roadUsed = await roadDistances(lat, lng, shortlist.slice(0, 24));

  // Pick the nearest in each bucket on the best distance we have, and decide.
  for (const [level, buckets] of Object.entries(result.byLevel)) {
    const threshold = TRANSPORT_RULES[level].km;
    for (const [key, list] of Object.entries(buckets)) {
      const scored = list.map(c => ({ ...c, km: c.roadKm != null ? c.roadKm : c.straightKm }))
                         .sort((a, b) => a.km - b.km);
      const best = scored[0] || null;
      buckets[key] = best ? {
        school: best.s,
        km: best.km,
        isRoad: best.roadKm != null,
        eligible: best.km >= threshold,
      } : null;
    }
  }
  lastTransport = result;
  return result;
}

function renderTransport(result) {
  if (!result) return '';
  let html = '<div style="margin-top:10px;border-top:1px solid #e0e0e0;padding-top:8px">' +
             '<div style="font-weight:700;font-size:12px;margin-bottom:5px">🚌 School transport eligibility</div>';

  for (const [level, rule] of Object.entries(TRANSPORT_RULES)) {
    const b = result.byLevel[level];
    if (!b || !b.any) continue;
    const n = b.any;
    const ok = n.eligible;
    html += `<div style="margin-bottom:7px">
      <div style="font-weight:600">${rule.label} — needs ${rule.km} km</div>
      <div style="color:#555">Nearest: <strong>${n.school.name}</strong>, ${n.km.toFixed(1)} km</div>
      <div style="font-weight:700;color:${ok ? '#2E7D32' : '#C62828'}">
        ${ok ? '✓ Likely eligible for transport to this school'
             : '✗ Too close to qualify (' + (rule.km - n.km).toFixed(1) + ' km short)'}
      </div>`;

    // The exceptions: measured against the nearest school of the kind you want.
    const alts = [
      ['irish', 'Irish-medium'], ['english', 'English-medium'],
      ...ETHOS_CATEGORIES.map(c => [c.key, c.label]),
    ].map(([k, lab]) => [lab, b[k]])
     .filter(([, v]) => v && v.school.id !== n.school.id);

    if (alts.length) {
      html += '<details style="margin-top:3px"><summary style="cursor:pointer;color:var(--soft);font-size:11px">' +
              'If you need a particular ethos or language</summary><div style="font-size:11px;margin-top:3px">';
      alts.forEach(([lab, v]) => {
        html += `<div style="color:${v.eligible ? '#2E7D32' : '#777'}">
          ${v.eligible ? '✓' : '·'} Nearest ${lab}: ${v.school.name} — ${v.km.toFixed(1)} km</div>`;
      });
      html += '</div></details>';
    }
    html += '</div>';
  }

  html += `<div style="font-size:10px;color:#888;line-height:1.4;margin-top:4px">
    Distances are ${result.roadUsed ? 'by road (OSRM)' : 'straight-line — Bus Éireann measures by road, which is longer'}.
    This is an indication, not a decision: the Department determines your nearest
    <em>suitable</em> school, and eligibility is not a seat — places depend on capacity,
    applying by the deadline and the annual charge.
    <a href="https://www.gov.ie/en/service/07a71-school-transport/" target="_blank" rel="noopener">Scheme details ↗</a>
  </div></div>`;
  return html;
}


// ============================================================
// DEEP LINKS  (/#school=<roll>)
// ============================================================
//
// Every static school page and every row in the compare table links back here
// with a school id in the hash. Without this those links all land on the
// default national view, which would make the whole set of pages feel broken.
// The school is fetched by id rather than hoped for in the current viewport.
async function openSchoolFromHash() {
  const m = /(?:^|[#&])school=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  try {
    const { data, error } = await window.supabaseClient
      .from('schools').select('*').eq('id', id).limit(1);
    if (error || !data || !data.length) return;
    const s = data[0];
    if (!s.lat || !s.lng) return;
    if (s.country === 'US') setRegion('US');
    map.setView([s.lat, s.lng], 16);
    // Give the bbox fetch a moment to place the marker, then open the panel.
    setTimeout(() => {
      openSidebar(s);
      drawFeederLines(s);
    }, 900);
  } catch (e) {
    console.error('deep link failed', e);
  }
}
window.addEventListener('hashchange', openSchoolFromHash);

initApp();
openSchoolFromHash();

