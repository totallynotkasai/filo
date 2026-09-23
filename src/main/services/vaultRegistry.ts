import * as fs from 'fs';

/**
 * In-process registry of the currently-open vault path.
 *
 * The renderer's vault store is authoritative for the renderer's own
 * lifecycle, but the main process needs a synchronous way to answer
 * "what vault is open?" so it can fail-closed on stale IPC handles. The
 * `assertActiveVault` helper in `utils/activeVaultCheck.ts` consults this
 * registry to reject any vaultRoot-bearing IPC call whose path no longer
 * matches the active vault (e.g. a debounced write fired by a renderer
 * that hasn't yet realised the vault was swapped).
 *
 * Concurrency posture: Filo runs as a single Electron process via
 * `app.requestSingleInstanceLock()` (see `main.ts`), with exactly one
 * `BrowserWindow`. Two windows or two processes cannot open the same
 * vault concurrently — this registry exists for vault-swap consistency
 * within a single window, not multi-window arbitration.
 *
 * The currentVaultPath is set when the renderer signals that it has
 * opened a vault via `vault:watch` or `board:save`. It is null on
 * launch (before any vault is opened) and stays null after the user
 * closes a vault via the home screen.
 *
 * Sprint A / A3 — the stored path is canonicalised through
 * `fs.realpathSync` at registration so subsequent `assertWithinVault`
 * comparisons compare canonical-vs-canonical and a vault path that's
 * a symlink (e.g. `/Users/me/vault` → `/Volumes/Drive/vault`) can't
 * confuse the lexical prefix check.
 */

let currentVaultPath: string | null = null;

/**
 * Audit-17 3.5 — monotonically increasing registration epoch, bumped on
 * EVERY `setCurrentVault` call (open, close, re-arm). Lets a multi-await
 * main-side handler (`vault:watch`) detect that the registry changed under
 * one of its awaits — including a close→reopen of the SAME path, which a
 * bare path compare would miss — and bail instead of silently reversing the
 * newer state. The main-process mirror of the renderer's
 * `isStillSameVault` generation discipline.
 */
let registrationEpoch = 0;

/**
 * Sprint A / A3 — canonicalise a vault path via `fs.realpathSync`. Falls
 * back to the input string when the path doesn't exist (the caller's
 * responsibility to validate that separately) so callers receive
 * predictable strings regardless of state on disk.
 */
function canonicalise(p: string): string {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return p;
  }
}

export const vaultRegistry = {
  get currentVaultPath(): string | null {
    return currentVaultPath;
  },
  /** Audit-17 3.5 — see `registrationEpoch`. */
  get epoch(): number {
    return registrationEpoch;
  },
  setCurrentVault(path: string | null): void {
    registrationEpoch += 1;
    currentVaultPath = path === null ? null : canonicalise(path);
  },
};
