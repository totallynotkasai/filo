/**
 * Vault-lifecycle coverage gate (Phase 4, Consolidation 2026-05-25).
 *
 * Every renderer module that holds module-level `$state(...)` and isn't
 * trivially scoped per-pane MUST subscribe to `vaultLifecycle.on('pre-swap',
 * ...)`. Without it, prior-vault state leaks into the new vault on swap — the
 * exact bug class Phase 4 was built to prevent.
 *
 * The gate walks `src/renderer/stores/**` and `src/renderer/lib/**`, picks
 * modules that contain `$state(`, and checks each one for an
 * `onVaultSwap(` call (or imports the registry indirectly). Stores that are
 * deliberately exempt from vault-swap reset (per-pane scopes, transient UI
 * state, the lifecycle registry itself) live in EXEMPT_MODULES with a
 * short reason.
 *
 * Fixing a failure: either subscribe via
 *   `onVaultSwap('pre-swap', 'storeName', () => { … reset … });`
 * or add the module path to EXEMPT_MODULES below with a one-line reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RENDERER_DIR = join(ROOT, 'src/renderer');

/**
 * Modules that hold `$state(...)` but legitimately do NOT need a vault-swap
 * reset. Keep the list short and well-commented; each entry is an excuse the
 * reviewer should be able to defend in 10 seconds.
 */
const EXEMPT_MODULES = new Map([
  // Sprint C / C25 — vault.svelte.ts used to be exempt as "owns the swap
  // event"; it now subscribes for the reconcile-throttle reset, so the
  // exemption is gone.

  // Per-pane state: every BoardScope owns its own instance and is recreated
  // on workspace re-hydrate. No shared module-level state survives a swap.
  ['src/renderer/stores/board.svelte.ts', 'per-BoardScope factory; state lives inside createBoardScopeBoard'],
  ['src/renderer/stores/canvas.svelte.ts', 'per-BoardScope factory; state lives inside createCanvasScope'],
  ['src/renderer/stores/spatial.svelte.ts', 'per-BoardScope factory; state lives inside createSpatialScope'],

  // Transient/ephemeral UI state with no vault binding. Holding stale values
  // across a swap is visually harmless — the next user gesture overrides.
  // Sprint B / B14 — guides/connections/ui/navigation now subscribe explicitly
  // (no relying on the next gesture). The remaining toolbar mirror is still
  // a per-editor-focus reset, not vault-scoped.
  ['src/renderer/stores/toolbar.svelte.ts', 'text-formatting toolbar mirror of TipTap state; resets per editor focus'],

  // Per-pane / per-board controllers — scoped by their consumer components and
  // torn down when the pane / board unmounts on workspace re-hydrate.
  ['src/renderer/lib/boards/boardScope.svelte.ts', 'per-pane scope factory; state lives inside createBoardScope'],
  ['src/renderer/lib/kanban/kanbanDragController.svelte.ts', 'per-Kanban-board drag controller; recreated on board mount'],
  ['src/renderer/lib/kanban/kanbanFiltersAndSort.svelte.ts', 'per-Kanban-board filter/sort state; recreated on board mount'],
  ['src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts', 'per-Kanban-board multi-select state; recreated on board mount'],
  ['src/renderer/lib/mindmap/marqueeSelectionController.svelte.ts', 'per-MindMap-board marquee controller; recreated on board mount'],
  ['src/renderer/lib/tasklist/filtersAndViews.svelte.ts', 'per-TaskList-board view/filter state; recreated on board mount'],
  ['src/renderer/lib/tasklist/multiSelectController.svelte.ts', 'per-TaskList-board multi-select state; recreated on board mount'],
  ['src/renderer/lib/tasklist/taskDragController.svelte.ts', 'per-TaskList-board drag controller; recreated on board mount'],

  // Per-instance UI helper: a fresh announcer per board, disposed on unmount.
  // Its $state is function-local (createAriaAnnouncer), never module-level.
  ['src/renderer/lib/utils/ariaAnnouncer.svelte.ts', 'per-instance aria-live announcer; created per board, disposed on unmount (Audit 5.3)'],
]);

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkTs(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (s.isFile() && /\.(ts|svelte\.ts)$/.test(entry)) out.push(full);
  }
}

const tsFiles = [];
walkTs(RENDERER_DIR, tsFiles);

const STATE_RE = /\$state\s*[<(]/;
// Match `onVaultSwap(` calls only when not preceded by alpha (avoids matching
// inside identifiers like `fireVaultSwap`). Strip line comments + block
// comments first so a `// onVaultSwap(...)` reference in a docblock doesn't
// false-positive the subscription check.
const SUBSCRIBE_RE = /(?<![A-Za-z0-9_$])onVaultSwap\s*\(/;
function stripComments(src) {
  // Order matters: block comments first, then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const offenders = [];
const staleExempt = [];

for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const text = readFileSync(abs, 'utf8');
  if (!STATE_RE.test(text)) continue;
  // The lifecycle module itself defines onVaultSwap; skip it.
  if (rel === 'src/renderer/core/vaultLifecycle.ts') continue;
  const codeOnly = stripComments(text);
  const exemptReason = EXEMPT_MODULES.get(rel);
  const subscribes = SUBSCRIBE_RE.test(codeOnly);
  if (exemptReason) {
    if (subscribes) {
      // Exempt + subscribes — exempt entry is redundant. Force the
      // reviewer to remove it so the list stays trim.
      staleExempt.push({ rel, reason: exemptReason });
    }
    continue;
  }
  if (!subscribes) {
    offenders.push(rel);
  }
}

let ok = true;

if (offenders.length > 0) {
  ok = false;
  console.error('[check-vault-lifecycle-coverage] FAILED — modules with $state but no onVaultSwap subscription:');
  for (const rel of offenders.sort()) {
    console.error(`  ${rel}`);
  }
  console.error(
    '\nFix: subscribe via `onVaultSwap(\'pre-swap\', \'storeName\', () => { … reset … });`\n' +
      '     at module init in each file, or add the path to EXEMPT_MODULES in\n' +
      '     scripts/check-vault-lifecycle-coverage.mjs with a one-line reason.',
  );
}

if (staleExempt.length > 0) {
  ok = false;
  console.error('\n[check-vault-lifecycle-coverage] FAILED — EXEMPT_MODULES entries that DO subscribe (redundant):');
  for (const { rel, reason } of staleExempt) {
    console.error(`  ${rel} — exempt reason was: "${reason}"`);
  }
  console.error('\nFix: remove these paths from EXEMPT_MODULES in scripts/check-vault-lifecycle-coverage.mjs.');
}

if (!ok) process.exit(1);

const exemptCount = EXEMPT_MODULES.size;
const subscribedCount = tsFiles.filter((abs) => {
  const text = readFileSync(abs, 'utf8');
  return STATE_RE.test(text) && SUBSCRIBE_RE.test(stripComments(text));
}).length;
console.log(
  `[check-vault-lifecycle-coverage] OK — ${subscribedCount} renderer modules subscribed, ${exemptCount} exempt.`,
);
process.exit(0);
