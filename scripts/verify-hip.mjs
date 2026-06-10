import catalog from '../src/data/starCatalog.json' with { type: 'json' };
const stars = catalog.constellations.flatMap((c) =>
  c.stars.map((s) => ({ ...s, constellation: c.iau })),
);
const hips = [...new Set(stars.map((s) => s.hip))];

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

async function fetchHipCatalog() {
  const query = `SELECT HIP, RAhms, DEdms, Vmag FROM "I/239/hip_main" WHERE HIP IN (${hips.join(',')})`;
  const url =
    'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?request=doQuery&lang=adql&format=csv&query=' +
    encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VizieR TAP failed: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  if (lines.length <= 1) {
    console.error('Unexpected VizieR response (first 800 chars):\n', text.slice(0, 800));
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [hip, rahms, dedms, vmag] = parseCsvLine(lines[i]);
    if (!hip || !rahms || !dedms) continue;
    map.set(Number(hip), {
      raHours: parseRaHms(rahms),
      decDeg: parseDecDms(dedms),
      mag: Number(vmag),
    });
  }
  return map;
}

function angularSeparationDeg(ra1, dec1, ra2, dec2) {
  const r1 = (ra1 * 15 * Math.PI) / 180;
  const r2 = (ra2 * 15 * Math.PI) / 180;
  const d1 = (dec1 * Math.PI) / 180;
  const d2 = (dec2 * Math.PI) / 180;
  const cos =
    Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

const hipCatalog = await fetchHipCatalog();
console.log(`Fetched ${hipCatalog.size}/${hips.length} HIP entries from VizieR I/239\n`);

const inspect = process.argv.includes('--inspect');
if (inspect) {
  for (const hip of process.argv.slice(process.argv.indexOf('--inspect') + 1)) {
    const ref = hipCatalog.get(Number(hip));
    console.log(`HIP ${hip}:`, ref ?? 'not found');
  }
  process.exit(0);
}

const problems = [];
for (const star of stars) {
  const ref = hipCatalog.get(star.hip);
  if (!ref) {
    problems.push({ star, issue: 'HIP not found in Hipparcos catalog' });
    continue;
  }
  const sep = angularSeparationDeg(star.raHours, star.decDeg, ref.raHours, ref.decDeg);
  const raDiff = Math.abs(star.raHours - ref.raHours) * 15 * 60; // arcmin
  const decDiff = Math.abs(star.decDeg - ref.decDeg) * 60;
  if (sep > 0.5) {
    problems.push({
      star,
      issue: 'coords mismatch vs HIP catalog',
      catalog: ref,
      sepDeg: sep.toFixed(3),
      raDiffArcmin: raDiff.toFixed(1),
      decDiffArcmin: decDiff.toFixed(1),
    });
  }
}

if (problems.length === 0) {
  console.log('All catalog stars match their HIP coordinates (within 0.5°).');
} else {
  console.log(`Found ${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.log(
      `${p.star.constellation} ${p.star.id} (${p.star.name}) HIP ${p.star.hip}: ${p.issue}`,
    );
    if (p.catalog) {
      console.log(
        `  catalog:  RA ${p.catalog.raHours.toFixed(4)}h Dec ${p.catalog.decDeg.toFixed(3)}° mag ${p.catalog.mag}`,
      );
      console.log(
        `  ours:     RA ${p.star.raHours}h Dec ${p.star.decDeg}° mag ${p.star.mag}`,
      );
      console.log(`  separation: ${p.sepDeg}° (RA Δ${p.raDiffArcmin}' Dec Δ${p.decDiffArcmin}')`);
    }
    console.log();
  }
}

// Check for duplicate HIPs in catalog
const hipCounts = new Map();
for (const star of stars) {
  hipCounts.set(star.hip, (hipCounts.get(star.hip) ?? 0) + 1);
}
const dups = [...hipCounts.entries()].filter(([, n]) => n > 1);
if (dups.length) {
  console.log('Duplicate HIP numbers in catalog:', dups);
}
