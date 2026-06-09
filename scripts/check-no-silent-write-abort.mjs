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
 *  - FORBIDS a bare `!fm) return` UNLESS the SAME ENCLOSING FUNCTION also wires
 *    the loud-failure surface (`markPathFailed`), proving the no-FM path
 *    attributes the loss instead of resolving ok. (`frontmatterWriteScheduler.ts`
 *    keeps its one `!fm) return` precisely because `writeFrontmatter` ALSO
 *    markPathFailed+throws on the real no-editor disk-read-failure branch.)
 *
 *    ── Audit-13 M13 — same-function scoping (was file-level) ──
 *    The `markPathFailed` co-presence used to be tested across the WHOLE file, so
 *    an UNRELATED `markPathFailed('other')` in any sibling function re-opened the
 *    silent drop (bite-tested by the auditor). It is now scoped to the top-level
 *    function/construct that CONTAINS the `!fm) return`: the match's enclosing
 *    depth-0→1 brace block (found on a string/comment-blanked copy so braces in
 *    strings/comments don't skew the count) must itself contain a `markPathFailed`
 *    call. A `markPathFailed` in a different top-level function no longer satisfies
 *    it.
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
 *
 * ── Audit-14 7.2 — this gate is a TRIPWIRE, not a proof ──
 * The forbidden-shape regexes catch the exact silent-success spelling AND its
 * common variants (`=== undefined` / `== null` / optional-chained / bare
 * `continue`, via `silentAbortRe`), but a renamed local, a helper that returns
 * the guard, or a `?? return` ternary can still slip a regex. The LOAD-BEARING
 * protection is the behavioral matrices that drive a real field-edit write with
 * NO `loadDocument` and assert the edit reaches disk:
 *   src/tests/unit/kanbanFrontmatterSeedFromDisk.test.ts  (B1)
 *   src/tests/unit/auditNinePhase2.test.ts                (A9-L2 / A9-L3)
 *   src/tests/unit/audit10Phase2.test.ts                  (H2 gateway empty-cache)
 *   src/tests/unit/documentEditorHydrateFailure.test.ts   (M1 DocumentEditor)
 * Treat green here as "the obvious regressions are absent", not "the class is
 * closed". When you add a write path, add a no-editor behavioral case to those
 * matrices — not just a spelling here. The gate self-tests its own matchers on
 * every run (`selfTestFixtures`) so it can't quietly stop catching what it claims.
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
// Audit-12 M1 — the DocumentEditor twin of the silent-loss class. A failed
// on-mount hydrate read used to leave the editor blank + writable: a keystroke
// then truncated the real (unread) file on the next debounced write. The fix
// flags the failed read (`hydrateReadFailed = true`) and the write-arg builder
// REFUSES to write while it's set with no loaded body
// (`hydrateReadFailed && !lastLoadedBody`). Both distinctive tokens must
// survive so a refactor can't silently flip the editor back to "blank but
// writable on a failed read".
const DOC_EDITOR_FILE = 'src/renderer/components/boards/DocumentEditor.svelte';

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

/**
 * Offset-preserving blank of string/template/comment bodies (each char replaced
 * by a space, newlines kept) so brace-counting and match-position arithmetic see
 * only real code — braces inside a string/comment can't skew the depth count, and
 * a `!fm) return` mentioned in a comment can't trip the scan. Mirrors the proven
 * blanker in check-board-path-casefold.mjs.
 */
function blankStringsAndComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i += 1; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // template literal
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/**
 * Returns `[start, end)` of the top-level (depth-0→1) brace block that contains
 * `idx`, or `null` if the position is not inside one. In a module the top-level
 * functions ARE the depth-0→1 blocks, so this is the enclosing function/construct
 * of a statement — the scope the `markPathFailed` co-presence must live in.
 */
function topLevelBlockContaining(code, idx) {
  let depth = 0;
  let blockStart = -1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && blockStart !== -1) {
          if (idx >= blockStart && idx < i) return [blockStart, i + 1];
          blockStart = -1;
        }
      }
    }
  }
  return null;
}

/**
 * True when the blanked source contains a `!fm) return` whose enclosing top-level
 * function does NOT also call `markPathFailed` (the Audit-13 M13 same-function
 * scoping). A `!fm) return` outside any function (no enclosing block) falls back
 * to a whole-file `markPathFailed` check — a bare `return` at module scope is a
 * syntax error, so this fallback is never reached by real code; it just avoids a
 * spurious failure on a malformed file.
 */
