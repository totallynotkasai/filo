/**
 * `VaultPath` — branded string for vault-relative paths used as map / record /
 * set keys.
 *
 * On Windows/macOS the file system is case-preserving but not
 * case-sensitive, so a rename from `Notes/Foo.md` → `notes/foo.md` is a
 * no-op on disk but the OS event arrives with the new casing. A
 * `Map<string, _>` keyed by the raw OS path would keep the entry forever
 * under the OLD casing — orphaning frontmatter sync, tag rewrites,
 * broken-ref tracking, and so on.
 *
 * Forcing every vault-relative-path map key through `vaultPath()` fixes that
 * at the type level: the brand makes raw strings inassignable to `VaultPath`,
 * and the constructor always normalises, so a casing drift between writer
 * and reader can never silently miss.
 *
 * This module lives in `src/shared/` so the main process and the renderer
 * share one normalisation rule. The renderer's `lib/utils/path.ts` re-
 * exports `normalizeVaultRelative` from here to avoid drift between two
 * implementations.
 */

declare const _brand: unique symbol;

/**
 * Vault-relative path normalised through `vaultPath()`. Always:
 *  - forward slashes (no backslashes)
 *  - no leading slash
 *  - en-US lowercase (Turkish locale's dotted-i fold would otherwise split
 *    path identity across machines)
 *
 * The brand makes it impossible to pass an un-normalised raw `string` into
 * a `Map<VaultPath, _>` / `Record<VaultPath, _>` / `Set<VaultPath>` key
 * slot without going through the `vaultPath()` constructor first.
 */
export type VaultPath = string & { readonly [_brand]: 'VaultPath' };

/**
 * Lowest-level normalisation: backslashes → forward slashes, leading slashes
 * stripped, en-US lowercased. Pinned to `'en-US'` so two Filo installs on
 * different locales agree on whether `Notes/X.md` matches `notes/X.md`.
 *
 * Exported so the renderer's `lib/utils/path.ts` can re-export it; this is
 * the canonical implementation.
 */
export function normalizeVaultRelative(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').toLocaleLowerCase('en-US');
}

/**
 * Wraps a raw path in the `VaultPath` brand after normalising it. Always
 * safe to call — idempotent on already-branded inputs.
 *
 * The empty string is a valid `VaultPath` and survives the normalisation
 * round-trip (`vaultPath('') === ''`) so callers can treat it as a sentinel
 * for "no path yet" without a separate union type.
 */
export function vaultPath(raw: string): VaultPath {
  return normalizeVaultRelative(raw) as VaultPath;
}

/**
 * Type-guard for "is this string already in canonical `VaultPath` form?".
 * Useful at IPC boundaries and in tests that want to assert a value was
 * routed through `vaultPath()` upstream.
 */
export function isVaultPath(v: unknown): v is VaultPath {
  return typeof v === 'string' && v === normalizeVaultRelative(v);
}

/**
 * True when vault-relative `path` is `folder` itself or sits anywhere inside
 * it, compared as `VaultPath`s (case-folded, separator-agnostic, trailing
 * slash ignored). An empty `folder` matches nothing: the vault root is never
 * an item a caller deletes or moves.
 */
export function isAtOrUnder(path: string, folder: string): boolean {
  const f = vaultPath(folder).replace(/\/+$/, '');
  if (!f) return false;
  const p = vaultPath(path);
  return p === f || p.startsWith(`${f}/`);
}
