/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — `ci:frontmatter-delta-write`.
 *
 * Pins the STRUCTURAL invariant that ends the recurring untouched-key-drop class:
 *
 *   The field/popup frontmatter write path NEVER serialises a cached full FM
 *   object as its write source. It records an explicit FrontmatterDelta and the
 *   gateway applies that delta to a FRESH disk read at write time — so `nextFm`
 *   and the source-preserving `originalFrontmatter` baseline both derive from the
 *   SAME fresh read, and every key the user did NOT touch (including an external
 *   addition the in-memory cache never saw) is emitted from disk by construction.
 *
 * Before Phase 4 the write path read `documentStore.getFrontmatter(docId)` (a
 * full object that could go stale / over-cleaned / empty) and diffed it against a
 * SEED-TIME source; the CST engine then faithfully wrote the wrong object,
 * silently dropping untouched keys. Nine prior audits kept finding new instances
 * because the invariant was test-enforced, not structural. This gate makes it
 * structural: revert any leg below and the gate fails.
 *
 * Two halves:
 *  A. The gateway's delta branch (`markdownFileWriter.ts`) reads CURRENT disk and
 *     derives BOTH the applied object AND the baseline from that one read —
 *     `applyFrontmatterDelta(parsedFresh.frontmatter, …)` +
 *     `originalFrontmatter: parsedFresh.rawFrontmatter`. If those two ever sourced
 *     from different reads (or the cache), the "rewrites only the delta keys"
 *     guarantee would break.
 *  B. The field-edit + Properties write sites CONSTRUCT a delta (patch → delta,
 *     or open-snapshot → current diff) and thread it — rather than handing the
 *     gateway a full object as the authoritative FM. This INCLUDES the orphan
 *     card/task write (`applyOrphanPatchRebased` in kanbanCommands.ts): Audit-11
 *     FILO-UR-1 found Phase 4 migrated the docId path to the delta but left this
 *     twin on the old whole-object clean (`{ ...baseFm, ...patch }` + a drop-
 *     empty-keys loop), which deleted present-but-empty disk keys (`aliases:` /
 *     `cssclasses:`) on execute AND undo. The orphan check below is FUNCTION-
 *     SCOPED (`within`): it REQUIRES a delta and FORBIDS a `frontmatter:` whole-
 *     object write inside that one function, so the ban can't false-positive on
 *     an unrelated `frontmatter:` elsewhere in the (large) command file.
 *
 * Heuristic token-presence check on a comment-stripped copy (same pragmatic style
 * as check-awaited-writes-bounded.mjs / check-eol-preservation.mjs) — not an AST
 * walk. The tokens asserted appear ONLY in the delta mechanism, so a doc-comment
 * that merely mentions them can't satisfy the gate (comments are stripped first).
 * A `within` check instead blanks strings + comments (offset-preserving) so the
 * function-body brace-match is robust and a forbidden token inside a string can't
 * trip it; the whole-file checks keep `stripComments` because one of them asserts
 * a string-literal channel name (`vault:read-file-text`).
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

/**
 * Replace string-literal + comment bodies with spaces (offset/length preserved),
 * so brace-matching for a `within` slice ignores braces inside strings/`${…}` and
 * a forbidden token inside a string can't trip the check. Same blanker the
 * reconciler-vault-guard / no-dead-flush gates use.
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
    // sq | dq | tpl
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/**
 * Returns the body (`{…}` inclusive) of a top-level `function NAME(...)` from
 * already-blanked code, or null if not found. Balances the params from the `(`
 * the header regex consumed, then balances the body braces. Used by `within`
 * checks to scope a token search to one write site.
 */
