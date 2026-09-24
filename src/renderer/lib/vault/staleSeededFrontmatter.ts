import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { tileBacksMarkdownPath } from './frontmatterSync';

/**
 * Drop the `documentStore` frontmatter cache for any document backed by
 * `relPath` that is SEEDED but has NO open editor.
 *
 * A Kanban card / Task row that was field-edited once is seeded into the FM
 * cache (keyed by the tile's `contentId`) without being opened as a Document
 * tab. The external-edit reconciler refreshes that cache ONLY for an OPEN
 * editor, so a not-open seeded entry goes stale when another tool edits the
 * file. Cards / rows render priority/dueDate from that cache (cache-wins; see
 * `KanbanCard.svelte`), so they would show the OLD value. Clearing the entry
 * bumps the version tick so the card falls back to the freshly-reindexed disk
 * metadata. (Writes are safe regardless — they apply a delta to fresh disk.)
 * This is the only production `clearFrontmatter` caller; keep it until the
 * display path stops preferring the cache for not-open tiles.
 *
 * Only seeded-but-NOT-open entries are cleared: an open editor's cache is kept
 * current by the `editorDoc` branch / `handleExternalChange`, and may hold
 * unsaved edits we must not discard.
 *
 * Safe to call from the reconciler's apply branches because the pre-switch
 * `isPathPending` guard already routed any path with a pending/in-flight write
 * to the prompt path, so no scheduled write can read the just-cleared cache.
 *
 * Cost note: walks every loaded board's tile defs, the same shape of scan the
 * sibling `applyFrontmatterToBackedTiles` already performs for `relPath`, so
 * this doubles an existing per-path cost rather than adding a new order of
 * magnitude.
 */
export function dropStaleSeededFrontmatterCache(relPath: string): void {
  for (const data of Object.values(boardCacheStore.cache)) {
    for (const def of Object.values(data.tileDefs ?? {})) {
      // Only text tiles carry a `contentId` (= the FM cache key / docId).
      if (def.type !== 'text') continue;
      const contentId = (def as Record<string, unknown>).contentId;
      if (typeof contentId !== 'string' || !contentId) continue;
      // Open editor → its cache is authoritative; leave it alone.
      if (documentStore.getDocument(contentId)) continue;
      // Not seeded → nothing stale to drop.
      if (!documentStore.hasFrontmatter(contentId)) continue;
      if (tileBacksMarkdownPath(def, relPath)) {
        documentStore.clearFrontmatter(contentId);
      }
    }
  }
}
