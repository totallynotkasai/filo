/**
 * Audit-4 DI-01 CI gate — every js-yaml frontmatter read uses CORE_SCHEMA.
 *
 * Class-kill for "the frontmatter read/serialise schemas drift apart again".
 * Filo reads `.md` frontmatter with `js-yaml` but re-serialises the disk
 * baseline with the `yaml` package (`frontmatterEngine.patchFrontmatterSource`).
 * js-yaml's DEFAULT_SCHEMA (YAML 1.1) resolves `2026-06-01` → a JS `Date` and
 * `<<: *a` → a merged map; the `yaml` package keeps them a `string` / a literal
 * `<<`. When the two disagree, the source-preserving engine thinks an UNCHANGED
 * key changed and rewrites it — corrupting unquoted dates to ISO timestamps
 * (DI-01) and destroying merge references (DI-05).
 *
 * The fix routes every frontmatter `yaml.load(...)` through CORE_SCHEMA so the
 * parsed object matches the serializer. This gate forecloses the regression:
 * any `yaml.load(` in the renderer must pass `CORE_SCHEMA` (on the call line or
 * the next, to allow a wrapped argument list).
 *
 * Per-line escape: `// allow-default-schema: <reason>` on the same or preceding
 * line opts a specific occurrence out — for a `yaml.load` that is NOT reading a
 * frontmatter block and intentionally wants YAML 1.1 type resolution (e.g. the
 * `tagsStorage.isSafeNewTagName` minting guard, which validates that a single
 * bare tag name round-trips as a plain string scalar).
 *
 * Assumes the codebase's uniform `import yaml from 'js-yaml'; yaml.load(...)`
 * call form (the convention everywhere today). A named `{ load }` import would
 * sidestep this matcher — if that form is ever introduced, extend the pattern.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = [join(ROOT, 'src/renderer')];
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

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const YAML_LOAD_RE = /yaml\.load\s*\(/;
const CORE_SCHEMA_RE = /CORE_SCHEMA/;
const ALLOW_INLINE_RE = /\/\/\s*allow-default-schema:\s*\S+/;

const offenders = [];

const files = [];
for (const root of SCAN_ROOTS) walkExt(root, EXTENSIONS, files);

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  for (let i = 0; i < codeLines.length; i++) {
    if (!YAML_LOAD_RE.test(codeLines[i])) continue;
    // Allow a wrapped argument list: accept CORE_SCHEMA on the call line or the
    // next line.
    const schemaWindow = `${codeLines[i]}\n${codeLines[i + 1] ?? ''}`;
    if (CORE_SCHEMA_RE.test(schemaWindow)) continue;
    // Intentional non-frontmatter load opted out on the same/preceding line.
    const annotationWindow = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
    if (ALLOW_INLINE_RE.test(annotationWindow)) continue;
    offenders.push({ rel, line: i + 1, snippet: rawLines[i].trim() });
  }
}

if (offenders.length > 0) {
  console.error(`[check-frontmatter-core-schema] FAILED — ${offenders.length} violation(s):`);
  for (const o of offenders.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.error(`  ${o.rel}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nEvery js-yaml frontmatter read must pass `{ schema: yaml.CORE_SCHEMA }` so the\n' +
      'parsed object matches the `yaml`-package serializer in frontmatterEngine. Under\n' +
      'DEFAULT_SCHEMA an unquoted date loads as a `Date` and `<<` as a merged map, which\n' +
      'the source-preserving engine then rewrites — corrupting the date to an ISO\n' +
      'timestamp / destroying the merge key (Audit-4 DI-01 / DI-05).\n' +
      '\n' +
      'Fix: add `{ schema: yaml.CORE_SCHEMA }` to the load. If this load is NOT reading a\n' +
      'frontmatter block and intentionally wants YAML 1.1 resolution, annotate it with\n' +
      '`// allow-default-schema: <reason>`.',
  );
  process.exit(1);
}

console.log(`[check-frontmatter-core-schema] OK — scanned ${files.length} file(s); 0 offenders.`);
process.exit(0);
