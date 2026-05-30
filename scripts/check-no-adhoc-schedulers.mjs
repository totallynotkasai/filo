/**
 * Ad-hoc scheduler ratchet (Phase R1 regression-prevention gate).
 *
 * Forbids new `setTimeout(...)` calls that schedule an IPC write outside
 * of `writeScheduler.ts`. The five scheduler families (board / markdown /
 * frontmatter / config / misc) all consume `createScheduler`; this gate
 * stops a sixth from reinventing the pending/in-flight/failure pattern
 * (and accidentally dropping failure attribution like the legacy
 * markdownFileWriter and configWriteScheduler did).
 *
 * Detection: locate each `setTimeout(...)` in scanned source; find the
 * opening `{` of its callback body; brace-walk to the matching `}`; if
 * the body contains `invokeOk(`, `window.filo.invoke(`, or
 * `filo.invoke(`, flag it. Brace walking prevents false positives where
 * a non-IPC setTimeout sits in the same file as a sibling IPC call.
 *
 * Allowlist: the primitive itself (`writeScheduler.ts`) and any existing
 * matches whose migration is deferred.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

/**
 * Files exempt from this gate. The primitive owns the only legitimate
 * setTimeout-around-IPC pattern; add files here only when migration is
 * genuinely deferred and the reason is documented inline.
 */
const ALLOWLIST = new Set([
  // The scheduler primitive itself — owns the canonical
  // setTimeout-around-IPC pattern that every other writer consumes.
  'src/renderer/lib/boards/writeScheduler.ts',
  // Sidebar geometry persistence (`sidebar:set-state`). This writes to
  // Electron `userData`, NOT the vault, so it deliberately bypasses the
  // vault sentinel / inflight-counter pipeline that `createScheduler`
  // serves. CLAUDE.md documents this carve-out (per-machine UI geometry
  // lives outside any vault). Routing it through `createScheduler` would
  // require giving the primitive a "skip vault sentinel" mode that's
  // strictly less useful than the current two-line debounce.
  'src/renderer/stores/ui.svelte.ts',
]);

const IPC_PATTERNS = [
  /\binvokeOk\s*\(/,
  /\bwindow\.filo\.invoke\s*\(/,
  /\bfilo\.invoke\s*\(/,
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

/**
 * Given source text and the index of `setTimeout`, find the opening `{`
 * of the callback body and the matching close brace. Returns the
 * substring inside the braces, or `null` if the structure looks
 * malformed (e.g. setTimeout called with a function reference rather
 * than an inline callback).
 */
function extractCallbackBody(src, setTimeoutIdx) {
  // Step over `setTimeout(` to find the start of the args list.
  let i = setTimeoutIdx + 'setTimeout'.length;
  while (i < src.length && src[i] !== '(') i++;
  if (i >= src.length) return null;
  i++; // skip the `(`
  // Skip whitespace and `async` keyword.
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('async', i)) i += 'async'.length;
  // The next non-whitespace char is either `(` (arrow param list) or
  // `function`. If it's neither, this is a function-reference
  // setTimeout — we treat it as opaque and skip (no inline body to scan).
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === 'f' && src.startsWith('function', i)) {
    // `setTimeout(function () { ... })` — skip past the `function` keyword.
    i += 'function'.length;
  }
  // Walk past the parameter list `(` ... `)` (could be `()` or `(arg)`).
  if (src[i] === '(') {
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
  }
  // Skip whitespace and the `=>` for arrow callbacks.
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('=>', i)) i += 2;
  while (i < src.length && /\s/.test(src[i])) i++;
  // Next char should be `{`. If it's anything else (e.g. an immediate
  // expression), there's no body block to scan.
  if (src[i] !== '{') return null;
  const bodyStart = i + 1;
  // Walk to matching `}`, skipping nested braces, string literals, and
  // template-literal expressions.
  let depth = 1;
  let j = bodyStart;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string content. Templates can contain ${...} but we don't
      // track those carefully — we just want to avoid stray `{`/`}` in
      // strings tripping the brace counter.
      const quote = ch;
      j++;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++; // skip escape
        j++;
      }
    }
    j++;
  }
  if (depth !== 0) return null;
  return src.slice(bodyStart, j - 1);
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(abs, 'utf8');
  if (!src.includes('setTimeout')) continue;
  // Find every `setTimeout(` occurrence and inspect its callback body.
  const re = /\bsetTimeout\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = extractCallbackBody(src, m.index);
    if (!body) continue;
    const hasIpc = IPC_PATTERNS.some((p) => p.test(body));
    if (!hasIpc) continue;
    const upto = src.slice(0, m.index);
    const lineNo = upto.split('\n').length;
    const snippet = src.split('\n')[lineNo - 1].trim();
    offenders.push({ rel, lineNo, snippet });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-no-adhoc-schedulers] OK — scanned ${files.length} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-no-adhoc-schedulers] FAILED — ${offenders.length} ad-hoc scheduler(s) detected:\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route the debounced write through `createScheduler` in\n' +
    'src/renderer/lib/boards/writeScheduler.ts. If you really need a\n' +
    'one-off timer-around-IPC pattern (e.g. a single-shot retry that\n' +
    'cannot share the scheduler primitive), add the file to ALLOWLIST in\n' +
    'scripts/check-no-adhoc-schedulers.mjs with a written justification.',
);
process.exit(1);
