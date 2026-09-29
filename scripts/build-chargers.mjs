// Builds src/data/chargers.json: public EV charging sites in Hungary from OpenStreetMap.
//
//   node scripts/build-chargers.mjs            -> downloads fresh data from Overpass, then builds
//   node scripts/build-chargers.mjs --cached   -> rebuilds from scripts/.cache/chargers.json
//
// Sites mapped as several points (one per charger post) are merged. Prices are not in OSM: they come from the
// operators' published tariffs at runtime (src/data/evTariffs.js), matched by network and charger power.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, 'scripts', '.cache', 'chargers.json');
const PLACES = path.join(ROOT, 'scripts', '.cache', 'places.json');
const OUT_FILE = path.join(ROOT, 'src', 'data', 'chargers.json');
const QUERY = '[out:json][timeout:170];area["ISO3166-1"="HU"][admin_level=2]->.hu;nwr["amenity"="charging_station"](area.hu);out center tags;';
const MAX_AGE_DAYS = 7; // reject Overpass data older than this
const MIN_KEEP_RATIO = 0.8; // reject a new list with more than 20% fewer chargers than the current one
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function download() {
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'TankoljOkosan/1.0 (hobby project)', Accept: 'application/json' },
        body: new URLSearchParams({ data: QUERY })
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        const data = JSON.parse(text);
        // Some mirrors lag months behind: an old copy would silently drop everything mapped since
        const base = data.osm3s?.timestamp_osm_base;
        if (Date.now() - Date.parse(base) < MAX_AGE_DAYS * 86400000) return data;
        console.warn(`  ${url} -> data from ${base || 'unknown date'}, older than ${MAX_AGE_DAYS} days, trying next`);
        continue;
      }
      console.warn(`  ${url} -> HTTP ${res.status}, trying next`);
    } catch (e) {
      console.warn(`  ${url} -> ${e.message}, trying next`);
    }
  }
  throw new Error('All Overpass endpoints failed');
}

// Network (charging brand) from operator / brand / network / name; order matters
const NETWORK_RULES = [
  [/\blidl\b/i, 'Lidl'],
  [/mobiliti|e-mobi\b|e-mobi elektromobilit|nkm mobilit|\bmvm\b/i, 'Mobiliti'],
  [/plugee|\bmol\b/i, 'MOL Plugee'],
  [/\be\.?\s?on\b|e-on\b|\bedri\b|elmű|elmu\b/i, 'E.ON Drive'],
  [/shell/i, 'Shell Recharge'],
  [/\bomv\b/i, 'OMV eMotion'],
  [/tesla/i, 'Tesla'],
  [/ionity/i, 'IONITY'],
  [/penny/i, 'Penny'],
  [/tea mobilit|teapont|^tea\.?$/i, 'TEA'],
  [/parkl/i, 'Parkl'],
  [/alte-?go|alteo/i, 'ALTE-GO']
];
const networkOf = (t) => {
  for (const src of [t.brand, t.network, t.operator, t.name]) {
    if (!src) continue;
    for (const [re, net] of NETWORK_RULES) if (re.test(src)) return net;
  }
  return 'Egyéb töltő';
};

const DC_SOCKETS = new Set(['type2_combo', 'chademo', 'tesla_supercharger', 'tesla_supercharger_ccs', 'type1_combo']);
const CAR_SOCKETS = new Set(['type2', 'type2_cable', 'type2_combo', 'chademo', 'tesla_supercharger', 'tesla_supercharger_ccs', 'type1', 'type1_combo', 'schuko', 'typee', 'cee_blue', 'cee_red_16a', 'cee_red_32a', 'type3']);
const SOCKET_LABEL = {
  type2: 'Type 2', type2_cable: 'Type 2 (kábeles)', type2_combo: 'CCS2', chademo: 'CHAdeMO', tesla_supercharger: 'Tesla', tesla_supercharger_ccs: 'Tesla (CCS)',
  type1: 'Type 1', type1_combo: 'CCS1', schuko: 'Schuko', typee: 'Schuko (E)', cee_blue: 'CEE kék', cee_red_16a: 'CEE piros 16A', cee_red_32a: 'CEE piros 32A', type3: 'Type 3'
};

// "22 kW", "50kW", "300 kW;150 kW", "AC 22 kW", "22" -> highest value in kW
function parseKw(v) {
  if (!v) return null;
  const nums = String(v).split(/[;,/]/).map(s => {
    const m = /([\d.]+)\s*(kw|w)?/i.exec(s.replace(',', '.'));
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2] && m[2].toLowerCase() === 'w') n /= 1000;
    return n;
  }).filter(n => n > 0 && n <= 1000);
  return nums.length ? Math.max(...nums) : null;
}

function socketsOf(t) {
  const out = [];
  for (const [key, value] of Object.entries(t)) {
    const m = /^socket:([a-z0-9_]+)$/.exec(key);
    if (!m || !CAR_SOCKETS.has(m[1])) continue;
    const count = parseInt(value, 10);
    if (value === 'no' || count === 0) continue;
    const dc = DC_SOCKETS.has(m[1]);
    let kw = parseKw(t[`${key}:output`]);
    let assumed = false;
    if (!kw) {
      kw = parseKw(t['charging_station:output']) || (dc ? 50 : m[1] === 'schuko' ? 3.7 : 22);
      assumed = !t['charging_station:output'];
    }
    out.push({ type: m[1], label: SOCKET_LABEL[m[1]] || m[1], count: Number.isFinite(count) && count > 0 ? count : 1, kw, dc, assumed });
  }
  return out;
}

