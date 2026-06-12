import { SvelteMap } from 'svelte/reactivity';
import type { BoardType } from '../../shared/types';
import { createId } from '../lib/utils/ids';
import type { Board, WorkspaceState } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import { historyStore } from './history.svelte';
import { uiStore } from './ui.svelte';
import { flushAllMarkdownWriters } from '../lib/vault/markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { onVaultSwap } from '../core/vaultLifecycle';
import { runWithCloseDrain } from '../lib/editor/closeDrainGate.svelte';

/**
 * Sprint B / B15 — partitions a `flushAllMarkdownWriters` failure list into
 * (a) failures attributable to editors inside `boardId`'s board and
 * (b) failures we can POSITIVELY attribute to another board.
 *
 * Attribution rules:
 *   - `text-tile:${tileId}` is "other tabs" only when the tile is found in
 *     a different board's cached tiles. If the tile is in the closing
 *     board, or in no board at all (cache miss / not yet hydrated), treat
 *     as in-tab so the confirm still gates the close. Silently swallowing
 *     a failure is worse than surfacing a false positive.
 *   - `document-editor:${docId}` is in-tab when the closing board is a
 *     Document board whose `contentId === docId`. If the closing board is
 *     a different document board, walk the cache for a positive match
 *     against another board's contentId; only mark as other-tabs on a
 *     positive match elsewhere.
 *   - Any unknown owner shape stays in-tab.
 */
function partitionMarkdownFailuresByBoard(
  failures: Array<{ ownerId: string; error: unknown }>,
  boardId: string | null,
): { inTab: Array<{ ownerId: string; error: unknown }>; otherTabs: Array<{ ownerId: string; error: unknown }> } {
  if (!boardId) return { inTab: failures, otherTabs: [] };

  // Read-only attribution maps built from a non-reactive cache snapshot.
  // No `$state` mutation here, so SvelteSet / SvelteMap aren't required.
  // Disabling the rule per-block is cleaner than pulling reactive
  // collections into a pure helper.
  /* eslint-disable svelte/prefer-svelte-reactivity */
  const cache = boardCacheStore.cache;
  const closing = cache[boardId];
  const closingTileIds = new Set<string>();
  if (closing) {
    for (const tileId of Object.keys(closing.tileDefs ?? {})) {
      closingTileIds.add(tileId);
    }
  }
  const closingDocContentId = closing?.board?.type === 'document'
    ? (closing.board as { contentId?: string }).contentId
    : undefined;

  // Build the global "tile id → owning boardId" and "docId → owning boardId"
  // maps so we can positively attribute owners we don't see in the closing
  // board's cache. Iterates the cache once per partition call; the cache
  // size is bounded by the number of open boards (a few dozen at most).
  const tileToBoard = new Map<string, string>();
  const docToBoard = new Map<string, string>();
  for (const [bid, entry] of Object.entries(cache)) {
    for (const tileId of Object.keys(entry.tileDefs ?? {})) {
      tileToBoard.set(tileId, bid);
    }
    if (entry.board?.type === 'document') {
      const cid = (entry.board as { contentId?: string }).contentId;
      if (cid) docToBoard.set(cid, bid);
    }
  }
  /* eslint-enable svelte/prefer-svelte-reactivity */

  const inTab: typeof failures = [];
  const otherTabs: typeof failures = [];
  for (const f of failures) {
    if (f.ownerId.startsWith('text-tile:')) {
      const tileId = f.ownerId.slice('text-tile:'.length);
      if (closingTileIds.has(tileId)) { inTab.push(f); continue; }
      const owningBoard = tileToBoard.get(tileId);
      if (owningBoard && owningBoard !== boardId) { otherTabs.push(f); continue; }
      // Not positively attributed elsewhere — surface in the closing tab's
      // prompt so the user has at least one chance to see the failure.
      inTab.push(f);
      continue;
    }
    if (f.ownerId.startsWith('document-editor:')) {
      const docId = f.ownerId.slice('document-editor:'.length);
      if (closingDocContentId && closingDocContentId === docId) { inTab.push(f); continue; }
      const owningBoard = docToBoard.get(docId);
      if (owningBoard && owningBoard !== boardId) { otherTabs.push(f); continue; }
      inTab.push(f);
      continue;
    }
    // Unknown owner shape — preserve the prior "always surface" behaviour
    // so we never silently swallow a failure.
    inTab.push(f);
  }
  return { inTab, otherTabs };
}

/**
 * Phase 4 / 4.2 — promisifies `uiStore.openConfirm` for the save-failure
 * confirm in `close` / `closeOthers`. Mirrors the helper in
 * `vault.svelte.ts` — re-implemented here so this module can stay free
 * of a circular import on `vaultStore`.
 */
