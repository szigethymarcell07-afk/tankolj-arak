// Price history (2026-10-08, the user's request: a line chart of how prices moved): the national daily average per
// fuel, and per station only its price changes. Built from src/data/stationPrices.json, run after every price update
// (update-history.mjs); the past filled in once from this repository's git history (backfill-history.mjs).
//
// history/national.json  { version, from, updatedAt, days: ["2026-09-28", …], fuels: { [fuel]: { avg: [], n: [] } } }
//   One value per Budapest calendar day: the average of the daily station prices at the day's last update (today's
//   moves with every run). Left out: suspect source prices (stationPrices.suspect), prices that look out of date (the
//   app's "elavult?": most of the station's network changed that price at least 12 hours later), estimates (not in the
//   source) and the users' reported prices (not in this repository). avg in Ft with one decimal, n the stations
//   counted; null where no update ran that day.
// history/stations/NN.json  (SHARDS files; a station's file: shardOf(id), the same function as the app's
//   src/data/priceHistory.js) { version, shard, shards, stations: { [id]: { [fuel]: [h0, p0, dh1, p1, …] } } }
//   (no time stamp of their own: a file is rewritten only when one of its stations changed)
//   Each fuel a flat list of its changes: the unix hour the price was first seen (the first absolute, then the hours
//   since the previous change) and the price in whole forints as the app shows it; negative: a suspect source price;
//   0: no daily price from then on. One station per line, so a day's changes are small diffs in git.
import fs from 'node:fs/promises';
import path from 'node:path';

export const FUELS = ['benzin95', 'diesel', 'lpg', 'premium95', 'premiumDiesel', 'adblue'];
export const SHARDS = 32;
// FNV-1a over the id's UTF-16 code units: the same in the app (src/data/priceHistory.js shardOf)
export function shardOf(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SHARDS;
}

// The app's "elavult?" rule (src/data/stationsData.js staleness): keep in sync
const STALE_SHARE = 0.6;
const STALE_GAP_H = 12;
const STALE_MIN = 5;

export const budapestDay = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
const hourOf = (ms) => Math.floor(ms / 3600e3);
const round1 = (v) => Math.round(v * 10) / 10;

// One state of the price file: { at (ms), hour, prices: { [id]: { [fuel]: price } }, brand: { [id]: brand },
// suspect: { [id]: { [fuel]: true } }, since: { [id]: { [fuel]: hour } } | null }
// stationsById: the OSM station list (src/data/stations.json) for the brands; the source's brands for independent
// ones and its own extra stations as in the app (stationsData.js applyPrices)
export function snapshotOf(file, stationsById, at = Date.parse(file.checkedAt)) {
  const prices = {};
  const brand = {};
  for (const [id, p] of Object.entries(file.stations || {})) {
    prices[id] = p;
    brand[id] = file.brands?.[id] || stationsById.get(id)?.brand || 'Független';
  }
  for (const e of file.extra || []) {
    prices[e.id] = e.prices;
    brand[e.id] = e.brand || 'Független';
  }
  const suspect = {};
  for (const [id, fuels] of Object.entries(file.suspect || {})) suspect[id] = Object.fromEntries(Object.keys(fuels).map(f => [f, true]));
  return { at, hour: hourOf(at), prices, brand, suspect, since: file.since ? { trackedFrom: file.trackedFrom, ...file.since } : null };
}

// "elavult?" flags of a state: { [id]: { [fuel]: true } }. sinceOf(id, fuel): the hour the price was first seen at its
// value (or the start of the record)
function staleFlags(snap, sinceOf) {
  const byNetwork = {};
  for (const [id, p] of Object.entries(snap.prices)) {
    const b = snap.brand[id];
    if (b === 'Független') continue;
    for (const fuel of Object.keys(p)) ((byNetwork[fuel] ||= {})[b] ||= []).push(sinceOf(id, fuel));
  }
  for (const nets of Object.values(byNetwork)) for (const v of Object.values(nets)) v.sort((a, b) => a - b);
  const stale = {};
  for (const [id, p] of Object.entries(snap.prices)) {
    for (const fuel of Object.keys(p)) {
      const v = byNetwork[fuel]?.[snap.brand[id]];
      if (!v || v.length < STALE_MIN) continue;
      const own = sinceOf(id, fuel);
      const i = v.findIndex(h => h > own + STALE_GAP_H);
      if (i >= 0 && (v.length - i) / v.length >= STALE_SHARE) (stale[id] ||= {})[fuel] = true;
    }
  }
  return stale;
}

// The national average of a state: { [fuel]: { avg, n } }
export function nationalOf(snap, sinceOf) {
  const stale = staleFlags(snap, sinceOf);
  const out = {};
  for (const fuel of FUELS) {
    let sum = 0;
    let n = 0;
    for (const [id, p] of Object.entries(snap.prices)) {
      const v = p[fuel];
      if (!(v > 0) || snap.suspect[id]?.[fuel] || stale[id]?.[fuel]) continue;
      sum += v;
      n++;
    }
    out[fuel] = n ? { avg: round1(sum / n), n } : { avg: null, n: 0 };
  }
  return out;
}

export function emptyHistory() {
  return { national: { version: 1, from: null, updatedAt: null, days: [], fuels: Object.fromEntries(FUELS.map(f => [f, { avg: [], n: [] }])) }, stations: {} };
}

// The changes of a station's fuel as [[hour, price], …] (decoded) and back
export function decode(list) {
  const out = [];
  let h = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    h = i === 0 ? list[0] : h + list[i];
    out.push([h, list[i + 1]]);
  }
  return out;
}
function encode(events) {
  const out = [];
  events.forEach(([h, p], i) => out.push(i === 0 ? h : h - events[i - 1][0], p));
  return out;
}

