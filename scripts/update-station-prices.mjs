// Updates src/data/stationPrices.json with the current pump prices of every Hungarian filling station.
//
//   node scripts/update-station-prices.mjs          -> always downloads
//   node scripts/update-station-prices.mjs --soft   -> skips when checked in the last FRESH_HOURS, never fails
//   node scripts/update-station-prices.mjs --grace  -> the data repo's hourly runs: a source outage only warns while
//                                                      the last successful check is recent (GRACE_HOURS)
//
// Source: benzinkutarak.hu (daily updated per-station prices; robots.txt allows everything). One request per
// fuel type covers the whole country, sent one by one with a pause. The price rows are matched to the
// OpenStreetMap stations in src/data/stations.json; priced stations missing from OpenStreetMap are kept as extras.
// The file is only rewritten when a price changed or on a new day, so a running dev server reloads rarely; the time of
// every successful check is in CHECK_FILE (the data repo's build-site.mjs publishes it as stationPrices.checkedAt).
//
// `since` records when each price was first seen at its current value: { [station id]: { [fuel]: unix hour } }
// (hours since 1970, UTC), carried over from the previous file while the price stays the same. `trackedFrom` is the
// hour the record starts; a price without an entry has not changed since then (at least).
//
// `suspect` marks the 95 and diesel prices far from what similar stations ask (suspectPrices): { [station id]:
// { [fuel]: { ref, basis } } }. They are kept and shown, flagged, with a call to report the real price.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, 'src', 'data', 'stationPrices.json');
const STATIONS_FILE = path.join(ROOT, 'src', 'data', 'stations.json');
const PLACES_FILE = path.join(ROOT, 'scripts', '.cache', 'places.json'); // settlements (build-stations.mjs)
const CHECK_FILE = path.join(ROOT, 'node_modules', '.cache', 'station-prices-checked');
const SITE = 'https://www.benzinkutarak.hu';
const ENDPOINT = `${SITE}/kozel.php`;
const HEADERS = { 'User-Agent': 'TankoljOkosan/1.0 (hobby project; daily price refresh)', Referer: ENDPOINT };
const SOFT = process.argv.includes('--soft');
const GRACE = process.argv.includes('--grace');
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
  OrangesOil: 'Oranges Oil', EDO: 'EDO', HunPetrol: 'HunPetrol', Maxiline: 'MAXILine', FullEnergy: 'FullEnergy',
  // M.Petrol stations listed under a network of their own (2026-10-03: 6 sites, M.Petrol's prices, its stations in OSM)
  Mobiliti: 'Mobil Petrol'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The source sometimes does not answer for a few minutes (connect timeouts from GitHub's runners: 2026-10-02 15:06,
// 10-03 13:08 and 10-04 03:05 UTC, 3 of 67 runs; the next hourly run was fine each time). A network error or a
// server error is tried again three times (after 20 s, 1 and 3 minutes) before the run fails; not with --soft (a
// local build or dev start should not wait).
export const RETRY_WAITS_MS = [20000, 60000, 180000];
export const transient = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' || /fetch failed|HTTP 5\d\d/.test(String(err?.message));
export async function withRetries(task, { waits = RETRY_WAITS_MS, log = console.log } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (!transient(err) || attempt >= waits.length) throw err;
      log(`A forrás nem válaszolt (${err.cause?.code || err.message}); újrapróbálás ${waits[attempt] / 1000} s múlva.`);
      await sleep(waits[attempt]);
    }
  }
}

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

const plain = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// "XI, Budafoki út 211" / "1117 Budapest, Budafoki út 211" -> ["budafoki"]; streetKey: the first one
function streetWords(address) {
  return plain(address)
    .replace(/^[ivxlc]+\s*,\s*/, '')
    .split(/[\s,.()]+/)
    .filter(w => w.length > 2 && !/^\d/.test(w) && !/^(ut|utca|u|ter|korut|hrsz|sz)$/.test(w));
}
const streetKey = (address) => streetWords(address)[0] || '';

