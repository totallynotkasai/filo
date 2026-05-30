/**
 * `VaultPath` — branded string for vault-relative paths used as map / record /
 * set keys.
 *
 * Phase 4 (IMPLEMENTATION_PLAN_2026-05-27 §Phase 4): on Windows/macOS the
 * file system is case-preserving but not case-sensitive, so a rename from
 * `Notes/Foo.md` → `notes/foo.md` is a no-op on disk but the OS event
 * arrives with the new casing. Any renderer-side `Map<string, _>` keyed by
 * the raw OS path keeps the entry forever under the OLD casing — orphaning
 * frontmatter sync, tag rewrites, broken-ref tracking, and so on (P0 #8 in
 * the 2026-05-26 audit).
 *
 * Forcing every vault-relative-path map key through `vaultPath()` is the
 * type-level fix: the brand makes raw strings inassignable to `VaultPath`,
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
 *    path identity across machines — Phase 31 C3.7)
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
 * Exported so the renderer's `lib/utils/path.ts` can re-export it — the
 * function is identical to what used to live there and is now the canonical
 * implementation.
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
