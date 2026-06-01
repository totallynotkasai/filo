/**
 * Phase 6.1.R3 CI gate — Command files target THIS command's board.
 *
 * Class-kill for "command marks the wrong board". The bug class:
 *   `boardCacheStore.markDirty(boardStore.current?.id ?? '')`
 * inside a Command's `execute` / `undo`. The active board can pivot
 * between command construction and dispatch (cross-board undo/redo, or
 * an async `applySnapshot` step that awaits a flush mid-way and lands
 * after the user clicked a different tab). Every command already
 * captures its originating board as `readonly targetBoardId: string` at
 * construction time — that field is the only correct dirty target.
 *
 * Audit2 2.4 fixed `UpdateBoardSettingsCommand` one-off. Audit-3 surfaced
 * three more (`UpdatePropertiesCommand`, `UpdateOrphanFrontmatterCommand`,
 * the metadata-kind branch of `applySnapshot`). Phase 6.1.R3 forecloses
 * the class instead of picking off instances.
 *
 * Two rules, scoped to `src/renderer/commands/**`:
 *
 *   1. `boardStore.current` is forbidden except in:
 *        - constructor fallback assignments `this.targetBoardId = … ?? boardStore.current?.id ?? '';`
 *          (the implicit allow-pattern — common across 35+ commands;
 *          requiring an annotation on each would be noise).
 *        - lines annotated with `// allow-board-store-current: <reason>`
 *          on the same line or the preceding line. Used for the rare
 *          active-vs-cache pivot inside `CascadeDeleteCommand.execute/undo`
 *          and `DeleteTilesCommand.execute/undo`, where the command
 *          operates across boards and must route same-board mutations
 *          through the runtime facade vs. other-board mutations through
 *          the cache-only persist path.
 *
 *   2. `boardCacheStore.markDirty(<arg>)` is forbidden unless `<arg>` is
 *        - `this.targetBoardId` (the canonical case), OR
 *        - an empty string literal `''` or `""` (board-agnostic
 *          commands like `CascadeDeleteCommand` / `ReplaceAllCommand`),
 *          OR
 *        - annotated with `// allow-non-target-markdirty: <reason>` on
 *          the same line. Used for the `applyFrontmatterPatchRebased`
 *          helper, which is the sanctioned chokepoint for "merge a
 *          rebased FM patch THEN dirty the originating board"; callers
 *          pass `this.targetBoardId` and the helper laundrs it through
 *          a `targetBoardId` parameter.
 *
 * Fixing a failure: replace `boardStore.current?.id` with
 * `this.targetBoardId`, OR replace `this.boardId` / `boardId` with
 * `this.targetBoardId`, OR annotate the line if the bypass is genuinely
 * required.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'src/renderer/commands');
// Files in commands/ that legitimately discuss these patterns in
// docstrings/comments (Command.ts, the README-style index.ts) — the
// per-line annotation check below already filters out comment-only
// references, so an empty allowlist here is the default. Add a path
// only if a future case can't be expressed via inline annotation.
const ALLOWLIST = new Set();

function toPosix(p) {
  return p.split(sep).join('/');
}

function listTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...listTsFiles(full));
    else if (s.isFile() && entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip block + line comments while preserving line counts so a regex
 * match against `code[i]` lines up with `raw[i]` for error reporting.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

// Rule 1: boardStore.current references.
const BOARDSTORE_CURRENT_RE = /\bboardStore\.current\b/;
// Implicit allow — the constructor-fallback pattern: a `this.targetBoardId =`
// assignment that uses `boardStore.current?.id` somewhere in its RHS.
const CTOR_FALLBACK_RE = /this\.targetBoardId\s*=.*boardStore\.current\?\.id/;
const ALLOW_BOARDSTORE_RE = /\/\/\s*allow-board-store-current:\s*\S+/;

// Rule 2: boardCacheStore.markDirty( call sites.
//
// The argument must be one of:
//   - `this.targetBoardId` (the canonical case)
//   - `''` or `""` (board-agnostic commands)
// `.+?` makes the capture non-greedy so a complex argument is still
// matched in full up to the closing `)`.
const MARKDIRTY_CALL_RE = /boardCacheStore\.markDirty\s*\(\s*([^)]*?)\s*\)/g;
const ALLOW_NON_TARGET_MARKDIRTY_RE = /\/\/\s*allow-non-target-markdirty:\s*\S+/;
function isAllowedMarkDirtyArg(arg) {
  const stripped = arg.trim();
  if (stripped === 'this.targetBoardId') return true;
  if (stripped === `''` || stripped === `""`) return true;
  return false;
}

const offenders = [];

for (const abs of listTsFiles(COMMANDS_DIR)) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWLIST.has(rel)) continue;
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);

  for (let i = 0; i < codeLines.length; i++) {
    const codeLine = codeLines[i];
    const rawLine = rawLines[i] ?? '';
    const prevRawLine = rawLines[i - 1] ?? '';
    const annotationWindow = `${prevRawLine}\n${rawLine}`;

    // Rule 1 — boardStore.current outside an allowed context.
    if (BOARDSTORE_CURRENT_RE.test(codeLine)) {
      const inCtorFallback = CTOR_FALLBACK_RE.test(codeLine);
      const annotated = ALLOW_BOARDSTORE_RE.test(annotationWindow);
      if (!inCtorFallback && !annotated) {
        offenders.push({
          rel,
          line: i + 1,
          rule: 'boardStore.current',
          snippet: rawLine.trim(),
        });
      }
    }

    // Rule 2 — boardCacheStore.markDirty(<arg>) with non-target arg.
    for (const match of codeLine.matchAll(MARKDIRTY_CALL_RE)) {
      const arg = match[1] ?? '';
      if (isAllowedMarkDirtyArg(arg)) continue;
      if (ALLOW_NON_TARGET_MARKDIRTY_RE.test(annotationWindow)) continue;
      offenders.push({
        rel,
        line: i + 1,
        rule: 'markDirty arg',
        snippet: rawLine.trim(),
      });
    }
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-command-targets-self] OK — scanned ${listTsFiles(COMMANDS_DIR).length} command file(s), 0 offenders.`,
  );
  process.exit(0);
}

console.error(
  `[check-command-targets-self] FAILED — ${offenders.length} violation(s):`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.line} [${o.rule}]`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nA command\'s execute / undo must dirty its ORIGINATING board, never\n' +
    'whichever board is active at dispatch time. Use `this.targetBoardId`\n' +
    '(captured in the constructor) for `boardCacheStore.markDirty(...)`. The\n' +
    'constructor-fallback pattern `this.targetBoardId = boardId ?? boardStore.current?.id ?? \'\'`\n' +
    'is implicitly allowed. For genuinely-required bypasses (active-vs-cache\n' +
    'pivot inside CascadeDeleteCommand / DeleteTilesCommand, or the\n' +
    '`applyFrontmatterPatchRebased` helper that takes a `targetBoardId`\n' +
    'parameter), annotate the line with `// allow-board-store-current: <reason>`\n' +
    'or `// allow-non-target-markdirty: <reason>` on the same or preceding line.',
);
process.exit(1);