/**
 * Builds a short, user-readable description of what failed to flush.
 * `boardOkOrUnused = true` means no .board.json write was attempted (or
 * it succeeded). `boardFailedCount` is passed for the multi-tab path.
 */
function buildFailureDetails(
  markdownFailed: number,
  fmFailed: string[],
  boardOk: boolean,
  boardFailedCount: number = 0,
): string {
  const parts: string[] = [];
  if (markdownFailed > 0) {
    parts.push(`${markdownFailed} text document${markdownFailed === 1 ? '' : 's'}`);
  }
  if (fmFailed.length > 0) {
    parts.push(`${fmFailed.length} frontmatter write${fmFailed.length === 1 ? '' : 's'}`);
  }
  const boardCount = boardFailedCount > 0 ? boardFailedCount : (boardOk ? 0 : 1);
  if (boardCount > 0) {
    parts.push(`${boardCount} board file${boardCount === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return '';
  return ` (${parts.join(', ')})`;
}

function confirmCloseAnyway(failedDetails: string): Promise<boolean> {
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: 'Save failed',
      body:
        `Filo couldn't save the latest changes${failedDetails}. ` +
        'Closing now will lose those edits. ' +
        "Pick \"Close anyway\" to discard them, or \"Cancel\" to keep the tab open so you can retry.",
      confirmLabel: 'Close anyway',
      cancelLabel: 'Cancel',
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/**
 * Tab data represents an open board tab.
 */
export interface TabData {
  id: string;
  boardId: string;
  name: string;
  boardType: BoardType;
  emoji: string;
}

/**
 * Tab store — manages open tabs, active tab, add/remove/rename/reorder.
 *
 * Mutations notify an optional change listener (wired up by the project store)
 * so the project file can persist open-tab state in `project.workspace`.
 */

let tabs = $state<TabData[]>([]);
let activeTabId = $state<string>('');

/** Notifier invoked after every mutation. Wired up by project store. */
let onChangeListener: (() => void) | null = null;

function notifyChange() {
  onChangeListener?.();
}

export const tabStore = {
  get tabs() { return tabs; },
  get activeTabId() { return activeTabId; },
  get activeTab(): TabData | undefined {
    return tabs.find((t) => t.id === activeTabId);
  },
  get count() { return tabs.length; },

  /**
   * Registers a listener invoked after every tab mutation. Use `null` to clear.
   * The project store uses this to mark metadata dirty so workspace state is saved.
   */
  setChangeListener(fn: (() => void) | null) {
    onChangeListener = fn;
  },

  /**
   * Opens a new tab for a board. If already open, switches to it.
   */
  open(boardId: string, name: string, boardType: BoardType, emoji = '') {
    const existing = tabs.find((t) => t.boardId === boardId);
    if (existing) {
      if (activeTabId !== existing.id) {
        activeTabId = existing.id;
        notifyChange();
      }
      return existing;
    }

    const tab: TabData = { id: createId(), boardId, name, boardType, emoji };
    tabs = [...tabs, tab];
    activeTabId = tab.id;
    notifyChange();
    return tab;
  },

  /**
   * Closes a tab by its ID.
   *
   * Sprint B / B2 — drains every pending markdown + frontmatter write
   * BEFORE removing the tab from `tabs`. Removing the tab triggers the
   * Svelte unmount of any TextTile / DocumentEditor inside it; the
   * editor's onDestroy hook does fire a flush, but it's fire-and-forget,
   * so a user who closes a tab inside the 300 ms idle window can land
   * the disk write AFTER the contextBridge IPC route has been
   * unregistered — silently losing the last keystrokes. Awaiting the
   * registry flush here is the only safe close path. The flush is bounded
   * by the number of currently-armed editors (small) and is a no-op
   * for owners without a pending write.
   *
   * Flushes any pending debounced write for the closing tab's board so
   * a queued settings/placement write can't fire after the cache entry
   * has changed or under a different active board — both of which were
   * symptoms of the freeze-on-reopen-after-settings-change bug.
   */
  async close(tabId: string): Promise<void> {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    const closing = tabs[idx];

    // Audit-17 5.7 — raise the close-drain gate for the ENTIRE drain → confirm
    // → re-drain window. The editors stay mounted through it, so without this
    // a keystroke typed during the drain (or during the failed-drain confirm,
    // which can sit open for minutes) re-arms a debounce the snapshots never
    // saw and the unmount below destroys it. While the gate is raised the
    // editors go read-only (a visual "saving…" freeze), so no keystroke can be
    // stranded. `runWithCloseDrain` lowers the gate on EVERY exit (cancel,
    // throw, success) via try/finally.
    const proceed = await runWithCloseDrain(async () => {
      // B2 — drain pending writes synchronously before unmount.
      //
      // Phase 4 / 4.2 — collect any failures from the drains so we can
      // surface a confirm before destroying the editor (and its in-memory
      // edits). Without this gate, closing a tab while disk is full
      // silently dropped the user's last edits with no UI indication.
      const mdResult = await flushAllMarkdownWriters();
      const fmResult = await flushAllPendingFrontmatterWrites();
      let boardOk = true;
      if (closing) {
        const result = await boardCacheStore.flushDirty(closing.boardId);
        boardOk = result.ok;
      }

      // Sprint B / B15 — only block the close on failures attributable to
      // editors inside the closing tab. Failures in OTHER tabs are surfaced
      // via a non-blocking toast so the user knows about them, but they
      // don't gate this tab's close (the user has no recourse to retry a
      // foreign tab's editor from this dialog).
      const { inTab, otherTabs } = partitionMarkdownFailuresByBoard(
        mdResult.failed,
        closing?.boardId ?? null,
      );
      if (otherTabs.length > 0) {
        uiStore.toast(
          `Pending writes failed for ${otherTabs.length} editor${otherTabs.length === 1 ? '' : 's'} in other tabs. Retry from those tabs.`,
          'warning',
          6000,
        );
      }
      const failed =
        inTab.length > 0 ||
        fmResult.failed.length > 0 ||
        !boardOk;
      if (failed) {
        const details = buildFailureDetails(inTab.length, fmResult.failed, boardOk);
        const ok = await confirmCloseAnyway(details);
        if (!ok) return false;
      }

      // Audit-16 6.7 — the editor stays mounted through the drains above (and
      // through the interactive confirm when one was shown). 5.7 makes it
      // read-only for that window, so the re-arm window is gone; this second
      // pass remains as a belt-and-suspenders capture of anything armed before
      // the gate engaged. A failure in this second pass is not re-confirmed
      // (no loop) — the writers' trackComponentWrite pipeline surfaces it
      // loudly (toast + `.filo/.dirty` sentinel), so the bytes are recoverable.
      await flushAllMarkdownWriters();
      await flushAllPendingFrontmatterWrites();
      if (closing) {
        await boardCacheStore.flushDirty(closing.boardId);
      }
      return true;
    });
    if (!proceed) return;

    tabs = tabs.filter((t) => t.id !== tabId);

    // Drop the per-board undo/redo stack on close. The board's content is
    // preserved on disk; reopening it via the sidebar gets a fresh history.
    // If the same board is still open in another tab (the tab list now
    // missing the closing tab), preserve history.
    if (closing && !tabs.some((t) => t.boardId === closing.boardId)) {
      historyStore.clearBoard(closing.boardId);
    }

    // If closing the active tab, switch to the nearest tab
    if (activeTabId === tabId) {
      if (tabs.length === 0) {
        activeTabId = '';
      } else {
        const newIdx = Math.min(idx, tabs.length - 1);
        activeTabId = tabs[newIdx]?.id ?? '';
      }
    }
    notifyChange();
  },

  /**
   * Closes all tabs except the given one.
   *
   * Sprint B / B2 — same flush gate as `close`: drain pending writes
   * before unmounting any of the soon-to-close editors.
   *
   * Phase 31 A1.4 — mirrors the per-tab `flushDirty` from `close()`: each
   * closing tab's `.board.json` debounced write is awaited explicitly
   * before the cache entry is dereferenced. Without this, a settings or
   * placement mutation that scheduled its 300ms debounce mid-closeOthers
   * could fire against a stale cache after the tab list narrows.
   */
  async closeOthers(tabId: string): Promise<void> {
    const keepBoardId = tabs.find((t) => t.id === tabId)?.boardId;

    // A1.4 — collect the closing board ids first (dedupe so we don't
    // double-flush when the same boardId is open in multiple tabs).
    const closingBoardIds: string[] = [];
    for (const t of tabs) {
      if (t.id === tabId) continue;
      if (!closingBoardIds.includes(t.boardId)) closingBoardIds.push(t.boardId);
    }

    // Audit-17 5.7 — same close-drain gate as close(): editors go read-only for
    // the whole drain → confirm → re-drain window so no keystroke can re-arm a
    // debounce the bulk unmount would destroy. Gate lowered on every exit.
    const proceed = await runWithCloseDrain(async () => {
      // B2 — drain pending writes synchronously before bulk unmount.
      //
      // Phase 4 / 4.2 — same save-failure gate as `close()`: if any of the
      // drains failed, prompt the user before destroying the editors.
      const mdResult = await flushAllMarkdownWriters();
      const fmResult = await flushAllPendingFrontmatterWrites();

      // A1.4 — await every closing board's flush before mutating the tab list.
      let boardFailedCount = 0;
      for (const boardId of closingBoardIds) {
        const result = await boardCacheStore.flushDirty(boardId);
        if (!result.ok) boardFailedCount++;
      }

      const failed =
        mdResult.failed.length > 0 ||
        fmResult.failed.length > 0 ||
        boardFailedCount > 0;
      if (failed) {
        const details = buildFailureDetails(
          mdResult.failed.length,
          fmResult.failed,
          boardFailedCount === 0,
          boardFailedCount,
        );
        const ok = await confirmCloseAnyway(details);
        if (!ok) return false;
      }

      // Audit-16 6.7 — belt-and-suspenders re-flush (now that 5.7 holds the
      // editors read-only, the re-arm window is gone) before the bulk unmount.
      await flushAllMarkdownWriters();
      await flushAllPendingFrontmatterWrites();
      for (const boardId of closingBoardIds) {
        await boardCacheStore.flushDirty(boardId);
      }
      return true;
    });
    if (!proceed) return;

    tabs = tabs.filter((t) => t.id === tabId);
    activeTabId = tabId;
    for (const boardId of closingBoardIds) {
      if (boardId !== keepBoardId) historyStore.clearBoard(boardId);
    }
    notifyChange();
  },

  /**
   * Switches to a tab by ID.
   */
  setActive(tabId: string) {
    if (tabs.some((t) => t.id === tabId) && activeTabId !== tabId) {
      activeTabId = tabId;
      notifyChange();
    }
  },

  /**
   * Renames a tab.
   */
  rename(tabId: string, name: string) {
    tabs = tabs.map((t) => (t.id === tabId ? { ...t, name } : t));
    notifyChange();
  },

  /**
   * Sets the emoji for a tab.
   */
  setEmoji(tabId: string, emoji: string) {
    tabs = tabs.map((t) => (t.id === tabId ? { ...t, emoji } : t));
    notifyChange();
  },

  /**
   * Reorders tabs by moving a tab from one index to another.
   */
  reorder(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const updated = [...tabs];
    const [moved] = updated.splice(fromIndex, 1);
    if (!moved) return; // fromIndex out of range — nothing to move
    updated.splice(toIndex, 0, moved);
    tabs = updated;
    notifyChange();
  },

  /**
   * Clears all tabs (e.g. when creating a new project).
   * Does NOT notify — callers clearing during load manage persistence themselves.
   */
  closeAll() {
    tabs = [];
    activeTabId = '';
  },

  /**
   * Returns the minimal workspace snapshot for persistence.
   * Only tab id + board id are stored; display data (name, emoji, type) is
   * re-derived from the project's boards when tabs are restored.
   */
  serialize(): WorkspaceState {
    return {
      openTabs: tabs.map((t) => ({ id: t.id, boardId: t.boardId })),
      activeTabId,
    };
  },

  /**
   * Restores tabs from a saved workspace snapshot. Tab display data is pulled
   * from the project's boards. Any saved tabs whose board no longer exists
   * are silently dropped. Does NOT notify the change listener.
   */
  hydrateFromWorkspace(workspace: WorkspaceState | undefined, boards: Board[]) {
    tabs = [];
    activeTabId = '';

    if (!workspace || !workspace.openTabs || workspace.openTabs.length === 0) {
      return;
    }

    const boardById = new SvelteMap(boards.map((b) => [b.id, b]));
    const restored: TabData[] = [];

    for (const saved of workspace.openTabs) {
      const board = boardById.get(saved.boardId);
      if (!board) continue;
      restored.push({
        id: saved.id || createId(),
        boardId: board.id,
        name: board.name,
        boardType: board.type as BoardType,
        emoji: board.emoji || '',
      });
    }

    tabs = restored;

    // Honour the saved active tab if it's still open; otherwise fall back
    // to the first restored tab.
    if (workspace.activeTabId && restored.some((t) => t.id === workspace.activeTabId)) {
      activeTabId = workspace.activeTabId;
    } else if (restored.length > 0) {
      activeTabId = restored[0]?.id ?? '';
    }
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Closes every open tab before the new vault hydrates so a tab pointing
// at the prior vault's board id can't briefly render against the new
// vault's project. `hydrateFromWorkspace` repopulates after the new
// vault's workspace.json is parsed.
onVaultSwap('pre-swap', 'tabs', () => {
  tabStore.closeAll();
});
