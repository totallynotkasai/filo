/**
 * Phase 6.7 CI gate — js-yaml (and gray-matter) does not parse any frontmatter.
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
 * Audit-13 M2 — the gate was BLIND to `gray-matter`, which bundles
 * `js-yaml@3.x` (YAML 1.1) internally: the vault index + template service fell
 * back to it on malformed-but-recoverable YAML, re-introducing the SAME
 * cross-parser drift (an unquoted `date:` → Date, `0b1010` → 10) under a
 * different import name (bite-tested: a fresh `import matter from 'gray-matter'`
 * passed the old gate). So this gate now ALSO forbids `gray-matter` imports —
 * both index/template paths were migrated to the `yaml` package
 * (`lib/vault/frontmatterRead.ts`).
 *
 * The single intentional exception is `tagsStorage.isSafeNewTagName`, which uses
 * js-yaml's YAML-1.1 coercion ON PURPOSE to reject `2024` / `true` / `null` as
 * confusing tag names — it validates a single bare tag token, NOT a frontmatter
 * block. It opts out with `// allow-jsyaml: <reason>` on the import line or the
 * line above it (the same escape applies to any genuinely body-only gray-matter
 * use). Any new opt-out is visible in `git diff` and must be reviewed.
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
// Audit-13 M2 — gray-matter bundles js-yaml v3, so an import of it is a second
// frontmatter parser by proxy. Banned alongside js-yaml (same escape).
const GRAY_MATTER_IMPORT_RE = /(?:from|require\()\s*['"]gray-matter['"]/;
const ALLOW_INLINE_RE = /\/\/\s*allow-jsyaml:\s*\S+/;

const offenders = [];

const files = [];
for (const root of SCAN_ROOTS) walkExt(root, EXTENSIONS, files);

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lib = JS_YAML_IMPORT_RE.test(lines[i])
      ? 'js-yaml'
      : GRAY_MATTER_IMPORT_RE.test(lines[i])
        ? 'gray-matter'
        : null;
    if (!lib) continue;
    // Allow the intentional opt-out on the import line or the line above it.
    const annotationWindow = `${lines[i - 1] ?? ''}\n${lines[i]}`;
    if (ALLOW_INLINE_RE.test(annotationWindow)) continue;
    offenders.push({ rel, line: i + 1, lib, snippet: lines[i].trim() });
  }
}

if (offenders.length > 0) {
  console.error(`[check-no-jsyaml-in-frontmatter] FAILED — ${offenders.length} violation(s):`);
  for (const o of offenders.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.error(`  ${o.rel}:${o.line} [${o.lib}]`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nThe `yaml` package is the single parser for all frontmatter (Phase 6). js-yaml\n' +
      'and the `yaml` package disagree on a few scalar forms (an unquoted date, `<<`,\n' +
      '`1_000` / `0b1010`), and that disagreement WAS the recurring frontmatter\n' +
      'corruption class — so js-yaml must not read or write any frontmatter.\n' +
      '`gray-matter` bundles js-yaml v3 internally (Audit-13 M2), so importing it is\n' +
      'the same hazard under a different name — it is banned too.\n' +
      '\n' +
      'Fix: use the `yaml` package (`parseDocument(...).toJS()` to read, `new Document(...)`\n' +
      'or the CST engine to write). The index/template read paths share\n' +
      '`lib/vault/frontmatterRead.ts` (split + `yaml` parse). If this use is genuinely\n' +
      'NOT a frontmatter parse (e.g. the tag-name minting guard, or a body-only\n' +
      'split), annotate the import with `// allow-jsyaml: <reason>`.',
  );
  process.exit(1);
}

console.log(
  `[check-no-jsyaml-in-frontmatter] OK — scanned ${files.length} file(s); 0 unannotated js-yaml / gray-matter imports.`,
);
process.exit(0);