function hasUnscopedSilentFm(blanked) {
  const re = new RegExp(SILENT_FM.source, 'g');
  let m;
  while ((m = re.exec(blanked))) {
    const block = topLevelBlockContaining(blanked, m.index);
    const scope = block ? blanked.slice(block[0], block[1]) : blanked;
    if (!MARK_PATH_FAILED.test(scope)) return true;
  }
  return false;
}

/**
 * Audit-14 7.2 — builds the forbidden "missing-VALUE guard then silent abort"
 * matcher for a variable. Broadened from the original `!x) return` literal so a
 * REFACTOR of the B1 / A9-L3 silent-success drop into another spelling can't slip
 * the tripwire. Catches the absence test as:
 *     !x        !x?.prop  /  !x.prop
 *     x === undefined   x == null   x === null   x == undefined
 *     undefined === x   null == x          (yoda)
 * immediately followed (after the `if (...)` close + optional `{`) by a BARE
 * abort verb — `return` OR `continue`. `\b${v}\b` keeps `fm` from matching inside
 * `frontmatter` / `confirm`, exactly as the prior hand-written regex did.
 *
 * This is a TRIPWIRE, NOT a proof — a renamed local, a helper that returns the
 * guard, or a `?? return` ternary can still pass it. The LOAD-BEARING guarantee
 * is the no-`loadDocument` behavioral matrices (see the file header). Treat a
 * green result here as "the obvious regressions are absent", not "the class is
 * closed"; when you add a write path, add a no-editor behavioral case, not just a
 * spelling here.
 */
function silentAbortRe(varName) {
  const v = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absent =
    `(?:!\\s*\\b${v}\\b(?:\\s*\\??\\.\\s*\\w+)?` + // !x  /  !x?.prop  /  !x.prop
    `|\\b${v}\\s*===?\\s*(?:undefined|null)` + // x === undefined / x == null …
    `|(?:undefined|null)\\s*===?\\s*\\b${v}\\b)`; // undefined === x (yoda)
  return new RegExp(`${absent}\\s*\\)\\s*\\{?\\s*(?:return|continue)\\b`);
}

