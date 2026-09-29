// Builds _site/ for GitHub Pages: the files the TankoljOkosan app downloads at runtime.
//
//   node scripts/build-site.mjs
//
// _site/prices.json = { version, publishedAt, stationsGeneratedAt, stationPrices, priceReference, chargers }
//   stationPrices       per-station pump prices (src/data/stationPrices.json, scripts/update-station-prices.mjs)
//   priceReference      official national averages, fallback (src/data/priceReference.json, scripts/update-prices.mjs)
//   stationsGeneratedAt the station list the prices were matched to; the app compares it with its own
//   publishedAt         when this workflow run finished (the price files only change when a price changes)
//   chargers            { version, generatedAt, osmTimestamp, count, path } of _site/chargers.json: the app downloads
//                       that file (EV charging sites, scripts/build-chargers.mjs, daily) only when it is newer

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
  }
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
