/**
 * Inline path-normalize ratchet (Phase 9.2 regression-prevention gate).
 *
 * Forbids ad-hoc `replace(/\\/g, '/')` separator-normalization in renderer
 * source. The renderer can't import Node's `path` module, so callers must
 * route through the canonical helpers in `src/renderer/lib/utils/path.ts`
 * (`toPosix`, `normalizePath`, `normalizeVaultRelative`, `stripLeadingSlash`).
 *
 * Main-process code is exempt (Node's `path` module is available there).
 *
 * Escape hatch: lines containing the marker `// allow-inline-normalize:` are
 * skipped. The marker must include a justification, e.g.
 * `// allow-inline-normalize: composed with split() — no helper match`.
 * Reviewers gate on the marker. Tests are also exempt.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];
// path.ts hosts the canonical helpers and is allowed to use the raw regex.
const ALLOWLIST = new Set(['src/renderer/lib/utils/path.ts']);
const PATTERN = /replace\(\/\\\\\/g,\s*['"]\/['"]\)/;

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
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
  if (ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('// allow-inline-normalize:')) continue;
    if (PATTERN.test(line)) {
      offenders.push({ rel, lineNo: i + 1, snippet: line.trim() });
    }
  }
}

if (offenders.length === 0) {
  console.log(`[check-inline-path-normalize] OK — scanned ${files.length} files, 0 violations.`);
  process.exit(0);
}

console.error(
  `[check-inline-path-normalize] FAILED — ${offenders.length} inline path-normalize violation(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route through the canonical helpers in src/renderer/lib/utils/path.ts\n' +
    '(toPosix, normalizePath, normalizeVaultRelative, stripLeadingSlash).\n' +
    'If the helper set does not cover the use, add\n' +
    '`// allow-inline-normalize: <reason>` to the same line.',
);
process.exit(1);
