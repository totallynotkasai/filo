/**
 * "Delete from vault…" on a Kanban card: after a confirm, the card comes off
 * the board and its note goes to Filo's trash, as the Task List's "Delete
 * task and file" does. One undo step puts both back. Removing a card from the
 * board alone (Remove from board, Delete) stays immediate, with undo.
 */
import { DeleteCardCommand } from '../../commands/kanbanCommands';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { withDrainedWrites, PendingWritesFailedError } from '../vault/vaultOperations';
import { normalizePath } from '../utils/path';
import type { Tile } from '../../schema/index';

/** The card's note, when it has one to delete. */
export function cardNotePath(card: Tile | undefined): string | null {
  return card?.type === 'text' && card.filePath ? card.filePath : null;
}

/** Asks, then removes `card` from the board and moves its note to Filo's trash; `done` runs once both are gone. */
export function deleteCardWithFile(boardId: string, card: Tile, done: () => void): void {
  const filePath = cardNotePath(card);
  if (!filePath) return;
  const title = card.title || 'card';
  uiStore.openConfirm({
    title: 'Delete card and file',
    body: `"${title}" is removed and its .md file moves to Filo's trash. Any other tile showing the note becomes a broken link. Undo restores both, or restore the file from Settings → Trash.`,
    confirmLabel: 'Delete card & file',
    danger: true,
    onConfirm: () => {
      void performCardFileDelete(boardId, card.id, filePath, done);
    },
  });
}

async function performCardFileDelete(boardId: string, tileId: string, filePath: string, done: () => void): Promise<void> {
  const vaultRoot = normalizePath(vaultStore.path);
  try {
    // Pending writes are drained first, so nothing queued for the note can
    // recreate it after it moved to the trash; only a failed write to this
    // note refuses the delete.
    let executed: Promise<void> = Promise.resolve();
    await withDrainedWrites(async (drain) => {
      // Started here but awaited outside: the history chain may be running an
      // earlier undo whose restore waits for this op to end.
      executed = historyStore.execute(new DeleteCardCommand(boardId, tileId, { filePath, vaultRoot, drain }));
    }, { paths: [filePath] });
    await executed;
    done();
  } catch (err) {
    // The failed write already says what went wrong, in its own toast.
    if (err instanceof PendingWritesFailedError) return;
    throw err;
  }
}
