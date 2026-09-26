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
  {
    // `vault:write-file-text` creates the file (and its folders) and overwrites
    // whatever is there without a stat check: a note is changed only through
    // `vault:write-existing-file-text` (which names the read it builds on) and
    // created only through the exclusive `vault:create-file-text`.
    file: NOTE_WRITER,
    forbidden: [{ token: /['"`]vault:write-file-text['"`]/, why: 'the writer never uses the blind, create-capable write channel' }],
  },
  { file: 'src/renderer/commands/noteFieldCommand.ts', required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'field commands send a delta' }] },
  {
    file: 'src/renderer/commands/frontmatterInverse.ts',
    within: 'applyDeltaChecked',
    required: [{ token: /noteStore\.patchFrontmatter\s*\(/, why: 'undo/redo send a delta through the note store' }],
  },
  { file: 'src/renderer/commands/propertiesCommands.ts', required: [{ token: /applyDeltaChecked\s*\(/, why: 'UpdatePropertiesCommand sends a checked delta' }] },
  {
    file: NOTE_STORE,
    within: 'recreate',
    required: [{ token: /writer\.createExclusive\s*\(/, why: 'a note deleted on disk is written back exclusively (never over a file that came back)' }],
  },
];

// ── deletes-go-to-trash ───────────────────────────────────────────────────
// Every user-facing delete moves the item into Filo's trash; these are the
// places that do it, and the function that must.
const TRASH_CALLERS = [
  { file: 'src/renderer/stores/vaultDeleteOps.ts', fn: 'performDelete', why: 'the sidebar delete of a file or folder' },
  { file: 'src/renderer/stores/boardCacheDelete.ts', fn: 'deleteBoard', why: 'a board delete' },
  { file: 'src/renderer/commands/trashedFiles.ts', fn: 'trashFiles', why: '"delete tile/task and file" and the cascade redo' },
];
// The only renderer code that may name the unlink channel: crash-sentinel
// clean-ups inside .filo/, which are never user content.
const VAULT_DELETE_ALLOWED = new Set(['src/renderer/lib/vault/machineSentinels.ts']);
const TRASH_OPS = 'src/main/vault/trashOps.ts';
const TRASH_IPC = 'src/main/ipc/vaultTrash.ipc.ts';
const TRASH_STORE = 'src/renderer/stores/trash.svelte.ts';

// ── keep-local-backup ─────────────────────────────────────────────────────
// A note's Keep mine backs up inside `resolveConflict`, through
// `backupThenRead`, so the overwrite is built on the bytes that were backed up.
const KEEP_LOCAL_CHOKEPOINTS = [
  { file: 'src/renderer/lib/boards/boardWriteScheduler.ts', fn: 'writeBoardFile', fnKeyword: true, token: 'backupExternalVersion(' },
  { file: 'src/renderer/stores/notes.svelte.ts', fn: 'resolveConflict', fnKeyword: false, token: 'backupThenRead(' },
  { file: 'src/renderer/lib/vault/keepLocalBackup.ts', fn: 'backupThenRead', fnKeyword: true, token: 'backupExternalVersion(' },
  { file: 'src/renderer/components/boards/NoteRawView.svelte', fn: 'keepMine', fnKeyword: true, token: 'backupThenRead(' },
  { file: 'src/renderer/stores/boardDrift.ts', fn: 'keepLocalVersion', fnKeyword: true, token: 'backupExternalVersion(' },
  { file: 'src/renderer/lib/boards/configDrift.ts', fn: 'checkConfigDisk', fnKeyword: true, token: 'backupConfig(' },
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
      'Route every .md change through noteStore (setBody / patchFrontmatter / transform / createUnique / createExclusive / recreate). ' +
      'noteWriter itself writes only through vault:write-existing-file-text (stat-checked) and vault:create-file-text (exclusive). ' +
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
    title: 'a note file is renamed, trashed or restored only while its write queue is held',
    hint:
      "A write that starts while its file moves lands on the old path (or recreates it). vaultOperations' " +
      'renameVaultPath / trashVaultPath / restoreTrashed run the IPC inside noteStore.hold(...), and noteWriter.hold ' +
      "enters every path's queue before the operation runs.",
    run(ctx) {
      const out = [];
      const OPS = 'src/renderer/lib/vault/vaultOperations.ts';
      const raw = ctx.read(OPS);
      if (raw === null) return [fail(OPS, undefined, 'file missing')];
      const code = blank(raw);
      const text = blank(raw, { strings: false });
      for (const [fn, channel] of [['renameVaultPath', 'vault:rename'], ['trashVaultPath', 'vault:trash-move'], ['restoreTrashed', 'vault:trash-restore']]) {
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
    id: 'note-write-suppression',
    title: "a note write hides only its own echo: another program's rename or delete right after it still gets through",
    hint:
      'The .md write handlers in vault.ipc.ts suppress with suppressWrite (never a plain suppress, which also drops a delete or ' +
      'rename of the file for ~7 s) and call noteOwnWrite so the watcher knows the bytes on disk; the two overwrite handlers ' +
      'write through withOnDiskSpelling. Each passes the bytes it writes to suppressWrite, and the watcher passes whether ' +
      'the file exists and a probe of its bytes into isSuppressed, so another program saving the note inside the window ' +
      'is still reported.',
    run(ctx) {
      const out = [];
      const IPC = 'src/main/ipc/vault.ipc.ts';
      const raw = ctx.read(IPC);
      if (raw === null) return [fail(IPC, undefined, 'file missing')];
      const code = blank(raw, { strings: false });
      for (const ch of ['vault:write-file-text', 'vault:create-file-text', 'vault:write-existing-file-text']) {
        const start = code.indexOf(`'${ch}'`);
        if (start < 0) { out.push(fail(IPC, undefined, `the '${ch}' handler is missing`)); continue; }
        const end = code.indexOf('ipcMain.handle(', start);
        const body = code.slice(start, end < 0 ? code.length : end);
        const line = lineAt(raw, start);
        if (/\.suppress\s*\(/.test(body)) out.push(fail(IPC, line, `'${ch}' uses a plain suppress(); use suppressWrite()`));
        if (!/\.suppressWrite\s*\(/.test(body)) out.push(fail(IPC, line, `'${ch}' must suppressWrite() before the write`));
        else if (!/\.suppressWrite\s*\([^;]*,\s*content\s*\)/.test(body)) {
          out.push(fail(IPC, line, `'${ch}' must pass the bytes it writes to suppressWrite(path, ms, content)`));
        }
        if (!/\bnoteOwnWrite\s*\(/.test(body)) out.push(fail(IPC, line, `'${ch}' must call noteOwnWrite() after the write`));
        if (ch !== 'vault:create-file-text' && !/atomicWriteFile\s*\(\s*await\s+withOnDiskSpelling\s*\(/.test(body)) {
          out.push(fail(IPC, line, `'${ch}' must write through withOnDiskSpelling()`));
        }
      }
      const W = 'src/main/services/fileWatcher.ts';
      const wRaw = ctx.read(W);
      if (wRaw === null) return [...out, fail(W, undefined, 'file missing')];
      const w = stripComments(wRaw);
      if (!/isSuppressed\(\s*c\.filename\s*,\s*exists\(\s*c\.filename\s*\)\s*,\s*this\.probeFile\s*\)/.test(w)) {
        out.push(fail(W, undefined, 'the live notify pass must pass exists(c.filename) and this.probeFile into isSuppressed'));
      }
      if ((w.match(/isSuppressed\(\s*path\s*,\s*false\s*\)/g) ?? []).length < 2) {
        out.push(fail(W, undefined, 'the reconcile pass must treat a vanished path as not present (isSuppressed(path, false)) in both delete loops'));
      }
      return out;
    },
  },
  {
    id: 'note-write-expects-stat',
    title: 'a note overwrite names the stat of the read it builds on, and the main process refuses it (STALE) if the file changed since',
    hint:
      'A sync client or editor can replace a note between the note writer\'s read and its write (the rename retries for ' +
      'seconds on a Windows lock). Pass the fresh read\'s { mtimeMs, size } as the fourth argument of ' +
      "'vault:write-existing-file-text'; the handler hands it to atomicWriteFile as expectStat, which re-checks it before " +
      'every rename attempt and throws StaleWriteError (code STALE).',
    run(ctx) {
      const out = [];
      const raw = ctx.read(NOTE_WRITER);
      if (raw === null) return [fail(NOTE_WRITER, undefined, 'file missing')];
      const code = blank(raw, { strings: false });
      const sends = [...code.matchAll(/\binvoke(?:Ok)?\s*\(\s*['"`]vault:write-existing-file-text['"`]/g)];
      if (sends.length === 0) out.push(fail(NOTE_WRITER, undefined, "tripwire: no 'vault:write-existing-file-text' invoke found"));
      for (const m of sends) {
        const open = code.indexOf('(', m.index);
        const close = matchBrace(code, open, '(', ')');
        if (close < 0) { out.push(fail(NOTE_WRITER, lineAt(raw, m.index), 'unbalanced invoke(')); continue; }
        let depth = 0;
        let args = 1;
        for (let i = open + 1; i < close; i++) {
          const c = code[i];
          if ('([{'.includes(c)) depth++;
          else if (')]}'.includes(c)) depth--;
          else if (c === ',' && depth === 0) args++;
        }
        if (args < 5) out.push(fail(NOTE_WRITER, lineAt(raw, m.index), 'this note write passes no expected stat (vaultRoot, relPath, text, expect)'));
      }
      const IPC = 'src/main/ipc/vault.ipc.ts';
      const ipc = ctx.read(IPC);
      if (ipc === null) return [...out, fail(IPC, undefined, 'file missing')];
      const ipcCode = blank(ipc, { strings: false });
      const start = ipcCode.indexOf("'vault:write-existing-file-text'");
      const end = ipcCode.indexOf('ipcMain.handle(', start);
      const handler = start < 0 ? '' : ipcCode.slice(start, end < 0 ? ipcCode.length : end);
      if (!/expectStat\s*:\s*expect\b/.test(handler)) {
        out.push(fail(IPC, start < 0 ? undefined : lineAt(ipc, start), "the 'vault:write-existing-file-text' handler must pass its expect argument to atomicWriteFile as expectStat"));
      }
      const FU = 'src/main/vault/filenameUtils.ts';
      const fu = ctx.read(FU);
      if (fu === null) return [...out, fail(FU, undefined, 'file missing')];
      // From the function to the next top-level export (its signature defeats functionBody).
      const awStart = fu.indexOf('export async function atomicWriteFile(');
      const awEnd = awStart < 0 ? -1 : fu.indexOf('\nexport ', awStart + 1);
      const awBody = awStart < 0 ? '' : stripComments(fu.slice(awStart, awEnd < 0 ? fu.length : awEnd));
      if (!/beforeAttempt[\s\S]*expectStat[\s\S]*throw new StaleWriteError/.test(awBody)) {
        out.push(fail(FU, undefined, 'atomicWriteFile must re-check expectStat before every rename attempt (beforeAttempt) and throw StaleWriteError'));
      }
      const EC = 'src/main/ipc/ipcErrorCode.ts';
      const ec = ctx.read(EC);
      if (ec === null || !/instanceof StaleWriteError\)\s*return 'STALE'/.test(ec)) {
        out.push(fail(EC, undefined, "ipcErrorCode must map StaleWriteError to 'STALE'"));
      }
      return out;
    },
  },
  {
    id: 'baseline-stamp-forward-only',
    title: "a drift baseline only moves forward: a reader's stat never replaces one a newer self-write stamped, and a new board's create is Filo's own write",
    hint:
      'Take `const seq = baselineSeq(path)` before the read and pass `noteBaseline(path, mtime, size, { ifUnchangedSince: seq })`; ' +
      "self-writes use refreshBaselineAfterWrite. A rolled-back baseline makes the next save see its own write as an external edit. " +
      "board:create suppresses the new file's watcher echo, and persistNewBoard marks it as a recent self-write and seeds the baseline.",
    run(ctx) {
      const out = [];
      const REGISTRY = 'src/renderer/lib/vault/fileBaselineRegistry.ts';
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        if (rel === REGISTRY) continue;
        const raw = ctx.read(rel);
        if (!raw.includes('noteBaseline(')) continue;
        const code = stripCommentsKeepLines(raw);
        for (const m of code.matchAll(/\bnoteBaseline\s*\(/g)) {
          const close = matchBrace(code, m.index + m[0].length - 1, '(', ')');
          const args = code.slice(m.index, close < 0 ? code.length : close);
          if (!/\bifUnchangedSince\s*:/.test(args)) {
            out.push(fail(rel, lineAt(code, m.index), 'noteBaseline() without { ifUnchangedSince }'));
          }
        }
      }
      const IPC = 'src/main/ipc/board.ipc.ts';
      const ipcRaw = ctx.read(IPC);
      if (ipcRaw === null) return [...out, fail(IPC, undefined, 'file missing')];
      const ipc = stripComments(ipcRaw);
      const start = ipc.indexOf("'board:create'");
      const end = start < 0 ? -1 : ipc.indexOf('ipcMain.handle(', start);
      const createBody = start < 0 ? '' : ipc.slice(start, end < 0 ? ipc.length : end);
      if (!/\.suppress\s*\(\s*relativePath\b/.test(createBody)) {
        out.push(fail(IPC, undefined, "board:create must suppress the new file's watcher echo"));
      }
      const STORE = 'src/renderer/stores/boardCache.svelte.ts';
      const storeRaw = ctx.read(STORE);
      if (storeRaw === null) return [...out, fail(STORE, undefined, 'file missing')];
      const persist = functionBody(stripComments(storeRaw), 'persistNewBoard')?.text ?? '';
      if (!/\bmarkRecentSelfWrite\s*\(\s*result\.path\s*\)/.test(persist)) {
        out.push(fail(STORE, undefined, 'persistNewBoard must markRecentSelfWrite(result.path)'));
      }
      if (!/\bnoteBaseline\s*\(\s*result\.path\b/.test(persist)) {
        out.push(fail(STORE, undefined, "persistNewBoard must seed the baseline from board:create's stat"));
      }
      return out;
    },
  },
  {
    id: 'close-keeps-rescue-copy',
    title: 'close, open-another-vault and quit save first, and never let unsaved work go without a rescue copy',
    hint:
      'closeVault / openVault call saveBeforeLeaving() before fireVaultSwap and clear the sentinel only when it returns "saved"; ' +
      'saveBeforeLeaving returns "rescued" only after keepRescueCopies(); the quit dialog\'s "Quit anyway" runs ' +
      'keepRescueCopiesOrAsk() before app:ready-to-quit. There is no "Don\'t Save".',
    run(ctx) {
      const out = [];
      const VAULT = 'src/renderer/stores/vault.svelte.ts';
      const vaultRaw = ctx.read(VAULT);
      if (vaultRaw === null) return [fail(VAULT, undefined, 'file missing')];
      const vault = stripComments(vaultRaw);
      if (/Don't Save/.test(vault)) out.push(fail(VAULT, undefined, `a "Don't Save" choice drops queued edits`));
      for (const name of ['openVault', 'closeVault']) {
        const body = functionBody(vault, name)?.text ?? '';
        const guard = body.search(/\bsaveBeforeLeaving\s*\(/);
        const swap = body.search(/\bfireVaultSwap\s*\(/);
        if (guard < 0 || swap < 0 || guard > swap) {
          out.push(fail(VAULT, undefined, `${name} must call saveBeforeLeaving() before fireVaultSwap()`));
        }
        if (!/saveOutgoing:\s*leave\s*===\s*'saved'/.test(body)) {
          out.push(fail(VAULT, undefined, `${name}: saveOutgoing must be true only for a clean save (leave === 'saved')`));
        }
      }
      const GUARD = 'src/renderer/stores/vaultLeaveGuard.ts';
      const guardRaw = ctx.read(GUARD);
      if (guardRaw === null) return [...out, fail(GUARD, undefined, 'file missing')];
      const leave = functionBody(stripComments(guardRaw), 'saveBeforeLeaving')?.text ?? '';
      const rescue = leave.search(/\bkeepRescueCopies\s*\(/);
      const rescued = leave.search(/return\s+'rescued'/);
      if (rescue < 0 || rescued < 0 || rescue > rescued) {
        out.push(fail(GUARD, undefined, 'saveBeforeLeaving must keepRescueCopies() before returning "rescued"'));
      }
      const saved = leave.search(/return\s+'saved'/);
      if (saved < 0 || !/\bisUnsavedWorkEmpty\s*\([^)]*\)\s*\)\s*return\s+'saved'/.test(leave)) {
        out.push(fail(GUARD, undefined, 'saveBeforeLeaving may return "saved" only when unsavedWork() is empty'));
      }
      const QUIT = 'src/renderer/lib/vault/handleFlushAndQuit.ts';
      const quitRaw = ctx.read(QUIT);
      if (quitRaw === null) return [...out, fail(QUIT, undefined, 'file missing')];
      const quit = stripComments(quitRaw);
      const drain = functionBody(quit, 'drainAndQuit', { fnKeyword: true })?.text ?? '';
      const quitBranch = drain.indexOf("if (choice === 'quit')");
      const branch = quitBranch < 0 ? '' : drain.slice(quitBranch);
      const ask = branch.search(/\bkeepRescueCopiesOrAsk\s*\(/);
      const ready = branch.indexOf("'app:ready-to-quit'");
      if (ask < 0 || ready < 0 || ask > ready) {
        out.push(fail(QUIT, undefined, '"Quit anyway" must run keepRescueCopiesOrAsk() before app:ready-to-quit'));
      }
      const APP = 'src/renderer/App.svelte';
      const app = stripComments(ctx.read(APP) ?? '');
      if (!/\bkeepRescueCopies\s*:\s*\(\)\s*=>\s*keepRescueCopies\s*\(/.test(app)) {
        out.push(fail(APP, undefined, 'the quit handler must be given keepRescueCopies'));
      }
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
      for (const { file, fn, fnKeyword, token } of KEEP_LOCAL_CHOKEPOINTS) {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'chokepoint file missing')); continue; }
        const body = functionBody(blank(raw), fn, { fnKeyword });
        if (!body) { out.push(fail(file, undefined, `${fn}() not found`)); continue; }
        if (!blank(raw, { strings: false }).slice(body.start, body.end).includes(token)) {
          out.push(fail(file, undefined, `${fn}() keep-local branch must call ${token}...)`));
        }
      }
      if (sites < 4) out.push(fail(RENDERER, undefined, `tripwire: only ${sites} Keep-local action sites found (expected >= 4)`));
      return out;
    },
  },
  {
    id: 'deletes-go-to-trash',
    title: "user deletes move items to Filo's trash; only a confirmed fallback deletes for good",
    hint:
      "Delete through trashVaultPath(...) (lib/vault/vaultOperations.ts) so undo and Settings → Trash can move it back. " +
      'vault:delete is for .filo/ sentinel clean-ups only. A purge hands items to the Recycle Bin (shell.trashItem) and ' +
      'never deletes them itself; only offerPermanentDelete, after its confirm, may. Confirm text never promises "permanent" elsewhere.',
    run(ctx) {
      const out = [];
      for (const { file, fn, why } of TRASH_CALLERS) {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'file missing')); continue; }
        const body = functionBody(blank(raw), fn);
        if (!body) { out.push(fail(file, undefined, `${fn}() not found`)); continue; }
        if (!/\btrashVaultPath\s*\(/.test(body.text)) out.push(fail(file, lineAt(raw, body.start), `${fn}() (${why}) must call trashVaultPath(...)`));
      }
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        const raw = ctx.read(rel);
        const code = blank(raw, { strings: false });
        for (const m of code.matchAll(/['"`]vault:delete['"`]/g)) {
          if (!VAULT_DELETE_ALLOWED.has(rel)) out.push(fail(rel, lineAt(raw, m.index), "'vault:delete' outside the .filo/ sentinel clean-up; move the item to Filo's trash instead"));
        }
        for (const m of code.matchAll(/\bdeleteTrashPermanently\s*\(/g)) {
          if (rel === 'src/renderer/lib/vault/vaultOperations.ts') continue;
          const fnBody = rel === TRASH_STORE ? functionBody(blank(raw), 'offerPermanentDelete', { fnKeyword: true }) : null;
          const inside = fnBody && m.index > fnBody.start && m.index < fnBody.end;
          if (!inside) out.push(fail(rel, lineAt(raw, m.index), 'deleteTrashPermanently(...) is only for offerPermanentDelete, after its confirm'));
        }
        // Confirm and hint text: "permanent" only in the fallback dialog.
        for (const m of code.matchAll(/\b(?:body|hint|title|confirmLabel|text)\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
          if (!/permanent/i.test(m[2])) continue;
          const fnBody = rel === TRASH_STORE ? functionBody(blank(raw), 'offerPermanentDelete', { fnKeyword: true }) : null;
          if (fnBody && m.index > fnBody.start && m.index < fnBody.end) continue;
          out.push(fail(rel, lineAt(raw, m.index), 'user-facing delete text says "permanent"; deletes go to Filo\'s trash'));
        }
      }
      const opsRaw = ctx.read(TRASH_OPS);
      if (opsRaw === null) return [...out, fail(TRASH_OPS, undefined, 'file missing')];
      const ops = blank(opsRaw);
      for (const fn of ['purgeTrash', 'removeBookkeeping']) {
        const b = functionBody(ops, fn, { fnKeyword: true });
        if (!b) { out.push(fail(TRASH_OPS, undefined, `${fn}() not found`)); continue; }
        if (/\bfs\.rm\s*\(|\brecursive\s*:\s*true|\brimraf\b/.test(b.text)) {
          out.push(fail(TRASH_OPS, lineAt(opsRaw, b.start), `${fn}() must not delete recursively; items leave through the Recycle Bin`));
        }
        const withStrings = blank(opsRaw, { strings: false }).slice(b.start, b.end);
        for (const u of withStrings.matchAll(/\bunlink\s*\(([^)]*)\)/g)) {
          if (!/MANIFEST/.test(u[1])) out.push(fail(TRASH_OPS, lineAt(opsRaw, b.start + u.index), `${fn}() may only unlink the manifest`));
        }
      }
      const purge = functionBody(ops, 'purgeTrash', { fnKeyword: true });
      if (purge && !/\bopts\.trashItem\s*\(/.test(purge.text)) out.push(fail(TRASH_OPS, lineAt(opsRaw, purge.start), 'purgeTrash() must hand items to opts.trashItem (the OS Recycle Bin)'));
      const ipcRaw = ctx.read(TRASH_IPC);
      if (ipcRaw === null) return [...out, fail(TRASH_IPC, undefined, 'file missing')];
      const ipc = blank(ipcRaw, { strings: false });
      const start = ipc.indexOf("'vault:trash-purge'");
      const end = ipc.indexOf("ipcMain.handle(", start + 1);
      const handler = start < 0 ? '' : ipc.slice(start, end < 0 ? ipc.length : end);
      if (!/shell\.trashItem\s*\(/.test(handler)) out.push(fail(TRASH_IPC, undefined, "the 'vault:trash-purge' handler must purge through shell.trashItem"));
      if (/deleteTrashedPermanently|\bfs(?:Promises)?\.(?:rm|unlink)\s*\(/.test(handler)) out.push(fail(TRASH_IPC, undefined, "the 'vault:trash-purge' handler must never delete on its own"));
      return out;
    },
  },
];
