import { SvelteMap } from 'svelte/reactivity';
import type { BoardType } from '../../shared/types';
import { createId } from '../lib/utils/ids';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import type { Board, WorkspaceState } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import { historyStore } from './history.svelte';
import { uiStore } from './ui.svelte';
import { noteStore } from './notes.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { runWithCloseDrain } from '../lib/editor/closeDrainGate.svelte';
import { flushRawViews } from '../lib/notes/rawViews';

/**
 * The notes a board shows: its text tiles' paths, or a Document board's note.
 */
function notesOfBoard(boardId: string): VaultPath[] {
  const entry = boardCacheStore.cache[boardId];
  const out: VaultPath[] = [];
  if (!entry) return out;
  for (const def of Object.values(entry.tileDefs ?? {})) {
    if (def.type === 'text' && def.filePath) out.push(vaultPath(def.filePath));
  }
  if (entry.board?.type === 'document' && entry.board.filePath) out.push(vaultPath(entry.board.filePath));
  return out;
}

/**
 * Partitions the note writer's failed paths into (a) notes the closing tab
 * shows and (b) notes we can POSITIVELY attribute to another open tab. A
 * failure attributable to nothing stays in-tab, so the confirm still gates
 * the close: silently swallowing a failure is worse than a false positive.
 */
function partitionNoteFailuresByTab(
  failed: string[],
  closing: TabData | undefined,
): { inTab: string[]; otherTabs: string[] } {
  if (!closing) return { inTab: failed, otherTabs: [] };
  // Read-only lookups built from a non-reactive snapshot.
  /* eslint-disable svelte/prefer-svelte-reactivity */
  const inClosing = new Set<VaultPath>(notesOfBoard(closing.boardId));
  if (closing.notePath) inClosing.add(vaultPath(closing.notePath));
  const elsewhere = new Set<VaultPath>();
  for (const t of tabs) {
    if (t.id === closing.id) continue;
    for (const n of notesOfBoard(t.boardId)) elsewhere.add(n);
    if (t.notePath) elsewhere.add(vaultPath(t.notePath));
  }
  /* eslint-enable svelte/prefer-svelte-reactivity */
  const inTab: string[] = [];
  const otherTabs: string[] = [];
  for (const path of failed) {
    const key = vaultPath(path);
    if (!inClosing.has(key) && elsewhere.has(key)) otherTabs.push(path);
    else inTab.push(path);
  }
  return { inTab, otherTabs };
}

/**
 * Builds a short, user-readable description of what failed to flush.
 * `boardOkOrUnused = true` means no .board.json write was attempted (or
 * it succeeded). `boardFailedCount` is passed for the multi-tab path.
 */
