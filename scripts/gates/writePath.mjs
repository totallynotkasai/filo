// Write-path ratchets: markdown/frontmatter gateways, schedulers and the
// "never silently lose or misdirect a write" invariants.
import {
  fail, blank, functionBody, lineAt, matchBrace, stripComments, stripCommentsKeepLines, stripCommentsStateful, tokenChecks,
} from './lib.mjs';

const RENDERER = 'src/renderer';
const TS_SVELTE = ['.ts', '.svelte'];
const GATEWAY = 'src/renderer/lib/vault/markdownFileWriter.ts';
// A real invoke of a markdown write channel (comments/docstrings don't have the `invoke(` prefix).
const MD_WRITE_RE = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:(?:write-(?:existing-)?|create-)file-text['"`]/gs;

// Direct `.md` writers that never target a possibly-open editor.
const COUPLED_HELPER = 'src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts';
const RECONCILE_EXEMPT = new Map([
  [GATEWAY, 'the gateway owns the editor write + frontmatter cache'],
  ['src/renderer/lib/boards/seedTextFileForNewTile.ts', 'seeds a brand-new tile backing .md'],
  ['src/renderer/lib/kanban/kanbanTileCreation.ts', 'creates a new Kanban card backing .md'],
  ['src/renderer/lib/tasklist/taskCreation.ts', 'creates a new task backing .md'],
  ['src/renderer/lib/tasklist/fileDropHandler.ts', 'writes a freshly OS-dropped file'],
  ['src/renderer/lib/vault/createMdExclusive.ts', 'creates a brand-new .md (EEXIST otherwise)'],
  ['src/renderer/lib/vault/renameCascadeSentinel.ts', '.filo/ sentinel'],
  ['src/renderer/lib/vault/tagRewriteSentinel.ts', '.filo/ sentinel'],
  ['src/renderer/lib/vault/dirtyFlagRecovery.ts', '.filo/.dirty sentinel'],
  ['src/renderer/components/boards/KanbanSideToolbar.svelte', '.filo/ overlay geometry config'],
]);

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
  { file: GATEWAY, required: [TIMEOUT_FINITE], forbidden: [TIMEOUT_UNBOUNDED] },
  { file: 'src/renderer/lib/boards/frontmatterWriteScheduler.ts', required: [TIMEOUT_FINITE], forbidden: [TIMEOUT_UNBOUNDED] },
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
const HYDRATE_FAIL_TOKENS = [
  { token: /hydrateReadFailed\s*=\s*true/, why: 'a failed hydrate read is flagged instead of leaving a blank, writable editor' },
  { token: /hydrateReadFailed\s*&&\s*!\s*lastLoadedBody/, why: 'buildWriteArgs refuses to write over a file it could not read' },
];

// ── frontmatter-delta-write ───────────────────────────────────────────────
const DELTA_CHECKS = [
  {
    file: 'src/renderer/lib/vault/frontmatterDelta.ts',
    required: [
      { token: /export\s+function\s+patchToFrontmatterDelta\b/, why: 'patch → delta builder' },
      { token: /export\s+function\s+diffToFrontmatterDelta\b/, why: 'snapshot diff → delta builder' },
      { token: /export\s+function\s+applyFrontmatterDelta\b/, why: 'delta applier' },
    ],
  },
  {
    file: GATEWAY,
    required: [
      { token: /args\.frontmatterDelta/, why: 'the delta is threaded into the write' },
      { token: /vault:read-file-text/, why: 'the in-chain fresh disk read' },
      { token: /applyFrontmatterDelta\s*\(\s*parsedFresh\.frontmatter/, why: 'the written FM derives from the fresh read' },
      { token: /originalFrontmatter\s*:\s*parsedFresh\.rawFrontmatter/, why: 'the source-preserving baseline comes from the same read' },
    ],
  },
  {
    file: 'src/renderer/commands/frontmatterRebase.ts',
    required: [{ token: /scheduleFrontmatterWrite\s*\([^)]*patchToFrontmatterDelta\s*\(/, why: 'the undo/redo rebase schedules a delta' }],
  },
  { file: 'src/renderer/commands/kanbanCommands.ts', required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'UpdateCardFieldCommand builds a delta' }] },
  {
    file: 'src/renderer/commands/kanbanCommands.ts',
    within: 'applyOrphanPatchRebased',
    required: [
      { token: /patchToFrontmatterDelta\s*\(/, why: 'the orphan write builds a delta' },
      { token: /frontmatterDelta\s*:/, why: 'the orphan write threads frontmatterDelta' },
    ],
    forbidden: [{ token: /\bfrontmatter\s*:\s*\{/, why: 'a whole-object frontmatter write drops present-but-empty disk keys' }],
  },
  { file: 'src/renderer/commands/taskCommands.ts', required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'UpdateTaskFieldCommand builds a delta' }] },
  { file: 'src/renderer/commands/propertiesCommands.ts', required: [{ token: /frontmatterDelta\s*:/, why: 'UpdatePropertiesCommand writes via a delta' }] },
  {
    file: 'src/renderer/components/tiles/PropertiesPopup.svelte',
    required: [
      { token: /diffToFrontmatterDelta\s*\(/, why: 'the popup diffs its open-time snapshot' },
      { token: /frontmatterDelta\s*:/, why: 'the popup write threads the delta' },
    ],
  },
];

// ── keep-local-backup ─────────────────────────────────────────────────────
const KEEP_LOCAL_CHOKEPOINTS = [
  { file: 'src/renderer/lib/vault/preWriteDriftGate.ts', fn: 'runPreWriteDriftGate' },
  { file: 'src/renderer/lib/boards/boardWriteScheduler.ts', fn: 'writeBoardFile' },
  { file: 'src/renderer/stores/boardCache.svelte.ts', fn: 'syncTileMarkdown' },
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
    id: 'markdown-gateway',
    title: 'markdown write channels are only invoked by the gateway (or a justified direct write)',
    hint:
      'Route through writeMarkdownFile / scheduleMarkdownWrite (BOM, race guards, flushed-version bookkeeping). ' +
      'A one-shot seed/sentinel may use `// allow-direct-write: <reason>` on the call, channel or up to 4 lines above.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        if (rel === GATEWAY) continue;
        const text = ctx.read(rel);
        const lines = text.split('\n');
        for (const m of text.matchAll(MD_WRITE_RE)) {
          const line = lineAt(text, m.index);
          const endLine = lineAt(text, m.index + m[0].length - 1);
          const ESC = /\/\/ allow-direct-write:/;
          const escaped = [line, endLine, line - 1, line - 2, line - 3, line - 4].some((n) => n >= 1 && ESC.test(lines[n - 1] ?? ''));
          if (!escaped) out.push(fail(rel, line, `direct markdown write outside the gateway: ${(lines[line - 1] ?? '').trim()}`));
        }
      }
      return out;
    },
  },
  {
    id: 'md-writers-reconcile-editors',
    title: 'direct .md writes go through writeMarkdownAndReconcile (same-path editor reconcile)',
    hint:
      "A direct write under an open editor leaves its FM cache stale and the next body save inverts it. Use " +
      'writeMarkdownAndReconcile({ vaultRoot, path, content, mode }), list a never-open-editor writer in ' +
      'RECONCILE_EXEMPT, or mark the site `// reconcile-elsewhere: <reason>`.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        if (rel === COUPLED_HELPER || RECONCILE_EXEMPT.has(rel)) continue;
        const text = ctx.read(rel);
        if (!text.match(MD_WRITE_RE)) continue;
        const blanked = blank(text);
        const lines = text.split('\n');
        for (const m of text.matchAll(MD_WRITE_RE)) {
          if (blanked.slice(m.index, m.index + 6) !== 'invoke') continue;
          const line = lineAt(text, m.index);
          if ([0, 1, 2, 3, 4].some((j) => /\/\/ reconcile-elsewhere:/.test(lines[line - 1 - j] ?? ''))) continue;
          out.push(fail(rel, line, 'direct .md write outside writeMarkdownAndReconcile'));
        }
      }
      // A "Keep local" re-create of an externally deleted file must be O_EXCL: sync may have re-created it.
      const DRIFT = 'src/renderer/stores/vaultExternalDriftPrompts.ts';
      const src = ctx.read(DRIFT);
      if (src === null) return [...out, fail(DRIFT, undefined, 'file missing')];
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
      const fn = functionBody(noComments, 'recreateDeletedFile', { fnKeyword: true });
      if (!fn) out.push(fail(DRIFT, undefined, 'recreateDeletedFile() not found'));
      else if (!/create\s*:\s*['"]exclusive['"]/.test(fn.text) || /create\s*:\s*true\b/.test(fn.text)) {
        out.push(fail(DRIFT, lineAt(src, fn.start), "recreateDeletedFile() must re-create with create: 'exclusive', never create: true"));
      }
      return out;
    },
  },
  {
    id: 'markdown-read-gateway',
    title: 'files that mark docs hydrated read .md through readMarkdownForHydrate',
    hint:
      'A disk-read hydrate must seed the drift baseline from the same read, or an external edit is later overwritten. ' +
      'Use readMarkdownForHydrate(vaultRoot, relPath), or `// allow-hydrate-read: <reason>` on the read line.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(RENDERER, { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (rel === GATEWAY) continue;
        const src = ctx.read(rel);
        if (!/\bmarkHydrated\s*\(/.test(src)) continue;
        src.split('\n').forEach((line, i) => {
          if (/\binvoke(?:Ok)?\s*\(\s*['"`]vault:read-file-text['"`]/.test(line) && !/\/\/ allow-hydrate-read:/.test(line)) {
            out.push(fail(rel, i + 1, `hydrate-site read bypasses the gateway: ${line.trim()}`));
          }
        });
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
    title: 'frontmatter/body write paths fail loudly instead of resolving an abort as success',
    hint:
      'A bare `if (!docState) return` / `if (!fm) return` / read-only return resolves the write as SUCCESS (the dirty ' +
      'sentinel is cleared) while the edit never reaches disk. Read disk instead, or markPathFailed + throw. ' +
      'Escape (non-write path only): `// allow-silent-abort: <reason>` in the file.',
    run(ctx) {
      const out = selfTest().map((s) => fail('scripts/gates/writePath.mjs', undefined, `self-test: ${s}`));
      for (const rel of ctx.files(['src/renderer/lib/boards', 'src/renderer/lib/kanban', 'src/renderer/lib/tasklist'], {
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
      const need = (file, tokens, label) => {
        const raw = ctx.read(file);
        if (raw === null) { out.push(fail(file, undefined, 'required file missing')); return; }
        out.push(...tokenChecks(file, stripComments(raw), { required: tokens }, label));
      };
      need('src/renderer/lib/boards/frontmatterWriteScheduler.ts', [
        { token: /markPathFailed\s*\(/, why: 'a no-editor read failure is attributed (markPathFailed)' },
        { token: /readMarkdownForHydrate\s*\(/, why: 'the no-docState branch reads the body from disk' },
        { token: /readOnlyDoc\s*&&\s*!\s*delta/, why: 'only delta-LESS writes are refused on a read-only doc' },
        { token: /!\s*readOnlyDoc\s*\?/, why: "a read-only doc's delta write takes its body from disk, never the lossy docState.body" },
      ]);
      need(GATEWAY, [
        { token: /hasFrontmatter\s*\(/, why: 'the cache-FM branch detects a never-seeded FM cache' },
        { token: /argsFmEmpty/, why: 'a body-only save with no FM re-reads disk instead of assembling against {}' },
      ]);
      need('src/renderer/components/boards/DocumentEditor.svelte', HYDRATE_FAIL_TOKENS, 'DocumentEditor');
      need('src/renderer/components/tiles/TextTile.svelte', HYDRATE_FAIL_TOKENS, 'TextTile');

      const STORE = 'src/renderer/stores/document.svelte.ts';
      const storeRaw = ctx.read(STORE);
      if (storeRaw === null) return [...out, fail(STORE, undefined, 'required file missing')];
      const update = functionBody(blank(storeRaw), 'updateContent');
      if (!update) out.push(fail(STORE, undefined, 'updateContent() not found'));
      else {
        out.push(
          ...tokenChecks(STORE, update.text, {
            required: [
              { token: /bumpMutationVersion\s*\(/, why: 'a body change bumps the shared staleness token (else a notes write no-ops as stale)' },
              { token: /bodyMutationVersions\.set\s*\(/, why: 'the body bump is mirrored so FM-only consumers can subtract it' },
            ],
          }, 'updateContent()'),
        );
      }
      if (!/getFrontmatterOnlyMutationVersion/.test(stripComments(storeRaw))) {
        out.push(fail(STORE, undefined, 'getFrontmatterOnlyMutationVersion is gone (FM-only staleness API)'));
      }
      return out;
    },
  },
  {
    id: 'frontmatter-delta-write',
    title: 'field/popup frontmatter writes apply a delta to a fresh disk read',
    hint:
      'Serialising a cached full FM object silently drops keys it never saw. Build a FrontmatterDelta and let the ' +
      'gateway apply it to the same in-chain read that supplies originalFrontmatter.',
    run(ctx) {
      const out = [];
      for (const c of DELTA_CHECKS) {
        const raw = ctx.read(c.file);
        if (raw === null) { out.push(fail(c.file, undefined, 'file missing')); continue; }
        let scope = stripComments(raw);
        if (c.within) {
          const fn = functionBody(blank(raw), c.within, { fnKeyword: true });
          if (!fn) { out.push(fail(c.file, undefined, `${c.within}() not found`)); continue; }
          scope = fn.text;
        }
        out.push(...tokenChecks(c.file, scope, c, c.within ? `${c.within}()` : ''));
      }
      return out;
    },
  },
  {
    id: 'writer-path-honors-filepath',
    title: 'field/popup write-path resolvers use resolveTextTileVaultPath',
    hint: "A `${title}.md` root fallback ignores a subfolder card's filePath and writes the wrong file.",
    run(ctx) {
      const SITES = [
        'src/renderer/lib/kanban/kanbanFrontmatterWriter.ts',
        'src/renderer/components/tiles/PropertiesPopup.svelte',
        'src/renderer/components/boards/TaskListBoard.svelte',
        'src/renderer/components/boards/TaskItem.svelte',
        'src/renderer/stores/fileTags.svelte.ts',
      ];
      const out = [];
      for (const rel of SITES) {
        const src = ctx.read(rel);
        if (src === null) out.push(fail(rel, undefined, 'listed resolver site is missing — update the list'));
        else if (!/\bresolveTextTileVaultPath\b/.test(src)) out.push(fail(rel, undefined, 'does not use resolveTextTileVaultPath'));
      }
      return out;
    },
  },
  {
    id: 'creation-persists-filepath',
    title: 'text-tile creation stamps filePath onto the def before the command clones it',
    hint: 'Add*Command deep-clones the def; a later stamp never reaches .board.json and a cold-load edit hits the wrong file.',
    run(ctx) {
      const SITES = [
        { file: 'src/renderer/lib/tasklist/taskCreation.ts', fn: 'buildTaskDef', before: null },
        { file: 'src/renderer/lib/kanban/kanbanTileCreation.ts', fn: 'createTile', before: 'new AddCardCommand(' },
        { file: 'src/renderer/lib/boards/seedTextFileForNewTile.ts', fn: 'stampTextTileSeedPath', before: null },
      ];
      const out = [];
      for (const s of SITES) {
        const raw = ctx.read(s.file);
        if (raw === null) { out.push(fail(s.file, undefined, 'file missing')); continue; }
        const fn = functionBody(blank(raw), s.fn, { fnKeyword: true });
        if (!fn) { out.push(fail(s.file, undefined, `${s.fn}() not found`)); continue; }
        const assign = /\bfilePath\s*=(?!=)/.exec(fn.text);
        if (!assign) { out.push(fail(s.file, undefined, `${s.fn}() never assigns filePath`)); continue; }
        if (s.before) {
          const at = fn.text.indexOf(s.before);
          if (at < 0) out.push(fail(s.file, undefined, `${s.fn}(): marker \`${s.before}\` not found`));
          else if (assign.index > at) out.push(fail(s.file, undefined, `${s.fn}() assigns filePath after \`${s.before}\``));
        }
      }
      return out;
    },
  },
  {
    id: 'seed-writes-exclusive',
    title: 'new-file seeds are create-exclusive (never overwrite an existing vault file)',
    hint:
      'Seed through createUniqueMdFile / createMdFileExclusive (O_EXCL vault:create-file-text). The helper must not ' +
      "use trackComponentWrite: a losing EEXIST attempt targets the user's existing file.",
    run(ctx) {
      const out = [];
      for (const rel of [
        'src/renderer/lib/kanban/kanbanTileCreation.ts',
        'src/renderer/lib/tasklist/taskCreation.ts',
        'src/renderer/lib/tasklist/fileDropHandler.ts',
        'src/renderer/lib/boards/seedTextFileForNewTile.ts',
      ]) {
        const raw = ctx.read(rel);
        if (raw === null) { out.push(fail(rel, undefined, 'listed file is missing')); continue; }
        const src = stripCommentsStateful(raw);
        if (/\binvoke(?:Ok)?\s*\(\s*['"`]vault:write-file-text['"`]/.test(src)) out.push(fail(rel, undefined, "seeds via overwrite-capable 'vault:write-file-text'"));
        if (!/\b(?:createUniqueMdFile|createMdFileExclusive)\s*\(/.test(src)) out.push(fail(rel, undefined, 'does not call createUniqueMdFile / createMdFileExclusive'));
      }
      const HELPER = 'src/renderer/lib/vault/createMdExclusive.ts';
      const raw = ctx.read(HELPER);
      if (raw === null) return [...out, fail(HELPER, undefined, 'file missing')];
      const src = stripCommentsStateful(raw);
      if (!/['"`]vault:create-file-text['"`]/.test(src)) out.push(fail(HELPER, undefined, "must invoke 'vault:create-file-text'"));
      if (/\btrackComponentWrite\s*\(/.test(src)) out.push(fail(HELPER, undefined, 'must not use trackComponentWrite('));
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
    id: 'no-prod-md-test-flushers',
    title: 'the gateway’s test-only flusher hooks are not used by app code',
    hint: 'Use scheduleMarkdownWrite + registerForceWriter. Escape: `// allow-test-flusher: <reason>` on the line.',
    run(ctx) {
      const out = [];
      const SYMBOLS = ['__testRegisterFlusher', '__testUnregisterFlusher'];
      for (const rel of ctx.files([RENDERER, 'src/main', 'src/shared'], { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (rel === GATEWAY) continue;
        const src = ctx.read(rel);
        if (!SYMBOLS.some((s) => src.includes(s))) continue;
        src.split('\n').forEach((line, i) => {
          const hit = SYMBOLS.find((s) => line.includes(s));
          if (hit && !/\/\/\s*allow-test-flusher:/.test(line)) out.push(fail(rel, i + 1, `${hit}: ${line.trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'reload-cancels-writes',
    title: 'only the gateway and applyReloadFromDisk call cancelMarkdownWritesForDocument',
    hint:
      'Sync open editors via syncOpenEditorsAfterDiskMutation → applyReloadFromDisk, which cancels armed writes ' +
      'itself; a stale armed write would otherwise invert the reload.',
    run(ctx) {
      const ALLOWED = new Set([GATEWAY, 'src/renderer/stores/document.svelte.ts']);
      const CALL = /\bcancelMarkdownWritesForDocument\s*\(/;
      const out = [];
      const hits = new Set();
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        const raw = ctx.read(rel);
        const code = stripCommentsKeepLines(raw);
        if (!CALL.test(code)) continue;
        if (ALLOWED.has(rel)) { hits.add(rel); continue; }
        const rawLines = raw.split(/\r?\n/);
        code.split(/\r?\n/).forEach((l, i) => { if (CALL.test(l)) out.push(fail(rel, i + 1, (rawLines[i] ?? '').trim())); });
      }
      for (const rel of ALLOWED) if (!hits.has(rel)) out.push(fail(rel, undefined, 'allowed site no longer calls cancelMarkdownWritesForDocument — remove it from the list'));
      return out;
    },
  },
  {
    id: 'keep-local-backup',
    title: 'every "Keep local" overwrite first backs up the external version',
    hint:
      "Keeping Filo's version destroys the other device's edit unless it is copied to .filo/recovery/ first " +
      '(backupExternalVersion). Escape inside the action object: `// allow-keep-local-no-backup: <reason>`.',
    run(ctx) {
      const out = [];
      const TOKEN = 'backupExternalVersion(';
      let sites = 0;
      for (const rel of ctx.files(RENDERER, { ext: TS_SVELTE })) {
        const raw = ctx.read(rel);
        if (!/Keep (local|all|your edits)/.test(raw)) continue;
        const noComments = blank(raw, { strings: false });
        const code = blank(raw);
        for (const m of noComments.matchAll(/label\s*:\s*(['"`])(Keep local|Keep all|Keep your edits)\1/g)) {
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
      if (sites < 9) out.push(fail(RENDERER, undefined, `tripwire: only ${sites} Keep-local action sites found (expected >= 9)`));
      return out;
    },
  },
];
