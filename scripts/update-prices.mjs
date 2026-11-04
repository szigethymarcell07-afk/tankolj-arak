// Updates src/data/priceReference.json with the latest official Hungarian average fuel prices.
//
//   node scripts/update-prices.mjs          -> always downloads
//   node scripts/update-prices.mjs --soft   -> skips when the file is recent, never fails (used before dev/build)
//
// Sources (both free to reuse):
//   - European Commission, Weekly Oil Bulletin, "prices with taxes, latest": national average consumer prices
//     (Euro-super 95, automotive diesel, LPG) in EUR per 1000 l, published weekly (prices of Monday)
//   - European Central Bank euro reference rates, to convert EUR to HUF on the bulletin's price date
// Per-station prices are not published as open data in Hungary; see src/data/stationsData.js for the estimates.
//
// Each bulletin week is also kept in history/official-averages.json, a time series that is never cut: one entry per
// price date, added when first seen and only changed when the bulletin itself revises that week (for the learned
// price estimate later, see docs/claude/arbejelentes-es-szerver.md, "Archívum"). Only official public data goes in.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, 'src', 'data', 'priceReference.json');
const HISTORY_FILE = path.join(ROOT, 'history', 'official-averages.json');
const BULLETIN_PAGE = 'https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en';
const BULLETIN_LATEST = 'https://energy.ec.europa.eu/document/download/264c2d0f-f161-4ea3-a777-78faae59bea0_en';
const ECB_RATES = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const HEADERS = { 'User-Agent': 'TankoljOkosan/1.0 (hobby project)' };
const SOFT = process.argv.includes('--soft');
const FRESH_HOURS = 6;

async function download(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Minimal ZIP reader (an .xlsx file is a ZIP of XML files)
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// First worksheet as rows of { column letter: value }
function readSheet(xlsx) {
  const files = unzip(xlsx);
  const shared = files.has('xl/sharedStrings.xml')
    ? [...files.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml(m[1].replace(/<[^>]+>/g, '')))
    : [];
  const sheet = files.get('xl/worksheets/sheet1.xml')?.();
  if (!sheet) throw new Error('No worksheet in the bulletin');
  return [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(([, row]) => {
    const cells = {};
    for (const m of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const value = /<v>([\s\S]*?)<\/v>/.exec(m[3] || '')?.[1];
      if (value === undefined) continue;
      cells[m[1]] = /t="s"/.test(m[2]) ? shared[Number(value)] : decodeXml(value);
    }
    return cells;
  });
}

function parseBulletin(rows) {
  const header = rows.find(r => Object.values(r).some(v => /Euro-super 95/i.test(v)));
  if (!header) throw new Error('Bulletin header not found');
  const col = (re) => Object.keys(header).find(k => re.test(header[k]));
  const cols = { benzin95: col(/Euro-super 95/i), diesel: col(/Automotive gas oil/i), lpg: col(/LPG/i) };
  if (!cols.benzin95 || !cols.diesel) throw new Error('Bulletin columns not found');
  // The price date is an Excel serial number under the "in EUR" header cell
  const serial = Number(rows[rows.indexOf(header) + 1]?.A);
  if (!serial) throw new Error('Bulletin date not found');
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
  const hu = rows.find(r => /^Hungary$/i.test(String(r.A).trim()));
  if (!hu) throw new Error('Hungary not in the bulletin');
  const eurPerLitre = {};
  const eurPer1000l = {};
  for (const [key, c] of Object.entries(cols)) {
    const v = Number(hu[c]);
    if (c && v > 0) {
      eurPerLitre[key] = v / 1000;
      eurPer1000l[key] = v;
    }
  }
  return { date, eurPerLitre, eurPer1000l };
}

// EUR/HUF on the given day, or the last working day before it
function eurHufOn(xml, date) {
  const days = [...xml.matchAll(/<Cube time="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Cube>/g)]
    .map(([, time, body]) => ({ time, rate: Number(/currency=["']HUF["'] rate=["']([\d.]+)["']/.exec(body)?.[1]) }))
    .filter(d => d.rate)
    .sort((a, b) => (a.time < b.time ? 1 : -1));
  const hit = days.find(d => d.time <= date) || days[days.length - 1];
  if (!hit) throw new Error('No EUR/HUF rate');
  return hit;
}

// Adds the week to the time series, or updates it when the bulletin revised it; the file is only rewritten on a change
async function recordWeek(out, eurPer1000l) {
  let history = { weeks: [] };
  try {
    history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // a broken file is not replaced by a new, shorter one
  }
  const week = { date: out.date, averages: out.averages, eurPer1000l, eurHuf: out.eurHuf, eurHufDate: out.eurHufDate };
  const old = history.weeks.find(w => w.date === out.date);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // a week filled in from the git history has no EUR prices yet (eurPer1000l: null): adding them is no revision
  const revised = old && (!same(old.averages, week.averages) || old.eurHuf !== week.eurHuf || (old.eurPer1000l && !same(old.eurPer1000l, eurPer1000l)));
  if (old && !revised && same(old.eurPer1000l, eurPer1000l)) return;
  const entry = old
    ? { ...old, ...week, ...(revised ? { revisedAt: out.fetchedAt } : {}) }
    : { ...week, firstSeenAt: out.fetchedAt };
  const weeks = [...history.weeks.filter(w => w.date !== out.date), entry].sort((a, b) => (a.date < b.date ? -1 : 1));
  const file = {
    about: 'Hivatalos magyar országos átlagárak hetente (Ft/l; a közlöny hétfői árai), az EKB EUR/HUF árfolyamával átszámítva. Nem írjuk felül: hetente egy bejegyzés.',
    source: out.source,
    sourceUrl: out.sourceUrl,
    updatedAt: out.fetchedAt,
    weeks
  };
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Idősor: ${old ? 'javított hét' : 'új hét'} (${out.date}), összesen ${weeks.length} hét`);
}

async function main() {
  if (SOFT) {
    try {
      const current = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
      if (Date.now() - Date.parse(current.fetchedAt) < FRESH_HOURS * 3600000) return;
    } catch (e) {
      // no file yet
    }
  }

  const [xlsx, ecb] = await Promise.all([download(BULLETIN_LATEST), download(ECB_RATES)]);
  const { date, eurPerLitre, eurPer1000l } = parseBulletin(readSheet(xlsx));
  const fx = eurHufOn(ecb.toString('utf8'), date);
  const averages = Object.fromEntries(Object.entries(eurPerLitre).map(([k, eur]) => [k, Math.round(eur * fx.rate)]));
  if (!(averages.benzin95 > 300 && averages.benzin95 < 1500 && averages.diesel > 300 && averages.diesel < 1500)) {
    throw new Error(`Implausible prices: ${JSON.stringify(averages)}`);
  }

  const out = {
    date,
    fetchedAt: new Date().toISOString(),
    source: 'Európai Bizottság – Weekly Oil Bulletin (fogyasztói árak adókkal), EKB-árfolyam',
    sourceUrl: BULLETIN_PAGE,
    eurHuf: fx.rate,
    eurHufDate: fx.time,
    averages
  };
  await fs.writeFile(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  await recordWeek(out, eurPer1000l);
  console.log(`Országos átlagárak (${date}): 95: ${averages.benzin95} Ft, dízel: ${averages.diesel} Ft, LPG: ${averages.lpg ?? '—'} Ft (1 EUR = ${fx.rate} HUF, ${fx.time})`);
}

main().catch(err => {
  if (SOFT) {
    console.warn(`Árfrissítés kihagyva (${err.message}); a korábbi árak maradnak.`);
  } else {
    console.error(err);
    process.exit(1);
  }
});
