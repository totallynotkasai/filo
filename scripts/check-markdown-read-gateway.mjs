/**
 * Markdown read-gateway gate (Phase 4 / E1, recurrence-proofs F1).
 *
 * F1 was: the pre-write drift baseline (`fileBaselineRegistry`) is only
 * seeded when a hydrate threads the read's `mtimeMs` into `markHydrated`.
 * Several disk-read hydrate sites forgot to, so the writer's pre-write
 * drift check no-oped and an external edit that landed between hydrate and
 * the next debounced write was silently overwritten. Fixing each call site
 * by hand re-opens the gap the moment a new hydrate site is added.
 *
 * The fix is the `readMarkdownForHydrate` gateway in
 * `lib/vault/markdownFileWriter.ts`: it does the `vault:read-file-text`
 * read + parse + `markHydrated(relPath, hadBom, mtimeMs)` in one place, so
 * content and baseline always come from the SAME read (no read/stat TOCTOU)
 * and a disk-read hydrate can never land without its baseline.
 *
 * This gate makes that structural: a file that marks files hydrated
 * (`markHydrated(`) MUST NOT also issue a direct `vault:read-file-text`
 * invoke. The dangerous combination — read from disk, then hydrate — must
 * route through the gateway. Reads that don't hydrate (tag rewrite,
 * sentinels, drag-drop content seeds, conflict resolver, …) are untouched,
 * and in-memory hydrates (no disk read, `markHydrated(relPath, false)`) stay
 * legal because they seed no baseline.
 *
 * Why not forbid `vault:read-file-text` outright? ~18 renderer call sites
 * read `.md` for non-hydrate reasons; a blanket ban would be ~18 allowlist
 * entries and near-useless. Scoping to "file that ALSO hydrates" targets
 * exactly the F1 failure mode.
 *
 * Allowlist: the gateway module itself (owns the only sanctioned
 * read+markHydrated pairing). Per-line escape hatch:
 * `// allow-hydrate-read: <reason>` on the read line (used by
 * `boardCache.syncTileMarkdown`, which runs its own mtime guard).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

/**
 * Files allowed to pair a direct `vault:read-file-text` read with a
 * `markHydrated` call. Only the gateway qualifies — it IS the sanctioned
 * read+seed pairing every other hydrate site must route through.
 */
const ALLOWLIST = new Set([
  'src/renderer/lib/vault/markdownFileWriter.ts',
]);

/** A `markHydrated(...)` CALL (not the bare import, which has no paren). */
const HYDRATE_CALL_RE = /\bmarkHydrated\s*\(/;

/**
 * A direct `vault:read-file-text` invoke: `invoke('vault:read-file-text'`,
 * `invokeOk('vault:read-file-text'`, `window.filo.invoke('vault:read-file-text'`.
 * Requires the `invoke(` prefix so a doc comment merely *mentioning* the
 * channel name doesn't match.
 */
const READ_INVOKE_RE = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:read-file-text['"`]/;

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (s.isFile() && hasTrackedExtension(entry)) out.push(full);
  }
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(abs, 'utf8');
  // Only files that actually hydrate are in scope — a non-hydrate reader is
  // free to call `vault:read-file-text` directly.
  if (!HYDRATE_CALL_RE.test(src)) continue;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!READ_INVOKE_RE.test(line)) continue;
    if (/\/\/ allow-hydrate-read:/.test(line)) continue;
    offenders.push({ rel, lineNo: i + 1, snippet: line.trim() });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-markdown-read-gateway] OK — scanned ${files.length} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-markdown-read-gateway] FAILED — ${offenders.length} hydrate-site read(s) bypassing the gateway:\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nThis file marks files hydrated AND reads `.md` from disk directly. Route\n' +
    'the read through `readMarkdownForHydrate(vaultRoot, relPath)` in\n' +
    'src/renderer/lib/vault/markdownFileWriter.ts so the read seeds the pre-write\n' +
    'drift baseline atomically (F1). If this read genuinely must not seed a\n' +
    'baseline (it runs its own mtime guard), append\n' +
    '`// allow-hydrate-read: <reason>` on the read line.',
);
process.exit(1);
