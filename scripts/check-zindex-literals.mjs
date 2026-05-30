/**
 * Z-index literal ratchet (Phase 9.3 regression-prevention gate).
 *
 * Forbids hardcoded `z-index: NNN` values ≥ 1000 in renderer .svelte files.
 * Above the 1000-line lies the global stacking scale (sidebar, toolbar,
 * modals, toasts) — every value there must come from a `var(--z-*)` token
 * defined in `src/css/style.css`. Local stacking values (1, 2, 5, 50, etc.)
 * inside a single component remain free.
 *
 * Escape hatch: lines containing the marker `/* allow-zindex: <reason> *​/`
 * (inline CSS comment) or `// allow-zindex: <reason>` (style-attribute) are
 * skipped. Inline-style markers must be placed after the value but on the
 * same source line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte'];
const PATTERN = /z-index:\s*(\d+)/g;
const LOCAL_THRESHOLD = 1000;

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
    if (line.includes('allow-zindex:')) continue;
    PATTERN.lastIndex = 0;
    let m;
    while ((m = PATTERN.exec(line)) !== null) {
      const value = parseInt(m[1], 10);
      if (value >= LOCAL_THRESHOLD) {
        offenders.push({ rel, lineNo: i + 1, value, snippet: line.trim() });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log(`[check-zindex-literals] OK — scanned ${files.length} files, 0 violations.`);
  process.exit(0);
}

console.error(
  `[check-zindex-literals] FAILED — ${offenders.length} z-index literal violation(s) (>= ${LOCAL_THRESHOLD}):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} (z-index: ${o.value})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: replace the literal with a `var(--z-*)` token defined in\n' +
    'src/css/style.css. If a brand-new global layer is genuinely needed,\n' +
    'add the variable there first. If the value is truly one-off (e.g. a\n' +
    'particular workaround for a third-party widget), add\n' +
    '`/* allow-zindex: <reason> */` or `// allow-zindex: <reason>` to the\n' +
    'same line.',
);
process.exit(1);
