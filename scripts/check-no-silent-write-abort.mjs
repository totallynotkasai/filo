/**
 * Audit-8 B1 / Audit-9 L4 — `ci:no-silent-write-abort`.
 *
 * Pins the root-cause shape of the worst bug Audit-8 found: a frontmatter write
 * path that ABORTS with a BARE `return` on a missing live editor (`docState`) or
 * a missing frontmatter source (`fm`), which the scheduler then resolves as
 * SUCCESS — clearing `.filo/.dirty` and reporting "Saved" while the user's field
 * edit never reached disk.
 *
 * ── B1 (the `!docState` shape) ──
 * The 6.2.H5 guard added `if (!docState) return;` to `writeFrontmatter` so a
 * stale vault-index body could never resurrect onto disk. But a Kanban card /
 * Task row whose backing doc HAS a docId (so its FM patch was merged into the
 * keyed cache) but was NEVER opened as a Document tab has no `docState` in
 * `openDocuments`. The bare `return` then dropped the COMMON field edit (toggle
 * completed / set priority / pick dueDate) silently: performWrite resolved ok ->
 * endWrite(true) -> markClean wiped the recovery sentinel, and the `.md` was
 * never written. No error, no toast, no sentinel. Seven prior audits + the test
 * suite missed it because every disk-write test pre-loaded a docState.
 *
 * The fix unified body resolution: a docId with no live docState now falls
 * THROUGH to a fresh disk read (the same path the orphan branch uses), and a
 * read failure calls `markPathFailed` + `throw` so the loss is surfaced in the
 * save indicator + sentinel + `flushAll().failed` instead of swallowed.
 *
 * ── A9-L3 (the `!fm` shape) ──
 * A docId-less write (`scheduleFrontmatterWrite(path, null)`) resolves
 * `fm = vaultIndexStore.getMetadata(relPath)?.frontmatter`; when the path is
 * absent from the index, `if (!fm) return` is the SAME silent-success drop. The
 * fix routes docId-less Task/Kanban field edits through UpdateOrphanFrontmatter-
 * Command (a direct, undoable, loud-failing disk write) instead of arming the
 * scheduler with a null docId.
 *
 * ── H2 (Audit-10) — the gateway-twin of the same loss ──
 * The same "silently lose frontmatter on a body write" failure has a second
 * home: the markdown gateway's cache-FM branch
 * (`markdownFileWriter.ts writeMarkdownFileImpl`). A body-only editor save sets
 * `frontmatter: getFrontmatter(contentId) || {}` and passes NO `frontmatterDelta`.
 * When the FM cache was never seeded — the TextTile "adopt sibling doc" branch
 * flips hydrated=true WITHOUT seeding FM — `fm` collapses to `{}` and
 * `assembleMarkdownFile` emits BODY ONLY, deleting the on-disk YAML block. The
 * fix re-reads disk IN-CHAIN when the cache is empty (`hasFrontmatter` false) and
 * the caller's args carry no FM (`argsFmEmpty`), seeding the cache so the
 * assemble preserves the block verbatim. This gate REQUIRES that guard's
 * distinctive tokens survive in the gateway so a refactor can't quietly drop the
 * re-read and reopen the body-only-wipe. See AUDIT10_REMEDIATION_PLAN_2026-06-04
 * H2 + the gateway test in src/tests/unit/audit10Phase2.test.ts.
 *
 * ── What this gate enforces ──
 * Audit-9 L4 widened the scan from the single `frontmatterWriteScheduler.ts`
 * file (which the docstring used to overstate as the only scope) so the shape
 * can't be reintroduced in `kanbanFrontmatterWriter`, `tasklist/frontmatter-
 * Writer`, or a future scheduler unguarded. It walks every frontmatter WRITER +
 * write SCHEDULER under
 *     src/renderer/lib/{boards,kanban,tasklist}/**   (basename =~ /riter|scheduler/i)
 * and on a comment-stripped copy of each:
 *  - FORBIDS `!docState) return` / `!docState) { return` (the B1 shape).
 *  - FORBIDS a bare `!fm) return` UNLESS that file also wires the loud-failure
 *    surface (`markPathFailed`), proving the no-FM path attributes the loss
 *    instead of resolving ok. (`frontmatterWriteScheduler.ts` keeps its one
 *    `!fm) return` precisely because it ALSO markPathFailed+throws on the real
 *    no-editor disk-read-failure branch.)
 * Plus, on `frontmatterWriteScheduler.ts` specifically — the one file that
 * resolves a write body from disk:
 *  - REQUIRES both `markPathFailed` and `readMarkdownForHydrate` survive, proving
 *    the no-docState branch still reads disk for the canonical body and
 *    attributes a failure instead of returning ok.
 *
 * Heuristic token check on a comment-stripped copy (same pragmatic style as
 * check-awaited-writes-bounded.mjs / check-no-dead-flush.mjs), not an AST walk —
 * a doc-comment that merely describes the old shape can't trip it. Escape hatch
 * for a genuinely intentional silent return on a NON-write path:
 * `// allow-silent-abort: <reason>` anywhere in that file.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = [
  'src/renderer/lib/boards',
  'src/renderer/lib/kanban',
  'src/renderer/lib/tasklist',
];
// The loud-failure surface (markPathFailed + readMarkdownForHydrate) is asserted
// on the one file that actually resolves a write body from disk.
const SCHEDULER_FILE = 'src/renderer/lib/boards/frontmatterWriteScheduler.ts';
// Audit-10 H2 — the markdown gateway's cache-FM branch must re-read disk when the
// FM cache is empty so a body-only save can't assemble against `{}` and strip an
// on-disk YAML block. Asserted positively (the guard's distinctive tokens must
// survive), mirroring the SCHEDULER_FILE REQUIRED block below.
const GATEWAY_FILE = 'src/renderer/lib/vault/markdownFileWriter.ts';

// Writers (`*riter*` — "writer" contains "riter") + schedulers (`*scheduler*`):
// the files that own a frontmatter write path. Case-insensitive substring on the
// basename, matching the plan's `**/*riter*.ts` + the schedulers.
const SCAN_BASENAME = /(riter|scheduler)/i;

function toPosix(p) {
  return p.split(sep).join('/');
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
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (s.isFile() && entry.endsWith('.ts') && SCAN_BASENAME.test(entry)) out.push(full);
  }
}

/** Strip block + line comments so a doc-comment mention can't satisfy/trip a check. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

// FORBIDDEN — the bare silent-success aborts.
const SILENT_DOCSTATE = /!\s*docState\s*\)\s*\{?\s*return\b/;
const SILENT_FM = /!\s*\bfm\b\s*\)\s*\{?\s*return\b/;
const ESCAPE = /\/\/\s*allow-silent-abort:\s*\S+/;
const MARK_PATH_FAILED = /markPathFailed\s*\(/;

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
files.sort();

const failures = [];
let scanned = 0;

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    failures.push(`${rel} — cannot read: ${err.message}`);
    continue;
  }
  scanned++;
  // The escape hatch is matched against the RAW source (before comment strip).
  const hasEscape = ESCAPE.test(raw);
  const code = stripComments(raw);
  const hasMarkPathFailed = MARK_PATH_FAILED.test(code);

  if (!hasEscape && SILENT_DOCSTATE.test(code)) {
    failures.push(
      `${rel} — found a bare \`if (!docState) return\` (the B1 silent-success-on-abort shape). ` +
        'A docId with no live docState must FALL THROUGH to a fresh disk read (or ' +
        '`markPathFailed` + `throw`), never resolve performWrite as a silent success.',
    );
  }
  if (!hasEscape && SILENT_FM.test(code) && !hasMarkPathFailed) {
    failures.push(
      `${rel} — found a bare \`if (!fm) return\` with no \`markPathFailed\` in the file ` +
        '(the A9-L3 silent-drop shape). A write armed for a path with no FM source must ' +
        'attribute the loss (`markPathFailed`) or route through a direct, loud-failing ' +
        'write (e.g. UpdateOrphanFrontmatterCommand) — never resolve the write as a silent success.',
    );
  }
}