// Adds one state of the price file (states in time order). Returns whether anything changed.
export function addSnapshot(history, snap) {
  const { national, stations } = history;
  let changed = false;
  const last = (id, fuel) => {
    const list = stations[id]?.[fuel];
    if (!list?.length) return null;
    const ev = decode(list);
    return ev[ev.length - 1];
  };
  // the hour each price was first seen at its value: the price file's own record when it has one, else the history's
  const startHour = national.fromHour ?? snap.hour;
  const sinceOf = (id, fuel) => snap.since?.[id]?.[fuel] ?? (snap.since ? snap.since.trackedFrom : null) ?? last(id, fuel)?.[0] ?? startHour;

  // stations: an event where the shown price (whole forints, negative when suspect) differs from the last one
  const seen = new Set();
  for (const [id, p] of Object.entries(snap.prices)) {
    seen.add(id);
    for (const [fuel, raw] of Object.entries(p)) {
      if (!FUELS.includes(fuel) || !(raw > 0)) continue;
      const price = Math.round(raw) * (snap.suspect[id]?.[fuel] ? -1 : 1);
      const prev = last(id, fuel);
      if (prev && prev[1] === price) continue;
      // first seen at this value (the price file's record), not before the previous change nor after this state
      let h = snap.since?.[id]?.[fuel] ?? snap.hour;
      if (prev) h = Math.max(h, prev[0] + 1);
      h = Math.min(h, snap.hour);
      if (!prev && national.fromHour != null) h = Math.max(h, national.fromHour);
      const ev = prev ? [...decode(stations[id][fuel]), [h, price]] : [[h, price]];
      ((stations[id] ||= {})[fuel] = encode(ev));
      changed = true;
    }
  }
  // a daily price gone (the station without one now, or a fuel no longer listed): 0 from here
  for (const [id, fuels] of Object.entries(stations)) {
    for (const fuel of Object.keys(fuels)) {
      const prev = last(id, fuel);
      if (!prev || prev[1] === 0 || (seen.has(id) && snap.prices[id][fuel] > 0)) continue;
      fuels[fuel] = encode([...decode(fuels[fuel]), [Math.max(snap.hour, prev[0] + 1), 0]]);
      changed = true;
    }
  }

  // national: this state's average is the day's value so far (a later state of the same day replaces it)
  const day = budapestDay(snap.at);
  if (national.from == null) {
    national.from = day;
    national.fromHour = snap.hour;
  }
  const values = nationalOf(snap, sinceOf);
  let i = national.days.indexOf(day);
  if (i < 0) {
    // days with no update at all in between: no value
    const lastDay = national.days[national.days.length - 1];
    if (lastDay) {
      for (let d = nextDay(lastDay); d < day; d = nextDay(d)) {
        national.days.push(d);
        for (const f of FUELS) {
          national.fuels[f].avg.push(null);
          national.fuels[f].n.push(0);
        }
      }
    }
    national.days.push(day);
    for (const f of FUELS) {
      national.fuels[f].avg.push(null);
      national.fuels[f].n.push(0);
    }
    i = national.days.length - 1;
    changed = true;
  }
  for (const f of FUELS) {
    if (national.fuels[f].avg[i] !== values[f].avg || national.fuels[f].n[i] !== values[f].n) changed = true;
    national.fuels[f].avg[i] = values[f].avg;
    national.fuels[f].n[i] = values[f].n;
  }
  if (changed) national.updatedAt = new Date(snap.at).toISOString();
  return changed;
}
const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);

// Reading and writing history/ (dir: the repository's history folder)
export async function readHistory(dir) {
  const h = emptyHistory();
  try {
    Object.assign(h.national, JSON.parse(await fs.readFile(path.join(dir, 'national.json'), 'utf8')));
  } catch {
    return h; // no history yet
  }
  for (let s = 0; s < SHARDS; s++) {
    try {
      const file = JSON.parse(await fs.readFile(path.join(dir, 'stations', `${String(s).padStart(2, '0')}.json`), 'utf8'));
      Object.assign(h.stations, file.stations);
    } catch {
      // a shard not written yet
    }
  }
  return h;
}

// Writes only the files whose content changed; returns their number
export async function writeHistory(dir, history) {
  await fs.mkdir(path.join(dir, 'stations'), { recursive: true });
  const files = [['national.json', nationalText(history.national)]];
  const shards = Array.from({ length: SHARDS }, () => []);
  for (const id of Object.keys(history.stations).sort()) shards[shardOf(id)].push(id);
  shards.forEach((ids, s) => {
    const lines = ids.map(id => `${JSON.stringify(id)}:${JSON.stringify(history.stations[id])}`);
    files.push([path.join('stations', `${String(s).padStart(2, '0')}.json`),
      `{"version":1,"shard":${s},"shards":${SHARDS},"stations":{\n${lines.join(',\n')}\n}}\n`]);
  });
  let written = 0;
  for (const [name, text] of files) {
    const file = path.join(dir, name);
    const old = await fs.readFile(file, 'utf8').catch(() => null);
    if (old === text) continue;
    await fs.writeFile(file, text);
    written++;
  }
  return written;
}
function nationalText(n) {
  const fuels = FUELS.map(f => `${JSON.stringify(f)}:${JSON.stringify(n.fuels[f])}`).join(',\n');
  return `{"version":1,"from":${JSON.stringify(n.from)},"fromHour":${n.fromHour},"updatedAt":${JSON.stringify(n.updatedAt)},\n"days":${JSON.stringify(n.days)},\n"fuels":{\n${fuels}\n}}\n`;
}