function buildFailureDetails(
  notesFailed: number,
  boardOk: boolean,
  boardFailedCount: number = 0,
): string {
  const parts: string[] = [];
  if (notesFailed > 0) {
    parts.push(`${notesFailed} note${notesFailed === 1 ? '' : 's'}`);
  }
  const boardCount = boardFailedCount > 0 ? boardFailedCount : (boardOk ? 0 : 1);
  if (boardCount > 0) {
    parts.push(`${boardCount} board file${boardCount === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return '';
  return ` (${parts.join(', ')})`;
}

/**
 * Promisifies `uiStore.openConfirm` for the save-failure confirm in `close` /
 * `closeOthers`. Duplicated from `vault.svelte.ts` to avoid a circular import.
 */
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
 * The raw view of a closing Document tab couldn't write its text (the note
 * changed elsewhere, or the write failed). Closing keeps a copy of it in
 * `.filo/recovery/`, so the choice is between that and staying to resolve it.
 */
function confirmCloseRawAnyway(paths: string[]): Promise<boolean> {
  const names = paths.map((p) => `"${p}"`).join(', ');
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: 'Raw edits not saved',
      body:
        `Your raw edits to ${names} aren't saved: the note changed somewhere else, or the write failed. ` +
        'Close anyway keeps a copy of them in .filo/recovery/. Cancel keeps the tab open so you can choose which version to keep.',
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
  /**
   * A Document tab's note, by vault path. The tab's `boardId` is an opaque
   * id (it keys the tab's undo stack), so a rename only rewrites this path.
   */
  notePath?: string;
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
   * Opens a Document tab for the note at `notePath`, or switches to the one
   * already showing it (matched case-insensitively).
   */
  openNote(notePath: string, name: string): TabData {
    const key = vaultPath(notePath);
    const existing = tabs.find((t) => t.notePath !== undefined && vaultPath(t.notePath) === key);
    if (existing) {
      if (activeTabId !== existing.id) {
        activeTabId = existing.id;
        notifyChange();
      }
      return existing;
    }
    const tab: TabData = { id: createId(), boardId: createId(), name, boardType: 'document', emoji: '', notePath };
    tabs = [...tabs, tab];
    activeTabId = tab.id;
    notifyChange();
    return tab;
  },

  /**
   * Closes a tab by its ID.
   *
   * Drains every pending markdown + frontmatter write BEFORE removing the
   * tab. Removing it unmounts any TextTile / DocumentEditor inside, whose
   * onDestroy flush is fire-and-forget — closing inside the 300 ms debounce
   * could otherwise lose the last keystrokes. The flush is a no-op for
   * owners without a pending write.
   *
   * Also flushes the closing board's debounced write so a queued
   * settings/placement write can't fire after the cache entry has changed
   * or under a different active board.
   */
  async close(tabId: string): Promise<void> {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    const closing = tabs[idx];

    // Raise the close-drain gate for the whole drain → confirm → re-drain
    // window. The editors stay mounted through it (the confirm can sit open
    // for minutes), so a keystroke would otherwise re-arm a debounce the
    // unmount below destroys. While raised, editors are read-only.
    // `runWithCloseDrain` lowers the gate on every exit.
    const proceed = await runWithCloseDrain(async () => {
      // A raw view holds its text until it saves; unmounting it with text it
      // can't write would only leave a recovery copy, so ask first.
      if (closing?.notePath) {
        const raw = await flushRawViews([closing.notePath]);
        if (raw.notSaved.length > 0 && !(await confirmCloseRawAnyway(raw.notSaved))) return false;
      }
      // Drain pending writes before unmount, collecting failures so we can
      // confirm before destroying the editor's in-memory edits (e.g. disk full).
      const noteResult = await noteStore.flushAll();
      let boardOk = true;
      if (closing) {
        const result = await boardCacheStore.flushDirty(closing.boardId);
        boardOk = result.ok;
      }

      // Only block the close on failures of notes the closing tab shows.
      // Failures in OTHER tabs are surfaced via a non-blocking toast so the
      // user knows about them, but they don't gate this tab's close (the
      // user has no recourse to retry a foreign tab's note from this dialog).
      const { inTab, otherTabs } = partitionNoteFailuresByTab(noteResult.failed, closing);
      if (otherTabs.length > 0) {
        uiStore.toast(
          `Pending writes failed for ${otherTabs.length} note${otherTabs.length === 1 ? '' : 's'} in other tabs. Retry from those tabs.`,
          'warning',
          6000,
        );
      }
      const failed = inTab.length > 0 || !boardOk;
      if (failed) {
        const details = buildFailureDetails(inTab.length, boardOk);
        const ok = await confirmCloseAnyway(details);
        if (!ok) return false;
      }

      // Belt-and-suspenders second pass for anything armed before the gate
      // engaged. A failure here is not re-confirmed (no loop) — the writers'
      // trackComponentWrite pipeline surfaces it (toast + `.filo/.dirty`
      // sentinel), so the bytes are recoverable.
      await noteStore.flushAll();
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
   * Same flush gate as `close`: drain pending writes before unmounting any
   * of the soon-to-close editors, and await each closing board's
   * `.board.json` debounced write so it can't fire against a stale cache
   * after the tab list narrows.
   */
  async closeOthers(tabId: string): Promise<void> {
    const keepBoardId = tabs.find((t) => t.id === tabId)?.boardId;

    // Collect the closing board ids first (dedupe so we don't
    // double-flush when the same boardId is open in multiple tabs).
    const closingBoardIds: string[] = [];
    for (const t of tabs) {
      if (t.id === tabId) continue;
      if (!closingBoardIds.includes(t.boardId)) closingBoardIds.push(t.boardId);
    }

    // Same close-drain gate as close(): editors go read-only for the whole
    // drain → confirm → re-drain window so no keystroke can re-arm a
    // debounce the bulk unmount would destroy.
    const proceed = await runWithCloseDrain(async () => {
      const closingNotes = tabs.filter((t) => t.id !== tabId && t.notePath).map((t) => t.notePath as string);
      if (closingNotes.length > 0) {
        const raw = await flushRawViews(closingNotes);
        if (raw.notSaved.length > 0 && !(await confirmCloseRawAnyway(raw.notSaved))) return false;
      }
      // Same save-failure gate as `close()`: if any drain failed, prompt
      // before destroying the editors.
      const noteResult = await noteStore.flushAll();

      // Await every closing board's flush before mutating the tab list.
      let boardFailedCount = 0;
      for (const boardId of closingBoardIds) {
        const result = await boardCacheStore.flushDirty(boardId);
        if (!result.ok) boardFailedCount++;
      }

      const failed = noteResult.failed.length > 0 || boardFailedCount > 0;
      if (failed) {
        const details = buildFailureDetails(
          noteResult.failed.length,
          boardFailedCount === 0,
          boardFailedCount,
        );
        const ok = await confirmCloseAnyway(details);
        if (!ok) return false;
      }

      // Belt-and-suspenders re-flush before the bulk unmount.
      await noteStore.flushAll();
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

/**
 * A Document tab names its note by path, so a rename (of the note, or of a
 * folder above it) rewrites the tab's `notePath` to the new path.
 */
function renameDocumentTabs(oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const oldPrefix = `${oldKey}/`;
  let changed = false;
  const next = tabs.map((t) => {
    if (!t.notePath) return t;
    const key = vaultPath(t.notePath);
    let notePath: string | null = null;
    if (key === oldKey) notePath = newRel;
    else if (key.startsWith(oldPrefix)) notePath = newRel + t.notePath.slice(oldRel.length);
    if (notePath === null || notePath === t.notePath) return t;
    changed = true;
    return { ...t, notePath };
  });
  if (changed) tabs = next;
}

registerPathRenamable('tabs.documentTabs', renameDocumentTabs);

// Vault-swap reset: closes every open tab before the new vault hydrates so a tab pointing
// at the prior vault's board id can't briefly render against the new
// vault's project. `hydrateFromWorkspace` repopulates after the new
// vault's workspace.json is parsed.
onVaultSwap('pre-swap', 'tabs', () => {
  tabStore.closeAll();
});
