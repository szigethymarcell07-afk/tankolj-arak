// Adds the current prices (src/data/stationPrices.json) to the price history (history/, see price-history.mjs).
// Runs after every price update (the workflow's "Ártörténet" step); writes only the files that changed.
//
//   node scripts/update-history.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSnapshot, readHistory, snapshotOf, writeHistory } from './price-history.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'history');
const read = async (name) => JSON.parse(await fs.readFile(path.join(ROOT, 'src', 'data', name), 'utf8'));

const [file, stations] = await Promise.all([read('stationPrices.json'), read('stations.json')]);
if (!file?.stations) throw new Error('src/data/stationPrices.json is incomplete');
// the price file is rewritten only when a price changes (or its UTC day starts): the time of this run's check counts
const checkedMs = Number(await fs.readFile(path.join(ROOT, 'node_modules', '.cache', 'station-prices-checked'), 'utf8').catch(() => 0));
const at = Math.max(Date.parse(file.checkedAt), checkedMs || 0);
const history = await readHistory(DIR);
const last = history.national.updatedAt ? Date.parse(history.national.updatedAt) : 0;
if (at < last) {
  console.log(`Ártörténet: a kútárak (${new Date(at).toISOString()}) nem újabbak a történetnél (${history.national.updatedAt}).`);
} else {
  const changed = addSnapshot(history, snapshotOf(file, new Map(stations.stations.map(s => [s.id, s])), at));
  const written = changed ? await writeHistory(DIR, history) : 0;
  const n = history.national;
  const i = n.days.length - 1;
  console.log(`Ártörténet: ${n.days.length} nap (${n.from} óta), ma 95: ${n.fuels.benzin95.avg[i]} Ft (${n.fuels.benzin95.n[i]} kút), dízel: ${n.fuels.diesel.avg[i]} Ft; ${written} fájl írva.`);
}
