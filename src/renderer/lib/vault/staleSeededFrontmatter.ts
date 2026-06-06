import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { tileBacksMarkdownPath } from './frontmatterSync';

/**
 * Phase 2 / 2.1 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — drop the
 * `documentStore` frontmatter cache for any document backed by `relPath` that
 * is SEEDED but has NO open editor.
 *
 * The bug it closes (Finding #1, a 🔴 HIGH): a Kanban card / Task row that was
 * field-edited once is seeded into the FM live cache (keyed by the tile's
 * `contentId`) but is never opened as a Document tab. The external-edit
 * reconciler's `sync-frontmatter` / `reload-silently` branches refresh that
 * cache ONLY for an OPEN editor (`if (editorDoc) setFrontmatter(...)`), so a
 * not-open seeded entry goes stale the moment another tool (Obsidian, VS Code)
 * adds a key to the file. The next in-app field edit's
 * `seedDocumentFrontmatterFromDisk` then no-ops on the present-but-stale cache,
 * `mergeFrontmatter` layers the patch over it, and the source-preserving write
 * DROPS the externally-added key — and the baseline re-stamp the reconciler
 * does in the same breath means the pre-write drift prompt won't catch it.
 *
 * Clearing the entry forces that next seed to re-read FRESH disk, so the
 * external key survives.
 *
 * Only seeded-but-NOT-open entries are cleared: an open editor's cache is kept
 * current by the `editorDoc` branch / `handleExternalChange`, and may hold
 * unsaved edits we must not discard.
 *
 * Safe to call from the reconciler's apply branches because the pre-switch F4
 * guard (`isPathPending`) already routed any path with a pending/in-flight
 * write to the prompt path — so there is no scheduled write whose flush could
 * read the just-cleared (null) cache and silent-drop.
 *
 * Cost note: walks every loaded board's tile defs, the same shape of scan the
 * sibling `applyFrontmatterToBackedTiles` already performs for `relPath` in the
 * same loop iteration, so this doubles an existing per-path cost rather than
 * adding a new order of magnitude.
 *
 * Audit-11 STALE-1 — NOT removed (the plan proposed deleting it once Phase 4
 * landed). Phase 4's delta-onto-fresh-disk write source did retire its
 * WRITE-path role — the gateway now reads fresh disk and preserves untouched
 * keys by construction, so a stale seeded cache can no longer make a write drop
 * a key. But this helper still earns its keep on the DISPLAY side: Kanban cards
 * / Task rows render priority/dueDate from `documentStore.getFrontmatter(
 * contentId)` (cache-wins; see `KanbanCard.svelte`), and the external-edit
 * reconciler's `setFrontmatter` refresh covers ONLY open editors. So for a
 * seeded-but-NOT-open card, an external `.md` metadata edit would leave the
 * cache stale and the card showing the OLD value — UNLESS this drop fires (it
 * clears the entry, bumping the version tick so the card falls back to the
 * freshly-reindexed disk metadata). It is the ONLY production `clearFrontmatter`
 * caller. Keep it until the display path stops preferring the cache for
 * not-open tiles.
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
