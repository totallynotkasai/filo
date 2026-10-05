import * as path from 'path';
import { vaultRegistry } from './vaultRegistry';

/**
 * Approved-source registry for `vault:copy-file`.
 *
 * Copying ANY absolute path the renderer names would be an arbitrary host-file
 * READ primitive under the hostile-vault threat model: a compromised renderer
 * could pull `~/.ssh/id_rsa`, browser cookie DBs, etc. into the vault and
 * exfiltrate them. So the SOURCE is constrained to files the user actually
 * chose. A path is an approved copy source iff it is either:
 *   1. already inside the active vault (the renderer can already read it via
 *      `vault:read-file-text`, so copying it in is no new capability), or
 *   2. previously presented to the user through a trusted main/preload path —
 *      a native file dialog (`dialog:open-file`) or a real OS drag-drop
 *      resolved by the preload's `webUtils.getPathForFile`.
 *
 * The registration entry points are the load-bearing security property: they
 * are reachable ONLY from trusted contexts the hostile renderer cannot drive
 * with an arbitrary path of its choosing —
 *   - `dialog:open-file` runs in main; the USER picks the file, not the caller.
 *   - the preload's `getPathForFile` only mints a real path for a `File` backed
 *     by an actual on-disk file the user dropped; a renderer cannot synthesise a
 *     `File` for `/etc/passwd`. It registers via a DIRECT `ipcRenderer.send` on
 *     `vault:register-source-path`, NOT the contextBridge-exposed `api.send`, so
 *     hostile renderer JS cannot reach the channel (and the `z.never()` payload
 *     schema rejects any `window.filo.send/invoke('vault:register-source-path')`
 *     attempt as a belt-and-braces second line of defence).
 *
 * VAULT-BINDING: each registered source is tagged with the vault active when
 * it was minted, and `isApprovedCopySource` requires that binding to equal the
 * CURRENTLY-active vault, so a path picked under vault A can't be copied into
 * vault B. Both sides read the SAME `vaultRegistry.currentVaultPath`, so they
 * agree regardless of the renderer's symlinked-vs-canonical spelling. The
 * swap-time `clearApprovedSources` is kept as defence-in-depth.
 *
 * This removes the arbitrary-read primitive without restricting any
 * legitimate dialog/drag-drop import.
 */

const isWin = process.platform === 'win32';

/**
 * Normalises an absolute path to a stable set key: `path.resolve` collapses
 * `..`/`.` and separators; on Windows (case-insensitive FS) we case-fold so a
 * registered `C:\Users\me\a.png` matches a copy source spelled `c:\users\me\A.PNG`.
 */
function normalizeSourceKey(absPath: string): string {
  const resolved = path.resolve(absPath);
  return isWin ? resolved.toLowerCase() : resolved;
}

/**
 * The canonical key for the currently-active vault, or null when none is open.
 * Used as the binding anchor at BOTH registration and check time so the two
 * always reference the same value. Reads the registry (which stores the
 * realpath-canonicalised path), so a renderer that passes a symlinked vault
 * spelling to `vault:copy-file` still matches a binding minted under the
 * canonical path.
 */
function activeVaultKey(): string | null {
  const root = vaultRegistry.currentVaultPath;
  return root && root.length > 0 ? normalizeSourceKey(root) : null;
}

/**
 * Bounded so a long-running session that drops thousands of files can't grow
 * the map without limit. Insertion order = recency; the oldest entries evict
 * first once the cap is exceeded. 512 is comfortably above any realistic batch
 * of in-flight imports. Value = the active-vault key at registration time.
 */
const MAX_APPROVED_SOURCES = 512;
const approvedSources = new Map<string, string>();

/**
 * Records that the user legitimately selected `absPath` as an import source
 * (via a native dialog or a real OS drop), bound to the currently-active vault.
 * Idempotent; re-registering refreshes recency so a frequently-used source
 * isn't evicted under churn.
 *
 * With no active vault there is nothing to bind the approval to,
 * so the registration is refused. The legitimate dialog/drop minting points
 * only fire while a vault is open (the file picker is gated on it; an OS drop
 * targets a board), so this never drops a real approval.
 */
export function registerApprovedSource(absPath: string): void {
  if (typeof absPath !== 'string' || absPath.length === 0) return;
  const vaultKey = activeVaultKey();
  if (vaultKey === null) return;
  const key = normalizeSourceKey(absPath);
  // Delete-then-add bumps recency to the tail so eviction is LRU-ish.
  if (approvedSources.has(key)) approvedSources.delete(key);
  approvedSources.set(key, vaultKey);
  while (approvedSources.size > MAX_APPROVED_SOURCES) {
    const oldest = approvedSources.keys().next().value;
    if (oldest === undefined) break;
    approvedSources.delete(oldest);
  }
}

/**
 * Drops every approved source. Called on `vault:close` and at the start of
 * the `vault:watch` swap path. The per-source vault binding already makes a
 * leaked approval unusable across a swap; this is defence-in-depth (and
 * bounds the map at swap time).
 */
export function clearApprovedSources(): void {
  approvedSources.clear();
}

/**
 * Lexical (case-folded on Windows) containment check: is `candidate` the vault
 * root itself or a descendant? Purely lexical — symlink escapes through the
 * vault are handled separately by the copy-file handler's `lstat` (which rejects
 * any non-regular-file, including symlinks) before the copy runs.
 */
function isWithinVaultLexical(vaultRoot: string, candidate: string): boolean {
  const root = path.resolve(vaultRoot);
  const cand = path.resolve(candidate);
  const rc = isWin ? root.toLowerCase() : root;
  const cc = isWin ? cand.toLowerCase() : cand;
  if (cc === rc) return true;
  return cc.startsWith(rc.endsWith(path.sep) ? rc : rc + path.sep);
}

/**
 * True iff `sourcePath` is an approved `vault:copy-file` source for the given
 * active vault: inside the vault, or previously registered via a trusted
 * dialog/drop AND bound to the currently-active vault. The copy-file handler
 * calls this BEFORE it stats or opens the path, so an unapproved path is never
 * even touched on disk.
 */
export function isApprovedCopySource(vaultRoot: string, sourcePath: string): boolean {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return false;
  if (
    typeof vaultRoot === 'string' &&
    vaultRoot.length > 0 &&
    isWithinVaultLexical(vaultRoot, sourcePath)
  ) {
    return true;
  }
  return isChosenCopySource(sourcePath);
}

/**
 * True iff the user chose `sourcePath` in this vault: picked it in a file
 * dialog or dropped it from the OS, whether it lies inside the vault or not.
 * The approval is bound to the vault that was active when it was minted, and
 * that binding must equal the CURRENTLY active vault (read from the same
 * registry the binding used). So a path picked under vault A can't be copied
 * into vault B even if the swap-time clear was somehow skipped.
 */
export function isChosenCopySource(sourcePath: string): boolean {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return false;
  const bound = approvedSources.get(normalizeSourceKey(sourcePath));
  if (bound === undefined) return false;
  const current = activeVaultKey();
  return current !== null && bound === current;
}

/** Test seam — clears the registry between specs. Not used in production. */
export function __resetApprovedSourcesForTests(): void {
  approvedSources.clear();
}
