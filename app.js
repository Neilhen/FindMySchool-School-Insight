// ============================================================
// BASEMAPS & INIT
// ============================================================
const lightMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd', maxZoom: 19
});
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

function passesFilters(s) {
  const irishOk = s.irish ? activeFilters.irish : true;
  const charterOk = s.charter ? activeFilters.charter : true;
  return s.type === 'preschool'
    ? activeFilters.preschool && irishOk && charterOk
    : activeFilters[s.type] && activeFilters[s.gender] && activeFilters[s.fees] && irishOk && charterOk;
}

async function initApp() {
  try {
    const pRes = await fetch("parish_data.json");
    parishData = await pRes.json();
  } catch (e) {
    console.error("Failed to load parish data:", e);
    return;
  }
  
  parishLayer = L.geoJSON(parishData, {
    style: function () {
      return { color: "transparent", weight: 0, opacity: 0, fillColor: "transparent", fillOpacity: 0 };
    }
  }).addTo(map);
  layerControl.addOverlay(parishLayer, "Parish Boundaries");

  await fetchSchoolsInBounds();
}

async function fetchSchoolsInBounds() {
  const bounds = map.getBounds();
  const { data, error } = await window.supabaseClient
    .from('schools')
    .select('*')
    .gte('lat', bounds.getSouthWest().lat - 0.05)
    .lte('lat', bounds.getNorthEast().lat + 0.05)
    .gte('lng', bounds.getSouthWest().lng - 0.05)
    .lte('lng', bounds.getNorthEast().lng + 0.05)
    .limit(1000);
    
  if (error) {
    console.error("Supabase error:", error);
    return;
  }
  
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
}

map.on('moveend', fetchSchoolsInBounds);
map.on('zoomend', fetchSchoolsInBounds);


// ============================================================
// COLOUR SCHEME
// ============================================================
const COLORS = {
  boys_feepaying: { fill:'#1e40af', stroke:'#1e3a8a' }, boys_free: { fill:'#60a5fa', stroke:'#2563eb' },
  girls_feepaying:{ fill:'#be185d', stroke:'#9d174d' }, girls_free: { fill:'#f472b6', stroke:'#db2777' },
  coed_feepaying: { fill:'#6b21a8', stroke:'#581c87' }, coed_free: { fill:'#c084fc', stroke:'#9333ea' },
  preschool:      { fill:'#16a34a', stroke:'#15803d' },
};
function getC(gender, fees) { return COLORS[`${gender}_${fees}`] || COLORS.coed_feepaying; }

