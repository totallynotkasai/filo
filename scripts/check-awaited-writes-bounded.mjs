/**
 * Audit5 R3 / Phase 4 + Audit-11 WC-1 / QC-1 / QC-2 — `ci:awaited-writes-bounded`.
 *
 * Pins the load-bearing facts so the "save()/quit hangs forever on a wedged
 * markdown write" class can't silently regress:
 *
 *   1. The shared write-scheduler primitive (`writeScheduler.ts` `fireWrite`)
 *      RACES a configured `writeTimeoutMs` against the awaited `performWrite`
 *      (`Promise.race` + a `setTimeout`-backed `WRITE_TIMEOUT` sentinel), and on
 *      timeout attributes a failure instead of awaiting forever.
 *   2. The markdown write gateway (`markdownFileWriter.ts`) CONFIGURES that bound
 *      on its `createScheduler` (`writeTimeoutMs: …`). Its `performWrite`
 *      (`writeMarkdownFile`) awaits an interactive prompt (the external-edit drift
 *      Reload / Keep-local toast), so it can wedge.
 *   3. EVERY scheduler that transitively awaits that same wedge-prone work
 *      configures the bound too. Audit-11 (WC-1 / QC-1 / QC-2) corrected the
 *      earlier FALSE premise that "only the gateway can wedge; the other
 *      schedulers await fire-and-forget IPC": `frontmatterWriteScheduler`'s
 *      `writeFrontmatter` awaits the SAME `writeMarkdownFile` the gateway does
 *      (its drift prompt + `vault:write-existing-file-text` IPC), and
 *      `boardWriteScheduler`'s `writeBoardFile` awaits an interactive board drift
 *      prompt + a pre-write `vault:stat` + `board:save` IPC — any of which can
 *      wedge on a stalled OneDrive/SMB volume and hang `flushAll` → `save()` →
 *      quit forever. So this gate REQUIRES the bound on both. (The config / misc
 *      schedulers are genuinely whole-file fire-and-forget; Phase 2 bounds them
 *      for uniformity, but this gate doesn't require it — they never transitively
 *      await `writeMarkdownFile`.)
 *
 *   4. Audit-12 H4 + Audit-13 H1 — EVERY fire path pre-drains any older in-flight
 *      write for a key before firing that key's pending (newest) write, so a
 *      non-serialized scheduler (board/config/misc) can't let the stale write
 *      land last and clobber the newer .board.json/config payload. The WC-3
 *      pre-drain `flush(key)` had was mirrored into `flushAll` (H4) and then into
 *      the DEBOUNCE-TIMER fire path (H1) — the common active-editing path, which
 *      previously just fired `void fireWrite(...)` with no drain. All three now
 *      route through the shared `drainPriorInFlight(key)` helper; the gate pins
 *      its call on both the timer-fire path and the flushAll loop.
 *
 *   5. Audit-12 M2 — the `writeTimeoutMs` branch SELF-HEALS the failed mark on a
 *      LATE success. On timeout the path is `markPathFailed`-ed but the
 *      underlying write keeps running; board/config/misc call their IPC directly
 *      (no `trackComponentWrite` to fire a late `endWrite(true)`), so without a
 *      continuation a write that exceeds the bound then SUCCEEDS leaves a
 *      permanent phantom "failed" — `save()` returns false all session, sticky
 *      `.filo/.dirty`, a phantom recovery prompt next launch — while the bytes
 *      are on disk. The gate REQUIRES `clearFailedPathAfterLateSuccess` in the
 *      timeout branch.
 *
 * Background: pre-R3 the gateway awaited `performWrite` with NO timeout anywhere
 * in the flush chain. A stranded drift-prompt promise (the toast-eviction bug)
 * left that await pending, so `flushAll → save()` hung and the 5 s main-process
 * destroy timer killed the window mid-write. Audit-11 found the frontmatter +
 * board schedulers reach the same await and were also unbounded. The edits below
 * close all of it; reverting any re-opens the hang.
 *
 * Heuristic token-presence check (comment-stripped) — not an AST walk. The
 * tokens asserted appear ONLY in the timeout mechanism / the gateway option, so
 * a comment that merely mentions them can't satisfy the gate (comments are
 * stripped first) and an unrelated edit can't accidentally satisfy it.
 *
 * Audit-13 M13 — the bare-presence checks were tightened so they can't be
 * satisfied by a no-longer-load-bearing token: the race must include the timeout
 * promise IN the `Promise.race([…])` array (not just call `Promise.race`); each
 * `writeTimeoutMs` must reference a finite SCREAMING_SNAKE constant (the old
 * `:\s*\w` also matched `Infinity`); and the root `WRITE_TIMEOUT_MS` constant must
 * be a finite numeric literal. Bite-test: set any `writeTimeoutMs: Infinity`, drop
 * the timeout from the race array, or set `WRITE_TIMEOUT_MS = Infinity` → red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Strip block + line comments so a doc-comment mention can't satisfy a check. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

// Audit-13 M13 — a `writeTimeoutMs` set to a FINITE SCREAMING_SNAKE constant
// reference. The all-caps shape inherently excludes `Infinity` (mixed case),
// `undefined` / `null` / `NaN` (lower/mixed case), and bare numeric literals —
// forcing a NAMED finite constant. (`WRITE_TIMEOUT_MS` / `MARKDOWN_WRITE_TIMEOUT_MS`
// today.) The bare `writeTimeoutMs\s*:\s*\w` it replaces also matched
// `writeTimeoutMs: Infinity`, which re-opens the wedge-forever hang. The companion
// forbidden token gives a clearer message for the specific unbounded values.
const TIMEOUT_FINITE_CONST = { token: /writeTimeoutMs\s*:\s*[A-Z_][A-Z0-9_]*\b/, why: 'writeTimeoutMs set to a finite SCREAMING_SNAKE constant (not Infinity / a literal)' };
const TIMEOUT_UNBOUNDED = { token: /writeTimeoutMs\s*:\s*(?:Infinity|Number\s*\.\s*POSITIVE_INFINITY|undefined|null|NaN)\b/, why: 'an unbounded/absent writeTimeoutMs (Infinity / undefined / null / NaN) re-opens the wedge-forever hang' };

const checks = [
  {
    file: 'src/renderer/lib/boards/writeScheduler.ts',
    label: 'the shared scheduler primitive races a write timeout + flushAll pre-drains per key',
    required: [
      { token: /writeTimeoutMs/, why: 'the configurable bound option' },
      {
        // Audit-13 M13 — pin that the race ARRAY actually includes the timeout
        // promise, not merely that `Promise.race(` appears. A refactor to
        // `Promise.race([writePromise])` that drops the timeout leg would
        // otherwise pass a bare-presence check and silently un-bound the write.
        token: /Promise\.race\s*\(\s*\[[^\]]*\btimeout\b/,
        why: 'the write-vs-timeout race ARRAY includes the timeout promise (Audit-13 M13)',
      },
      {
        // Audit-13 M13 — the timer must RESOLVE to the sentinel (so the timeout
        // leg actually carries it) and the outcome must be COMPARED to it. A bare
        // `WRITE_TIMEOUT` token surviving only in e.g. a type annotation no longer
        // satisfies the gate.
        token: /resolve\(\s*WRITE_TIMEOUT\s*\)/,
        why: 'the timeout timer resolves to the WRITE_TIMEOUT sentinel (Audit-13 M13)',
      },
      { token: /===\s*WRITE_TIMEOUT/, why: 'the race outcome is compared to the WRITE_TIMEOUT sentinel (Audit-13 M13)' },
      { token: /setTimeout\s*\(/, why: 'the timeout timer' },
      {
        // Audit-13 H1 — the DEBOUNCE-TIMER fire path must also drain any OLDER
        // in-flight write for a key before firing the newest, not just flush() /
        // flushAll(). During normal active editing the timer just fires; on a
        // slow/synced volume a prior write still in flight overlapped the new IPC
        // and the OS could land the OLDER one last. The token is the timer-fire
        // pre-drain call inside schedule()'s setTimeout (`drainPriorInFlight(key)`).
        token: /drainPriorInFlight\(key\)/,
        why: 'timer-fire per-key prior-in-flight pre-drain (Audit-13 H1) so the newest write lands last on the debounce path, not only flush/flushAll',
      },
      {
        // Audit-12 H4 / Audit-13 H1 — flushAll must drain any OLDER in-flight
        // write for a key BEFORE firing that key's pending (newest) write, so a
        // non-serialized scheduler (board/config/misc) can't let the stale write
        // land last and clobber the newer payload. Now routed through the shared
        // `drainPriorInFlight` helper that the timer-fire path also uses; the
        // token is its call inside flushAll's drained loop (mirrors flush()'s
        // WC-3 pre-drain).
        token: /drainPriorInFlight\(entry\.key\)/,
        why: 'flushAll per-key prior-in-flight pre-drain (Audit-12 H4) so the newest write lands last',
      },
      {
        // Audit-12 M2 — on a timeout the path is markPathFailed-ed but the
        // underlying write keeps running. A non-self-healing scheduler
        // (board/config/misc IPCs directly, no trackComponentWrite) needs the
        // timeout branch to self-heal the failed mark on a LATE success, else a
        // phantom "Save failed" + sticky .filo/.dirty persist for the whole
        // session. The token is the continuation that clears the failed path.
        token: /clearFailedPathAfterLateSuccess\s*\(/,
        why: 'the timeout branch self-heals the failed mark on a late success (Audit-12 M2) so a slow-but-successful write does not leave a permanent phantom failure',
      },
    ],
  },
  {
    file: 'src/renderer/lib/vault/markdownFileWriter.ts',
    label: 'the markdown gateway configures the write timeout',
    required: [TIMEOUT_FINITE_CONST],
    forbidden: [TIMEOUT_UNBOUNDED],
  },
  {
    // Audit-11 WC-1 / QC-1 — writeFrontmatter awaits the SAME writeMarkdownFile.
    file: 'src/renderer/lib/boards/frontmatterWriteScheduler.ts',
    label: 'the frontmatter scheduler bounds its (writeMarkdownFile-awaiting) write',
    required: [TIMEOUT_FINITE_CONST],
    forbidden: [TIMEOUT_UNBOUNDED],
  },
  {
    // Audit-11 WC-1 / QC-2 — writeBoardFile awaits an interactive drift prompt + IPC.
    file: 'src/renderer/lib/boards/boardWriteScheduler.ts',
    label: 'the board scheduler bounds its (drift-prompt + stat/save IPC) write',
    required: [TIMEOUT_FINITE_CONST],
    forbidden: [TIMEOUT_UNBOUNDED],
  },
  {
    // Audit-13 M13 — the bound's finiteness is structural at the ROOT constant,
    // not just the call sites: WRITE_TIMEOUT_MS (re-exported as
    // MARKDOWN_WRITE_TIMEOUT_MS) must be a finite numeric literal. A
    // `WRITE_TIMEOUT_MS = Infinity` would un-bound every scheduler that
    // references the (still-SCREAMING_SNAKE) constant, slipping past the
    // call-site checks above.
    file: 'src/renderer/lib/boards/boardWriteDebounce.ts',
    label: 'the shared write-timeout constant is a finite literal',
    required: [
      { token: /WRITE_TIMEOUT_MS\s*=\s*[0-9][0-9_]*\b/, why: 'WRITE_TIMEOUT_MS is a finite numeric literal' },
    ],
    forbidden: [
      { token: /WRITE_TIMEOUT_MS\s*=\s*(?:Infinity|Number\s*\.\s*POSITIVE_INFINITY)\b/, why: 'an Infinity bound un-bounds every scheduler referencing the constant' },
    ],
  },
];

const failures = [];
for (const check of checks) {
  let code;
  try {
    code = stripComments(readFileSync(join(ROOT, check.file), 'utf8'));
  } catch (err) {
    failures.push(`${check.file} — could not read: ${err.message}`);
    continue;
  }
  for (const { token, why } of check.required) {
    if (!token.test(code)) {
      failures.push(`${check.file} — missing /${token.source}/ (${why}) — ${check.label}`);
    }
  }
  for (const { token, why } of check.forbidden ?? []) {
    if (token.test(code)) {
      failures.push(`${check.file} — found forbidden /${token.source}/ (${why}) — ${check.label}`);
    }
  }
}

// ── Audit-19 EXT-5 arm — the Windows lock backoff is TIME-bounded and shared ──
// OneDrive / Dropbox / antivirus hold rename-blocking handles for seconds; the
// old count-based ~310 ms loop turned every such hold into "Save failed" plus a
// stray `.tmp` in the synced folder. `retryOnWindowsLock` must compare ELAPSED
// time against `budgetMs`, and the two rename sites must route through it.
/** Brace-matched body of `function <name>(` in comment-stripped code, or null. */
function functionBody(code, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[<(]`).exec(code);
  if (!decl) return null;
  let depth = 0;
  let i = decl.index + decl[0].length - 1;
  // Skip the parameter list (may hold `{}` option types).
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) break;
  }
  let open = code.indexOf('{', i);
  // Step over a return-type literal `Promise<{ … }>` (its `{` follows `<`/`:`).
  while (open >= 0 && /[<:,|&(]\s*$/.test(code.slice(i, open))) {
    let d = 0;
    let j = open;
    for (; j < code.length; j++) {
      if (code[j] === '{') d++;
      else if (code[j] === '}' && --d === 0) break;
    }
    i = j + 1;
    open = code.indexOf('{', i);
  }
  if (open < 0) return null;
  depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return code.slice(open, k + 1);
  }
  return null;
}
const LOCK_ARM = [
  {
    file: 'src/main/vault/filenameUtils.ts',
    fn: 'retryOnWindowsLock',
    required: [
      { token: /Date\.now\(\)|performance\.now\(\)/, why: 'measures elapsed time' },
      { token: /elapsed\s*>=?\s*budgetMs|budgetMs\s*<=?\s*elapsed/, why: 'stops on an ELAPSED-time budget, not an attempt count' },
    ],
  },
  {
    file: 'src/main/vault/filenameUtils.ts',
    fn: 'atomicWriteFile',
    required: [{ token: /retryOnWindowsLock\s*\(\s*\(\)\s*=>\s*fs\.rename\(\s*tmpPath\s*,\s*filePath\s*\)/, why: 'the tmp→target rename uses the shared time-bounded lock retry' }],
    forbidden: [{ token: /\bRETRY_DELAYS_MS\s*=\s*\[/, why: 'a count-based RETRY_DELAYS_MS table re-introduces the ~310 ms lock budget' }],
  },
  {
    file: 'src/main/vault/fileOps.ts',
    fn: 'renameItem',
    required: [{ token: /retryOnWindowsLock\s*\(\s*\(\)\s*=>\s*fs\.rename\(\s*oldPath\s*,\s*newPath\s*\)/, why: 'a folder/file rename retries a transient Windows lock (EPERM on a held child handle)' }],
  },
];
for (const arm of LOCK_ARM) {
  let body = null;
  try {
    body = functionBody(stripComments(readFileSync(join(ROOT, arm.file), 'utf8')), arm.fn);
  } catch (err) {
    failures.push(`${arm.file} — could not read: ${err.message}`);
    continue;
  }
  if (body === null) {
    failures.push(`${arm.file} — function ${arm.fn}() not found (Audit-19 EXT-5 lock-retry arm)`);
    continue;
  }
  for (const { token, why } of arm.required) {
    if (!token.test(body)) failures.push(`${arm.file} — ${arm.fn}() missing /${token.source}/ (${why}) — Audit-19 EXT-5`);
  }
  for (const { token, why } of arm.forbidden ?? []) {
    if (token.test(body)) failures.push(`${arm.file} — ${arm.fn}() has forbidden /${token.source}/ (${why}) — Audit-19 EXT-5`);
  }
}

if (failures.length > 0) {
  console.error('[check-awaited-writes-bounded] FAILED — Audit5 R3 (#1) bounded-write invariant regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nR3 / Audit-11 WC-1 bound every awaited write that can wedge (a never-\n' +
      'resolving external-edit drift prompt, or a stuck IPC) so it cannot hang\n' +
      'flushAll() / vaultStore.save() / quit forever. Restore ALL:\n' +
      '  - writeScheduler.ts `fireWrite`: the `Promise.race([writePromise, timeout])`\n' +
      '    against `opts.writeTimeoutMs` (resolves to the WRITE_TIMEOUT sentinel,\n' +
      '    attributes a failure + keeps the .filo/.dirty sentinel dirty on timeout).\n' +
      '  - markdownFileWriter.ts: `writeTimeoutMs: MARKDOWN_WRITE_TIMEOUT_MS` on its\n' +
      '    createScheduler(...) options.\n' +
      '  - frontmatterWriteScheduler.ts + boardWriteScheduler.ts: `writeTimeoutMs:\n' +
      '    WRITE_TIMEOUT_MS` — both transitively await the same wedge-prone work.\n' +
      'See AUDIT5_REMEDIATION_PLAN_2026-06-02.md R3, AUDIT11_REMEDIATION_PLAN_2026-06-06.md\n' +
      'Phase 2, and src/tests/unit/{boundedWriteFlush,audit11Phase2}.test.ts.',
  );
  process.exit(1);
}

console.log('[check-awaited-writes-bounded] OK — write-timeout mechanism + gateway/frontmatter/board bounds present.');
process.exit(0);
