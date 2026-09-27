/**
 * Phase 7 — contract-level vault-lifecycle coverage.
 *
 * Phase 4 introduced `vaultLifecycle` as the single subscription point for
 * vault-swap reset; Phase 0's `vaultSwapResets.test.ts` covers a hardcoded
 * list of REQUIRED handler names; the `ci:vault-lifecycle-coverage` gate
 * (`scripts/gates:vault-lifecycle-coverage`) statically scans the
 * renderer for `$state` modules with no `onVaultSwap(...)` call.
 *
 * This test complements those two by walking the renderer source AT TEST
 * TIME, importing every module it finds, and asserting the registry holds
 * a handler for each. Difference from the static gate:
 *
 *   - The gate is a regex scan; this test actually evaluates each module
 *     so a handler that exists in source but throws at import time (and
 *     therefore never registers) surfaces here.
 *   - The gate's EXEMPT_MODULES list is enforced via a separate parity
 *     assertion: every exempted module must still match the same regex
 *     pattern (has `$state`, no `onVaultSwap`) — a stale exemption that
 *     no longer holds `$state` is flagged.
 *
 * If you add a new store / lib module with `$state(...)`, you MUST also
 * add an `onVaultSwap('pre-swap', '<name>', ...)` subscription OR add the
 * path to EXEMPT_MODULES below with a one-line reason that matches the
 * `scripts/gates:vault-lifecycle-coverage` entry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { __getRegisteredHandlerNames } from '@renderer/core/vaultLifecycle';

const ROOT = join(__dirname, '..', '..', '..');
const RENDERER_DIR = join(ROOT, 'src', 'renderer');

// Must mirror EXEMPT_MODULES in scripts/gates:vault-lifecycle-coverage.
// Any drift between the two is a maintenance hazard — the parity test below
// fails if the two lists diverge.
//
// Sprint B / B14 — guides/connections/ui/navigation now subscribe; their
// exemption entries (and the gate's matching entries) have been removed.
// Sprint C / C25 — vault.svelte.ts now subscribes for the reconcile
// throttle reset; removed from the exemption list.
const EXEMPT_MODULES = new Set([
  'src/renderer/stores/board.svelte.ts',
  'src/renderer/stores/canvas.svelte.ts',
  'src/renderer/stores/spatial.svelte.ts',
  'src/renderer/stores/toolbar.svelte.ts',
  'src/renderer/lib/boards/boardScope.svelte.ts',
  'src/renderer/lib/boards/boardToolbar.svelte.ts',
  'src/renderer/lib/kanban/kanbanDragController.svelte.ts',
  'src/renderer/lib/kanban/kanbanFiltersAndSort.svelte.ts',
  'src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts',
  'src/renderer/lib/mindmap/marqueeSelectionController.svelte.ts',
  'src/renderer/lib/tasklist/filtersAndViews.svelte.ts',
  'src/renderer/lib/tasklist/multiSelectController.svelte.ts',
  'src/renderer/lib/tasklist/taskDragController.svelte.ts',
  'src/renderer/lib/tasklist/datePickerViewState.svelte.ts',
  'src/renderer/lib/tasklist/notesBox.svelte.ts',
  // Audit 5.3 — per-instance aria-live announcer created by each board and
  // disposed on unmount; its $state is function-local (per createAriaAnnouncer
  // call), never module-level, so nothing survives a vault swap.
  'src/renderer/lib/utils/ariaAnnouncer.svelte.ts',
]);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function walkTs(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (s.isFile() && /\.(ts|svelte\.ts)$/.test(entry)) out.push(full);
  }
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const STATE_RE = /\$state\s*[<(]/;
const SUBSCRIBE_RE = /(?<![A-Za-z0-9_$])onVaultSwap\s*\(/;
const HANDLER_NAME_RE = /onVaultSwap\s*\(\s*['"](?:pre|post)-swap['"]\s*,\s*['"]([^'"]+)['"]/g;

interface ScannedModule {
  rel: string;
  abs: string;
  hasState: boolean;
  subscribes: boolean;
  handlerNames: string[];
}

function scanRenderer(): ScannedModule[] {
  const tsFiles: string[] = [];
  walkTs(RENDERER_DIR, tsFiles);
  const out: ScannedModule[] = [];
  for (const abs of tsFiles) {
    const rel = toPosix(relative(ROOT, abs));
    const raw = readFileSync(abs, 'utf8');
    const code = stripComments(raw);
    const hasState = STATE_RE.test(code);
    if (!hasState) continue;
    if (rel === 'src/renderer/core/vaultLifecycle.ts') continue;
    const subscribes = SUBSCRIBE_RE.test(code);
    const names: string[] = [];
    HANDLER_NAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANDLER_NAME_RE.exec(code)) !== null) names.push(m[1]);
    out.push({ rel, abs, hasState, subscribes, handlerNames: names });
  }
  return out;
}

const scanned = scanRenderer();
const required = scanned.filter((m) => !EXEMPT_MODULES.has(m.rel));

beforeAll(async () => {
  // Force-import every required module so its top-level `onVaultSwap(...)`
  // call runs and the registry sees the subscription. We can't statically
  // import these at the top of the file because that would couple this test
  // file to every store module's transitive dependency graph — leading to
  // import-cycle issues during test discovery. Dynamic import here keeps
  // the dependency surface localized to the modules we actually need.
  for (const m of required) {
    const importPath = m.abs.replace(/\.ts$/, '');
    // Vite/Vitest resolves `.svelte.ts` correctly via the alias chain — the
    // absolute path is passed through `import()` and the runtime locates it.
    /* @vite-ignore */
    await import(importPath);
  }
});