function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DAY_MAP = { Mo: 'H', Tu: 'K', We: 'Sze', Th: 'Cs', Fr: 'P', Sa: 'Szo', Su: 'V' };
const is24h = (raw) => !!raw && (/^24\/7$/.test(raw.trim()) || /^(Mo-Su )?00:00-24:00$/.test(raw.trim()));
const formatHours = (raw) =>
  !raw ? null : is24h(raw) ? '0–24' : raw.trim().replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, d => DAY_MAP[d]).replace(/\boff\b/g, 'zárva').replace(/;\s*/g, '; ');

async function main() {
  let data;
  if (process.argv.includes('--cached')) {
    data = JSON.parse(await fs.readFile(CACHE, 'utf8'));
  } else {
    console.log('Downloading charging stations from Overpass…');
    data = await download();
    await fs.writeFile(CACHE, JSON.stringify(data));
  }
  const places = JSON.parse(await fs.readFile(PLACES, 'utf8')).elements.map(p => ({ name: p.tags.name, postcode: p.tags.postal_code?.split(/[;,]/)[0], lat: p.lat, lng: p.lon }));
  const nearestPlace = (pt) => places.reduce((best, p) => (!best || distanceM(pt, p) < distanceM(pt, best) ? p : best), null);

  const stats = { total: data.elements.length, excluded: 0, merged: 0 };
  const raw = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!lat || !lng) continue;
    const sockets = socketsOf(t);
    const bikeOnly = t.motorcar === 'no' || ((t.bicycle === 'yes' || t.bicycle === 'designated') && !sockets.length);
    if (/^(private|no|employees|delivery)$/.test(t.access || '') || t.disused === 'yes' || t['disused:amenity'] || bikeOnly) {
      stats.excluded++;
      continue;
    }
    raw.push({ el, t, lat, lng, network: networkOf(t), sockets, capacity: parseInt(t.capacity, 10) || null });
  }

  // One site per network within 40 m (OSM often has a point per charger post)
  const sites = [];
  for (const c of raw) {
    const site = sites.find(s => s.network === c.network && distanceM(s, c) < 40);
    if (!site) {
      sites.push({ ...c, members: [c] });
      continue;
    }
    stats.merged++;
    site.members.push(c);
    for (const s of c.sockets) {
      const same = site.sockets.find(x => x.type === s.type && x.kw === s.kw);
      if (same) same.count += s.count;
      else site.sockets.push({ ...s });
    }
    if (c.capacity) site.capacity = (site.capacity || 0) + c.capacity;
    for (const [k, v] of Object.entries(c.t)) if (!(k in site.t)) site.t[k] = v;
  }

  const chargers = sites.map(s => {
    const t = s.t;
    const place = nearestPlace(s);
    const city = t['addr:city'] || place?.name || '';
    const postcode = t['addr:postcode'] || (t['addr:city'] ? '' : place?.postcode) || '';
    const street = t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim() : '';
    const address = [postcode && city ? `${postcode} ${city}` : city, street].filter(Boolean).join(', ');
    const label = s.network === 'Egyéb töltő' ? t.operator || t.brand || 'Töltőállomás' : s.network;
    const name = t.name && !/^(töltő|charging station|töltőállomás|elektromos töltő)$/i.test(t.name.trim()) ? t.name.trim() : `${label} – ${city}${street ? `, ${t['addr:street']}` : ''}`;
    const maxKw = s.sockets.length ? Math.max(...s.sockets.map(x => x.kw)) : parseKw(t['charging_station:output']);
    return {
      id: `ev-${s.el.type[0]}${s.el.id}`,
      name,
      network: s.network,
      operator: t.operator || null,
      city,
      address: address || city,
      lat: +s.lat.toFixed(6),
      lng: +s.lng.toFixed(6),
      is24h: is24h(t.opening_hours),
      openingHours: formatHours(t.opening_hours),
      sockets: s.sockets.map(({ type, label: l, count, kw, dc, assumed }) => ({ type, label: l, count, kw, dc, ...(assumed ? { assumed: true } : {}) })),
      maxKw: maxKw || null,
      capacity: s.capacity,
      fee: t.fee === 'no' ? false : t.fee === 'yes' ? true : null,
      osmCharge: t.charge || null,
      osmUrl: `https://www.openstreetmap.org/${s.el.type}/${s.el.id}`
    };
  });
  chargers.sort((a, b) => a.city.localeCompare(b.city, 'hu') || a.name.localeCompare(b.name, 'hu'));

  // A much shorter list is a broken download, not chargers closing down: keep the previous file
  const previousCount = await fs.readFile(OUT_FILE, 'utf8').then(t => JSON.parse(t).meta?.count).catch(() => null);
  if (previousCount && chargers.length < previousCount * MIN_KEEP_RATIO) {
    throw new Error(`Only ${chargers.length} chargers instead of ${previousCount}, keeping the previous file`);
  }

  const meta = { source: 'OpenStreetMap (ODbL) via Overpass API', osmTimestamp: data.osm3s?.timestamp_osm_base, generatedAt: new Date().toISOString(), count: chargers.length };
  await fs.writeFile(OUT_FILE, JSON.stringify({ meta, chargers }));
  const byNet = {};
  chargers.forEach(c => (byNet[c.network] = (byNet[c.network] || 0) + 1));
  console.log({ ...stats, sites: chargers.length, osmTimestamp: meta.osmTimestamp }, byNet);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