// FORBIDDEN — the silent-success aborts (bare + the 7.2-broadened spellings).
const SILENT_DOCSTATE = silentAbortRe('docState');
const SILENT_FM = silentAbortRe('fm');
const ESCAPE = /\/\/\s*allow-silent-abort:\s*\S+/;
const MARK_PATH_FAILED = /markPathFailed\s*\(/;

/**
 * Audit-14 7.2 — embedded FIXTURES + intrinsic bite-check. Every alternate
 * spelling of the silent-success abort MUST trip the matcher, and every known-
 * SAFE shape must NOT, so weakening a regex without noticing fails the gate on
 * its own fixtures (the bite-check is automatic, every run). Returns a list of
 * fixture-violation messages (empty when the matchers behave).
 */
function selfTestFixtures() {
  const fails = [];
  const docStateShouldMatch = [
    'if (!docState) return;',
    'if (!docState) { return; }',
    'if (!docState) continue;',
    'if (docState === undefined) return;',
    'if (docState == null) return;',
    'if (docState === null) return result;',
    'if (!docState?.body) return;',
    'if (!docState.body) return;',
    'if (undefined === docState) return;',
  ];
  const docStateShouldNotMatch = [
    'const docState = docId ? getDoc(docId) : undefined;',
    'if (docState) { body = docState.body; }',
    'const body = docState?.body ?? "";',
    'docStateMap.delete(key); return;', // a different identifier with `return` nearby
  ];
  // `!fm` shapes WITHOUT markPathFailed in scope must flag…
  const fmUnscopedShouldFlag = [
    'function w() { const fm = idx(); if (!fm) return; }',
    'function w() { const fm = idx(); if (fm === undefined) return; }',
    'function w() { const fm = idx(); if (!fm) continue; }',
  ];
  // …and WITH markPathFailed in the same top-level function must pass (the real
  // frontmatterWriteScheduler shape: `if (!delta && !fm) return` + a later
  // markPathFailed + throw on the no-editor read failure).
  const fmScopedShouldPass = [
    'function w() { const fm = idx(); if (!fm) { markPathFailed(v, p); throw e; } if (!fm) return; }',
    'function w() { if (!delta && !fm) return; markPathFailed(v, p); throw e; }',
  ];
  for (const s of docStateShouldMatch) {
    if (!SILENT_DOCSTATE.test(blankStringsAndComments(s))) fails.push(`docState shape NOT caught: ${s}`);
  }
  for (const s of docStateShouldNotMatch) {
    if (SILENT_DOCSTATE.test(blankStringsAndComments(s))) fails.push(`safe docState shape wrongly caught: ${s}`);
  }
  for (const s of fmUnscopedShouldFlag) {
    if (!hasUnscopedSilentFm(blankStringsAndComments(s))) fails.push(`unscoped !fm shape NOT flagged: ${s}`);
  }
  for (const s of fmScopedShouldPass) {
    if (hasUnscopedSilentFm(blankStringsAndComments(s))) fails.push(`markPathFailed-scoped !fm wrongly flagged: ${s}`);
  }
  return fails;
}

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
files.sort();

const failures = [];
let scanned = 0;

// Audit-14 7.2 — run the embedded fixtures FIRST. A weakened matcher fails here
// before the real scan, so the gate can never silently degrade into a no-op that
// "passes" because its own regex stopped catching the shape it polices.
for (const f of selfTestFixtures()) {
  failures.push(`self-test fixture regressed — ${f} (a forbidden-shape matcher in this gate was weakened; restore it)`);
}

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
  // Brace-counting + match-position scoping run on a string/comment-blanked copy
  // (offset-preserving) so a comment mention of either shape can't trip the scan
  // and a brace inside a string can't skew the enclosing-function depth count.
  const blanked = blankStringsAndComments(raw);

  if (!hasEscape && SILENT_DOCSTATE.test(blanked)) {
    failures.push(
      `${rel} — found a bare \`if (!docState) return\` (the B1 silent-success-on-abort shape). ` +
        'A docId with no live docState must FALL THROUGH to a fresh disk read (or ' +
        '`markPathFailed` + `throw`), never resolve performWrite as a silent success.',
    );
  }
  // Audit-13 M13 — the `!fm) return` is allowed ONLY when the SAME enclosing
  // function also calls `markPathFailed` (was: anywhere in the file, which an
  // unrelated sibling-function `markPathFailed` re-opened).
  if (!hasEscape && hasUnscopedSilentFm(blanked)) {
    failures.push(
      `${rel} — found a bare \`if (!fm) return\` whose enclosing function has no \`markPathFailed\` ` +
        '(the A9-L3 silent-drop shape). A write armed for a path with no FM source must ' +
        'attribute the loss (`markPathFailed`) in the SAME function or route through a direct, ' +
        'loud-failing write (e.g. UpdateOrphanFrontmatterCommand) — never resolve the write as a silent success.',
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

// REQUIRED — Audit-12 M1: the DocumentEditor's failed-read branch flags the
// failure and the write-arg builder consults it. Token check on the
// comment-stripped source (a doc-comment describing the old blank-writable
// behaviour can't satisfy it).
let docEditorRaw = '';
try {
  docEditorRaw = readFileSync(join(ROOT, DOC_EDITOR_FILE), 'utf8');
} catch (err) {
  failures.push(`${DOC_EDITOR_FILE} — cannot read (REQUIRED file): ${err.message}`);
}
const docEditorCode = stripComments(docEditorRaw);
const DOC_EDITOR_REQUIRED = [
  {
    token: /hydrateReadFailed\s*=\s*true/,
    why: 'the failed hydrate-read branch flags the failure (hydrateReadFailed = true) instead of mounting a blank, writable editor',
  },
  {
    token: /hydrateReadFailed\s*&&\s*!\s*lastLoadedBody/,
    why: 'buildWriteArgs REFUSES to write while the read failed and no real body is loaded (hydrateReadFailed && !lastLoadedBody), so a keystroke into the blank editor cannot truncate the unread file',
  },
];
for (const { token, why } of DOC_EDITOR_REQUIRED) {
  if (!token.test(docEditorCode)) {
    failures.push(`${DOC_EDITOR_FILE} — missing /${token.source}/ — ${why}`);
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
      'AUDIT10_REMEDIATION_PLAN_2026-06-04.md H2 + src/tests/unit/audit10Phase2.test.ts.\n\n' +
      'For a DOC_EDITOR_FILE miss (DocumentEditor.svelte): a failed on-mount hydrate\n' +
      'read must flag `hydrateReadFailed = true` and buildWriteArgs must bail on\n' +
      '`hydrateReadFailed && !lastLoadedBody` so a keystroke into the blank editor\n' +
      "can't truncate the file Filo couldn't read (Audit-12 M1). See\n" +
      'AUDIT12_REMEDIATION_PLAN_2026-06-06.md M1 + src/tests/unit/documentEditorHydrateFailure.test.ts.',
  );
  process.exit(1);
}

console.log(
  `[check-no-silent-write-abort] OK — ${scanned} writer/scheduler file(s) scanned; no silent-success abort. ` +
    'Gateway H2 disk-re-read + DocumentEditor M1 failed-read guards present.',
);
process.exit(0);
