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
 *
 * ── Audit-14 7.4 — two limits this gate cannot close on its own ──
 *  1. It checks SUBSCRIPTION, not that the callback BODY resets. A regex can't
 *     read the body, so the real guarantee is a per-module RESET unit test. The
 *     RESET_COVERAGE manifest below pins those tests for the highest-consequence
 *     vault-data modules; the gate fails if one is dropped. The behavioral tests
 *     + `vaultLifecycleCoverage.test.ts` (imports each module, asserts the handler
 *     actually registers) are the load-bearing guard — this gate is the tripwire.
 *  2. The `$state(`-only scan was blind to a module-level reactive collection
 *     declared WITHOUT `$state` (a session-global `SvelteMap`/`SvelteSet`). The
 *     scan now also flags those (MODULE_LEVEL_REACTIVE_RE), line-anchored to module
 *     scope so per-board/per-pane factories (function-local, indented) are not
 *     falsely surfaced.
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
  ['src/renderer/lib/tasklist/datePickerViewState.svelte.ts', 'per-popover date-picker view-month state; recreated on each TaskDatePicker mount'],

  // Per-instance UI helper: a fresh announcer per board, disposed on unmount.
  // Its $state is function-local (createAriaAnnouncer), never module-level.
  ['src/renderer/lib/utils/ariaAnnouncer.svelte.ts', 'per-instance aria-live announcer; created per board, disposed on unmount (Audit 5.3)'],
]);

/**
 * Audit-14 7.4 — RESET COVERAGE MANIFEST.
 *
 * Subscribing to `onVaultSwap` proves a reset is WIRED, never that the callback
 * body actually RESETS — a regex gate can't read the body. The real guarantee is
 * a unit test that drives the reset and asserts the state cleared. For the
 * highest-consequence vault-scoped modules (the ones holding real vault data),
 * pin that test here by a distinctive token it must contain (the module's reset
 * symbol, or a post-swap-clears assertion). This makes "the reset is tested" a CI
 * invariant: a future refactor that drops the reset test fails loud instead of
 * leaving the gate green on a reset that no longer resets. Add an entry when you
 * add a new vault-data store. The behavioral tests + vaultLifecycleCoverage.test.ts
 * (which imports each module and asserts the handler actually registers) remain
 * the real guard; this manifest is the tripwire that keeps them in place.
 */
const RESET_COVERAGE = [
  { module: 'src/renderer/stores/vaultRecovery.ts', test: 'src/tests/unit/vaultRecovery.test.ts', token: /acknowledgeRecovery/ },
  { module: 'src/renderer/lib/vault/dirtyFlagRecovery.ts', test: 'src/tests/unit/dirtyFlagRecovery.test.ts', token: /checkRecovery/ },
  { module: 'src/renderer/lib/boards/writeStateTracking.ts', test: 'src/tests/unit/audit14Phase1.test.ts', token: /__resetDirtyTrackingForTests/ },
  { module: 'src/renderer/lib/vault/markdownFileWriter.ts', test: 'src/tests/unit/gatewayDeltaWrite.test.ts', token: /__resetMarkdownFileWriterForTests/ },
  { module: 'src/renderer/stores/fileTags.svelte.ts', test: 'src/tests/unit/fileTagsCascade.test.ts', token: /fileTagsStore\.reset\s*\(/ },
];

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
// Audit-14 7.4 — also flag a MODULE-LEVEL (column-0) reactive collection that is
// NOT wrapped in `$state(...)`: a session-global `SvelteMap`/`SvelteSet` survives
// a vault swap exactly like module `$state`, but the `$state`-only scan was blind
// to it. The line anchor (`^`, with /m) keeps this to module scope — a
// per-board/per-pane factory declares its collections INSIDE a function (indented,
// so `^` never matches), which is the deliberately-exempt case. Plain
// `new Map()`/`new Set()` is intentionally NOT scanned: most module-level plain
// maps are non-reactive memo caches, not vault state, and the named plain-map
// vault stores are pinned by RESET_COVERAGE below instead.
const MODULE_LEVEL_REACTIVE_RE = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+[^\n=]*=\s*new\s+Svelte(?:Map|Set)\s*\(/m;
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
  // The lifecycle module itself defines onVaultSwap; skip it.
  if (rel === 'src/renderer/core/vaultLifecycle.ts') continue;
  const codeOnly = stripComments(text);
  // 7.4 — flag a module that holds module `$state` OR a module-level reactive
  // collection; both survive a vault swap unless explicitly reset.
  if (!STATE_RE.test(codeOnly) && !MODULE_LEVEL_REACTIVE_RE.test(codeOnly)) continue;
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

// Audit-14 7.4 — RESET COVERAGE manifest: each critical vault-scoped module must
// keep a unit test that EXERCISES its reset (the named token must survive).
for (const { module, test, token } of RESET_COVERAGE) {
  let moduleMissing = false;
  try {
    readFileSync(join(ROOT, module), 'utf8');
  } catch {
    moduleMissing = true;
  }
  if (moduleMissing) {
    ok = false;
    console.error(
      `\n[check-vault-lifecycle-coverage] FAILED — RESET_COVERAGE module not found: ${module}\n` +
        '  The module moved or was renamed — update RESET_COVERAGE in scripts/check-vault-lifecycle-coverage.mjs.',
    );
    continue;
  }
  let testSrc = '';
  try {
    testSrc = readFileSync(join(ROOT, test), 'utf8');
  } catch {
    /* falls into the missing-test branch below */
  }
  if (!testSrc) {
    ok = false;
    console.error(
      `\n[check-vault-lifecycle-coverage] FAILED — RESET_COVERAGE test missing for ${module}: ${test}\n` +
        '  A vault-scoped data module must keep a unit test that drives its reset; restore the test or update the manifest.',
    );
    continue;
  }
  if (!token.test(testSrc)) {
    ok = false;
    console.error(
      `\n[check-vault-lifecycle-coverage] FAILED — ${test} no longer exercises ${module}'s reset (missing /${token.source}/).\n` +
        '  Subscribing to onVaultSwap proves the reset is WIRED, not that it RESETS — keep the behavioral reset test\n' +
        '  in place, or update the RESET_COVERAGE token in scripts/check-vault-lifecycle-coverage.mjs.',
    );
  }
}

if (!ok) process.exit(1);

const exemptCount = EXEMPT_MODULES.size;
const subscribedCount = tsFiles.filter((abs) => {
  const codeOnly = stripComments(readFileSync(abs, 'utf8'));
  const flagged = STATE_RE.test(codeOnly) || MODULE_LEVEL_REACTIVE_RE.test(codeOnly);
  return flagged && SUBSCRIBE_RE.test(codeOnly);
}).length;
console.log(
  `[check-vault-lifecycle-coverage] OK — ${subscribedCount} renderer modules subscribed, ${exemptCount} exempt, ` +
    `${RESET_COVERAGE.length} reset-coverage manifest entries verified.`,
);
process.exit(0);
