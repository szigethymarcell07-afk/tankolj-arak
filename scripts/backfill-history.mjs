// Fills the price history (history/) from the price files committed so far: every version of
// src/data/stationPrices.json in this repository's git history, and the app's (../benzinkút, optional) from before
// this repository's first one (the app's later ones were written on a development machine, some by older versions of
// the script: mixed in, a station dropped since came and went), in the order they were checked. The versions from
// before the suspect source prices were marked (2026-10-03) take the first marked version's: a price marked there is
// suspect before too while it was the same. (The rule itself, run on them, marked 61 stations instead of 13: it needs
// the source's own names and addresses, which tell the motorway stations; with the station list's, a step of 2 Ft
// that never happened showed in the diesel average.) Run once, before update-history.mjs takes over; it starts the
// history afresh.
//
//   node scripts/backfill-history.mjs [--ref origin/main] [--app ../benzinkút]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSnapshot, emptyHistory, snapshotOf, writeHistory } from './price-history.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const FILE = 'src/data/stationPrices.json';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });

function versions(repo, ref) {
  let hashes;
  try {
    hashes = git(repo, 'log', '--reverse', '--format=%H', ref, '--', FILE).split('\n').filter(Boolean);
  } catch (err) {
    console.warn(`${repo}: no git history (${err.message.split('\n')[0]})`);
    return [];
  }
  return hashes.map(h => {
    try {
      return JSON.parse(git(repo, 'show', `${h}:${FILE}`));
    } catch {
      return null;
    }
  }).filter(f => f?.stations && f.checkedAt);
}

const own = versions(ROOT, arg('--ref', 'HEAD'));
const first = Math.min(...own.map(f => Date.parse(f.checkedAt)));
const earlier = versions(path.resolve(ROOT, arg('--app', '../benzinkút')), 'HEAD').filter(f => Date.parse(f.checkedAt) < first);
const ordered = [...earlier, ...own].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
const stations = JSON.parse(await fs.readFile(path.join(ROOT, 'src', 'data', 'stations.json'), 'utf8'));
const byId = new Map(stations.stations.map(s => [s.id, s]));
const marked = ordered.find(f => f.suspect);
const priceIn = (f, id, fuel) => f.stations[id]?.[fuel] ?? f.extra?.find(e => e.id === id)?.prices[fuel];
for (const f of ordered) {
  if (f.suspect || !marked) continue;
  f.suspect = {};
  for (const [id, fuels] of Object.entries(marked.suspect)) {
    for (const [fuel, m] of Object.entries(fuels)) if (priceIn(f, id, fuel) === priceIn(marked, id, fuel)) (f.suspect[id] ||= {})[fuel] = m;
  }
}

const history = emptyHistory();
for (const f of ordered) addSnapshot(history, snapshotOf(f, byId));
await fs.rm(path.join(ROOT, 'history'), { recursive: true, force: true });
const written = await writeHistory(path.join(ROOT, 'history'), history);
const events = Object.values(history.stations).reduce((a, fuels) => a + Object.values(fuels).reduce((b, l) => b + l.length / 2, 0), 0);
console.log(`Visszatöltve: ${ordered.length} árállapot (${ordered[0]?.checkedAt} – ${ordered[ordered.length - 1]?.checkedAt}), ${history.national.days.length} nap, ${Object.keys(history.stations).length} kút, ${events} árpont; ${written} fájl.`);
