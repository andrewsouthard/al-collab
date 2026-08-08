/* Planes Overhead — live demo using OpenSky Network free API via local proxy.
   Shows every airborne plane near your house on a map, exactly like the ADS-B
   receiver will, but with software only. */

const AIRLINES = {
  AAL:'American', UAL:'United', DAL:'Delta', SWA:'Southwest', FFT:'Frontier',
  AAY:'Allegiant', MXY:'Breeze', JBU:'JetBlue', ASA:'Alaska', NKS:'Spirit',
  JIA:'American Eagle', ENY:'Envoy/American Eagle', PDT:'Piedmont/American Eagle',
  RPA:'Republic', GJS:'GoJet/United Express', ASH:'Mesa', SKW:'SkyWest',
  UCA:'CommutAir', EDV:'Endeavor/Delta', QXE:'Horizon', OOJ:'Orange Jet',
  ACA:'Air Canada', WJA:'WestJet', DLH:'Lufthansa', BAW:'British Airways',
  AFR:'Air France', KLM:'KLM', UAE:'Emirates', QTR:'Qatar', ETD:'Etihad',
  CPA:'Cathay', CCA:'Air China', ANA:'ANA', JAL:'Japan Airlines', KAL:'Korean',
  SIA:'Singapore', THY:'Turkish', GLO:'Gol', AZU:'Azul', TAM:'LATAM',
  AVA:'Avianca', VIV:'Volaris', VOI:'Volaris', WJA:'WestJet', UAL:'United',
};

const HOME = { lat: 35.78, lon: -78.64 };   // Wake County, NC default
const REFRESH_MS = 8000;

const map = L.map('map').setView([HOME.lat, HOME.lon], 10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// home marker + coverage circle
let homeMarker = L.circleMarker([HOME.lat, HOME.lon], {
  radius: 10, color:'#fff', fillColor:'#ff5a5a', fillOpacity:.9, weight:2
}).addTo(map).bindPopup('🏠 Your house');
let rangeCircle = L.circle([HOME.lat, HOME.lon], {
  radius: 60000, color:'#4ea1ff', weight:1, dashArray:'6 6', fillOpacity:.04
}).addTo(map);

const markers = new Map();   // icao24 -> layer
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const latEl = document.getElementById('lat');
const lonEl = document.getElementById('lon');
const radEl = document.getElementById('radius');

function airline(name){
  const p = (name||'').trim().slice(0,3).toUpperCase();
  return AIRLINES[p] || 'Flight';
}

function fmtAlt(m){ return m==null? '—' : Math.round(m*3.28084).toLocaleString()+' ft'; }
function fmtSpd(ms){ return ms==null? '—' : Math.round(ms*2.23694)+' mph'; }

async function fetchStates(){
  try {
    statusEl.textContent = 'loading…';
    const u = `/api/states?lat=${HOME.lat}&lon=${HOME.lon}&radius=${Number(radEl.value||60)}`;
    const r = await fetch(u);
    const d = await r.json();
    if (d.error){ throw new Error(d.error); }
    render(d.states);
    statusEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch(e){
    statusEl.textContent = '⚠ '+e.message;
  }
}

function render(states){
  const seen = new Set();
  let airborne = 0;
  for (const s of states||[]){
    const icao = s[0];
    const callsign = (s[1]||'').trim();
    const lon = s[5], lat = s[6];
    const alt = s[7];                 // barometric altitude m (null on ground)
    const onGround = s[8];
    const vel = s[9], track = s[10], vrate = s[11];
    if (lat==null || lon==null) continue;
    seen.add(icao);
    if (!onGround && (alt!=null)) airborne++;
    const pop = popupHTML(callsign, onGround, alt, vel, track, vrate, s[2]);
    let m = markers.get(icao);
    const color = onGround ? '#8a93b5' : '#ffd43b';
    if (!m){
      m = L.circleMarker([lat, lon], {
        radius: onGround?5:7, color:'#111', weight:1,
        fillColor: color, fillOpacity:.95
      }).addTo(map).bindPopup(pop);
      markers.set(icao, m);
    } else {
      m.setLatLng([lat, lon]);
      m.setStyle({ radius: onGround?5:7, fillColor: color });
      m.setPopupContent(pop);
    }
  }
  // prune planes that left the area
  for (const [icao, m] of markers){
    if (!seen.has(icao)){ map.removeLayer(m); markers.delete(icao); }
  }
  countEl.textContent = (airborne + ' plane' + (airborne===1?'':'s') + ' overhead');
}

function popupHTML(callsign, onGround, alt, vel, track, vrate, country){
  const a = airline(callsign);
  const arrow = track==null? '—' : '➤ '+Math.round(track)+'°';
  const climb = vrate==null? '—' : (vrate>=0?'▲':'▼')+' '+Math.round(Math.abs(vrate)*196.85)+' ft/min';
  return `<div class="plane">
    <b>${a}</b> ${callsign? '<span style="color:#9aa6cf">('+callsign+')</span>' : ''}
    <div class="row">
      <span>🛬 ${onGround?'on ground':'✈ airborne'}</span>
      <span>📏 ${onGround?'—':fmtAlt(alt)}</span>
      <span>💨 ${fmtSpd(vel)}</span>
      <span>🧭 ${arrow}</span>
      <span>${climb}</span>
    </div>
    <div class="meta">${country||''}</div>
  </div>`;
}

document.getElementById('apply').addEventListener('click', () => {
  const lat = parseFloat(latEl.value), lon = parseFloat(lonEl.value);
  if (!isNaN(lat)&&!isNaN(lon)){
    HOME.lat = lat; HOME.lon = lon;
    map.setView([lat, lon], 10);
    homeMarker.setLatLng([lat, lon]);
    rangeCircle.setLatLng([lat, lon]);
    fetchStates();
  }
});

(async function init(){
  try{
    const r = await fetch('/api/home');
    const d = await r.json();
    latEl.value = d.lat; lonEl.value = d.lon; radEl.value = d.radius_km;
  }catch(e){ latEl.value=HOME.lat; lonEl.value=HOME.lon; }
  fetchStates();
  setInterval(fetchStates, REFRESH_MS);
})();