function createIcon(school) {
  const isPreschool = school.type === 'preschool';
  const isSpecial = school.type === 'special';
  const c = isPreschool ? COLORS.preschool : isSpecial ? {fill:'#FB8C00',stroke:'#E65100'} : getC(school.gender, school.fees);
  const size = school.type === 'secondary' ? 22 : isPreschool ? 14 : 16;
  const star = school.irish ? `<div style="position:absolute;top:-5px;right:-5px;width:12px;height:12px;background:#F9A825;border-radius:50%;border:1.5px solid #BF360C;font-size:9px;display:flex;align-items:center;justify-content:center;color:#333;z-index:2">★</div>` : '';
  const shape = (isPreschool || isSpecial) ? `border-radius:3px` : `border-radius:50%`;
  return L.divIcon({
    html: `<div style="position:relative;width:${size}px;height:${size}px">
      <div style="width:${size}px;height:${size}px;${shape};background:${c.fill};border:2.5px solid ${c.stroke};box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>
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
    return L.divIcon({ html: '<div style="background:var(--primary);color:white;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;box-shadow:0 2px 5px rgba(0,0,0,0.3);border:2px solid white;">' + cluster.getChildCount() + '</div>', className: 'custom-cluster', iconSize: L.point(30, 30) });
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
  parishLayer.eachLayer(layer => {
    parishLayer.resetStyle(layer);
  });
}

function drawLine(p1, p2, color) {
  const line = L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], { color: color, weight: 3, opacity: 0.7, dashArray: '6, 6' }).addTo(map);
  layerControl.addOverlay(parishLayer, "Parish Boundaries");
  line.bringToFront();
  activeLines.push(line);
}

function highlightParish(parishId) {
  clearParishes();
  if (!parishId) return;
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
  if(data.ethos && data.ethos !== 'Unknown') badgesHTML += `<span class="badge" style="background:#FFF3E0;color:#E65100;">${data.ethos}</span>`;
  if(data.irish) badgesHTML += `<span class="badge b-iri">★ Irish-medium</span>`;
  if(data.charter) badgesHTML += `<span class="badge" style="background:#FFF3E0;color:#E65100;">★ Charter</span>`;
  if(data.deis) badgesHTML += `<span class="badge" style="background:#E8F5E9;color:#2E7D32;font-weight:700;">✓ DEIS</span>`;
  sbBadges.innerHTML = badgesHTML;
  
  sbFee.textContent = data.fees === 'feepaying'
    ? (data.annualFee ? `€${data.annualFee.toLocaleString()} / year` : 'Fee-paying — amount to be confirmed')
    : 'Free';
  if (data.feeYear) sbFee.textContent += ` (${data.feeYear}${data.feeSource ? ', ' + data.feeSource : ''})`;
  if (data.feeNote) sbFee.textContent += ` (${data.feeNote})`;
  
  let locHTML = data.area || '';
  if (data.address) locHTML += `<br><span style="color:#666">${data.address}</span>`;
  if (data.eircode) locHTML += ` <span style="color:#999">${data.eircode}</span>`;
  if(data.parish) locHTML += `<br><strong style="color:#6A1B9A;margin-top:6px;display:inline-block;">📍 Parish: ${data.parish}</strong>`;
  if(data.parishNote) locHTML += `<br><span style="color:#E65100;font-size:11px;">⚠ ${data.parishNote}</span>`;
  // distance from the home pin, if one is set
  if (typeof homePin !== 'undefined' && homePin) {
    const d = pinDistKm(data.lat, data.lng);
    locHTML += `<br><strong style="color:#1a237e;">📏 ${d.toFixed(1)} km from your pin</strong>`;
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
  }
  sbLoc.innerHTML = locHTML;
  
  let notesHTML = data.notes || '';
  const facts = [];
  if (data.enrolment) facts.push(`Enrolment: ${data.enrolment} (2024/25)`);
  if (data.patron) facts.push(`Patron: ${data.patron}`);
  if (data.district_name) facts.push(`District: ${data.district_name}`);
  if (!data.id.startsWith('PRIV-') && !data.id.startsWith('PRE-') && !data.id.startsWith('US-')) facts.push(`Roll no: ${data.id}`);
  if (data.id.startsWith('US-')) facts.push(`NCES ID: ${data.nces_id}`);
  if (facts.length) notesHTML += `<br><span style="color:#555;font-size:12px">${facts.join(' · ')}</span>`;
  if (data.approxLocation) notesHTML += `<br><span style="color:#E65100;font-size:11px;font-weight:600">📍 Approximate location — run geocode_preschools.py or check the address</span>`;
  if (data.source && data.source.indexOf('DoE') === 0) notesHTML += `<br><span style="color:#2E7D32;font-size:11px;font-weight:600">✓ Verified against DoE register 2024/25</span>`;
  else if (data.needsReview) notesHTML += `<br><span style="color:#C62828;font-size:11px;font-weight:600">⚠ Not found in official register — details unverified</span>`;
  else if (data.source && data.source.indexOf('private') !== -1) notesHTML += `<br><span style="color:#E65100;font-size:11px;font-weight:600">Private school — not in DoE recognised-school register</span>`;
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
const filtersHeader = document.getElementById('filters-header');
const filtersContent = document.getElementById('filters-content');
const filtersIcon = document.getElementById('filters-icon');
filtersHeader.addEventListener('click', () => {
  if (filtersContent.style.display === 'none') {
    filtersContent.style.display = 'block';
    filtersIcon.textContent = '▼';
  } else {
    filtersContent.style.display = 'none';
    filtersIcon.textContent = '▶';
  }
});

const activeFilters = {
  preschool:true, primary:true, secondary:true, special:true,
  boys:true, girls:true, coed:true,
  feepaying:true, free:true, irish:true, charter:true
};
const btnCols = {
  preschool:'#16a34a', primary:'#0369a1', secondary:'#6b21a8', special:'#ea580c',
  boys:'#1e40af', girls:'#be185d', coed:'#6b21a8',
  feepaying:'#c2410c', free:'#15803d', irish:'#ca8a04', charter:'#ca8a04'
};

Object.keys(activeFilters).forEach(k => {
  const btn = document.getElementById('f-'+k);
  if (!btn) return;
  btn.style.borderColor = btnCols[k];
  btn.style.background = btnCols[k];
  btn.style.color = 'white';
});

window.toggleFilter = function(key) {
  activeFilters[key] = !activeFilters[key];
  const btn = document.getElementById('f-'+key);
  if (activeFilters[key]) {
    btn.style.background = btnCols[key];
    btn.style.color = 'white';
  } else {
    btn.style.background = 'white';
    btn.style.color = btnCols[key];
  }
  
  markersGroup.clearLayers();
  const activeSet = allMarkers.filter(m => passesFilters(m._schoolData));
  markersGroup.addLayers(activeSet);
  clearLines();
  clearParishes();
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
  layerControl.addOverlay(parishLayer, "Parish Boundaries");
  homePin.on('dragend', () => refreshNearest());
  document.getElementById('pin-clear').style.display = '';
  document.getElementById('pin-status').textContent = label || '';
  map.setView([lat, lng], Math.max(map.getZoom(), 14));
  refreshNearest();
}

function clearPin() {
  if (homePin) map.removeLayer(homePin);
  homePin = null;
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
      .filter(s => s.type === t && s.lat && s.lng)
      .filter(s => {
        const irishOk = s.irish ? activeFilters.irish : true;
        return t === 'preschool' ? activeFilters.preschool && irishOk
          : activeFilters[t] && activeFilters[s.gender] && activeFilters[s.fees] && irishOk;
      })
      .map(s => ({ d: pinDistKm(s.lat, s.lng), s: s }))
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
    
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.code === 'Ok' && data.durations && data.durations[0]) {
      allCands.forEach((c, i) => {
        const seconds = data.durations[0][i];
        c.driveMins = seconds ? Math.round(seconds / 60) : null;
      });
    }
  } catch(e) {
    console.error("OSRM failed, falling back to distance", e);
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
    el.onmouseenter = () => el.style.background = '#f0f4f8';
    el.onmouseleave = () => el.style.background = '';
    el.onclick = () => {
      const s = schools.find(x => x.id === el.dataset.sid);
      map.setView([s.lat, s.lng], 15);
      openSidebar(s);
      drawFeederLines(s);
    };
  });
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

document.getElementById('pin-go').addEventListener('click', geocodePin);
document.getElementById('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') geocodePin(); });
document.getElementById('pin-clear').addEventListener('click', clearPin);
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
    btnUs.style.background = '#1a237e';
    btnUs.style.color = 'white';
    btnIe.style.background = 'transparent';
    btnIe.style.color = 'black';
    if (ieFilters) ieFilters.style.display = 'none';
    if (usFilters) usFilters.style.display = 'block';
    map.setView([39.8, -98.5], 4);
    if (parishLayer && map.hasLayer(parishLayer)) map.removeLayer(parishLayer);
  } else {
    btnIe.style.background = '#1a237e';
    btnIe.style.color = 'white';
    btnUs.style.background = 'transparent';
    btnUs.style.color = 'black';
    if (usFilters) usFilters.style.display = 'none';
    if (ieFilters) ieFilters.style.display = 'block';
    map.setView([53.4, -8.0], 7);
    if (parishLayer && !map.hasLayer(parishLayer)) map.addLayer(parishLayer);
  }
};

initApp();