// Where a priced site may be: inside Hungary, and near its settlement. The source's coordinates are sometimes broken
// (2026-10-03: one of them a round 44.5, 45.5 or 19.5, 150–260 km off, which put three MOL stations in Serbia or in
// the wrong county). places: [{ name, lat, lng, city }] (build-stations.mjs's settlements), may be empty.
const HUNGARY = { south: 45.7, north: 48.6, west: 16.1, east: 22.95 };
const PLACE_REACH_M = 15000; // from a town's or village's point (outlying parts included)
const CITY_REACH_M = 25000; // from a city's (Budapest: 25 km reaches its edges)
function settlements(places) {
  const byName = new Map(places.map(p => [plain(p.name), p]));
  return (city) => byName.get(plain(city)) || null;
}
function coordsProblem(site, place) {
  const { lat, lng } = site;
  if (!(lat >= HUNGARY.south && lat <= HUNGARY.north && lng >= HUNGARY.west && lng <= HUNGARY.east)) return 'Magyarországon kívül';
  const d = place ? distanceM(site, place) : 0;
  if (d > (place?.city ? CITY_REACH_M : PLACE_REACH_M)) return `${Math.round(d / 1000)} km-re a településétől`;
  return null;
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

// A site with sound coordinates is moved to a station of its street this far at most (2026-10-03: the source put the
// two MOLs of Szatymaz, M5 4–5 km from where they are)
const THIRD_PASS_M = 8000;
// Words telling the two sides of a road apart ("M5 autópálya 151 km jobb oldal")
const SIDES = ['bal', 'jobb', 'eszak', 'del', 'kelet', 'nyugat'];

// Pair every priced site with the nearest OpenStreetMap station: same network within 300 m, any within 120 m
function match(sites, stations, places = []) {
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
  const siteOf = {}; // station id -> the priced site, for suspectPrices
  const take = (i, st) => {
    usedSite.add(i);
    byStation[st.id] = sites[i].prices;
    siteOf[st.id] = sites[i];
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

  // Third pass: a site still unmatched goes to the station of its settlement with the same street and network (the
  // street of the station's address among the words of the site's), when that station is the only one there of the
  // network, matched or not, and still free: within THIRD_PASS_M, or anywhere in the settlement when the site's
  // coordinates are broken. Of several (the two MOLs of "M5 autópálya", one each side), the one of the same side.
  // Both ways unique: not when two sites fit one station (Siófok, M7: both sides in the source, one in OSM). `moved`: station id -> the extra's id it had.
  const placeOf = settlements(places);
  const moved = {};
  const problems = new Map(); // site index -> why its coordinates cannot be right
  const third = []; // { i, st }: the one station each site fits
  sites.forEach((site, i) => {
    if (usedSite.has(i)) return;
    const problem = coordsProblem(site, placeOf(site.city));
    if (problem) problems.set(i, problem);
    const brand = BRANDS[site.network] || 'Független';
    const words = new Set(streetWords(site.address));
    let fits = stations.filter(st =>
      st.brand === brand && plain(site.city) && plain(st.city) === plain(site.city) &&
      words.has(streetKey(String(st.address || '').split(',').slice(1).join(',')))
    );
    const side = SIDES.find(w => words.has(w));
    if (fits.length > 1 && side) fits = fits.filter(st => streetWords(st.address).includes(side));
    if (fits.length !== 1 || byStation[fits[0].id] || (!problem && distanceM(site, fits[0]) > THIRD_PASS_M)) return;
    third.push({ i, st: fits[0] });
  });
  for (const { i, st } of third) {
    if (third.filter(t => t.st === st).length > 1) continue;
    take(i, st);
    moved[st.id] = `bk-${sites[i].lat.toFixed(5)}-${sites[i].lng.toFixed(5)}`;
  }

  // Unmatched sites become extras, unless their coordinates cannot be right (not shown: it would mislead)
  const dropped = [];
  const extra = sites
    .map((site, i) => ({ site, i }))
    .filter(({ i }) => !usedSite.has(i))
    .filter(({ site, i }) => !(problems.has(i) && dropped.push(`${site.network} – ${site.city}, ${site.address} (${problems.get(i)})`)))
    .map(({ site }) => {
      const brand = BRANDS[site.network] || 'Független';
      const city = String(site.city || '').trim();
      const id = `bk-${site.lat.toFixed(5)}-${site.lng.toFixed(5)}`;
      siteOf[id] = site;
      return {
        id,
        name: `${brand === 'Független' ? site.network : brand} – ${city}`,
        brand,
        city,
        address: [city, String(site.address || '').trim()].filter(Boolean).join(', '),
        lat: site.lat,
        lng: site.lng,
        prices: site.prices
      };
    });
  return { byStation, brands, extra, siteOf, moved, dropped };
}

// A daily price far from what similar stations ask today is more likely a source error (an old or mistyped price, seen
// 2026-10-03: an Orlen in Budapest at 572 Ft diesel, the network at 707) than a real one, as networks price alike.
// Similar stations: the same network (or, for an independent, the same source network) with at least SUSPECT_MIN
// prices, else the country; motorway stations against the motorway ones (at least SUSPECT_MIN_MOTORWAY), which ask
// 20–60 Ft more and spread more, so a wider margin; one at a city price (an exit station) is fine too. Only 95 and
// diesel: the premium grades and LPG differ much between stations of a network even when correct.
// entries: [{ id, brand, network: source network, text: names and addresses, prices }]
export const SUSPECT_FUELS = ['benzin95', 'diesel'];
export const SUSPECT_FT = 25;
export const SUSPECT_FT_MOTORWAY = 40;
const SUSPECT_MIN = 5;
const SUSPECT_MIN_MOTORWAY = 3;
const MOTORWAY = /\bM\s?\d{1,2}\b|aut[oó]p[aá]ly|pihen[oő]/i; // "M7", "M0 19 kijárat", "autópálya", "Kajáspihenő"
const middle = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export function suspectPrices(entries) {
  const rows = entries.map(e => ({
    ...e,
    motorway: MOTORWAY.test(e.text),
    group: e.brand !== 'Független' ? e.brand : `source:${e.network}`
  }));
  const suspect = {};
  for (const fuel of SUSPECT_FUELS) {
    const city = {};
    const motorway = {};
    for (const r of rows) {
      const p = r.prices[fuel];
      if (!p) continue;
      const by = r.motorway ? motorway : city;
      (by[r.group] ||= []).push(p);
      (by[''] ||= []).push(p); // the country
    }
    const typical = (by, min) => Object.fromEntries(Object.entries(by).filter(([, v]) => v.length >= min).map(([g, v]) => [g, middle(v)]));
    const cityTypical = typical(city, SUSPECT_MIN);
    const motorwayTypical = typical(motorway, SUSPECT_MIN_MOTORWAY);
    for (const r of rows) {
      const p = r.prices[fuel];
      if (!p) continue;
      const own = cityTypical[r.group] != null;
      const cityRef = cityTypical[r.group] ?? cityTypical[''];
      if (cityRef == null || Math.abs(p - cityRef) <= SUSPECT_FT) continue;
      let ref = cityRef;
      let basis = own ? (r.brand === 'Független' ? 'similar' : 'network') : 'country';
      if (r.motorway) {
        const ownMotorway = motorwayTypical[r.group] != null;
        ref = motorwayTypical[r.group] ?? motorwayTypical[''];
        if (ref == null || Math.abs(p - ref) <= SUSPECT_FT_MOTORWAY) continue;
        basis = ownMotorway && r.brand !== 'Független' ? 'motorway' : 'countryMotorway';
      }
      (suspect[r.id] ||= {})[fuel] = { ref: Math.round(ref), basis };
    }
  }
  return suspect;
}

// When each price was first seen at its current value (see the top of the file). A price seen for the first time gets
// this hour; one that had no record yet (the first run with `since`), the start of the record.
// moved: station id -> an earlier id of its prices (an extra matched to that station since), whose record carries over
export function sinceOf(previous, byStation, extra, hour, moved = {}) {
  const trackedFrom = previous?.trackedFrom ?? hour;
  const before = { ...(previous?.stations || {}) };
  for (const e of previous?.extra || []) before[e.id] = e.prices;
  const since = {};
  const record = (id, prices) => {
    for (const [fuel, price] of Object.entries(prices)) {
      const was = before[id] ? id : moved[id];
      const old = before[was]?.[fuel];
      const known = previous?.since?.[was]?.[fuel];
      const at = old !== price ? (old == null && !previous?.trackedFrom ? trackedFrom : hour) : known ?? trackedFrom;
      if (at !== trackedFrom) (since[id] ||= {})[fuel] = at;
    }
  };
  for (const [id, prices] of Object.entries(byStation)) record(id, prices);
  for (const e of extra) record(e.id, e.prices);
  return { since, trackedFrom };
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

  const [sites, stationsFile, placesFile] = await Promise.all([
    soft ? download() : withRetries(download, { log }),
    readJson(STATIONS_FILE),
    readJson(PLACES_FILE)
  ]);
  if (sites.length < 500) throw new Error(`Only ${sites.length} priced stations, keeping the previous prices`);
  const places = (placesFile?.elements || []).map(p => ({ name: p.tags?.name, lat: p.lat, lng: p.lon, city: p.tags?.place === 'city' }));
  if (!places.length) log('Települések nélkül (scripts/.cache/places.json): az új kutak csak országhatárra ellenőrizve.');
  const { byStation, brands, extra, siteOf, moved, dropped } = match(sites, stationsFile.stations, places);
  for (const d of dropped) log(`Kihagyott új kút, hibás koordináta: ${d}`);
  const stationById = new Map(stationsFile.stations.map(st => [st.id, st]));
  const suspect = suspectPrices([
    ...Object.entries(byStation).map(([id, prices]) => {
      const st = stationById.get(id);
      return { id, brand: brands[id] || st.brand, network: siteOf[id].network, text: `${st.name} ${st.address} ${siteOf[id].address}`, prices };
    }),
    ...extra.map(e => ({ id: e.id, brand: e.brand, network: siteOf[e.id].network, text: `${e.name} ${e.address}`, prices: e.prices }))
  ]);

  const averages = {};
  for (const key of Object.values(FUELS)) {
    const values = sites.map(s => s.prices[key]).filter(Boolean);
    if (values.length >= 20) averages[key] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  }

  await fs.mkdir(path.dirname(CHECK_FILE), { recursive: true });
  await fs.writeFile(CHECK_FILE, String(Date.now()));

  const previous = await readJson(OUT_FILE);
  const now = new Date();
  const { since, trackedFrom } = sinceOf(previous, byStation, extra, Math.floor(now.getTime() / 3600e3), moved);
  const sameDay = previous && new Date(previous.checkedAt).toDateString() === now.toDateString();
  const unchanged = previous && JSON.stringify([previous.stations, previous.brands, previous.extra, previous.since, previous.suspect]) === JSON.stringify([byStation, brands, extra, since, suspect]);
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
    extra,
    trackedFrom,
    since,
    suspect
  };
  await fs.writeFile(OUT_FILE, `${JSON.stringify(out)}\n`);
  log(`Kútárak frissítve: ${sites.length} kút (${out.matched} párosítva az OSM-kutakhoz, ${extra.length} új) · átlag 95: ${averages.benzin95} Ft, dízel: ${averages.diesel} Ft · gyanús forrásár: ${Object.keys(suspect).length} kút`);
  return true;
}

// --grace (the data repo's hourly runs): when the source still does not answer after the retries, the run only
// warns (a GitHub annotation, no failure mail) while the last successful check is under GRACE_HOURS old; the
// previous prices stay. An older one, an unknown one, or an error that is not about reaching the source (the page's
// layout changed…) fails the run, so a lasting outage is not missed.
export const GRACE_HOURS = 6;
const PUBLISHED_URL = 'https://szigethymarcell07-afk.github.io/tankolj-arak/prices.json';

// The last successful check (ms): the published prices.json's (build-site.mjs puts every successful check's time
// there), else this file's own `checkedAt` (the time it was written, so no later than the last check)
export async function lastCheckMs({ url = PUBLISHED_URL } = {}) {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const at = Date.parse((await res.json())?.stationPrices?.checkedAt);
    if (res.ok && Number.isFinite(at)) return at;
  } catch {
    // below
  }
  return Date.parse((await readJson(OUT_FILE))?.checkedAt);
}