function sliceFunctionBody(code, fnName) {
  const headerRe = new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`, 'g');
  const m = headerRe.exec(code);
  if (!m) return null;
  let i = headerRe.lastIndex - 1; // at the '('
  let depth = 0;
  let paramEnd = -1;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) { paramEnd = i; break; }
    }
  }
  if (paramEnd < 0) return null;
  let j = paramEnd + 1;
  while (j < code.length && code[j] !== '{') j++; // skip any return-type annotation
  if (j >= code.length) return null;
  const bodyStart = j;
  let bdepth = 0;
  for (; j < code.length; j++) {
    if (code[j] === '{') bdepth++;
    else if (code[j] === '}') {
      bdepth--;
      if (bdepth === 0) { j++; break; }
    }
  }
  return code.slice(bodyStart, j);
}

const checks = [
  {
    file: 'src/renderer/lib/vault/frontmatterDelta.ts',
    label: 'the pure delta primitives exist',
    required: [
      { token: /export\s+function\s+patchToFrontmatterDelta\b/, why: 'patch → delta builder' },
      { token: /export\s+function\s+diffToFrontmatterDelta\b/, why: 'full-object → delta builder (Properties)' },
      { token: /export\s+function\s+applyFrontmatterDelta\b/, why: 'delta applied to a base object' },
    ],
  },
  {
    file: 'src/renderer/lib/vault/markdownFileWriter.ts',
    label: 'the gateway applies the delta to a SAME-TICK fresh disk read',
    required: [
      { token: /args\.frontmatterDelta/, why: 'the delta is threaded into the write' },
      { token: /vault:read-file-text/, why: 'the in-chain fresh disk read' },
      {
        token: /applyFrontmatterDelta\s*\(\s*parsedFresh\.frontmatter/,
        why: 'nextFm derives from the fresh read (not the cache)',
      },
      {
        token: /originalFrontmatter\s*:\s*parsedFresh\.rawFrontmatter/,
        why: 'the source-preserving baseline derives from the SAME fresh read',
      },
    ],
  },
  {
    file: 'src/renderer/commands/frontmatterRebase.ts',
    label: 'the undo/redo rebase chokepoint threads a delta',
    required: [
      { token: /scheduleFrontmatterWrite\s*\([^)]*patchToFrontmatterDelta\s*\(/, why: 'the rebased commit schedules a delta' },
    ],
  },
  {
    file: 'src/renderer/commands/kanbanCommands.ts',
    label: 'the Kanban field command threads a delta',
    required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'UpdateCardFieldCommand constructs a delta' }],
  },
  {
    // Audit-11 FILO-UR-1 — the orphan card/task write site. Function-scoped so
    // the `frontmatter:` ban targets exactly this write, not the rest of the file.
    file: 'src/renderer/commands/kanbanCommands.ts',
    within: 'applyOrphanPatchRebased',
    label: 'the orphan card/task write threads a delta, not a cleaned whole object (FILO-UR-1)',
    required: [
      { token: /patchToFrontmatterDelta\s*\(/, why: 'the orphan commit builds a delta from the patch' },
      { token: /frontmatterDelta\s*:/, why: 'the orphan write threads frontmatterDelta into writeMarkdownFile' },
    ],
    forbidden: [
      { token: /\bfrontmatter\s*:/, why: 'a `frontmatter:` whole-object write reintroduces the FILO-UR-1 clean-loop key drop' },
    ],
  },
  {
    file: 'src/renderer/commands/taskCommands.ts',
    label: 'the Task field command threads a delta',
    required: [{ token: /patchToFrontmatterDelta\s*\(/, why: 'UpdateTaskFieldCommand constructs a delta' }],
  },
  {
    file: 'src/renderer/commands/propertiesCommands.ts',
    label: 'the Properties undo command threads a delta',
    required: [{ token: /frontmatterDelta\s*:/, why: 'UpdatePropertiesCommand writes via a delta' }],
  },
  {
    file: 'src/renderer/components/tiles/PropertiesPopup.svelte',
    label: 'the Properties popup live-write threads an open-snapshot diff delta',
    required: [
      { token: /diffToFrontmatterDelta\s*\(/, why: 'the popup diffs its open-time snapshot to current rows' },
      { token: /frontmatterDelta\s*:/, why: 'the popup write threads the delta' },
    ],
  },
];

const failures = [];
for (const check of checks) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, check.file), 'utf8');
  } catch (err) {
    failures.push(`${check.file} — could not read: ${err.message}`);
    continue;
  }
  // A `within` check scopes the token search to one function body (so a
  // forbidden `frontmatter:` only trips on THAT write site, not elsewhere in the
  // file). It blanks strings+comments for a robust brace-match; the whole-file
  // checks keep `stripComments` so a string-literal channel name survives.
  let scope;
  if (check.within) {
    const body = sliceFunctionBody(blankStringsAndComments(raw), check.within);
    if (body === null) {
      failures.push(`${check.file} — function ${check.within}(...) not found (gate target moved?) — ${check.label}`);
      continue;
    }
    scope = body;
  } else {
    scope = stripComments(raw);
  }
  for (const { token, why } of check.required ?? []) {
    if (!token.test(scope)) {
      failures.push(`${check.file} — missing /${token.source}/ (${why}) — ${check.label}`);
    }
  }
  for (const { token, why } of check.forbidden ?? []) {
    if (token.test(scope)) {
      failures.push(`${check.file} — forbidden /${token.source}/ present (${why}) — ${check.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[check-frontmatter-delta-write] FAILED — Phase 4 delta-write invariant regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nThe field/popup frontmatter write must apply an explicit delta to a FRESH disk\n' +
      'read — never serialise a cached full object as the write source. Restore:\n' +
      '  - markdownFileWriter.ts: the `args.frontmatterDelta` branch reads\n' +
      '    `vault:read-file-text` in-chain and assembles with\n' +
      '    `applyFrontmatterDelta(parsedFresh.frontmatter, …)` +\n' +
      '    `originalFrontmatter: parsedFresh.rawFrontmatter` (SAME read for both).\n' +
      '  - the field commands (kanban/task) + the rebase chokepoint thread\n' +
      '    `patchToFrontmatterDelta(patch)` into `scheduleFrontmatterWrite`.\n' +
      '  - the orphan write (`applyOrphanPatchRebased`) threads a\n' +
      '    `frontmatterDelta` and never a `frontmatter:` whole object (FILO-UR-1).\n' +
      '  - UpdatePropertiesCommand + PropertiesPopup thread a `frontmatterDelta`\n' +
      '    (the popup via `diffToFrontmatterDelta(openSnapshot, currentRows)`).\n' +
      'See WRITE_PATH_REMEDIATION_PLAN_2026-06-04.md Phase 4 and\n' +
      'src/tests/unit/{frontmatterDelta,gatewayDeltaWrite,writePathRemediationPhase4}.test.ts.',
  );
  process.exit(1);
}

console.log('[check-frontmatter-delta-write] OK — delta-based write source structural across gateway + field/popup sites.');
process.exit(0);
