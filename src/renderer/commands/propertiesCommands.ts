/**
 * Phase 5 / 5.1 — undoable PropertiesPopup edits.
 *
 * Each time the popup closes after the user touched a row, a single
 * `UpdatePropertiesCommand` is pushed for the whole session. Per-keystroke
 * commands would blow through MAX_HISTORY for a normal edit, and the user's
 * mental model is "I opened properties, I undo to close it" — one command
 * per popup-session matches that.
 *
 * Snapshots capture the metadata source for the tile's type:
 *  - text tiles → frontmatter (canonical source, lives on disk)
 *  - non-text tiles → `tile.metadata` (lives in board JSON)
 *
 * Execute / undo apply the corresponding "after" / "before" snapshot. For
 * text tiles the disk write goes through `vault:write-existing-file-text`
 * (same channel the popup itself uses) so an externally-deleted file does
 * not get resurrected by undo. Pending frontmatter writes are drained
 * pre-execute to mirror `UpdateCardFieldCommand` — a rapid Apply → Undo
 * without the flush would race the still-debounced forward write against
 * the inverse patch's fresh write at the same docId.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { vaultStore } from '../stores/vault.svelte';
import type { Tile } from '../schema/index';
import {
  writeMarkdownFile,
  markHydrated,
  isHydrated,
  readMarkdownForHydrate,
} from '../lib/vault/markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { reportError } from '../lib/utils/errorBus';

export type PropertiesSnapshot =
  | { kind: 'frontmatter'; relPath: string; docId: string | null; fm: Record<string, unknown> }
  | { kind: 'metadata'; tileId: string; metadata: Record<string, unknown> };

export class UpdatePropertiesCommand extends Command {
  description: string;
  /**
   * Phase 3 / 3.1 (polish plan 2026-05-25) — capture the originating board
   * so the history dispatcher refuses to redo this against a different
   * board. `applySnapshot` ends with `boardCacheStore.markDirty(boardStore.current?.id)`
   * — a redo with the wrong active board would silently mark that other
   * board dirty (and an Update*Tile call could find an unrelated tile by
   * ID). The targetBoardId guard in `historyStore.undo/redo` surfaces a
   * "switch back to originate" toast instead.
   */
  readonly targetBoardId: string;
  private before: PropertiesSnapshot;
  private after: PropertiesSnapshot;

  constructor(before: PropertiesSnapshot, after: PropertiesSnapshot, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.before = this.cloneSnapshot(before);
    this.after = this.cloneSnapshot(after);
    this.description = `Update properties`;
  }

  private cloneSnapshot(snap: PropertiesSnapshot): PropertiesSnapshot {
    if (snap.kind === 'frontmatter') {
      return {
        kind: 'frontmatter',
        relPath: snap.relPath,
        docId: snap.docId,
        // Phase R3 — `this.snapshot(...)` detaches every nested key/value
        // in the frontmatter map.
        fm: this.snapshot(snap.fm),
      };
    }
    return {
      kind: 'metadata',
      tileId: snap.tileId,
      metadata: this.snapshot(snap.metadata),
    };
  }

  async execute(): Promise<void> {
    await applySnapshot(this.after);
  }

  async undo(): Promise<void> {
    await applySnapshot(this.before);
  }
}

async function applySnapshot(snap: PropertiesSnapshot): Promise<void> {
  if (snap.kind === 'metadata') {
    boardStore.updateTile(snap.tileId, { metadata: { ...snap.metadata } } as Partial<Tile>);
    return;
  }

  // Drain pending debounced writes before this command writes its own copy
  // so the prior in-memory state lands on disk first. Same reason as
  // UpdateCardFieldCommand: a rapid Apply → Undo without the flush would
  // race the still-debounced forward write against this command's fresh
  // write at the same path.
  await flushAllPendingFrontmatterWrites();

  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

  // Sync the live FM cache so any open editor/popup sees the snapshot's
  // values. Without this, an already-open PropertiesPopup would re-write
  // its stale snapshot 300ms later and clobber what we just applied.
  if (snap.docId) documentStore.setFrontmatter(snap.docId, { ...snap.fm });

  // Prefer the live in-memory body — an open TextTile/DocumentEditor keeps
  // it current with un-debounced keystrokes. Fall back to the watcher
  // snapshot so a popup-only edit (no editor mounted) still round-trips.
  const docState = snap.docId ? documentStore.getDocument(snap.docId) : null;
  const body = docState?.body ?? vaultIndexStore.getMetadata(snap.relPath)?.content ?? '';

  // If no sibling editor has hydrated the file yet, hydrate it via the read
  // gateway — it detects the BOM AND seeds the drift baseline from the same
  // read's mtime. Costs one IPC per never-hydrated file; once hydrated,
  // subsequent writes hit the fast path.
  if (!isHydrated(snap.relPath)) {
    try {
      await readMarkdownForHydrate(vaultRoot, snap.relPath);
    } catch {
      // File missing or unreadable — mark hydrated with no BOM so the write
      // below ENOENT-fails on missing files, surfacing the same toast path
      // the old direct write produced.
      markHydrated(snap.relPath, false);
    }
  }

  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath: snap.relPath,
      frontmatter: snap.fm,
      body,
      callerId: `update-properties-command:${snap.relPath}`,
      docId: snap.docId,
    });
  } catch (err) {
    reportError('updateProperties', err, `Failed to apply properties to ${snap.relPath}`);
  }

  boardCacheStore.markDirty(boardStore.current?.id ?? '');
}
