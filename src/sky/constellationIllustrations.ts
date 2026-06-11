const illustrationModules = import.meta.glob('../illustrations/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const illustrationBySlug = new Map<string, string>();

for (const path of Object.keys(illustrationModules)) {
  const slug = path.match(/\/([^/]+)\.webp$/)?.[1];
  if (slug) illustrationBySlug.set(slug, illustrationModules[path]);
}

export function constellationIllustrationUrl(name: string): string | undefined {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  return illustrationBySlug.get(slug);
}
