/**
 * Add constellation(s) to starCatalog.json from HIP lists + VizieR + Stellarium name.fab.
 * Usage: node scripts/add-constellations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../src/data/starCatalog.json');
const nameFabUrl =
  'https://raw.githubusercontent.com/Stellarium/stellarium/refs/heads/master/stars/hip_gaia3/name.fab';

const TO_ADD = [
  {
    id: 'cma',
    iau: 'CMa',
    name: 'Canis Major',
    hips: [30122, 30324, 31416, 31592, 32349, 33152, 33160, 33347, 33579, 33856, 34444],
  },
  {
    id: 'lyr',
    iau: 'Lyr',
    name: 'Lyra',
    hips: [91262, 91971, 92420, 92791, 93194],
  },
  {
    id: 'sco',
    iau: 'Sco',
    name: 'Scorpius',
    hips: [78401, 78265, 80763, 78820, 81266, 82396, 82514, 82671, 84143, 85927, 86228, 86670, 87073],
  },
];

const PROPER_NAMES = {
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
  return Math.round((h + m / 60 + s / 3600) * 1000) / 1000;
}

function parseDecDms(dedms) {
  const sign = dedms.startsWith('-') ? -1 : 1;
  const parts = dedms.replace(/^[+-]/, '').trim().split(/\s+/).map(Number);
  const [d, m, s] = parts;
  return Math.round(sign * (d + m / 60 + s / 3600) * 1000) / 1000;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function displayNameFromFab(label) {
  const [left, con] = label.split('_');
  const greek = {
    α: 'Alpha', β: 'Beta', γ: 'Gamma', δ: 'Delta', ε: 'Epsilon', ζ: 'Zeta', η: 'Eta',
    θ: 'Theta', ι: 'Iota', κ: 'Kappa', λ: 'Lambda', μ: 'Mu', ν: 'Nu', ξ: 'Xi', ο: 'Omicron',
    π: 'Pi', ρ: 'Rho', σ: 'Sigma', τ: 'Tau', υ: 'Upsilon', φ: 'Phi', χ: 'Chi', ψ: 'Psi', ω: 'Omega',
  };
  if (/^\d+$/.test(left)) return `${left} ${con}`;
  if (left.length === 1 && greek[left]) {
    return /^\d/.test(con ?? '') ? `${greek[left]}${con}` : `${greek[left]} ${con}`;
  }
  return `${left} ${con}`;
}

function pickFabName(entries, iau) {
  const pool = entries.filter((e) => e.endsWith(`_${iau}`));
  const list = pool.length ? pool : entries;
  const bayer = list.find((e) => /^[αβγδεζηθικλμνξοπρστυφχψω]/u.test(e));
  if (bayer) return displayNameFromFab(bayer);
  const flam = list.find((e) => /^\d+_/.test(e));
  if (flam) return displayNameFromFab(flam);
  return displayNameFromFab(list[0]);
}

async function fetchNameFab() {
  const res = await fetch(nameFabUrl);
  const byHip = new Map();
  for (const line of (await res.text()).split('\n')) {
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
  const query = `SELECT HIP, RAhms, DEdms, Vmag FROM "I/239/hip_main" WHERE HIP IN (${hipList.join(',')})`;
  const url =
    'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?request=doQuery&lang=adql&format=csv&query=' +
    encodeURIComponent(query);
  const res = await fetch(url);
  const lines = (await res.text()).trim().split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [hip, rahms, dedms, vmag] = parseCsvLine(lines[i]);
    map.set(Number(hip), {
      raHours: parseRaHms(rahms),
      decDeg: parseDecDms(dedms),
      mag: Math.round(Number(vmag) * 1000) / 1000,
    });
  }
  return map;
}

function buildStars(hips, iau, nameFab, hipData) {
  const usedIds = new Set();
  const stars = [];
  for (const hip of [...hips].sort((a, b) => a - b)) {
    const coords = hipData.get(hip);
    if (!coords) {
      console.warn(`Missing Hipparcos entry for HIP ${hip}`);
      continue;
    }
    const name = PROPER_NAMES[hip] ?? pickFabName(nameFab.get(hip) ?? [], iau);
    let id = slugify(name);
    if (!id || usedIds.has(id)) id = `hip_${hip}`;
    usedIds.add(id);
    stars.push({ id, name, hip, ...coords });
    console.log(`+ ${iau} ${name} (HIP ${hip})`);
  }
  return stars;
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const nameFab = await fetchNameFab();
const allHips = [...new Set(TO_ADD.flatMap((c) => c.hips))];
const hipData = await fetchHipData(allHips);

for (const con of TO_ADD) {
  if (catalog.constellations.some((c) => c.iau === con.iau)) {
    console.warn(`Skipping ${con.iau}: already in catalog`);
    continue;
  }
  const stars = buildStars(con.hips, con.iau, nameFab, hipData);
  catalog.constellations.push({
    id: con.id,
    iau: con.iau,
    name: con.name,
    stars,
  });
  console.log(`Added ${con.name} (${stars.length} stars)\n`);
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Catalog now has ${catalog.constellations.length} constellations`);
