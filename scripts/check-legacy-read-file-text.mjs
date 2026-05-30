/**
 * Legacy `vault:read-file-text` shape guard.
 *
 * Phase 37 / 37.6 (and later corrective sweeps in IMPL_PLAN_2026-05-23_v2)
 * removed the legacy single-arg absolute-path branch from
 * `vault:read-file-text`. The canonical shape is the (vaultRoot,
 * relativePath) tuple — see ipcSchemas.ts. Any caller that re-introduces
 * a single-arg call form fails the preload validator at runtime and
 * silently falls back to stale/empty content; if the caller is a text
 * tile writer, the next save overwrites the disk file with that empty
 * content (data loss).
 *
 * This gate fails the build if a single-arg call form re-appears. The
 * detection heuristic looks for `'vault:read-file-text',` followed by a
 * template-literal argument (backtick) or a string-concatenation
 * argument — the two shapes that produced the original bugs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main', 'src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

// Match: `'vault:read-file-text',` followed by either a template literal
// (backtick) or a concatenation that's clearly building an absolute path
// (e.g. `vaultRoot + '/' + relPath`). The canonical form is a bare
// identifier — `vault:read-file-text', vaultRoot, relPath` — which this
// regex does NOT match.
const LEGACY_TEMPLATE_LITERAL = /['"]vault:read-file-text['"]\s*,\s*`/;
const LEGACY_STRING_CONCAT = /['"]vault:read-file-text['"]\s*,\s*[^,)]*\+/;

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
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && hasTrackedExtension(entry)) {
      out.push(full);
    }
  }
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LEGACY_TEMPLATE_LITERAL.test(line)) {
      offenders.push({ rel, lineNo: i + 1, shape: 'template-literal', snippet: line.trim() });
    } else if (LEGACY_STRING_CONCAT.test(line)) {
      offenders.push({ rel, lineNo: i + 1, shape: 'string-concat', snippet: line.trim() });
    }
  }
}

if (offenders.length === 0) {
  console.log(`[check-legacy-read-file-text] OK — scanned ${files.length} files, 0 violations.`);
  process.exit(0);
}

console.error(
  `[check-legacy-read-file-text] FAILED — ${offenders.length} legacy call shape(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} (${o.shape})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  "\nFix: pass the canonical two-arg tuple instead.\n" +
    "  await window.filo.invoke('vault:read-file-text', vaultRoot, relativePath);\n" +
    'Single-arg / concatenated-path forms are rejected by the preload validator\n' +
    'and silently fall back to stale content — see ipcSchemas.ts entry.',
);
process.exit(1);
