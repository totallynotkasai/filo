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
 *   4. Audit-12 H4 — `flushAll` PRE-DRAINS any older in-flight write for a key
 *      before firing that key's pending (newest) write, so a non-serialized
 *      scheduler (board/config/misc) can't let the stale write land last and
 *      clobber the newer .board.json/config payload (the WC-3 pre-drain that
 *      `flush(key)` already had, now mirrored in `flushAll`).
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

const checks = [
  {
    file: 'src/renderer/lib/boards/writeScheduler.ts',
    label: 'the shared scheduler primitive races a write timeout + flushAll pre-drains per key',
    required: [
      { token: /writeTimeoutMs/, why: 'the configurable bound option' },
      { token: /Promise\.race\s*\(/, why: 'the write-vs-timeout race' },
      { token: /WRITE_TIMEOUT/, why: 'the timeout-outcome sentinel' },
      { token: /setTimeout\s*\(/, why: 'the timeout timer' },
      {
        // Audit-12 H4 — flushAll must drain any OLDER in-flight write for a key
        // BEFORE firing that key's pending (newest) write, so a non-serialized
        // scheduler (board/config/misc) can't let the stale write land last and
        // clobber the newer payload. The token is the per-key prior-in-flight
        // drain inside flushAll's drained loop (mirrors flush()'s WC-3 pre-drain).
        token: /inFlight\.get\(entry\.key\)/,
        why: 'flushAll per-key prior-in-flight pre-drain (Audit-12 H4) so the newest write lands last',
      },
    ],
  },
  {
    file: 'src/renderer/lib/vault/markdownFileWriter.ts',
    label: 'the markdown gateway configures the write timeout',
    required: [
      { token: /writeTimeoutMs\s*:\s*\w/, why: 'createScheduler({ writeTimeoutMs: … }) on the gateway' },
    ],
  },
  {
    // Audit-11 WC-1 / QC-1 — writeFrontmatter awaits the SAME writeMarkdownFile.
    file: 'src/renderer/lib/boards/frontmatterWriteScheduler.ts',
    label: 'the frontmatter scheduler bounds its (writeMarkdownFile-awaiting) write',
    required: [
      { token: /writeTimeoutMs\s*:\s*\w/, why: 'createScheduler({ writeTimeoutMs: … }) — writeFrontmatter awaits the gateway-grade writeMarkdownFile' },
    ],
  },
  {
    // Audit-11 WC-1 / QC-2 — writeBoardFile awaits an interactive drift prompt + IPC.
    file: 'src/renderer/lib/boards/boardWriteScheduler.ts',
    label: 'the board scheduler bounds its (drift-prompt + stat/save IPC) write',
    required: [
      { token: /writeTimeoutMs\s*:\s*\w/, why: 'createScheduler({ writeTimeoutMs: … }) — writeBoardFile awaits an interactive board drift prompt + vault:stat + board:save' },
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
