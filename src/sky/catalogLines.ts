import constellationsData from '../data/contellations.json';

export interface CatalogStarWithHip {
  id: string;
  hip: number;
}

interface ConstellationEntry {
  iau?: string;
  lines?: (number | string)[][];
}

const linesByIau = new Map<string, number[][]>();
for (const entry of (constellationsData as { constellations: ConstellationEntry[] }).constellations) {
  if (!entry.iau || !entry.lines) continue;
  linesByIau.set(entry.iau, parsePolylines(entry.lines));
}

function parsePolylines(rawLines: (number | string)[][]): number[][] {
  const polylines: number[][] = [];
  for (const entry of rawLines) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    const hips = entry.filter((value): value is number => typeof value === 'number');
    if (hips.length >= 2) polylines.push(hips);
  }
  return polylines;
}

/** Derive line pairs from contellations.json polylines for stars in the catalog. */
export function deriveConstellationLines(
  iau: string,
  stars: CatalogStarWithHip[],
): string[][] {
  const polylines = linesByIau.get(iau);
  if (!polylines) return [];

  const hipToId = new Map(stars.map((star) => [star.hip, star.id]));
  const edges = new Map<string, string[]>();

  for (const polyline of polylines) {
    for (let i = 0; i < polyline.length - 1; i++) {
      const fromId = hipToId.get(polyline[i]);
      const toId = hipToId.get(polyline[i + 1]);
      if (!fromId || !toId || fromId === toId) continue;

      const key = fromId < toId ? `${fromId}:${toId}` : `${toId}:${fromId}`;
      edges.set(key, [fromId, toId]);
    }
  }

  return [...edges.values()];
}
