/**
 * Versioned-config loader gate (Phase 4 / E2, recurrence-proofs F6).
 *
 * F6 was: the board / tags / layout-template envelopes each grew a
 * `version` field plus a `migrate*` scaffold, but two of the three loaders
 * called `Schema.safeParse(rawFromDisk)` directly and never ran their
 * migrator. A `version: 99` file written by a future Filo parsed clean
 * against the broadened `z.number().int()` version field, and an older
 * build re-saved it → silent downgrade.
 *
 * The fix routes every versioned-config loader through
 * `lib/vault/loadVersionedFile.ts`, which always migrates-then-validates
 * (and short-circuits the from-future / no-migration-path cases so a file
 * Filo must not re-save never reaches the parse step). This gate makes the
 * "forgot to migrate" failure mode structurally impossible: any direct
 * `.safeParse` / `.parse` against a versioned schema must live in a file
 * that ALSO references `loadVersionedFile` or the matching migrator.
 *
 * Detection: scan `src/renderer` for `<VersionedSchema>.safeParse(` /
 * `<VersionedSchema>.parse(`. For each hit, the containing file must
 * reference `loadVersionedFile` OR the schema's migrator. The board loader
 * passes via `loadVersionedFile`; `tagsStorage`'s read-only `bestEffortParse`
 * passes because the file also routes its primary load through the helper.
 *
 * MAINTENANCE — when you add a new versioned `.filo/` config type (one with
 * a `CURRENT_*_VERSION` constant + a `migrate*` scaffold), add its schema
 * name to `VERSIONED_SCHEMAS` below so this gate covers its loader too.
 *
 * Escape hatch: append `// allow-unversioned-parse: <reason>` on the same
 * line (e.g. a test fixture builder that parses a hand-built object that is
 * not disk-loaded).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

/**
 * Schemas whose on-disk file carries a `version` envelope + a migration
 * scaffold. A `.safeParse` / `.parse` against any of these MUST be
 * migration-guarded. Add new versioned config schemas here.
 */
const VERSIONED_SCHEMAS = [
  'V7BoardFileDataSchema',
  'TagsFileSchema',
  'LayoutTemplateSchema',
];

/**
 * Tokens that prove the file migrates-before-parse. The shared helper
 * (`loadVersionedFile`) does it internally; a file that calls a migrator
 * directly (the board loader's reference path historically) also qualifies.
 */
const GUARD_TOKENS = [
  'loadVersionedFile',
  'migrateBoardFile',
  'migrateTagsFile',
  'migrateLayoutTemplate',
];

const parseRe = new RegExp(
  `\\b(${VERSIONED_SCHEMAS.join('|')})\\s*\\.\\s*(?:safeParse|parse)\\s*\\(`,
);

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
  const src = readFileSync(abs, 'utf8');
  if (!VERSIONED_SCHEMAS.some((s) => src.includes(s))) continue;
  const fileIsGuarded = GUARD_TOKENS.some((t) => src.includes(t));
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!parseRe.test(line)) continue;
    if (/\/\/ allow-unversioned-parse:/.test(line)) continue;
    if (fileIsGuarded) continue;
    offenders.push({ rel, lineNo: i + 1, snippet: line.trim() });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-versioned-config-loader] OK — scanned ${files.length} files, 0 unguarded versioned-schema parses.`,
  );
  process.exit(0);
}

console.error(
  `[check-versioned-config-loader] FAILED — ${offenders.length} versioned-schema parse(s) not migration-guarded:\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route the load through `loadVersionedFile(schema, migrator, raw)`\n' +
    '(src/renderer/lib/vault/loadVersionedFile.ts) so the file migrates before\n' +
    'it parses — otherwise a from-future config parses clean and an older build\n' +
    'silently downgrades it on the next save (F6). If this is a hand-built,\n' +
    'non-disk-loaded object (e.g. a test fixture), append\n' +
    '`// allow-unversioned-parse: <reason>` on the same line.',
);
process.exit(1);
