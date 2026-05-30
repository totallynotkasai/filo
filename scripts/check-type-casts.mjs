/**
 * Type-cast ratchet (Phase 7 regression-prevention gate).
 *
 * Forbids `as any` and `as unknown as` in non-test source code. ESLint's
 * `@typescript-eslint/no-explicit-any` catches `as any` but NOT
 * `as unknown as`, and an inline `// eslint-disable-next-line` can silence
 * either. This grep-based gate is defense-in-depth — it cannot be
 * silenced by ESLint directives.
 *
 * Escape hatch: lines containing the marker `// allow-cast:` are skipped.
 * The marker must include a justification, e.g. `// allow-cast: third-party
 * type def has unfixable bug, see issue #42`. Reviewers gate on the marker.
 *
 * Tests (`src/tests/**`) are exempt — matches the test exemption in
 * `eslint.config.js`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main', 'src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];
const PATTERNS = [
  { name: 'as any', re: /\bas\s+any\b/ },
  { name: 'as unknown as', re: /\bas\s+unknown\s+as\b/ },
];

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
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('// allow-cast:')) continue;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        offenders.push({ rel, lineNo: i + 1, pattern: name, snippet: line.trim() });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log(`[check-type-casts] OK — scanned ${files.length} files, 0 violations.`);
  process.exit(0);
}

console.error(
  `[check-type-casts] FAILED — ${offenders.length} type-cast violation(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} (${o.pattern})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: replace the cast with a real type narrowing (discriminated union\n' +
    'switch, Zod parse at the boundary, etc.). If the cast is truly unavoidable,\n' +
    'add `// allow-cast: <reason>` to the same line.',
);
process.exit(1);
