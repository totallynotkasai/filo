import { reportError } from '../lib/utils/errorBus';

/**
 * Vault lifecycle registry — single subscription point for vault-swap reset.
 *
 * A publish/subscribe registry: every store / write scheduler / sentinel that
 * holds vault-scoped state subscribes once at module load; the openVault /
 * closeVault paths fire `pre-swap` before hydrating (or tearing down) the vault.
 *
 * Single phase — `pre-swap`:
 *  - Runs while the OUTGOING vault is still semantically active. Handlers
 *    cancel debounced timers, flush sentinels against the outgoing vaultRoot,
 *    drop history stacks. Any "save before swap" disk write has already
 *    finished by the time the event fires (the dialog flow awaits
 *    `vaultStore.save()` first); pre-swap handlers must not assume the project
 *    is still hydrated.
 *  - Post-commit hydration (vaultIndex rebuild, recovery sequencer, etc.) is
 *    NOT a lifecycle phase — it lives in `vault.svelte.ts:runPostCommitTasks`,
 *    which runs against the freshly-committed vault.
 *
 * Ordering: handlers within a phase run sequentially, in registration order
 * by default. A handler may declare `runAfter: ['handlerName']` so a
 * dependent handler waits for its prerequisite. The dispatcher topologically
 * sorts within each phase. Cycles fall back to registration order with a
 * `reportError` so a misconfigured dependency surfaces but doesn't deadlock.
 *
 * Error policy: a handler that throws does NOT abort the swap. Failures are
 * aggregated and reported via `reportError` after the phase completes. The
 * vault swap is a user gesture; silently bailing mid-reset would leave the
 * app in an inconsistent state worse than the original error.
 */

export type VaultSwapPhase = 'pre-swap';

export interface VaultSwapEvent {
  phase: VaultSwapPhase;
  /**
   * The vault path that is being swapped away from. `null` when the
   * application is opening its first vault (no outgoing vault). Handlers
   * that flush sentinels against the outgoing vault should short-circuit
   * when this is null.
   */
  previousVault: string | null;
  /**
   * The vault path being opened. `null` when the swap is a vault CLOSE
   * — the user is returning to the home screen rather
   * than opening another vault. Handlers that need to hydrate against a
   * new vault should short-circuit when this is null.
   */
  nextVault: string | null;
  /**
   * True when the save before leaving left nothing unsaved. False when the
   * user left anyway with work that couldn't be saved (rescue copies were
   * kept). Drives the sentinel-clear branch in
   * `writeStateTracking.resetWriteTracking`: only a clean save earns a
   * `.filo/.dirty` clear; otherwise the sentinel stays so a later reopen
   * surfaces the Recovery modal.
   */
  saveOutgoing: boolean;
}

export interface VaultSwapHandlerOptions {
  /**
   * Names of handlers (within the same phase) that must run before this one.
   * The dispatcher topologically sorts within the phase so the dependency
   * order is honoured even if the registration order differs.
   */
  runAfter?: string[];
}

interface RegisteredHandler {
  name: string;
  phase: VaultSwapPhase;
  fn: (event: VaultSwapEvent) => void | Promise<void>;
  runAfter: string[];
}

const handlers: RegisteredHandler[] = [];

/**
 * Subscribe to a vault-swap phase. Returns an unsubscribe function.
 *
 * Handler `name` must be unique within a phase — re-registering with the
 * same `(phase, name)` pair overwrites the prior entry (matches the
 * registry-pattern conventions used elsewhere in `src/renderer/core/`).
 */
