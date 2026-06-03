import { documentStore } from '../../stores/document.svelte';
import { readMarkdownForHydrate } from '../vault/markdownFileWriter';

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
 *    clobber unsaved mutations.
 *  - No-op on a disk read failure (ENOENT for a not-yet-created `.md`, EACCES, a
 *    mid-write transient) — the caller's existing index-seed fallback then runs
 *    exactly as before, so the worst case is the prior behaviour, never a throw.
 *  - Re-checks the cache AFTER the await so a parallel editor hydrate that
 *    seeded the doc while this read was in flight is not overwritten.
 */
export async function seedDocumentFrontmatterFromDisk(
  docId: string | null,
  vaultRoot: string | null | undefined,
  relPath: string,
): Promise<void> {
  if (!docId || !vaultRoot || !relPath) return;
  if (documentStore.getFrontmatter(docId)) return;
  try {
    const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
    if (!documentStore.getFrontmatter(docId)) {
      documentStore.setFrontmatter(docId, hydrate.frontmatter, hydrate.rawFrontmatter);
    }
  } catch {
    // Leave the cache unseeded; the caller's index-seed fallback runs as before.
  }
}
