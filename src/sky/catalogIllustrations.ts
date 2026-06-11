import constellationsData from '../data/contellations.json';

export interface IllustrationAnchor {
  pos: [number, number];
  hip: number;
}

export interface IllustrationMetadata {
  size: [number, number];
  anchors: IllustrationAnchor[];
}

interface ConstellationEntry {
  iau?: string;
  image?: {
    size: [number, number];
    anchors: IllustrationAnchor[];
  };
}

const metadataByIau = new Map<string, IllustrationMetadata>();

for (const entry of (constellationsData as { constellations: ConstellationEntry[] }).constellations) {
  if (!entry.iau || !entry.image?.anchors?.length) continue;
  metadataByIau.set(entry.iau, {
    size: entry.image.size,
    anchors: entry.image.anchors,
  });
}

export function getIllustrationMetadata(iau: string): IllustrationMetadata | undefined {
  return metadataByIau.get(iau);
}