export function onVaultSwap(
  phase: VaultSwapPhase,
  name: string,
  fn: (event: VaultSwapEvent) => void | Promise<void>,
  opts?: VaultSwapHandlerOptions,
): () => void {
  const existing = handlers.findIndex((h) => h.phase === phase && h.name === name);
  const entry: RegisteredHandler = {
    name,
    phase,
    fn,
    runAfter: opts?.runAfter?.slice() ?? [],
  };
  if (existing >= 0) {
    handlers[existing] = entry;
  } else {
    handlers.push(entry);
  }
  return () => {
    const idx = handlers.findIndex((h) => h.phase === phase && h.name === name);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/**
 * Register a vault-swap RESET handler. Sugar over
 * `onVaultSwap('pre-swap', name, fn)` that mirrors the registration in a
 * queryable set so a CI gate (or a unit test) can confirm a specific
 * module-state owner registered through THIS entry point. Nothing checks at
 * runtime that the body actually resets something — that's for review.
 *
 * For shared infrastructure that subscribes for reasons OTHER than
 * resetting module-scoped state (sentinel flushes, rebuilds, registry
 * mirrors), use `onVaultSwap` directly. Mixing both is fine — the
 * `vaultSwapResettable` set is purely a marker. New module-scoped state
 * should subscribe via this helper.
 *
 * Returns an unsubscribe function (same shape as `onVaultSwap`). Calling
 * it removes both the swap handler AND the resettable-name marker.
 */
const resettableNames = new Set<string>();

export function vaultSwapResettable(
  name: string,
  fn: (event: VaultSwapEvent) => void | Promise<void>,
  opts?: VaultSwapHandlerOptions,
): () => void {
  const unsub = onVaultSwap('pre-swap', name, fn, opts);
  resettableNames.add(name);
  return () => {
    resettableNames.delete(name);
    unsub();
  };
}

/**
 * Test-only: returns the set of names that subscribed through
 * `vaultSwapResettable`, so tests can confirm a given module's owner
 * registered via this entry point.
 */
export function __getResettableHandlerNames(): Set<string> {
  return new Set(resettableNames);
}

/**
 * Topologically sort a list of handlers using `runAfter`. Falls back to
 * registration order on cycles (reports the cycle so it surfaces).
 */
function topoSort(group: RegisteredHandler[]): RegisteredHandler[] {
  const byName = new Map<string, RegisteredHandler>();
  for (const h of group) byName.set(h.name, h);

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const ordered: RegisteredHandler[] = [];
  let cycleDetected = false;

  function visit(node: RegisteredHandler): void {
    if (visited.has(node.name)) return;
    if (onStack.has(node.name)) {
      cycleDetected = true;
      return;
    }
    onStack.add(node.name);
    for (const dep of node.runAfter) {
      const depNode = byName.get(dep);
      if (depNode) visit(depNode);
    }
    onStack.delete(node.name);
    visited.add(node.name);
    ordered.push(node);
  }

  for (const h of group) visit(h);

  if (cycleDetected) {
    reportError(
      'vaultLifecycle.topoSort',
      new Error('Cycle detected in vault-lifecycle runAfter dependencies; falling back to registration order.'),
      'A vault-swap handler dependency forms a cycle. Inspect runAfter declarations.',
    );
    return group.slice();
  }
  return ordered;
}

/**
 * Fires every handler subscribed to `event.phase` in dependency order.
 * Errors thrown by individual handlers are surfaced via `reportError`
 * but do not abort the chain — the vault swap is a user gesture and
 * stopping mid-reset would leave the app in a worse state than the
 * original error.
 */
export async function fireVaultSwap(event: VaultSwapEvent): Promise<void> {
  const phaseHandlers = handlers.filter((h) => h.phase === event.phase);
  if (phaseHandlers.length === 0) return;
  const ordered = topoSort(phaseHandlers);
  if (event.phase === 'pre-swap') tearingDown = true;
  try {
    for (const handler of ordered) {
      try {
        await handler.fn(event);
      } catch (err) {
        reportError(
          `vaultLifecycle.${event.phase}.${handler.name}`,
          err,
          `Vault-swap handler "${handler.name}" failed during ${event.phase}; continuing to remaining handlers.`,
        );
      }
    }
  } finally {
    if (event.phase === 'pre-swap') tearingDown = false;
  }
}

let tearingDown = false;

/**
 * True while the pre-swap handlers run. Their resets (closing every tab,
 * dropping the pane layout) notify the same listeners a user's change does;
 * persisting them would write the outgoing vault's config after its final
 * save, and re-mark it dirty after its crash sentinel was cleared, so the
 * next open would offer to recover a clean close.
 */
export function isVaultTearingDown(): boolean {
  return tearingDown;
}

/**
 * Test-only: drops every registered handler. Call between tests so a
 * subscription from a prior test doesn't leak into the next one's
 * dispatch. Re-importing the store modules in the next test re-registers
 * their handlers (the registrations live at module top level).
 *
 * Not exposed in production — handlers are registered for the process
 * lifetime by design.
 */
export function __resetVaultLifecycleForTests(): void {
  handlers.length = 0;
  resettableNames.clear();
}

/**
 * Test-only: returns the registered handler names per phase. Used by
 * `check-vault-lifecycle-coverage` and the registry's own unit tests to
 * assert subscription coverage without exposing the handler array.
 */
export function __getRegisteredHandlerNames(): Record<VaultSwapPhase, string[]> {
  return {
    'pre-swap': handlers.filter((h) => h.phase === 'pre-swap').map((h) => h.name),
  };
}
