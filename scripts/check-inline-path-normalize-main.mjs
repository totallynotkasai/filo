/**
 * Sprint C / C13 — main-process counterpart to `check-inline-path-normalize.mjs`.
 *
 * Forbids ad-hoc `replace(/\\/g, '/')` separator-normalization in the
 * Electron main process. The canonical helpers live in
 * `src/main/utils/pathHelpers.ts` (`toPosix`, `relativePosix`,
 * `stripLeadingSlash`).
 *
 * Escape hatch: same `// allow-inline-normalize: <reason>` marker as the
 * renderer gate. Reviewers gate on the justification.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main'];
const EXTENSIONS = ['.ts'];
// pathHelpers.ts hosts the canonical helpers and is allowed to use the raw regex.
const ALLOWLIST = new Set(['src/main/utils/pathHelpers.ts']);
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
  console.log(`[check-inline-path-normalize-main] OK — scanned ${files.length} files, 0 violations.`);
  process.exit(0);
}

console.error(
  `[check-inline-path-normalize-main] FAILED — ${offenders.length} inline path-normalize violation(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route through the canonical helpers in src/main/utils/pathHelpers.ts\n' +
    '(toPosix, relativePosix, stripLeadingSlash).\n' +
    'If the helper set does not cover the use, add\n' +
    '`// allow-inline-normalize: <reason>` to the same line.',
);
process.exit(1);
