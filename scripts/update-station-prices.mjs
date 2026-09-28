// Updates src/data/stationPrices.json with the current pump prices of every Hungarian filling station.
//
//   node scripts/update-station-prices.mjs          -> always downloads
//   node scripts/update-station-prices.mjs --soft   -> skips when checked in the last FRESH_HOURS, never fails
//
// Source: benzinkutarak.hu (daily updated per-station prices; robots.txt allows everything). One request per
// fuel type covers the whole country, sent one by one with a pause. The price rows are matched to the
// OpenStreetMap stations in src/data/stations.json; priced stations missing from OpenStreetMap are kept as extras.
// The file is only rewritten when a price changed or on a new day, so a running dev server reloads rarely.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, 'src', 'data', 'stationPrices.json');
const STATIONS_FILE = path.join(ROOT, 'src', 'data', 'stations.json');
const CHECK_FILE = path.join(ROOT, 'node_modules', '.cache', 'station-prices-checked');
const SITE = 'https://www.benzinkutarak.hu';
const ENDPOINT = `${SITE}/kozel.php`;
const HEADERS = { 'User-Agent': 'TankoljOkosan/1.0 (hobby project; daily price refresh)', Referer: ENDPOINT };
const SOFT = process.argv.includes('--soft');
export const FRESH_HOURS = 3;

// Site fuel id -> app fuel key
const FUELS = {
  Benzina_Regular: 'benzin95',
  Motorina_Regular: 'diesel',
  GPL: 'lpg',
  Benzina_Premium: 'premium95',
  Motorina_Premium: 'premiumDiesel',
  AdBlue: 'adblue'
};

// Site network id -> app brand (others become "Független")
const BRANDS = {
  Mol: 'MOL', MolPartner: 'MOL', Shell: 'Shell', OMV: 'OMV', Orlen: 'Orlen', AVIA: 'Avia', Auchan: 'Auchan',
  OIL: 'OIL!', MPetrol: 'Mobil Petrol', ALDI: 'Aldi', Envi: 'ENVI', TeleTank: 'Teletank', Dallas: 'Dallas',
  OrangesOil: 'Oranges Oil', EDO: 'EDO', HunPetrol: 'HunPetrol', Maxiline: 'MAXILine', FullEnergy: 'FullEnergy'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

async function networkIds() {
  const res = await fetch(ENDPOINT, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${ENDPOINT} -> HTTP ${res.status}`);
  const ids = [...(await res.text()).matchAll(/name="retea" id="([^"]+)"/g)].map(m => m[1]);
  if (ids.length < 10) throw new Error('Network list not found (page layout changed?)');
  return ids;
}

// Every station selling the fuel within 1000 km of the middle of Hungary: [network, lat, lng, city, address, price]
async function fetchFuel(fuelId, networks) {
  const body = new URLSearchParams({ carburant: fuelId, raza: '1000', lat: '47.16', lng: '19.5' });
  for (const n of networks) body.append('retele[]', n);
  const res = await fetch(ENDPOINT, { method: 'POST', body, headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${fuelId} -> HTTP ${res.status}`);
  const m = /var rezultate = JSON\.parse\('([^']*)'\)/.exec(await res.text());
  if (!m) throw new Error(`${fuelId}: no results in the page (layout changed?)`);
  return JSON.parse(m[1]) || [];
}

// "XI, Budafoki út 211" / "1117 Budapest, Budafoki út 211" -> "budafoki"
function streetKey(address) {
  const words = String(address || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^[ivxlc]+\s*,\s*/, '')
    .split(/[\s,.]+/)
    .filter(w => w.length > 2 && !/^\d/.test(w) && !/^(ut|utca|u|ter|korut|hrsz|sz)$/.test(w));
  return words[0] || '';
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
};

async function download() {
  const networks = await networkIds();
  const sites = new Map(); // "lat,lng" -> { network, lat, lng, city, address, prices }
  for (const [fuelId, key] of Object.entries(FUELS)) {
    await sleep(1200);
    const rows = await fetchFuel(fuelId, networks);
    // 999999 and similar placeholders mean "no price"; drop anything far from the median
    const mid = median(rows.map(r => Number(r[5])).filter(p => p > 0 && p < 5000));
    for (const [network, lat, lng, city, address, raw] of rows) {
      const id = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
      if (!sites.has(id)) sites.set(id, { network, lat: Number(lat), lng: Number(lng), city, address, prices: {} });
      const price = Number(raw);
      if (mid && price > mid * 0.6 && price < mid * 1.6) sites.get(id).prices[key] = price;
    }
  }
  return [...sites.values()].filter(s => Object.keys(s.prices).length);
}

