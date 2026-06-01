/**
 * Phase 6.1.R5 CI gate — `hadBom` is sourced from disk reads only.
 *
 * Class-kill for "BOM lost on first save". The bug: a caller sniffs the
 * BOM byte from in-memory content that has ALREADY been BOM-stripped
 * (by `gray-matter`, `js-yaml`, or `parseMarkdownFile`), so the sniff
 * is permanently `false`. The hydrate stamps `hadBom: false` into
 * `fileState`, the next gateway write assembles without the BOM, and
 * the user's Notepad-saved `.md` loses its `EF BB BF` prefix.
 *
 * Audit-3 surfaced two sites:
 *   - PropertiesPopup's `buildFrontmatterWriteArgs` sniffed
 *     `vaultIndexStore.content` (body-only, BOM-stripped) → always false.
 *   - TextTile's sibling-adoption + in-memory body branches sniffed
 *     `parsed.hadBom` from a body-only `existing.body` / `docState.body`
 *     → always false. Each path re-stamped the sibling's correct
 *     `hadBom: true` to `false`.
 *
 * Phase 6.1.R5 routes both sites through `readMarkdownForHydrate`
 * (PropertiesPopup at onMount) or inherits the sibling's existing
 * `fileState` entry (TextTile). The CI gate forecloses the class by
 * banning every form of the BOM sniff outside the canonical
 * disk-bytes-reading sites.
 *
 * Banned patterns (outside the allowed files):
 *   - `charCodeAt(0) === 0xfeff` / `0xFEFF`
 *   - `charCodeAt(0) === 65279` (decimal form of `0xfeff`)
 *   - The literal `﻿` character (anywhere)
 *   - `﻿` / `\u{FEFF}` (escape forms)
 *
 * Allowed files:
 *   - `lib/vault/markdownFileWriter.ts` — owns the disk read + hydrate
 *     gate and is the only caller that legitimately sees raw bytes.
 *   - `lib/editor/markdownSync.ts` — `parseMarkdownFile` reads raw
 *     bytes and emits the parsed `hadBom`. The gateway and
 *     PropertiesPopup forward this; no other reader sniffs.
 *
 * Per-line inline escape: `// allow-bom-sniff: <reason>` on the same or
 * preceding line opts a specific occurrence out. Used for callers that
 * receive raw disk bytes via a different gateway (e.g. `ReplaceAll`
 * reads via `vault:read-file-text` and computes frontmatter-end byte
 * offsets for the body splice — the raw param is genuinely raw bytes,
 * not BOM-stripped cached content).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = [join(ROOT, 'src/renderer'), join(ROOT, 'src/main')];
const EXTENSIONS = ['.ts', '.svelte', '.mjs'];

const ALLOWED_FILES = new Set([
  'src/renderer/lib/vault/markdownFileWriter.ts',
  'src/renderer/lib/editor/markdownSync.ts',
]);

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

// Banned sniff patterns. `﻿` literal would be entered as either
// `\\ufeff` in regular source or as the actual U+FEFF code point —
// both forms are banned.
const HEX_FEFF_RE = /charCodeAt\s*\(\s*0\s*\)\s*===\s*0x[fF][eE][fF][fF]/;
const DEC_FEFF_RE = /charCodeAt\s*\(\s*0\s*\)\s*===\s*65279\b/;
const ESCAPE_FEFF_RE = /\\u\{?[fF][eE][fF][fF]\}?/;
// The actual U+FEFF character in source. Excluded inside string literals
// would still produce a runtime check on the byte; including it as a
// raw character ALSO matches.
const LITERAL_FEFF_RE = /﻿/;

const ALLOW_INLINE_RE = /\/\/\s*allow-bom-sniff:\s*\S+/;

const offenders = [];

const files = [];
for (const root of SCAN_ROOTS) walkExt(root, EXTENSIONS, files);

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWED_FILES.has(rel)) continue;
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  for (let i = 0; i < codeLines.length; i++) {
    const codeLine = codeLines[i];
    const annotationWindow = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
    if (ALLOW_INLINE_RE.test(annotationWindow)) continue;
    for (const [name, re] of [
      ['hex-feff', HEX_FEFF_RE],
      ['dec-feff', DEC_FEFF_RE],
      ['escape-feff', ESCAPE_FEFF_RE],
      ['literal-feff', LITERAL_FEFF_RE],
    ]) {
      if (re.test(codeLine)) {
        offenders.push({
          rel,
          line: i + 1,
          rule: name,
          snippet: rawLines[i].trim(),
        });
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `[check-no-bom-sniff] FAILED — ${offenders.length} violation(s):`,
  );
  for (const o of offenders.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.error(`  ${o.rel}:${o.line} [${o.rule}]`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nThe BOM byte (U+FEFF) is a property of the raw on-disk bytes. Any caller\n' +
      'that sniffs it from in-memory content is reading a value that has already\n' +
      'been BOM-stripped by gray-matter / js-yaml / parseMarkdownFile — the\n' +
      'sniff is permanently `false`, the hydrate stamps the wrong `hadBom`, and\n' +
      'Notepad-saved files lose their BOM on the next save.\n' +
      '\n' +
      'Fix: route the hydrate through `readMarkdownForHydrate(vaultRoot, relPath)`\n' +
      'from `lib/vault/markdownFileWriter.ts`. That helper does the disk read\n' +
      'AND seeds the drift baseline from the same `vault:read-file-text` call.\n' +
      'For unavoidable in-memory fallback paths (sibling-adoption, recovery\n' +
      'flows), inherit the existing `fileState` entry by checking `isHydrated`\n' +
      'first; if absent, `markHydrated(relPath, false)` is the safe fallback\n' +
      "(the next gateway write surfaces the missing-file case via the gateway's\n" +
      'normal error path).',
  );
  process.exit(1);
}

console.log(
  `[check-no-bom-sniff] OK — scanned ${files.length} file(s); 0 offenders.`,
);
process.exit(0);
