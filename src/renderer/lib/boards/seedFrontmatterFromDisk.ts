import { documentStore } from '../../stores/document.svelte';
import { readMarkdownForHydrate } from '../vault/markdownFileWriter';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';

/**
 * Audit-6 M4 — lazily seed the live `documentStore` frontmatter cache for a
 * Kanban card / Task row that has NO open editor, reading the CURRENT bytes
 * from disk rather than the (durably-stale) vault index.
 *
 * Kanban / Task field writers seed the FM cache the first time a row is
 * touched (`ensureSeededFm`). The old seed pulled
 * `vaultIndexStore.getMetadata(path)?.frontmatter` — a watcher snapshot that
 * the sync-frontmatter reconciler only refreshes for OPEN editors, so a key an
 * external editor added since the last index rebuild (`priority: high`) was
 * absent from the seed. The subsequent debounced write then diffed the live
 * object against the on-disk frontmatter source and DROPPED that key — the
 * source-preserving engine (`patchFrontmatterSourceCst`) treats a disk key missing
 * from the object as a deletion. Seeding from a fresh disk read closes the loss;
 * passing `rawFrontmatter` additionally gives the gateway the source baseline it
 * needs to preserve comments / key order / quoting on the untouched keys (the
 * old index seed carried no raw source, forcing a lossy full re-dump).
 *
 * Awaited BEFORE the synchronous `ensureSeededFm` so that, finding the cache
 * already populated, it skips the index seed. Deliberately conservative:
 *
 *  - No-op when the cache already holds an entry for `docId` — an open editor or
 *    a prior in-app edit already seeded it from disk, and re-seeding would
 *    clobber unsaved mutations. (The `refreshSeedVersion` mode below is the one
 *    sanctioned exception — see its docstring.)
 *  - No-op on a disk read failure (ENOENT for a not-yet-created `.md`, EACCES, a
 *    mid-write transient) — the caller's existing index-seed fallback then runs
 *    exactly as before, so the worst case is the prior behaviour, never a throw.
 *  - Re-checks the cache AFTER the await so a parallel editor hydrate that
 *    seeded the doc while this read was in flight is not overwritten.
 *
 * A9-M1 (Audit-9) — vault-identity guard. This is the load-bearing root of the
 * cross-vault frontmatter corruption (A9-H1): the read suspends on an `await`,
 * and a vault swap (File > Open Vault) can COMMIT while it is in flight. The
 * pre-swap handler runs `documentStore.clear()` (binding the store to the
 * INCOMING vault); resuming this continuation would otherwise re-inject the
 * OUTGOING vault's frontmatter keyed by `docId` into the now-incoming-vault
 * store — and, via the field-command write path, write it onto the NEW vault's
 * same-named file. Capturing the active vault identity before the await and
 * bailing after it (the G1 discipline) closes that at the root: a swap that
 * landed during the read leaves the cache untouched.
 */

export interface SeedFrontmatterOptions {
  /**
   * A9-M2 (Audit-9) — "refresh" mode. The caller has already seeded a
   * PLACEHOLDER frontmatter object (e.g. from the vault index, to keep an
   * early-armed debounced write from no-op'ing on an empty cache) at this
   * mutation version, and wants the fresh disk bytes to OVERWRITE that
   * placeholder — restoring the source-preserving baseline (comments / key
   * order / quoting) the index seed lacks, and any key the index missed.
   *
   * The overwrite happens ONLY when the cache is STILL at `refreshSeedVersion`
   * after the read, i.e. nothing mutated the frontmatter in the interim. A
   * concurrent in-app field edit (`mergeFrontmatter`) bumps the version and so
   * must NOT be clobbered by the stale disk bytes — the caller guarantees only
   * that ITS placeholder seed is safe to replace, not a later mutation. Without
   * this option the seed skips entirely on a present cache entry (the default,
   * mutation-preserving behaviour).
   */
  refreshSeedVersion?: number;
}

export async function seedDocumentFrontmatterFromDisk(
  docId: string | null,
  vaultRoot: string | null | undefined,
  relPath: string,
  options?: SeedFrontmatterOptions,
): Promise<void> {
  if (!docId || !vaultRoot || !relPath) return;
  const refreshVersion = options?.refreshSeedVersion;
  // Default mode skips a present cache entry (don't clobber unsaved mutations).
  // Refresh mode skips this guard — the caller's placeholder IS the present
  // entry — and instead gates the overwrite on an unchanged mutation version
  // below, after the vault-identity re-check.
  if (refreshVersion === undefined && documentStore.getFrontmatter(docId)) return;
  // A9-M1 — snapshot the active vault BEFORE the await; bail after if it swapped.
  const identity = captureVaultIdentity();
  try {
    const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
    // A swap committed during the read — never inject the outgoing vault's
    // frontmatter into the new vault's freshly-cleared store.
    if (!isStillSameVault(identity)) return;
    if (refreshVersion !== undefined) {
      // Overwrite the placeholder ONLY if nothing mutated FM since it was seeded
      // (a concurrent field edit bumps the version and must be preserved).
      if (documentStore.getFrontmatterMutationVersion(docId) === refreshVersion) {
        documentStore.setFrontmatter(docId, hydrate.frontmatter, hydrate.rawFrontmatter);
      }
      return;
    }
    if (!documentStore.getFrontmatter(docId)) {
      documentStore.setFrontmatter(docId, hydrate.frontmatter, hydrate.rawFrontmatter);
    }
  } catch {
    // Leave the cache unseeded (or the placeholder intact); the caller's
    // index-seed fallback runs as before.
  }
}
