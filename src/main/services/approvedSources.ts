import * as path from 'path';

/**
 * Audit-12 S1 — approved-source registry for `vault:copy-file`.
 *
 * The `vault:copy-file` handler used to copy ANY absolute path the renderer
 * named into the vault (only the *destination* was vault-contained). Under the
 * hostile-vault threat model (hostile note content reaching IPC via TipTap
 * `html:true`), that is an arbitrary host-file READ primitive: a compromised
 * renderer could pull `~/.ssh/id_rsa`, `/etc/passwd`, browser cookie DBs, etc.
 * into the vault where it can then be exfiltrated.
 *
 * The fix constrains the SOURCE to files the user actually chose. A path is an
 * approved copy source iff it is either:
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
 * This is defence-in-depth — N/A for first-party vaults — but it removes the
 * arbitrary-read primitive entirely without restricting any legitimate
 * dialog/drag-drop import.
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
 * Bounded so a long-running session that drops thousands of files can't grow
 * the set without limit. Insertion order = recency; the oldest entries evict
 * first once the cap is exceeded. 512 is comfortably above any realistic batch
 * of in-flight imports.
 */
const MAX_APPROVED_SOURCES = 512;
const approvedSources = new Set<string>();

/**
 * Records that the user legitimately selected `absPath` as an import source
 * (via a native dialog or a real OS drop). Idempotent; re-registering refreshes
 * recency so a frequently-used source isn't evicted under churn.
 */
export function registerApprovedSource(absPath: string): void {
  if (typeof absPath !== 'string' || absPath.length === 0) return;
  const key = normalizeSourceKey(absPath);
  // Delete-then-add bumps recency to the tail so eviction is LRU-ish.
  if (approvedSources.has(key)) approvedSources.delete(key);
  approvedSources.add(key);
  while (approvedSources.size > MAX_APPROVED_SOURCES) {
    const oldest = approvedSources.values().next().value;
    if (oldest === undefined) break;
    approvedSources.delete(oldest);
  }
}

/**
 * Audit-13 M11 — drops every approved source. Called on `vault:close` and at the
 * start of the `vault:watch` swap path so a path the user picked while vault A
 * was open does NOT stay approved for vault B. Without this the set is
 * process-global and keyed by absolute path alone: a compromised renderer in a
 * later vault could re-import any file the user ever selected this session. The
 * legitimate dialog/drop registration always runs AFTER the vault is open, so
 * clearing at swap time never wipes the current vault's freshly-picked sources.
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
 * dialog/drop. The copy-file handler calls this BEFORE it stats or opens the
 * path, so an unapproved path is never even touched on disk.
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
  return approvedSources.has(normalizeSourceKey(sourcePath));
}

/** Test seam — clears the registry between specs. Not used in production. */
export function __resetApprovedSourcesForTests(): void {
  approvedSources.clear();
}