// Whether a failed run may pass with a warning: { pass, hours } (hours since the last successful check, or NaN)
export function graceFor(err, lastMs, now = Date.now()) {
  const hours = (now - lastMs) / 3600e3;
  return { pass: transient(err) && hours >= 0 && hours < GRACE_HOURS, hours };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateStationPrices({ soft: SOFT }).catch(async err => {
    if (SOFT) {
      console.warn(`Kútár-frissítés kihagyva (${err.message}); a korábbi árak maradnak.`);
      return;
    }
    if (GRACE && transient(err)) {
      const last = await lastCheckMs();
      const { pass, hours } = graceFor(err, last);
      const when = Number.isFinite(hours) ? `${hours.toFixed(1)} órája` : 'ismeretlen ideje';
      if (pass) {
        // The time of the last successful check is published again (build-site.mjs), not this file's older one
        await fs.mkdir(path.dirname(CHECK_FILE), { recursive: true });
        await fs.writeFile(CHECK_FILE, String(last));
        console.log(`::warning title=Kútárak::A forrás most nem érhető el (${err.cause?.code || err.message}); a legutóbbi sikeres ellenőrzés ${when} volt, a korábbi árak maradnak.`);
        return;
      }
      console.error(`A forrás ${GRACE_HOURS} óránál régebben nem érhető el (legutóbbi sikeres ellenőrzés: ${when}).`);
    }
    console.error(err);
    process.exit(1);
  });
}