// Pair every priced site with the nearest OpenStreetMap station: same network within 300 m, any within 120 m
function match(sites, stations) {
  const cell = (lat, lng) => `${Math.floor(lat / 0.01)},${Math.floor(lng / 0.015)}`;
  const grid = new Map();
  for (const st of stations) {
    const k = cell(st.lat, st.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(st);
  }
  const pairs = [];
  sites.forEach((site, i) => {
    const brand = BRANDS[site.network] || 'Független';
    const [ci, cj] = cell(site.lat, site.lng).split(',').map(Number);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const st of grid.get(`${ci + di},${cj + dj}`) || []) {
          const d = distanceM(site, st);
          const sameBrand = st.brand === brand || (brand === 'Független') !== (st.brand === 'Független');
          if (d <= 120 || (sameBrand && d <= 300)) pairs.push({ i, st, d: d - (st.brand === brand ? 150 : 0) });
        }
      }
    }
  });
  // Closest pairs first, each station and site used once
  pairs.sort((a, b) => a.d - b.d);
  const usedSite = new Set();
  const byStation = {};
  const brands = {};
  const take = (i, st) => {
    usedSite.add(i);
    byStation[st.id] = sites[i].prices;
    // OpenStreetMap often lacks the brand of small or rebranded stations
    const brand = BRANDS[sites[i].network];
    if (brand && st.brand === 'Független') brands[st.id] = brand;
  };
  for (const { i, st } of pairs) {
    if (!usedSite.has(i) && !byStation[st.id]) take(i, st);
  }

  // The source's coordinates are sometimes geocoded roughly: second pass for the rest, within 2 km,
  // when the street names agree or the network is the same (the nearest free station of that network)
  const free = stations.filter(st => !byStation[st.id]);
  const late = [];
  sites.forEach((site, i) => {
    if (usedSite.has(i)) return;
    const brand = BRANDS[site.network] || 'Független';
    const street = streetKey(site.address);
    for (const st of free) {
      const d = distanceM(site, st);
      if (d > 2000) continue;
      const sameStreet = street && street === streetKey(String(st.address || '').split(',').slice(1).join(','));
      if (sameStreet || (brand !== 'Független' && st.brand === brand && d <= 1200)) late.push({ i, st, d: d - (sameStreet ? 2000 : 0) });
    }
  });
  late.sort((a, b) => a.d - b.d);
  for (const { i, st } of late) {
    if (!usedSite.has(i) && !byStation[st.id]) take(i, st);
  }
  const extra = sites
    .map((site, i) => ({ site, i }))
    .filter(({ i }) => !usedSite.has(i))
    .map(({ site }) => {
      const brand = BRANDS[site.network] || 'Független';
      const city = String(site.city || '').trim();
      return {
        id: `bk-${site.lat.toFixed(5)}-${site.lng.toFixed(5)}`,
        name: `${brand === 'Független' ? site.network : brand} – ${city}`,
        brand,
        city,
        address: [city, String(site.address || '').trim()].filter(Boolean).join(', '),
        lat: site.lat,
        lng: site.lng,
        prices: site.prices
      };
    });
  return { byStation, brands, extra };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function updateStationPrices({ soft = false, log = console.log } = {}) {
  if (soft) {
    const checked = Number(await fs.readFile(CHECK_FILE, 'utf8').catch(() => 0));
    if (Date.now() - checked < FRESH_HOURS * 3600000 && (await readJson(OUT_FILE))) return false;
  }

  const [sites, stationsFile] = await Promise.all([download(), readJson(STATIONS_FILE)]);
  if (sites.length < 500) throw new Error(`Only ${sites.length} priced stations, keeping the previous prices`);
  const { byStation, brands, extra } = match(sites, stationsFile.stations);

  const averages = {};
  for (const key of Object.values(FUELS)) {
    const values = sites.map(s => s.prices[key]).filter(Boolean);
    if (values.length >= 20) averages[key] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  }

  await fs.mkdir(path.dirname(CHECK_FILE), { recursive: true });
  await fs.writeFile(CHECK_FILE, String(Date.now()));

  const previous = await readJson(OUT_FILE);
  const now = new Date();
  const sameDay = previous && new Date(previous.checkedAt).toDateString() === now.toDateString();
  const unchanged = previous && JSON.stringify([previous.stations, previous.brands, previous.extra]) === JSON.stringify([byStation, brands, extra]);
  if (sameDay && unchanged) {
    log(`Kútárak ellenőrizve: nem változtak (${sites.length} kút).`);
    return false;
  }

  const out = {
    checkedAt: now.toISOString(),
    changedAt: unchanged ? previous.changedAt : now.toISOString(),
    source: 'benzinkutarak.hu',
    sourceUrl: SITE,
    count: sites.length,
    matched: Object.keys(byStation).length,
    averages,
    stations: byStation,
    brands,
    extra
  };
  await fs.writeFile(OUT_FILE, `${JSON.stringify(out)}\n`);
  log(`Kútárak frissítve: ${sites.length} kút (${out.matched} párosítva az OSM-kutakhoz, ${extra.length} új) · átlag 95: ${averages.benzin95} Ft, dízel: ${averages.diesel} Ft`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateStationPrices({ soft: SOFT }).catch(err => {
    if (SOFT) {
      console.warn(`Kútár-frissítés kihagyva (${err.message}); a korábbi árak maradnak.`);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}
