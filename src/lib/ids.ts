/** Prefixed, sortable-enough IDs, e.g. "haz_m3k9x2_4f1a9c0b". */
export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
