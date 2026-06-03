/**
 * Phase 6.7 CI gate — js-yaml does not parse any frontmatter.
 *
 * Repurposed from the Audit-4 DI-01 `ci:frontmatter-core-schema` gate (which
 * required every `yaml.load(...)` to pass `CORE_SCHEMA`). Phase 6 made the `yaml`
 * package the SINGLE parser for every frontmatter read / write / compare and
 * deleted the legacy js-yaml byte-splice engine, so the CORE_SCHEMA discipline is
 * moot. This gate enforces the stronger, structural invariant that replaced it:
 * NO renderer/main module may `import` js-yaml at all — the root cause of the
 * recurring corruption class (DI-01, DI-05, R1, M2) was js-yaml and the `yaml`
 * package disagreeing on a frontmatter value, and removing js-yaml from the
 * source tree forecloses that class entirely.
 *
 * The single intentional exception is `tagsStorage.isSafeNewTagName`, which uses
 * js-yaml's YAML-1.1 coercion ON PURPOSE to reject `2024` / `true` / `null` as
 * confusing tag names — it validates a single bare tag token, NOT a frontmatter
 * block. It opts out with `// allow-jsyaml: <reason>` on the import line or the
 * line above it. Any new opt-out is visible in `git diff` and must be reviewed.
 *
 * Tests (`src/tests/**`) are out of scope — they freely use js-yaml as an
 * independent oracle to cross-check the `yaml`-package write path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = [join(ROOT, 'src/renderer'), join(ROOT, 'src/main')];
const EXTENSIONS = ['.ts', '.svelte'];

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkExt(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkExt(full, exts, out);
    else if (s.isFile() && exts.some((e) => entry.endsWith(e))) out.push(full);
  }
}

// Matches `import … from 'js-yaml'` / `import 'js-yaml'` and `require('js-yaml')`.
const JS_YAML_IMPORT_RE = /(?:from|require\()\s*['"]js-yaml['"]/;
const ALLOW_INLINE_RE = /\/\/\s*allow-jsyaml:\s*\S+/;

const offenders = [];

const files = [];
for (const root of SCAN_ROOTS) walkExt(root, EXTENSIONS, files);

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!JS_YAML_IMPORT_RE.test(lines[i])) continue;
    // Allow the intentional opt-out on the import line or the line above it.
    const annotationWindow = `${lines[i - 1] ?? ''}\n${lines[i]}`;
    if (ALLOW_INLINE_RE.test(annotationWindow)) continue;
    offenders.push({ rel, line: i + 1, snippet: lines[i].trim() });
  }
}

if (offenders.length > 0) {
  console.error(`[check-no-jsyaml-in-frontmatter] FAILED — ${offenders.length} violation(s):`);
  for (const o of offenders.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.error(`  ${o.rel}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nThe `yaml` package is the single parser for all frontmatter (Phase 6). js-yaml\n' +
      'and the `yaml` package disagree on a few scalar forms (an unquoted date, `<<`,\n' +
      '`1_000` / `0b1010`), and that disagreement WAS the recurring frontmatter\n' +
      'corruption class — so js-yaml must not read or write any frontmatter.\n' +
      '\n' +
      'Fix: use the `yaml` package (`parseDocument(...).toJS()` to read, `new Document(...)`\n' +
      'or the CST engine to write). If this js-yaml use is genuinely NOT a frontmatter\n' +
      'parse (e.g. the tag-name minting guard), annotate the import with\n' +
      '`// allow-jsyaml: <reason>`.',
  );
  process.exit(1);
}

console.log(
  `[check-no-jsyaml-in-frontmatter] OK — scanned ${files.length} file(s); 0 unannotated js-yaml imports.`,
);
process.exit(0);
