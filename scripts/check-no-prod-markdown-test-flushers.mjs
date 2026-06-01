/**
 * Audit2 5.9 — forbids production code from importing the test-only flusher
 * registry symbols from `lib/vault/markdownFileWriter.ts`.
 *
 * `__testRegisterFlusher` / `__testUnregisterFlusher` are inherited from the
 * deleted `markdownWriteRegistry` shim's `registerMarkdownFlusher` fixture
 * surface — they live on the gateway so the shim file could go away without
 * forcing the test fixtures to be rewritten, but they must NEVER reach a
 * production code path. A prod-side registration would mean the
 * `flushAllMarkdownWrites` drain has user-visible side effects coming from
 * an unstructured callback registry, exactly the smell the shim deletion
 * was meant to close.
 *
 * Inline escape: `// allow-test-flusher: <reason>` on the import line, when
 * the import is genuinely test infrastructure imported from a non-test file
 * (none today; the gate is preventative).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer', 'src/main', 'src/shared'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

const FORBIDDEN_SYMBOLS = ['__testRegisterFlusher', '__testUnregisterFlusher'];
const INLINE_ALLOW_PATTERN = /\/\/\s*allow-test-flusher:/;

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
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
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
  // The gateway itself defines and exports the symbols — allowed.
  if (rel === 'src/renderer/lib/vault/markdownFileWriter.ts') continue;
  const src = readFileSync(abs, 'utf8');
  if (!FORBIDDEN_SYMBOLS.some((s) => src.includes(s))) continue;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const hit = FORBIDDEN_SYMBOLS.find((s) => lineText.includes(s));
    if (!hit) continue;
    if (INLINE_ALLOW_PATTERN.test(lineText)) continue;
    offenders.push({ rel, lineNo: i + 1, symbol: hit, snippet: lineText.trim() });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-no-prod-markdown-test-flushers] OK — scanned ${files.length} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-no-prod-markdown-test-flushers] FAILED — ${offenders.length} prod use(s) of the test-only flusher API:\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}  (${o.symbol})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: production code MUST NOT import `__testRegisterFlusher` /\n' +
    '`__testUnregisterFlusher` from `lib/vault/markdownFileWriter`. Those\n' +
    'exist solely so the test fixtures inherited from the deleted\n' +
    '`markdownWriteRegistry` shim keep working. For a real production\n' +
    'write, use `scheduleMarkdownWrite` + `registerForceWriter` instead.',
);
process.exit(1);
