/**
 * Phase 6.1.R1 CI gate — `applyReloadFromDisk` self-cancels gateway writes.
 *
 * Class-kill: "Reload silently overwrites a typed body". The mechanism was
 * that `documentStore.applyReloadFromDisk(...)` replaced state but did NOT
 * cancel an armed body writer for the docId. The gateway's
 * `scheduleMarkdownWrite` closure-captures `args.body` at schedule time, so
 * a still-armed timer fires ~250 ms after the Reload carrying the pre-
 * Reload typed body and silently inverts the user's choice.
 *
 * Phase 6.0.C2 moved `cancelMarkdownWritesForDocument(docId)` inside
 * `applyReloadFromDisk` itself, making the contract automatic. Phase 6.1.R1
 * hoisted the disk-mutation-then-restore sites (ReplaceAllCommand,
 * CascadeDeleteCommand.undo, tagRewriteSweep, recreateDeletedFile) into a
 * shared `syncOpenEditorsAfterDiskMutation` helper that goes through the
 * self-cancelling `applyReloadFromDisk`.
 *
 * After R1, NO call site outside the gateway, the document store, or the
 * shared helper has a legitimate reason to call
 * `cancelMarkdownWritesForDocument` directly. Manually calling it adjacent
 * to `applyReloadFromDisk` is the very pattern the class-kill replaces:
 * it doubles the cancel, hides the contract from the next reader, and
 * teaches future code to forget the cancel when copying the pattern.
 *
 * This gate scans `src/renderer/**` and fails when any file outside the
 * allowed list calls `cancelMarkdownWritesForDocument`. Tests can still
 * use it (they import the API directly to drive fixtures).
 *
 * Fixing a failure:
 *   - If you have a "I just wrote disk authoritatively, sync open editors"
 *     site, call `syncOpenEditorsAfterDiskMutation([{path, content}, …])`
 *     from `lib/vault/syncOpenEditorsAfterDiskMutation`. It goes through
 *     `applyReloadFromDisk`, which self-cancels.
 *   - If you really need a bare cancel (no reload), reconsider — the
 *     reload + cancel pairing is the entire reason for the helper. If
 *     it's still warranted, add the file to ALLOWED_FILES with a one-line
 *     reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = [join(ROOT, 'src/renderer')];
const EXTENSIONS = ['.ts', '.svelte'];

/**
 * Files that may call `cancelMarkdownWritesForDocument` directly. Keep the
 * list short — each entry should be defensible in 10 seconds.
 */
const ALLOWED_FILES = new Set([
  // The gateway exports the function — has to reference it.
  'src/renderer/lib/vault/markdownFileWriter.ts',
  // The document store calls it from inside `applyReloadFromDisk` — the
  // class-kill chokepoint itself.
  'src/renderer/stores/document.svelte.ts',
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

/**
 * Strip block + line comments while preserving line counts so a line number
 * reported by a downstream regex match aligns with what the user sees in
 * their editor. Block-comment bodies are replaced with their newline-only
 * shadow; line comments are dropped from the line after the `//` up to
 * (but not including) the newline.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const offenders = [];
const allowedHits = new Set();

// Match call-site shape: `cancelMarkdownWritesForDocument(` followed by anything.
// A backticked mention in a docstring (`` `cancelMarkdownWritesForDocument` ``)
// has no `(` after the identifier, so the regex skips comment references and
// only flags real call sites.
const CALL_RE = /\bcancelMarkdownWritesForDocument\s*\(/;

const files = [];
for (const root of SCAN_ROOTS) walkExt(root, EXTENSIONS, files);

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  if (!CALL_RE.test(code)) continue;
  if (ALLOWED_FILES.has(rel)) {
    allowedHits.add(rel);
    continue;
  }
  // Find the offending lines so the error message points at the call site,
  // not just the file. Re-scan per-line with comments stripped so a single
  // comment line that mentions the name in backticks doesn't surface as a
  // false-positive offender row (the body-level check above already used
  // the comment-stripped source as the trigger).
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  for (let i = 0; i < codeLines.length; i++) {
    if (CALL_RE.test(codeLines[i])) {
      offenders.push({ rel, line: i + 1, snippet: rawLines[i].trim() });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    '[check-reload-cancels-writes] FAILED — ' + offenders.length +
      ' direct call(s) to cancelMarkdownWritesForDocument outside the allowed sites:',
  );
  for (const o of offenders) {
    console.error(`  ${o.rel}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nThis function is the gateway-internal cancel for armed body writers. After Phase 6.1.R1,\n' +
      'all disk-mutation-then-restore sites should route through\n' +
      '  `syncOpenEditorsAfterDiskMutation` (src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts)\n' +
      'which goes through `applyReloadFromDisk` — which self-cancels (Phase 6.0.C2).\n' +
      "Manually calling the cancel adjacent to applyReloadFromDisk is the very pattern the\n" +
      "class-kill replaces: it doubles the cancel and teaches future code to forget it.\n" +
      "Escape hatch: add the file path to ALLOWED_FILES in scripts/check-reload-cancels-writes.mjs\n" +
      "with a one-line reason.\n",
  );
  process.exit(1);
}

// Stale-allowlist check: every entry in ALLOWED_FILES should actually
// reference the token; if not, the entry is dead and should be removed.
const staleAllowed = [];
for (const rel of ALLOWED_FILES) {
  if (!allowedHits.has(rel)) staleAllowed.push(rel);
}
if (staleAllowed.length > 0) {
  console.error(
    '[check-reload-cancels-writes] FAILED — stale ALLOWED_FILES entries (no longer call the token):',
  );
  for (const rel of staleAllowed) console.error(`  ${rel}`);
  console.error('\nFix: remove these from ALLOWED_FILES in scripts/check-reload-cancels-writes.mjs.');
  process.exit(1);
}

console.log(
  `[check-reload-cancels-writes] OK — scanned ${files.length} file(s); ` +
    `${allowedHits.size} allowed call site(s), 0 offenders.`,
);
process.exit(0);
