/**
 * renamePathKeys — central rename-cascade registry for relPath-keyed
 * module state.
 *
 * Prevents "X is stranded after rename": a relPath-keyed map that no rename
 * cascade remembers to update (e.g. the note store's models, after which
 * every keystroke would be queued against the old path).
 *
 * Each owner of relPath-keyed state subscribes a sweep
 * `(oldRel, newRel) => void` at module init.
 * Each rename cascade calls `renameAllPathKeys(oldRel, newRel)` exactly
 * once after the disk rename succeeds. New code that introduces a
 * relPath-keyed map either subscribes here or carries the inline escape
 * `// allow-no-rename-transfer: <reason>` on its declaration (e.g. for
 * intentionally rename-blind caches).
 *
 * The older explicit peer calls in the cascades (`renameBoardPath`,
 * `propagateRename`, `renameFile`, `renameKey`) remain;
 * the stores behind them are listed in the gate's EXEMPT_OWNERS. The gate
 * enforces that new path-keyed stores route through here.
 */

import { normalizeVaultRelative } from '@shared/vaultPath';
import { stripLeadingSlash, toPosix } from '../utils/path';
import { reportError } from '../utils/errorBus';

type RenameSweep = (oldRel: string, newRel: string) => void;

/**
 * Where `path` is after `oldRel` was renamed to `newRel`: `newRel` itself when
 * `path` is `oldRel`, `newRel/…` when `path` sits under the folder `oldRel`,
 * else null (the rename doesn't touch it). Paths compare case-folded, as the
 * file system does; the result keeps `newRel`'s spelling and the rest of
 * `path` as it was.
 */
export function rebasePath(path: string, oldRel: string, newRel: string): string | null {
  if (!path || !oldRel) return null;
  const p = normalizeVaultRelative(path);
  const o = normalizeVaultRelative(oldRel).replace(/\/+$/, '');
  const next = stripLeadingSlash(toPosix(newRel)).replace(/\/+$/, '');
  if (p === o) return next;
  if (p.startsWith(`${o}/`)) return next + stripLeadingSlash(toPosix(path)).slice(o.length);
  return null;
}

interface RegisteredSweep {
  name: string;
  fn: RenameSweep;
}

const sweeps: RegisteredSweep[] = [];

/**
 * Subscribe a relPath rename sweep. The handler receives the
 * canonical-form rename `(oldRel, newRel)` and is responsible for moving
 * every entry it owns keyed by `oldRel` (exact match AND child-prefix
 * descendants if relevant) under `newRel`.
 *
 * `name` must be unique. Re-registering with the same name overwrites
 * the prior entry — matches the `onVaultSwap` convention so HMR /
 * test-import flows behave predictably.
 *
 * Returns an unsubscribe function.
 */
export function registerPathRenamable(name: string, fn: RenameSweep): () => void {
  const existingIdx = sweeps.findIndex((s) => s.name === name);
  const entry: RegisteredSweep = { name, fn };
  if (existingIdx >= 0) sweeps[existingIdx] = entry;
  else sweeps.push(entry);
  return () => {
    const idx = sweeps.findIndex((s) => s.name === name);
    if (idx >= 0) sweeps.splice(idx, 1);
  };
}

/**
 * Fire every registered sweep against the rename `(oldRel, newRel)`.
 * Each sweep runs in registration order; a throw from one sweep is
 * reported but does NOT abort the remaining sweeps — a rename cascade
 * that bails mid-way leaves the codebase in a worse state than the
 * original error.
 *
 * Returns false when any sweep threw. Some state is then still keyed by
 * the old path, so the caller keeps its rename-cascade sentinel and the
 * next vault open replays the rename.
 *
 * `oldRel` and `newRel` are vault-relative paths in canonical
 * (forward-slash, no leading slash) form. Callers that have a mixed
 * shape should normalise via `normalizePath` / `stripLeadingSlash`
 * first.
 */
export function renameAllPathKeys(oldRel: string, newRel: string): boolean {
  if (!oldRel || !newRel || oldRel === newRel) return true;
  let ok = true;
  // A copy: a sweep may unregister itself (a one-shot wait for a rename), and
  // removing it from the live array mid-loop would skip the sweep after it.
  for (const { name, fn } of [...sweeps]) {
    try {
      fn(oldRel, newRel);
    } catch (err) {
      ok = false;
      reportError(
        'renameAllPathKeys',
        err,
        `Couldn't move "${name}" state from "${oldRel}" to "${newRel}"; the rename will be retried when the vault is next opened.`,
      );
    }
  }
  return ok;
}

/**
 * Test-only — returns the set of registered sweep names. Used by the
 * unit tests to assert each owner subscribed at module-init time.
 */
export function __getRegisteredPathRenamableNames(): Set<string> {
  return new Set(sweeps.map((s) => s.name));
}

/**
 * Test-only — drops every registered sweep. Call between tests so a
 * subscription from a prior test doesn't leak into the next one. The
 * production owners re-register on next module import.
 */
export function __resetRenamePathKeysForTests(): void {
  sweeps.length = 0;
}
