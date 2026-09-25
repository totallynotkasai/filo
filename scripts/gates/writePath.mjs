// Write-path ratchets: markdown/frontmatter gateways, schedulers and the
// "never silently lose or misdirect a write" invariants.
import {
  fail, blank, functionBody, lineAt, matchBrace, stripComments, stripCommentsKeepLines, stripCommentsStateful, tokenChecks,
} from './lib.mjs';

const RENDERER = 'src/renderer';
const TS_SVELTE = ['.ts', '.svelte'];
// The one module allowed to write a note (.md), and the pieces of its contract.
const NOTE_WRITER = 'src/renderer/lib/notes/noteWriter.ts';
const NOTE_FILE = 'src/renderer/lib/notes/noteFile.ts';
const NOTE_STORE = 'src/renderer/stores/notes.svelte.ts';
// A real invoke of a markdown write channel (comments/docstrings don't have the `invoke(` prefix).
const MD_WRITE_RE = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:(?:write-(?:existing-)?|create-)file-text['"`]/gs;

// Every scheduler whose write can wedge (drift prompt / stalled volume) must race a finite timeout.
const TIMEOUT_FINITE = { token: /writeTimeoutMs\s*:\s*[A-Z_][A-Z0-9_]*\b/, why: 'writeTimeoutMs is a finite SCREAMING_SNAKE constant' };
const TIMEOUT_UNBOUNDED = {
  token: /writeTimeoutMs\s*:\s*(?:Infinity|Number\s*\.\s*POSITIVE_INFINITY|undefined|null|NaN)\b/,
  why: 'an unbounded writeTimeoutMs lets a wedged write hang flush/save/quit forever',
};
const BOUNDED_FILES = [
  {
    file: 'src/renderer/lib/boards/writeScheduler.ts',
    required: [
      { token: /writeTimeoutMs/, why: 'the configurable bound option' },
      { token: /Promise\.race\s*\(\s*\[[^\]]*\btimeout\b/, why: 'the race array includes the timeout promise' },
      { token: /resolve\(\s*WRITE_TIMEOUT\s*\)/, why: 'the timer resolves to the WRITE_TIMEOUT sentinel' },
      { token: /===\s*WRITE_TIMEOUT/, why: 'the race outcome is compared to WRITE_TIMEOUT' },
      { token: /setTimeout\s*\(/, why: 'the timeout timer' },
      { token: /drainPriorInFlight\(key\)/, why: 'the debounce-timer fire drains an older in-flight write first (newest lands last)' },
      { token: /drainPriorInFlight\(entry\.key\)/, why: 'flushAll drains an older in-flight write per key first' },
      { token: /clearFailedPathAfterLateSuccess\s*\(/, why: 'a timed-out write that later succeeds clears its failed mark' },
    ],
  },
  { file: NOTE_WRITER, required: [TIMEOUT_FINITE], forbidden: [TIMEOUT_UNBOUNDED] },
  { file: 'src/renderer/lib/boards/boardWriteScheduler.ts', required: [TIMEOUT_FINITE], forbidden: [TIMEOUT_UNBOUNDED] },
  {
    file: 'src/renderer/lib/boards/boardWriteDebounce.ts',
    required: [{ token: /WRITE_TIMEOUT_MS\s*=\s*[0-9][0-9_]*\b/, why: 'WRITE_TIMEOUT_MS is a finite numeric literal' }],
    forbidden: [{ token: /WRITE_TIMEOUT_MS\s*=\s*(?:Infinity|Number\s*\.\s*POSITIVE_INFINITY)\b/, why: 'an Infinity bound un-bounds every scheduler' }],
  },
];
// Windows lock backoff (sync clients / AV hold handles for seconds) is time-bounded and shared.
const LOCK_RETRY = [
  {
    file: 'src/main/vault/filenameUtils.ts',
    fn: 'retryOnWindowsLock',
    required: [
      { token: /Date\.now\(\)|performance\.now\(\)/, why: 'measures elapsed time' },
      { token: /elapsed\s*>=?\s*budgetMs|budgetMs\s*<=?\s*elapsed/, why: 'stops on an elapsed-time budget, not an attempt count' },
    ],
  },
  {
    file: 'src/main/vault/filenameUtils.ts',
    fn: 'atomicWriteFile',
    required: [{ token: /retryOnWindowsLock\s*\(\s*\(\)\s*=>\s*fs\.rename\(\s*tmpPath\s*,\s*filePath\s*\)/, why: 'the tmp→target rename retries a transient lock' }],
    forbidden: [{ token: /\bRETRY_DELAYS_MS\s*=\s*\[/, why: 'a count-based delay table re-introduces the ~310 ms budget' }],
  },
  {
    file: 'src/main/vault/fileOps.ts',
    fn: 'renameItem',
    required: [{ token: /retryOnWindowsLock\s*\(\s*\(\)\s*=>\s*fs\.rename\(\s*oldPath\s*,\s*newPath\s*\)/, why: 'a rename retries a transient Windows lock' }],
  },
];

// ── no-silent-write-abort ─────────────────────────────────────────────────
/** A missing-value guard on `v` immediately followed by a bare `return` / `continue`. */
function silentAbortRe(v) {
  const absent = `(?:!\\s*\\b${v}\\b(?:\\s*\\??\\.\\s*\\w+)?|\\b${v}\\s*===?\\s*(?:undefined|null)|(?:undefined|null)\\s*===?\\s*\\b${v}\\b)`;
  return new RegExp(`${absent}\\s*\\)\\s*\\{?\\s*(?:return|continue)\\b`);
}
const SILENT_DOCSTATE = silentAbortRe('docState');
const SILENT_FM = silentAbortRe('fm');
// A POSITIVE read-only test followed by a bare abort (a field delta on a read-only doc must still be written).
const SILENT_READONLY = /(?:isReadOnly\s*\([^()]*(?:\([^()]*\)[^()]*)*\)|(?<![!\w])readOnly\w*)\s*(?:&&[^)\n]*)?\)\s*\{?\s*(?:return|continue)\b/;
const MARK_PATH_FAILED = /markPathFailed\s*\(/;

/** `[start, end)` of the depth-0 → 1 brace block containing `idx`, or null. */
function topLevelBlock(code, idx) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (code[i] === '}' && depth > 0 && --depth === 0 && start !== -1) {
      if (idx >= start && idx < i) return [start, i + 1];
      start = -1;
    }
  }
  return null;
}
/** A `!fm) return` whose enclosing top-level function has no markPathFailed. */
function unscopedSilentFm(code) {
  for (const m of code.matchAll(new RegExp(SILENT_FM.source, 'g'))) {
    const b = topLevelBlock(code, m.index);
    if (!MARK_PATH_FAILED.test(b ? code.slice(b[0], b[1]) : code)) return true;
  }
  return false;
}
/** The matchers above must keep catching every known spelling (and nothing safe). */
function selfTest() {
  const out = [];
  const t = (re, s) => re.test(blank(s));
  const cases = [
    [SILENT_DOCSTATE, true, ['if (!docState) return;', 'if (!docState) { return; }', 'if (!docState) continue;', 'if (docState === undefined) return;',
      'if (docState == null) return;', 'if (docState === null) return result;', 'if (!docState?.body) return;', 'if (!docState.body) return;',
      'if (undefined === docState) return;']],
    [SILENT_DOCSTATE, false, ['const docState = docId ? getDoc(docId) : undefined;', 'if (docState) { body = docState.body; }',
      'const body = docState?.body ?? "";', 'docStateMap.delete(key); return;']],
    [SILENT_READONLY, true, ['if (docId && documentStore.isReadOnly(docId)) return;', 'if (documentStore.isReadOnly(docId)) { return; }',
      'if (readOnlyDoc) return;', 'if (readOnlyDoc && !delta) return;', 'if (readOnlyDoc) continue;', 'if (documentStore.isReadOnly(idOf(tile))) return;']],
    [SILENT_READONLY, false, ['const readOnlyDoc = docId ? documentStore.isReadOnly(docId) : false;',
      'if (readOnlyDoc && !delta) {\n  reportError(k, null, msg);\n  markPathFailed(v, p);\n  throw new Error(msg);\n}',
      'const docState = docId && !readOnlyDoc ? documentStore.getDocument(docId) : undefined;', 'if (!readOnlyDoc) return;']],
  ];
  for (const [re, expect, list] of cases) for (const s of list) if (t(re, s) !== expect) out.push(`matcher ${expect ? 'missed' : 'wrongly caught'}: ${s}`);
  for (const s of ['function w() { const fm = idx(); if (!fm) return; }', 'function w() { const fm = idx(); if (fm === undefined) return; }',
    'function w() { const fm = idx(); if (!fm) continue; }']) if (!unscopedSilentFm(blank(s))) out.push(`unscoped !fm missed: ${s}`);
  for (const s of ['function w() { const fm = idx(); if (!fm) { markPathFailed(v, p); throw e; } if (!fm) return; }',
    'function w() { if (!delta && !fm) return; markPathFailed(v, p); throw e; }']) if (unscopedSilentFm(blank(s))) out.push(`scoped !fm wrongly flagged: ${s}`);
  return out;
}
const EDITOR_FREEZE_TOKENS = [
  { token: /unreadable\s*=\s*\$derived\(\s*model\?\.status\s*===\s*'unreadable'\s*\)/, why: 'a failed read is flagged instead of leaving a blank, writable editor' },
  { token: /frozen\s*=[^;]*\bunreadable\b/, why: 'the editor stays non-editable while the note could not be read' },
];

// ── single-note-writer: the writer's contract and its callers ────────────
const NOTE_WRITER_CONTRACT = [
  {
    file: 'src/renderer/lib/vault/frontmatterDelta.ts',
    required: [
      { token: /export\s+function\s+patchToFrontmatterDelta\b/, why: 'patch → delta builder' },
      { token: /export\s+function\s+diffToFrontmatterDelta\b/, why: 'snapshot diff → delta builder' },
      { token: /export\s+function\s+applyFrontmatterDelta\b/, why: 'delta applier' },
    ],
  },
  {
    file: NOTE_FILE,
    within: 'assembleNoteText',
    required: [
      { token: /applyFrontmatterDelta\s*\(\s*fresh\.frontmatter/, why: 'the written frontmatter derives from the fresh read' },
      { token: /originalFrontmatter\s*:\s*fresh\.rawFrontmatter/, why: 'the source-preserving baseline comes from the same read' },
      { token: /bom\s*:\s*fresh\.hadBom/, why: 'the BOM follows the fresh read' },
      { token: /change\.body\s*\?\?\s*fresh\.body/, why: 'without a new body the disk body is kept' },
    ],
  },
  {
    file: NOTE_WRITER,
    within: 'writePending',
    required: [
      { token: /readNoteFresh\s*\(/, why: 'every flush reads the file fresh' },
      { token: /assembleNoteText\s*\(\s*fresh\.text/, why: 'the change applies to that fresh read' },
      { token: /sameBody\s*\(\s*fresh\.text\.body\s*,\s*snapshotBody\s*\(\s*base\s*\)\s*\)/, why: 'a body change on disk is detected against the base' },
      { token: /onBodyConflict\s*\(/, why: 'a drifted body is handed to the store, never written over' },
      { token: /text\s*!==\s*fresh\.text\.raw/, why: 'identical bytes are not written' },
    ],
  },
  { file: 'src/renderer/commands/noteFieldCommand.ts', required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'field commands send a delta' }] },
  {
    file: 'src/renderer/commands/frontmatterRebase.ts',
    required: [{ token: /noteStore\.patchFrontmatter\s*\([^)]*patchToFrontmatterDelta\s*\(/, why: 'the undo/redo rebase sends a delta' }],
  },
  { file: 'src/renderer/commands/propertiesCommands.ts', required: [{ token: /noteStore\.patchFrontmatter\s*\(/, why: 'UpdatePropertiesCommand sends a delta' }] },
  {
    file: 'src/renderer/components/tiles/PropertiesPopup.svelte',
    required: [
      { token: /diffToFrontmatterDelta\s*\(/, why: 'the popup sends only what changed' },
      { token: /noteStore\.patchFrontmatter\s*\(/, why: 'through the note store' },
    ],
  },
  {
    file: NOTE_STORE,
    within: 'recreate',
    required: [{ token: /writer\.createExclusive\s*\(/, why: 'a note deleted on disk is written back exclusively (never over a file that came back)' }],
  },
];

// ── keep-local-backup ─────────────────────────────────────────────────────
const KEEP_LOCAL_CHOKEPOINTS = [
  { file: 'src/renderer/lib/boards/boardWriteScheduler.ts', fn: 'writeBoardFile' },
  { file: 'src/renderer/stores/notePrompts.ts', fn: 'promptConflict' },
];

/** Index of the `{` enclosing `pos` (nearest unmatched), or -1. */
function enclosingOpen(code, pos) {
  let depth = 0;
  for (let k = pos - 1; k >= 0; k--) {
    if (code[k] === '}') depth++;
    else if (code[k] === '{') { if (depth === 0) return k; depth--; }
  }
  return -1;
}

/** setTimeout callback body (inline arrow / function), or null for a function reference. */
function setTimeoutBody(src, at) {
  let i = src.indexOf('(', at);
  if (i < 0) return null;
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('async', i)) i += 5;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('function', i)) i += 8;
  if (src[i] === '(') {
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
  }
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('=>', i)) i += 2;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      j++;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j++;
        j++;
      }
    }
    j++;
  }
  return depth === 0 ? src.slice(i + 1, j - 1) : null;
}

export const checks = [
  {
    id: 'single-note-writer',
    title: 'only noteWriter writes a note, applying each change to a fresh read of the file',
    hint:
      'Route every .md change through noteStore (setBody / patchFrontmatter / transform / createUnique / restore). ' +
      'A write of a non-note file (a .filo/ sentinel or config) may use `// allow-direct-write: <reason>` on the call, ' +
      'the channel line or up to 4 lines above.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        if (rel === NOTE_WRITER) continue;
        const text = ctx.read(rel);
        const lines = text.split('\n');
        for (const m of text.matchAll(MD_WRITE_RE)) {
          const line = lineAt(text, m.index);
          const endLine = lineAt(text, m.index + m[0].length - 1);
          const ESC = /\/\/ allow-direct-write:/;
          const escaped = [line, endLine, line - 1, line - 2, line - 3, line - 4].some((n) => n >= 1 && ESC.test(lines[n - 1] ?? ''));
          if (!escaped) out.push(fail(rel, line, `a text write outside noteWriter: ${(lines[line - 1] ?? '').trim()}`));
        }
      }
      for (const c of NOTE_WRITER_CONTRACT) {
        const raw = ctx.read(c.file);
        if (raw === null) { out.push(fail(c.file, undefined, 'file missing')); continue; }
        let scope = stripComments(raw);
        if (c.within) {
          const fn = functionBody(blank(raw), c.within, { fnKeyword: true }) ?? functionBody(blank(raw), c.within);
          if (!fn) { out.push(fail(c.file, undefined, `${c.within}() not found`)); continue; }
          scope = blank(raw, { strings: false }).slice(fn.start, fn.end);
        }
        out.push(...tokenChecks(c.file, scope, c, c.within ? `${c.within}()` : ''));
      }
      return out;
    },
  },
  {
    id: 'note-queue-per-path',
    title: 'a note file is renamed or deleted only while its write queue is held',
    hint:
      "A write that starts while its file moves lands on the old path (or recreates it). vaultOperations' " +
      'renameVaultPath / deleteVaultPath run the IPC inside noteStore.hold(...), and noteWriter.hold enters every ' +
      "path's queue before the operation runs.",
    run(ctx) {
      const out = [];
      const OPS = 'src/renderer/lib/vault/vaultOperations.ts';
      const raw = ctx.read(OPS);
      if (raw === null) return [fail(OPS, undefined, 'file missing')];
      const code = blank(raw);
      const text = blank(raw, { strings: false });
      for (const [fn, channel] of [['renameVaultPath', 'vault:rename'], ['deleteVaultPath', 'vault:delete']]) {
        const b = functionBody(code, fn, { fnKeyword: true });
        if (!b) { out.push(fail(OPS, undefined, `${fn}() not found`)); continue; }
        const body = text.slice(b.start, b.end);
        const hold = body.indexOf('noteStore.hold(');
        const ipc = body.indexOf(`'${channel}'`);
        if (hold < 0 || ipc < 0 || ipc < hold) out.push(fail(OPS, undefined, `${fn}() must run '${channel}' inside noteStore.hold(...)`));
      }
      const writerRaw = ctx.read(NOTE_WRITER);
      if (writerRaw === null) return [...out, fail(NOTE_WRITER, undefined, 'file missing')];
      const hold = functionBody(blank(writerRaw), 'hold');
      if (!hold) out.push(fail(NOTE_WRITER, undefined, 'hold() not found'));
      else if (!/onPath\s*\(/.test(blank(writerRaw).slice(hold.start, hold.end))) {
        out.push(fail(NOTE_WRITER, undefined, "hold() must enter each path's queue (onPath)"));
      }
      return out;
    },
  },
  {
    id: 'legacy-read',
    title: "vault:read-file-text is called with (vaultRoot, relPath), never a built absolute path",
    hint: 'The single-arg form fails validation and falls back to stale content, which the next save writes back.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(['src/main', RENDERER], { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        ctx.read(rel).split('\n').forEach((line, i) => {
          if (/['"]vault:read-file-text['"]\s*,\s*`/.test(line)) out.push(fail(rel, i + 1, `template-literal path: ${line.trim()}`));
          else if (/['"]vault:read-file-text['"]\s*,\s*[^,)]*\+/.test(line)) out.push(fail(rel, i + 1, `concatenated path: ${line.trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'awaited-writes-bounded',
    title: 'wedge-prone writes race a finite timeout; flushes land newest-last; lock retry is time-bounded',
    hint:
      'An unbounded await on a drift prompt or stalled volume hangs flushAll / save() / quit forever. Keep the ' +
      'Promise.race timeout, the per-key drains, the late-success self-heal and the shared retryOnWindowsLock.',
    run(ctx) {
      const out = [];
      for (const f of BOUNDED_FILES) {
        const raw = ctx.read(f.file);
        if (raw === null) { out.push(fail(f.file, undefined, 'file missing')); continue; }
        out.push(...tokenChecks(f.file, stripComments(raw), f));
      }
      for (const arm of LOCK_RETRY) {
        const raw = ctx.read(arm.file);
        if (raw === null) { out.push(fail(arm.file, undefined, 'file missing')); continue; }
        const fn = functionBody(stripComments(raw), arm.fn, { fnKeyword: true });
        if (!fn) { out.push(fail(arm.file, undefined, `${arm.fn}() not found`)); continue; }
        out.push(...tokenChecks(arm.file, fn.text, arm, `${arm.fn}()`));
      }
      return out;
    },
  },
  {
    id: 'failed-write-refire',
    title: 'transiently failed writes are retained and re-fired by flushAll / Retry',
    hint:
      'An edit whose write lost a sync/AV lock otherwise exists only in memory. Keep drainRetained() in flushAll, ' +
      'ledger.retain() in fireWrite, and lock codes (never user-deferred ones) in RETAINABLE.',
    run(ctx) {
      const out = [];
      const SCHED = 'src/renderer/lib/boards/writeScheduler.ts';
      const FAILS = 'src/renderer/lib/boards/writeSchedulerFailures.ts';
      const sched = ctx.read(SCHED);
      if (sched === null) out.push(fail(SCHED, undefined, 'file missing'));
      else {
        const code = stripCommentsStateful(sched);
        const flushAll = functionBody(code, 'flushAll', { fnKeyword: true });
        if (!flushAll) out.push(fail(SCHED, undefined, 'flushAll() not found'));
        else if (!/\bdrainRetained\s*\(/.test(flushAll.text)) out.push(fail(SCHED, undefined, 'flushAll() never calls drainRetained('));
        const fire = functionBody(code, 'fireWrite', { fnKeyword: true });
        if (!fire) out.push(fail(SCHED, undefined, 'fireWrite() not found'));
        else if (!/\bledger\.retain\s*\(/.test(fire.text)) out.push(fail(SCHED, undefined, 'fireWrite() never retains a transient failure (ledger.retain)'));
      }
      const failsRaw = ctx.read(FAILS);
      if (failsRaw === null) return [...out, fail(FAILS, undefined, 'file missing')];
      const m = /export\s+const\s+RETAINABLE\b[^=]*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(stripCommentsStateful(failsRaw));
      if (!m) return [...out, fail(FAILS, undefined, '`export const RETAINABLE = new Set([...])` not found')];
      const codes = [...m[1].matchAll(/['"`]([A-Z_]+)['"`]/g)].map((x) => x[1]);
      for (const c of ['EPERM', 'EBUSY', 'EACCES']) if (!codes.includes(c)) out.push(fail(FAILS, undefined, `RETAINABLE is missing lock code '${c}'`));
      for (const c of ['EXTERNAL_EDIT', 'DEFER', 'DEFERRED', 'CONFIG_CORRUPT']) {
        if (codes.includes(c)) out.push(fail(FAILS, undefined, `RETAINABLE must not contain '${c}' (a user-deferred write would re-prompt during quit)`));
      }
      return out;
    },
  },
  {
    id: 'no-silent-write-abort',
    title: 'note and frontmatter write paths fail loudly instead of resolving an abort as success',
    hint:
      'A bare `if (!docState) return` / `if (!fm) return` / read-only return resolves the write as SUCCESS (the dirty ' +
      'sentinel is cleared) while the edit never reaches disk. Read disk instead, or markPathFailed + throw. ' +
      'Escape (non-write path only): `// allow-silent-abort: <reason>` in the file.',
    run(ctx) {
      const out = selfTest().map((s) => fail('scripts/gates/writePath.mjs', undefined, `self-test: ${s}`));
      for (const rel of ctx.files(['src/renderer/lib/boards', 'src/renderer/lib/kanban', 'src/renderer/lib/tasklist', 'src/renderer/lib/notes'], {
        ext: ['.ts'],
        name: /(riter|scheduler)/i,
      })) {
        const raw = ctx.read(rel);
        if (/\/\/\s*allow-silent-abort:\s*\S+/.test(raw)) continue;
        const code = blank(raw);
        if (SILENT_DOCSTATE.test(code)) out.push(fail(rel, undefined, 'bare `if (!docState) return` — fall through to a disk read or markPathFailed + throw'));
        if (SILENT_READONLY.test(code)) out.push(fail(rel, undefined, 'bare read-only abort — a delta must still be written; a delta-less write must refuse loudly'));
        if (unscopedSilentFm(code)) out.push(fail(rel, undefined, 'bare `if (!fm) return` with no markPathFailed in the same function'));
      }
      const need = (file, tokens, label, within) => {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'required file missing')); return; }
        let scope = stripComments(raw);
        if (within) {
          const fn = functionBody(blank(raw), within, { fnKeyword: true }) ?? functionBody(blank(raw), within);
          if (!fn) { out.push(fail(file, undefined, `${within}() not found`)); return; }
          scope = blank(raw, { strings: false }).slice(fn.start, fn.end);
        }
        out.push(...tokenChecks(file, scope, { required: tokens }, label));
      };
      need(NOTE_WRITER, [
        { token: /markPathFailed\s*\(/, why: 'a note that is gone, unreadable or not UTF-8 keeps its change queued and is attributed' },
        { token: /failHeldBody\s*\(/, why: 'a body that can\'t be written (conflict, lossy) fails the flush instead of reporting saved' },
        { token: /fresh\.nonUtf8/, why: 'a non-UTF-8 note is never written from decoded text' },
      ], 'writePending()', 'writePending');
      need(NOTE_STORE, [
        { token: /m\.views\.has\s*\(\s*viewId\s*\)/, why: 'only a view holding the note may write its body (a leftover view from a closed vault cannot)' },
        { token: /m\.status\s*===\s*'unreadable'/, why: 'a body is never taken from a view of a note that could not be read' },
      ], 'setBody()', 'setBody');
      need('src/renderer/components/boards/DocumentEditor.svelte', EDITOR_FREEZE_TOKENS, 'DocumentEditor');
      need('src/renderer/components/tiles/TextTile.svelte', EDITOR_FREEZE_TOKENS, 'TextTile');
      return out;
    },
  },
  {
    id: 'seed-writes-exclusive',
    title: 'new-file seeds are create-exclusive (never overwrite an existing vault file)',
    hint:
      'Seed through createNoteFile / noteStore.createUnique / noteStore.createExclusive (O_EXCL vault:create-file-text). ' +
      "The writer's exclusive create must not use trackComponentWrite: a losing EEXIST attempt targets the user's existing file.",
    run(ctx) {
      const out = [];
      for (const rel of [
        'src/renderer/lib/kanban/kanbanTileCreation.ts',
        'src/renderer/lib/tasklist/taskCreation.ts',
        'src/renderer/lib/tasklist/fileDropHandler.ts',
        'src/renderer/lib/boards/seedTextFileForNewTile.ts',
        'src/renderer/lib/notes/createNote.ts',
      ]) {
        const raw = ctx.read(rel);
        if (raw === null) { out.push(fail(rel, undefined, 'listed file is missing')); continue; }
        const src = stripCommentsStateful(raw);
        if (/\binvoke(?:Ok)?\s*\(\s*['"`]vault:write-file-text['"`]/.test(src)) out.push(fail(rel, undefined, "seeds via overwrite-capable 'vault:write-file-text'"));
        if (!/\b(?:noteStore\.createUnique|noteStore\.createExclusive|createNoteFile)\s*\(/.test(src)) {
          out.push(fail(rel, undefined, 'does not call createNoteFile / noteStore.createUnique / noteStore.createExclusive'));
        }
      }
      const raw = ctx.read(NOTE_WRITER);
      if (raw === null) return [...out, fail(NOTE_WRITER, undefined, 'file missing')];
      const fn = functionBody(blank(raw), 'createExclusive', { fnKeyword: true });
      if (!fn) return [...out, fail(NOTE_WRITER, undefined, 'function createExclusive() not found')];
      const body = blank(raw, { strings: false }).slice(fn.start, fn.end);
      if (!/['"`]vault:create-file-text['"`]/.test(body)) out.push(fail(NOTE_WRITER, undefined, "createExclusive() must invoke 'vault:create-file-text'"));
      if (/\btrackComponentWrite\s*\(/.test(body)) out.push(fail(NOTE_WRITER, undefined, 'createExclusive() must not use trackComponentWrite('));
      return out;
    },
  },
  {
    id: 'no-adhoc-schedulers',
    title: 'debounced IPC writes use createScheduler, not a hand-rolled setTimeout',
    hint: 'A hand-rolled timer-around-IPC drops failure attribution and flush/quit draining. Use createScheduler (writeScheduler.ts).',
    run(ctx) {
      const ALLOW = new Set([
        'src/renderer/lib/boards/writeScheduler.ts',
        'src/renderer/stores/ui.svelte.ts', // sidebar geometry → userData, deliberately outside the vault pipeline
      ]);
      const out = [];
      for (const rel of ctx.files(RENDERER, { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (ALLOW.has(rel)) continue;
        const src = ctx.read(rel);
        if (!src.includes('setTimeout')) continue;
        for (const m of src.matchAll(/\bsetTimeout\s*\(/g)) {
          const body = setTimeoutBody(src, m.index);
          if (body && [/\binvokeOk\s*\(/, /\bwindow\.filo\.invoke\s*\(/, /\bfilo\.invoke\s*\(/].some((p) => p.test(body))) {
            out.push(fail(rel, lineAt(src, m.index), 'setTimeout wraps an IPC write'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'keep-local-backup',
    title: 'every "Keep local" overwrite first backs up the external version',
    hint:
      "Keeping Filo's version destroys the other program's edit unless it is copied to .filo/recovery/ first " +
      '(backupExternalVersion). Escape inside the action object: `// allow-keep-local-no-backup: <reason>`.',
    run(ctx) {
      const out = [];
      const TOKEN = 'backupExternalVersion(';
      let sites = 0;
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        const raw = ctx.read(rel);
        if (!/Keep (local|all|mine|your edits)/.test(raw)) continue;
        const noComments = blank(raw, { strings: false });
        const code = blank(raw);
        for (const m of noComments.matchAll(/label\s*:\s*(['"`])(Keep local|Keep all|Keep mine|Keep your edits)\1/g)) {
          sites++;
          const open = enclosingOpen(code, m.index);
          const close = open < 0 ? -1 : matchBrace(code, open, '{', '}');
          if (close < 0) { out.push(fail(rel, lineAt(raw, m.index), `could not brace-match the '${m[2]}' action object`)); continue; }
          if (noComments.slice(open, close).includes(TOKEN) || raw.slice(open, close).includes('allow-keep-local-no-backup:')) continue;
          out.push(fail(rel, lineAt(raw, m.index), `'${m[2]}' action overwrites without backupExternalVersion(...)`));
        }
      }
      for (const { file, fn } of KEEP_LOCAL_CHOKEPOINTS) {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'chokepoint file missing')); continue; }
        const body = functionBody(blank(raw), fn, { fnKeyword: true });
        if (!body) { out.push(fail(file, undefined, `${fn}() not found`)); continue; }
        if (!blank(raw, { strings: false }).slice(body.start, body.end).includes(TOKEN)) {
          out.push(fail(file, undefined, `${fn}() keep-local branch must call backupExternalVersion(...)`));
        }
      }
      if (sites < 4) out.push(fail(RENDERER, undefined, `tripwire: only ${sites} Keep-local action sites found (expected >= 4)`));
      return out;
    },
  },
];
