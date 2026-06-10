/**
 * Add stars referenced in contellations.json polylines but missing from starCatalog.json.
 *
 * Data sources:
 * - Coordinates/magnitude: Hipparcos catalog via VizieR TAP (I/239/hip_main)
 * - Names: Stellarium stars/hip_gaia3/name.fab (same project as constellations.json)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'src/data/starCatalog.json');
const constellationsPath = join(root, 'src/data/constellations.json');
const nameFabUrl =
  'https://raw.githubusercontent.com/Stellarium/stellarium/refs/heads/master/stars/hip_gaia3/name.fab';

const GREEK = {
  alf: 'Alpha',
  bet: 'Beta',
  gam: 'Gamma',
  del: 'Delta',
  eps: 'Epsilon',
  zet: 'Zeta',
  eta: 'Eta',
  tet: 'Theta',
  iot: 'Iota',
  kap: 'Kappa',
  lam: 'Lambda',
  mu: 'Mu',
  nu: 'Nu',
  xi: 'Xi',
  omi: 'Omicron',
  pi: 'Pi',
  rho: 'Rho',
  sig: 'Sigma',
  tau: 'Tau',
  ups: 'Upsilon',
  phi: 'Phi',
  chi: 'Chi',
  psi: 'Psi',
  ome: 'Omega',
};

const PROPER_NAMES = {
  26207: 'Meissa',
  36850: 'Castor',
  37826: 'Pollux',
  4889: 'Alpherg',
  7097: 'Fum al Samakah',
  8198: 'Alrescha',
  87072: 'Kaus Borealis',
  88635: 'Kaus Media',
  89642: 'Kaus Australis',
  90185: 'Nunki',
  92855: 'Ascella',
  95294: 'Alnasl',
  30324: 'Mirzam',
  31592: 'Adhara',
  32349: 'Sirius',
  33579: 'Wezen',
  80763: 'Antares',
  85927: 'Shaula',
  86670: 'Sargas',
  91262: 'Vega',
};

function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

function parseRaHms(rahms) {
  const [h, m, s] = rahms.trim().split(/\s+/).map(Number);
  return h + m / 60 + s / 3600;
}

function parseDecDms(dedms) {
  const sign = dedms.startsWith('-') ? -1 : 1;
  const parts = dedms.replace(/^[+-]/, '').trim().split(/\s+/).map(Number);
  const [d, m, s] = parts;
  return sign * (d + m / 60 + s / 3600);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function displayNameFromFab(label) {
  const [left, con] = label.split('_');
  if (/^\d+$/.test(left)) return `${left} ${con}`;
  if (left.length === 1 && 'αβγδεζηθικλμνξοπρστυφχψω'.includes(left)) {
    // Unicode Greek in name.fab
    const greekNames = {
      α: 'Alpha',
      β: 'Beta',
      γ: 'Gamma',
      δ: 'Delta',
      ε: 'Epsilon',
      ζ: 'Zeta',
      η: 'Eta',
      θ: 'Theta',
      ι: 'Iota',
      κ: 'Kappa',
      λ: 'Lambda',
      μ: 'Mu',
      ν: 'Nu',
      ξ: 'Xi',
      ο: 'Omicron',
      π: 'Pi',
      ρ: 'Rho',
      σ: 'Sigma',
      τ: 'Tau',
      υ: 'Upsilon',
      φ: 'Phi',
      χ: 'Chi',
      ψ: 'Psi',
      ω: 'Omega',
    };
    const prefix = greekNames[left] ?? left;
    const suffix = /^\d$/.test(con?.[0] ?? '') ? con : con;
    return `${prefix}${suffix && /^\d/.test(con) ? con : ` ${con}`}`.trim();
  }
  const prefix = GREEK[left] ?? left;
  if (/^\d/.test(con ?? '')) return `${prefix}${con}`;
  return `${prefix} ${con}`;
}

function pickFabName(entries, iau) {
  const forConstellation = entries.filter((entry) => entry.endsWith(`_${iau}`));
  const pool = forConstellation.length ? forConstellation : entries;
  const bayer = pool.find((entry) => /^[αβγδεζηθικλμνξοπρστυφχψω]/u.test(entry));
  if (bayer) return displayNameFromFab(bayer);
  const flam = pool.find((entry) => /^\d+_/.test(entry));
  if (flam) return displayNameFromFab(flam);
  return displayNameFromFab(pool[0]);
}

async function fetchNameFab() {
  const res = await fetch(nameFabUrl);
  if (!res.ok) throw new Error(`Failed to fetch name.fab: ${res.status}`);
  const text = await res.text();
  const byHip = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [hipRaw, label] = line.trim().split('|');
    const hip = Number(hipRaw);
    if (!hip || !label) continue;
    const list = byHip.get(hip) ?? [];
    list.push(label);
    byHip.set(hip, list);
  }
  return byHip;
}

async function fetchHipData(hipList) {
  if (!hipList.length) return new Map();
  const query = `SELECT HIP, RAhms, DEdms, Vmag FROM "I/239/hip_main" WHERE HIP IN (${hipList.join(',')})`;
  const url =
    'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?request=doQuery&lang=adql&format=csv&query=' +
    encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VizieR TAP failed: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [hip, rahms, dedms, vmag] = parseCsvLine(lines[i]);
    map.set(Number(hip), {
      raHours: round3(parseRaHms(rahms)),
      decDeg: round3(parseDecDms(dedms)),
      mag: round3(Number(vmag)),
    });
  }
  return map;
}

function lineHipsForIau(constellationsData, iau) {
  const entry = constellationsData.constellations.find((c) => c.iau === iau);
  const hips = new Set();
  for (const line of entry?.lines ?? []) {
    for (const value of line) {
      if (typeof value === 'number') hips.add(value);
    }
  }
  return hips;
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const constellationsData = JSON.parse(readFileSync(constellationsPath, 'utf8'));
const nameFab = await fetchNameFab();

let added = 0;
for (const constellation of catalog.constellations) {
  const catalogHips = new Set(constellation.stars.map((star) => star.hip));
  const neededHips = [...lineHipsForIau(constellationsData, constellation.iau)]
    .filter((hip) => !catalogHips.has(hip))
    .sort((a, b) => a - b);

  if (!neededHips.length) continue;

  const hipData = await fetchHipData(neededHips);
  const usedIds = new Set(constellation.stars.map((star) => star.id));

  for (const hip of neededHips) {
    const coords = hipData.get(hip);
    if (!coords) {
      console.warn(`Skipping HIP ${hip}: not found in Hipparcos`);
      continue;
    }

    const fabEntries = nameFab.get(hip) ?? [];
    const proper = PROPER_NAMES[hip];
    const name =
      proper ??
      (fabEntries.length ? pickFabName(fabEntries, constellation.iau) : `HIP ${hip}`);

    let id = slugify(name);
    if (!id || usedIds.has(id)) id = `hip_${hip}`;
    while (usedIds.has(id)) id = `hip_${hip}`;

    constellation.stars.push({
      id,
      name,
      hip,
      raHours: coords.raHours,
      decDeg: coords.decDeg,
      mag: coords.mag,
    });
    usedIds.add(id);
    catalogHips.add(hip);
    added++;
    console.log(`+ ${constellation.iau} ${name} (HIP ${hip})`);
  }

  constellation.stars.sort((a, b) => a.hip - b.hip);
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`\nAdded ${added} star(s) to starCatalog.json`);
