/**
 * Direct-board-mutation ratchet (Phase G.2 regression-prevention gate).
 *
 * The 2026-05-23 Phase 7 risk register predicted that future refactors
 * would re-introduce direct mutator calls bypassing the command-pattern
 * undo stack. Phase 7 wired 12 mutators through `historyStore.execute(new
 * <Update*>Command(...))`; without an automated gate the 13th direct
 * call lands silently and the user loses Ctrl+Z coverage on whatever the
 * command was supposed to wrap.
 *
 * This gate fails the build if any tracked mutator is called from outside
 * `src/renderer/commands/`. The tracked surface is intentionally small —
 * we only gate the high-value "must-be-undoable" writers identified in
 * IMPL_PLAN_2026-05-24_v2.md Phase G.2:
 *
 *   - boardStore.updateSettings
 *   - boardStore.deleteSettingsKeys
 *   - boardCacheStore.setKanbanColumnCollapsed
 *   - boardCacheStore.setKanbanColumnWipLimit
 *   - boardCacheStore.setKanbanColumnWidth
 *   - boardCacheStore.setKanbanSavedViews
 *   - boardCacheStore.setTaskListSavedViews
 *
 * `boardStore.updateTile` is NOT gated — too many legitimate ephemeral
 * call sites (Timer remaining/isRunning, Audio isPlaying, Video
 * isPlaying, drag-restore loops) to enforce without an unreasonable
 * allowlist. Code review covers those.
 *
 * Escape hatch: lines containing `// allow-direct-mutation:` are skipped.
 * The marker is honoured on the same line as the call OR the immediately
 * preceding line — the latter accommodates multi-line call sites where
 * the call spans several lines (e.g. `boardStore.updateSettings({\n  ... \n})`).
 * The marker must include a justification, e.g.
 * `// allow-direct-mutation: gesture-survival write, command pushed on
 * dragend`. Reviewers gate on the marker.
 *
 * Tests, the commands directory itself, and the store source file
 * defining the mutator are exempt.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

// Directories whose contents are allowed to call the tracked mutators directly.
const ALLOW_DIRS = [
  'src/renderer/commands/',
  'src/tests/',
];

// Files where the mutators are *defined* — they obviously contain the
// method name in declaration form, not as a call site.
const ALLOW_FILES = new Set([
  'src/renderer/stores/board.svelte.ts',
  'src/renderer/stores/boardCache.svelte.ts',
  'src/renderer/stores/boardCacheKanban.ts',
  'src/renderer/stores/boardCacheTaskList.ts',
]);

const MUTATORS = [
  { object: 'boardStore', method: 'updateSettings' },
  { object: 'boardStore', method: 'deleteSettingsKeys' },
  { object: 'boardCacheStore', method: 'setKanbanColumnCollapsed' },
  { object: 'boardCacheStore', method: 'setKanbanColumnWipLimit' },
  { object: 'boardCacheStore', method: 'setKanbanColumnWidth' },
  { object: 'boardCacheStore', method: 'setKanbanSavedViews' },
  { object: 'boardCacheStore', method: 'setTaskListSavedViews' },
];

// Match `<object>.<method>(`. The trailing `(` is what distinguishes a
// call from an interface declaration / type reference / JSDoc mention.
const PATTERNS = MUTATORS.map(({ object, method }) => ({
  name: `${object}.${method}`,
  // \b on each side keeps `setKanbanColumnCollapsed` from matching
  // `setKanbanColumnCollapsedAndPersist`; the `\s*\(` tail anchors to a
  // call expression.
  re: new RegExp(`\\b${object}\\.${method}\\s*\\(`),
}));

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isAllowedPath(rel) {
  if (ALLOW_FILES.has(rel)) return true;
  for (const dir of ALLOW_DIRS) {
    if (rel.startsWith(dir)) return true;
  }
  return false;
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
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && hasTrackedExtension(entry)) {
      out.push(full);
    }
  }
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
let scannedCount = 0;
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (isAllowedPath(rel)) continue;
  scannedCount++;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : '';
    if (
      line.includes('// allow-direct-mutation:') ||
      prev.includes('// allow-direct-mutation:')
    ) {
      continue;
    }
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        offenders.push({ rel, lineNo: i + 1, mutator: name, snippet: line.trim() });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-direct-board-mutations] OK — scanned ${scannedCount} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-direct-board-mutations] FAILED — ${offenders.length} direct-mutation violation(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} (${o.mutator})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route the mutation through a Command class under src/renderer/commands/\n' +
    'and dispatch via historyStore.execute(new <Update*>Command(...)). The command\n' +
    'pattern preserves Ctrl+Z coverage and gives undo a snapshot to restore.\n' +
    'If the call is genuinely non-undoable (transient UI state, gesture-survival\n' +
    'write committed via a command at gesture end), add\n' +
    '`// allow-direct-mutation: <reason>` to the same line.',
);
process.exit(1);
