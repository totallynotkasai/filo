import { resolve } from 'path';
import * as fs from 'fs';
import { vaultRegistry } from '../services/vaultRegistry';

/**
 * Thrown when an IPC handler is invoked with a vaultRoot that does not match
 * the currently-open vault. Surface a stable string in the error message so
 * the renderer can detect this code path even without inspecting `.code`.
 */
export class NoActiveVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoActiveVaultError';
  }
}

/**
 * The single source of truth for the active vault path. `vault:watch`
 * mirrors `currentVaultRoot` (in `vault.ipc.ts`) into `vaultRegistry` for
 * cross-window access, so reading from the registry gives us the same
 * answer in any IPC handler without an import cycle through `vault.ipc.ts`.
 */
function currentVault(): string | null {
  return vaultRegistry.currentVaultPath;
}

/**
 * Returns true iff `vaultRoot` resolves to the same filesystem path as the
 * currently-open vault. Case-insensitive on Windows, strict on POSIX.
 *
 * Exported so callers that want a boolean check (e.g. tests, defensive UI
 * code) can use it without `try/catch` flow control.
 */
export function isActiveVault(vaultRoot: string): boolean {
  const current = currentVault();
  if (!current) return false;
  if (typeof vaultRoot !== 'string' || vaultRoot.length === 0) return false;

  const a = resolve(vaultRoot);
  const b = resolve(current);
  const cmp = process.platform === 'win32'
    ? (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase()
    : (x: string, y: string): boolean => x === y;
  if (cmp(a, b)) return true;

  // Sprint A / A3 — the registry stores the canonicalised (realpath'd)
  // form. The renderer keeps its original (potentially symlinked) path,
  // so a strict resolve-equality miss falls through to comparing the
  // canonical form of the input against the canonical registry entry.
  // Missing realpath (ENOENT, EACCES) means the input doesn't resolve;
  // not active.
  try {
    const aReal = fs.realpathSync.native ? fs.realpathSync.native(a) : fs.realpathSync(a);
    return cmp(aReal, b);
  } catch {
    return false;
  }
}

/**
 * Throws `NoActiveVaultError` if `vaultRoot` does not match the currently-
 * open vault. Used at the top of every IPC handler that accepts a vaultRoot
 * argument so a buggy or compromised renderer can't redirect a write into
 * an arbitrary directory by passing a different path than the open vault.
 *
 * The check is strict equality (after resolution + case-folding on Windows)
 * rather than path-containment, because the caller's intent is always
 * "operate on the active vault" — a different vault root means the
 * renderer's state is desynced and the safe move is to refuse rather than
 * accidentally touch a second vault.
 */
export function assertActiveVault(vaultRoot: string): void {
  const current = currentVault();
  if (!current) {
    throw new NoActiveVaultError('No vault is currently open');
  }
  if (!isActiveVault(vaultRoot)) {
    throw new NoActiveVaultError('vaultRoot does not match the active vault');
  }
}
