import { documentStore } from '../../stores/document.svelte';
import { readMarkdownForHydrate } from '../vault/markdownFileWriter';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';

/**
 * Lazily seed the live `documentStore` frontmatter cache for a Kanban card /
 * Task row that has NO open editor, reading the CURRENT bytes from disk rather
 * than the (durably-stale) vault index.
 *
 * The vault index is only refreshed for OPEN editors, so a key an external
 * editor added since the last rebuild would be absent from an index seed — and
 * the source-preserving engine treats a disk key missing from the object as a
 * deletion. Seeding from a fresh disk read avoids that; passing
 * `rawFrontmatter` also gives the gateway the source baseline it needs to
 * preserve comments / key order / quoting on untouched keys.
 *
 * Awaited BEFORE the synchronous `ensureSeededFm` so that, finding the cache
 * already populated, it skips the index seed. Deliberately conservative:
 *
 *  - No-op when the cache already holds an entry for `notePath` — an open editor or
 *    a prior in-app edit already seeded it from disk, and re-seeding would
 *    clobber unsaved mutations. (The `refreshSeedVersion` mode below is the one
 *    sanctioned exception — see its docstring.)
 *  - No-op on a disk read failure (ENOENT for a not-yet-created `.md`, EACCES, a
 *    mid-write transient) — the caller's index-seed fallback then runs, so the
 *    worst case is an index seed, never a throw.
 *  - Re-checks the cache AFTER the await so a parallel editor hydrate that
 *    seeded the doc while this read was in flight is not overwritten.
 *
 * Vault-identity guard: a vault swap can commit while the read is in flight.
 * Resuming would re-inject the OUTGOING vault's frontmatter into the incoming
 * vault's store — and, via the field-command write path, onto the new vault's
 * same-named file. Capturing the vault identity before the await and bailing
 * after it leaves the cache untouched.
 */

export interface SeedFrontmatterOptions {
  /**
   * "Refresh" mode. The caller has already seeded a
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
   *
   * Capture AND compare via
   * `documentStore.getFrontmatterOnlyMutationVersion` (NOT the shared
   * `getFrontmatterMutationVersion`, which also bumps on body edits): a
   * racing notes keystroke between the placeholder seed and this read is
   * irrelevant to "did anything mutate the FRONTMATTER" — the refresh only
   * replaces the FM cache, never the body — and blocking on it would strand
   * the cache on the baseline-less index placeholder, forcing the eventual
   * write into a lossy FM re-dump.
   */
  refreshSeedVersion?: number;
}

export async function seedDocumentFrontmatterFromDisk(
  notePath: string | null,
  vaultRoot: string | null | undefined,
  relPath: string,
  options?: SeedFrontmatterOptions,
): Promise<void> {
  if (!notePath || !vaultRoot || !relPath) return;
  const refreshVersion = options?.refreshSeedVersion;
  // Default mode skips a present cache entry (don't clobber unsaved mutations).
  // Refresh mode skips this guard — the caller's placeholder IS the present
  // entry — and instead gates the overwrite on an unchanged mutation version
  // below, after the vault-identity re-check.
  if (refreshVersion === undefined && documentStore.getFrontmatter(notePath)) return;
  // Snapshot the active vault BEFORE the await; bail after if it swapped.
  const identity = captureVaultIdentity();
  try {
    const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
    // A swap committed during the read — never inject the outgoing vault's
    // frontmatter into the new vault's freshly-cleared store.
    if (!isStillSameVault(identity)) return;
    if (refreshVersion !== undefined) {
      // Overwrite the placeholder ONLY if nothing mutated FM since it was seeded
      // (a concurrent field edit bumps the version and must be preserved).
      // FM-only version, so a racing notes BODY keystroke
      // (which bumps the shared token) doesn't block the refresh.
      if (documentStore.getFrontmatterOnlyMutationVersion(notePath) === refreshVersion) {
        documentStore.setFrontmatter(notePath, hydrate.frontmatter, hydrate.rawFrontmatter);
      }
      return;
    }
    if (!documentStore.getFrontmatter(notePath)) {
      documentStore.setFrontmatter(notePath, hydrate.frontmatter, hydrate.rawFrontmatter);
    }
  } catch {
    // Leave the cache unseeded (or the placeholder intact); the caller's
    // index-seed fallback runs as before.
  }
}
