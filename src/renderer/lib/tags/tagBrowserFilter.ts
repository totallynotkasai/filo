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
  /** Carriers per exact spelling (`Project` 3, `project` 1). */
  spellings: Map<string, number>;
}

/**
 * How many files and tiles carry each tag, counted once per carrier. Keyed by
 * the case-folded name, since `Project` and `project` are one tag everywhere
 * else (rename, delete, filters).
 */
export function countTagUsage(
  files: Iterable<{ tags: readonly string[] }>,
  tiles: Iterable<{ tags: readonly string[] }>,
): Map<string, TagCounts> {
  const out = new Map<string, TagCounts>();
  const tally = (carriers: Iterable<{ tags: readonly string[] }>, field: 'files' | 'tiles'): void => {
    for (const carrier of carriers) {
      const seen = new Set<string>();
      for (const tag of carrier.tags) {
        const key = fold(tag);
        let e = out.get(key);
        if (!e) {
          e = { files: 0, tiles: 0, spellings: new Map() };
          out.set(key, e);
        }
        if (seen.has(key)) continue;
        seen.add(key);
        e[field]++;
        e.spellings.set(tag, (e.spellings.get(tag) ?? 0) + 1);
      }
    }
  };
  tally(files, 'files');
  tally(tiles, 'tiles');
  return out;
}

export interface TagRow {
  name: string;
  files: number;
  tiles: number;
}

/**
 * One Tags Browser row per tag, whatever its case: the registered spelling
 * when there is one, else the spelling most carriers use (the first
 * alphabetically on a tie). Sorted by name.
 */
export function tagBrowserRows(registered: readonly string[], usage: ReadonlyMap<string, TagCounts>): TagRow[] {
  const rows = new Map<string, TagRow>();
  for (const name of registered) {
    const key = fold(name);
    if (!rows.has(key)) rows.set(key, { name, files: 0, tiles: 0 });
  }
  for (const [key, u] of usage) {
    const row = rows.get(key) ?? { name: mostUsedSpelling(u.spellings), files: 0, tiles: 0 };
    row.files = u.files;
    row.tiles = u.tiles;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mostUsedSpelling(spellings: ReadonlyMap<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [name, n] of spellings) {
    if (n > bestCount || (n === bestCount && name.localeCompare(best) < 0)) {
      best = name;
      bestCount = n;
    }
  }
  return best;
}
