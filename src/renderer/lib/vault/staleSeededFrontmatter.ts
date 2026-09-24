import { documentStore } from '../../stores/document.svelte';

/**
 * Drop the `documentStore` frontmatter cache for the note at `relPath` when it
 * is SEEDED but has NO open editor.
 *
 * A Kanban card / Task row that was field-edited once is seeded into the FM
 * cache without being opened as a Document tab. The external-edit reconciler
 * refreshes that cache ONLY for an OPEN editor, so a not-open seeded entry
 * goes stale when another tool edits the file, and the note's views (which
 * prefer the live cache, see `noteMeta`) would show the OLD values. Clearing
 * the entry bumps the version tick so they fall back to the freshly-reindexed
 * disk metadata. (Writes are safe regardless — they apply a delta to fresh
 * disk.)
 *
 * An open editor's cache is kept current by the `editorDoc` branch /
 * `handleExternalChange`, and may hold unsaved edits we must not discard.
 *
 * Safe to call from the reconciler's apply branches because the pre-switch
 * `isPathPending` guard already routed any path with a pending/in-flight write
 * to the prompt path, so no scheduled write can read the just-cleared cache.
 */
export function dropStaleSeededFrontmatterCache(relPath: string): void {
  if (documentStore.getDocument(relPath)) return;
  if (!documentStore.hasFrontmatter(relPath)) return;
  documentStore.clearFrontmatter(relPath);
}
