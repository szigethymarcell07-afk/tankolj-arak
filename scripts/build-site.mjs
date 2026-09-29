// Builds _site/ for GitHub Pages: the files the TankoljOkosan app downloads at runtime.
//
//   node scripts/build-site.mjs
//
// _site/prices.json = { version, publishedAt, stationsGeneratedAt, stationPrices, priceReference, chargers, evTariffs }
//   stationPrices       per-station pump prices (src/data/stationPrices.json, scripts/update-station-prices.mjs)
//   priceReference      official national averages, fallback (src/data/priceReference.json, scripts/update-prices.mjs)
//   stationsGeneratedAt the station list the prices were matched to; the app compares it with its own
//   publishedAt         when this workflow run finished (the price files only change when a price changes)
//   chargers            { version, generatedAt, osmTimestamp, count, path } of _site/chargers.json: the app downloads
//                       that file (EV charging sites, scripts/build-chargers.mjs, daily) only when it is newer
//   evTariffs           the EV charging tariffs, src/data/evTariffs.json as is (edited by hand). Left out when the
//                       file has an error (the app keeps the tariffs it has); the run then fails so it gets noticed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'src', 'data');
const OUT = path.join(ROOT, '_site');

const read = async (name) => JSON.parse(await fs.readFile(path.join(DATA, name), 'utf8'));

const [stationPrices, priceReference, stations, chargers] = await Promise.all([
  read('stationPrices.json'),
  read('priceReference.json'),
  read('stations.json'),
  read('chargers.json')
]);
if (!Array.isArray(chargers?.chargers) || !chargers.meta?.generatedAt) throw new Error('Charger file is incomplete');
if (!stationPrices?.stations || !priceReference?.averages) throw new Error('Price files are incomplete');

// The same rules as validEvTariffs in the app (src/data/evTariffs.js): a file the app would reject is not published
const PRICE_KEYS = ['adhoc', 'app', 'member', 'night'];
const isPrice = (v) => (typeof v === 'number' && v > 0) || (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && n > 0));
function tariffErrors(file) {
  const errors = [];
  if (file?.version !== 1) errors.push('"version" must be 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(file?.checked || '')) errors.push('"checked" must be a date like "2026-09-27"');
  if (!file?.networks?.['Egyéb töltő']) errors.push('the "Egyéb töltő" network (fallback) is missing');
  for (const [key, n] of Object.entries(file?.networks || {})) {
    if (typeof n?.abbr !== 'string' || typeof n?.color !== 'string') errors.push(`${key}: "abbr" and "color" are required`);
    if (!Array.isArray(n?.bands)) {
      errors.push(`${key}: "bands" must be a list`);
      continue;
    }
    n.bands.forEach((b, i) => {
      const at = `${key}, band ${i + 1}`;
      if (typeof b?.dc !== 'boolean') errors.push(`${at}: "dc" must be true or false`);
      if (!(b?.upToKw === null || (typeof b?.upToKw === 'number' && b.upToKw > 0))) errors.push(`${at}: "upToKw" must be a number or null`);
      if (!PRICE_KEYS.some(k => b?.[k] != null)) errors.push(`${at}: no price (${PRICE_KEYS.join(', ')})`);
      for (const k of PRICE_KEYS) if (b?.[k] != null && !isPrice(b[k])) errors.push(`${at}: "${k}" must be a number or [min, max]`);
    });
  }
  return errors;
}
let evTariffs = null;
let tariffProblems;
try {
  evTariffs = await read('evTariffs.json');
  tariffProblems = tariffErrors(evTariffs);
} catch (err) {
  tariffProblems = [`cannot be read: ${err.message}`];
}
if (tariffProblems.length) console.error(`src/data/evTariffs.json is not published:\n  ${tariffProblems.join('\n  ')}`);

const prices = {
  version: 1,
  publishedAt: new Date().toISOString(),
  stationsGeneratedAt: stations.meta?.generatedAt ?? null,
  stationPrices,
  priceReference,
  chargers: {
    version: 1,
    generatedAt: chargers.meta.generatedAt,
    osmTimestamp: chargers.meta.osmTimestamp,
    count: chargers.chargers.length,
    path: 'chargers.json'
  },
  ...(tariffProblems.length ? {} : { evTariffs })
};

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'prices.json'), JSON.stringify(prices));
await fs.writeFile(path.join(OUT, 'chargers.json'), JSON.stringify(chargers));
await fs.writeFile(
  path.join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>TankoljOkosan árak</title>
<p>A TankoljOkosan app üzemanyagár-adatai. Fájlok: <a href="prices.json">prices.json</a>, <a href="chargers.json">chargers.json</a>.
Frissítve: ${prices.publishedAt}. Kútárak forrása: ${stationPrices.source}, országos átlag: ${priceReference.source}.</p>\n`
);
console.log(`_site/prices.json: ${stationPrices.count} priced stations (checked ${stationPrices.checkedAt}), averages of ${priceReference.date}`);
console.log(`_site/chargers.json: ${chargers.chargers.length} charging sites (OSM ${chargers.meta.osmTimestamp})`);
if (tariffProblems.length) {
  // The files above are still published (the prices keep flowing); the failed step makes the error visible in Actions
  process.exitCode = 1;
} else {
  console.log(`evTariffs: ${Object.keys(evTariffs.networks).length} networks (checked ${evTariffs.checked})`);
}
