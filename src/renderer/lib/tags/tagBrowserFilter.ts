/**
 * Tags Browser helpers: the text filter over tag rows, and every tag's file
 * and tile counts in one pass.
 */

function fold(s: string): string {
  return s.toLocaleLowerCase('en-US');
}

/**
 * The names whose full path contains `query` (case-insensitive, so `proj`
 * matches `work/project`), plus any listed parent of one (`work` for
 * `work/project`), so the hierarchy still reads. Keeps the input order. An
 * empty query keeps everything.
 */
export function filterTagNames(names: readonly string[], query: string): string[] {
  const q = fold(query.trim().replace(/^#/, ''));
  if (!q) return names.slice();
  const keep = new Set<string>();
  for (const name of names) {
    if (!fold(name).includes(q)) continue;
    keep.add(name);
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) keep.add(name.slice(0, i));
  }
  return names.filter((n) => keep.has(n));
}

export interface TagCounts {
  files: number;
  tiles: number;
}

/** How many files and tiles carry each tag (exact name), counted once per carrier. */
export function countTagUsage(
  files: Iterable<{ tags: readonly string[] }>,
  tiles: Iterable<{ tags: readonly string[] }>,
): Map<string, TagCounts> {
  const out = new Map<string, TagCounts>();
  const entry = (tag: string): TagCounts => {
    let e = out.get(tag);
    if (!e) {
      e = { files: 0, tiles: 0 };
      out.set(tag, e);
    }
    return e;
  };
  for (const f of files) for (const t of new Set(f.tags)) entry(t).files++;
  for (const tile of tiles) for (const t of new Set(tile.tags)) entry(t).tiles++;
  return out;
}