// REQUIRED — the loud-failure surface stays wired in the scheduler's write path.
let schedRaw = '';
try {
  schedRaw = readFileSync(join(ROOT, SCHEDULER_FILE), 'utf8');
} catch (err) {
  failures.push(`${SCHEDULER_FILE} — cannot read (REQUIRED file): ${err.message}`);
}
const schedCode = stripComments(schedRaw);
const REQUIRED = [
  { token: /markPathFailed\s*\(/, why: 'the no-live-editor read failure attributes the loss (markPathFailed)' },
  { token: /readMarkdownForHydrate\s*\(/, why: 'the no-docState branch reads the canonical body from disk' },
];
for (const { token, why } of REQUIRED) {
  if (!token.test(schedCode)) {
    failures.push(`${SCHEDULER_FILE} — missing /${token.source}/ — ${why}`);
  }
}

// REQUIRED — Audit-10 H2: the gateway's cache-FM branch re-reads disk when the
// FM cache is empty. `hasFrontmatter(` (the never-seeded-vs-deliberate-`{}`
// probe) and `argsFmEmpty` (the empty-caller-args guard) are introduced SOLELY
// by the H2 fix and appear nowhere else in the gateway, so their joint presence
// pins the re-read. Token check on the comment-stripped source (same heuristic
// style as above) — a doc-comment describing the old wipe can't satisfy it.
let gatewayRaw = '';
try {
  gatewayRaw = readFileSync(join(ROOT, GATEWAY_FILE), 'utf8');
} catch (err) {
  failures.push(`${GATEWAY_FILE} — cannot read (REQUIRED file): ${err.message}`);
}
const gatewayCode = stripComments(gatewayRaw);
const GATEWAY_REQUIRED = [
  {
    token: /hasFrontmatter\s*\(/,
    why: 'the cache-FM branch probes the never-seeded FM cache (hasFrontmatter) before assembling, so a deliberate `{}` seed is trusted but a never-seeded doc re-reads disk',
  },
  {
    token: /argsFmEmpty/,
    why: 'the body-only re-read engages only when the caller passes no FM (argsFmEmpty), the exact case that would otherwise assemble against `{}` and wipe the on-disk YAML block',
  },
];
for (const { token, why } of GATEWAY_REQUIRED) {
  if (!token.test(gatewayCode)) {
    failures.push(`${GATEWAY_FILE} — missing /${token.source}/ — ${why}`);
  }
}

if (failures.length > 0) {
  console.error('[check-no-silent-write-abort] FAILED — silent-write-abort invariant regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nA frontmatter write for an un-opened Kanban card / Task row (docId present,\n' +
      'no live docState) OR a docId-less field edit (no FM source) must persist the\n' +
      'edit — resolve the body from a fresh disk read, or route a direct undoable\n' +
      'write — and on failure call markPathFailed + throw so the loss surfaces in the\n' +
      'save indicator, the .filo/.dirty sentinel, and flushAll().failed. A bare\n' +
      '`if (!docState) return` / `if (!fm) return` resolves the write as a silent\n' +
      'SUCCESS (markClean wipes the sentinel) and the edit is lost on quit. See\n' +
      'AUDIT8_REMEDIATION_PLAN_2026-06-04.md B1, AUDIT9_REMEDIATION_PLAN_2026-06-04.md\n' +
      'A9-L3/L4, and the no-loadDocument cases in\n' +
      'src/tests/unit/kanbanFrontmatterSeedFromDisk.test.ts.\n\n' +
      'For a GATEWAY_FILE miss (markdownFileWriter.ts): the cache-FM branch must\n' +
      're-read disk when the FM cache is empty (Audit-10 H2) so a body-only save\n' +
      "can't assemble against `{}` and strip the on-disk YAML block. See\n" +
      'AUDIT10_REMEDIATION_PLAN_2026-06-04.md H2 + src/tests/unit/audit10Phase2.test.ts.',
  );
  process.exit(1);
}

console.log(
  `[check-no-silent-write-abort] OK — ${scanned} writer/scheduler file(s) scanned; no silent-success abort. ` +
    'Gateway H2 disk-re-read guard present.',
);
process.exit(0);