describe('Phase 7 contract — vault-lifecycle coverage', () => {
  it('discovers every renderer module that holds $state', () => {
    expect(scanned.length).toBeGreaterThan(0);
    // Sanity bound: ratchet downward if the scanner regresses on detection.
    // The current renderer has ~30 modules with $state across stores + lib.
    expect(scanned.length).toBeGreaterThanOrEqual(20);
  });

  it.each(
    // Wrap in objects so vitest's table output names each row by `rel`
    // — easier to scan a failure than a positional tuple.
    required.map((m) => ({ rel: m.rel, handlerNames: m.handlerNames })),
  )(
    'module $rel subscribes via onVaultSwap(...)',
    ({ rel, handlerNames }) => {
      const sourceSubscribes = handlerNames.length > 0;
      if (!sourceSubscribes) {
        throw new Error(
          `Module ${rel} holds \`$state\` but does not call onVaultSwap(...). ` +
            'Either subscribe to vault-swap reset OR add the path to EXEMPT_MODULES ' +
            'in this file AND scripts/gates:vault-lifecycle-coverage.',
        );
      }
      const registered = __getRegisteredHandlerNames();
      const allRegistered = new Set([
        ...registered['pre-swap'],
      ]);
      const matched = handlerNames.some((name) => allRegistered.has(name));
      expect({
        rel,
        sourceHandlers: handlerNames,
        registered: [...allRegistered].sort(),
        matched,
      }).toMatchObject({ matched: true });
    },
  );

  it('every EXEMPT_MODULES entry still holds $state (no stale exemptions)', () => {
    const scannedPaths = new Set(scanned.map((m) => m.rel));
    const stale: string[] = [];
    for (const rel of EXEMPT_MODULES) {
      if (!scannedPaths.has(rel)) {
        stale.push(rel);
      }
    }
    expect(stale).toEqual([]);
  });

  it('EXEMPT_MODULES does not list any subscriber (exemption + subscription is redundant)', () => {
    const redundant: string[] = [];
    for (const m of scanned) {
      if (EXEMPT_MODULES.has(m.rel) && m.subscribes) {
        redundant.push(m.rel);
      }
    }
    expect(redundant).toEqual([]);
  });
});
