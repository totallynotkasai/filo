/**
 * Audit5 R3 / Phase 4 — `ci:awaited-writes-bounded`.
 *
 * Pins the two load-bearing facts of R3 (#1) so the "save()/quit hangs forever
 * on a wedged markdown write" class can't silently regress:
 *
 *   1. The shared write-scheduler primitive (`writeScheduler.ts` `fireWrite`)
 *      RACES a configured `writeTimeoutMs` against the awaited `performWrite`
 *      (`Promise.race` + a `setTimeout`-backed `WRITE_TIMEOUT` sentinel), and on
 *      timeout attributes a failure instead of awaiting forever.
 *   2. The markdown write gateway (`markdownFileWriter.ts`) actually CONFIGURES
 *      that bound on its `createScheduler` (`writeTimeoutMs: …`). The gateway is
 *      the one scheduler whose `performWrite` (`writeMarkdownFile`) awaits an
 *      interactive prompt (the external-edit drift Reload / Keep-local toast),
 *      so it is the one that can wedge; the board / config / misc / frontmatter
 *      schedulers await only fire-and-forget IPC and are intentionally NOT
 *      required to set a bound here.
 *
 * Background: pre-R3 the gateway awaited `performWrite` with NO timeout anywhere
 * in the flush chain. A stranded drift-prompt promise (the toast-eviction bug)
 * left that await pending, so `flushAll → save()` hung and the 5 s main-process
 * destroy timer killed the window mid-write. Both edits below close that;
 * reverting either re-opens it.
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
    label: 'the shared scheduler primitive races a write timeout',
    required: [
      { token: /writeTimeoutMs/, why: 'the configurable bound option' },
      { token: /Promise\.race\s*\(/, why: 'the write-vs-timeout race' },
      { token: /WRITE_TIMEOUT/, why: 'the timeout-outcome sentinel' },
      { token: /setTimeout\s*\(/, why: 'the timeout timer' },
    ],
  },
  {
    file: 'src/renderer/lib/vault/markdownFileWriter.ts',
    label: 'the markdown gateway configures the write timeout',
    required: [
      { token: /writeTimeoutMs\s*:\s*\w/, why: 'createScheduler({ writeTimeoutMs: … }) on the gateway' },
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
    '\nR3 bounds the markdown gateway\'s awaited write so a wedged write (a never-\n' +
      'resolving external-edit drift prompt, or a stuck IPC) cannot hang\n' +
      'flushAll() / vaultStore.save() / quit forever. Restore BOTH:\n' +
      '  - writeScheduler.ts `fireWrite`: the `Promise.race([writePromise, timeout])`\n' +
      '    against `opts.writeTimeoutMs` (resolves to the WRITE_TIMEOUT sentinel,\n' +
      '    attributes a failure + keeps the .filo/.dirty sentinel dirty on timeout).\n' +
      '  - markdownFileWriter.ts: `writeTimeoutMs: MARKDOWN_WRITE_TIMEOUT_MS` on its\n' +
      '    createScheduler(...) options.\n' +
      'See AUDIT5_REMEDIATION_PLAN_2026-06-02.md R3 and src/tests/unit/boundedWriteFlush.test.ts.',
  );
  process.exit(1);
}

console.log('[check-awaited-writes-bounded] OK — write-timeout mechanism + gateway bound present.');
process.exit(0);
