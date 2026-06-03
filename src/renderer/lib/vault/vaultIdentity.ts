/**
 * Vault-identity guard (Audit-5 G1) — generalizes the post-`await`
 * "did the vault swap under me?" check.
 *
 * Background. Work that suspends on an `await` (a rename cascade, a tree
 * cleanup, a `markClean`, a drained disk-shape op) can resume *after* the
 * user has swapped to a different vault — and then run against the new
 * vault's state. DI-03 added a guard at exactly ONE site
 * (`runRecoverySequencer`, comparing `vaultPath === newVaultPath`); the
 * audit kept finding sibling resumptions that lacked it. This module turns
 * that one-off into a discipline.
 *
 * Two failure modes the bare `vaultPath ===` compare misses, both covered
 * here by pairing the path with a monotonic generation token:
 *   - close → reopen the SAME path: the path string is unchanged, but it's a
 *     different vault *instance*; the generation differs, so a captured
 *     identity reads as stale.
 *   - A→B→A swap that lands back on A: again the generation differs.
 *
 * Usage:
 *   const id = captureVaultIdentity();   // before the await
 *   await something();
 *   if (!isStillSameVault(id)) return;    // after — bail if the vault swapped
 *
 * `beginVaultGeneration(path)` is called from the single vault-activation
 * points in `vault.svelte.ts` (`commitVaultCandidate` for open/swap/new,
 * `closeVault` for the return-to-home teardown). It bumps the generation
 * and records the now-active path, so this module's view of "the active
 * vault" stays in lock-step with `vaultStore.path`.
 *
 * Pure module-scoped state with no imports — safe for any `lib/` or `store`
 * consumer (no circular-dependency risk). The two scalars (`currentPath`,
 * `generation`) are not Map/Set/Promise, so the `ci:vault-scoped-state`
 * gate does not require an `onVaultSwap` subscription here; they are reset
 * explicitly by `beginVaultGeneration` at the swap boundary instead.
 */

export interface VaultIdentity {
  /** The active vault path at capture time (`''` when no vault is open). */
  readonly path: string;
  /** Monotonic token bumped on every vault activation / teardown. */
  readonly generation: number;
}

let currentPath = '';
let generation = 0;

/**
 * Records a new active vault and bumps the generation token. Call this at
 * each vault-activation boundary: open / swap / new (pass the new path) and
 * close (pass `''`). Any identity captured before this call reads as stale.
 */
export function beginVaultGeneration(path: string): void {
  currentPath = path;
  generation += 1;
}

/**
 * Snapshot the active vault identity. Capture this *before* an `await`, then
 * pass it to {@link isStillSameVault} after the await to detect a swap.
 */
export function captureVaultIdentity(): VaultIdentity {
  return { path: currentPath, generation };
}

/**
 * True iff the active vault is the same instance as when `captured` was
 * taken. Both the generation token AND the path must match, so a
 * close→reopen of the same path (same path, new generation) reads as stale.
 */
export function isStillSameVault(captured: VaultIdentity): boolean {
  return captured.generation === generation && captured.path === currentPath;
}

/**
 * The live generation token. For callers that key transient state per
 * generation (e.g. `withDrainedWrites`'s re-entrancy guard) rather than
 * capturing a full identity.
 */
export function currentVaultGeneration(): number {
  return generation;
}

/** Test-only — resets to the pre-open state so cases don't bleed identity. */
export function __resetVaultIdentityForTests(): void {
  currentPath = '';
  generation = 0;
}
