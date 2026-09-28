/**
 * A same-section reorder on a Task List sorted by anything but Manual: the
 * switch to Manual sort and the reorder run as one undo step, and a toast
 * says so and offers Undo.
 *
 * The toast's Undo undoes that step only while it is still the last one on
 * the board's stack; a later change (or a switch to another board) makes it
 * say so instead of undoing whatever is on top by then.
 */
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { BatchCommand, UpdateBoardSettingsCommand } from '../../commands/index';
import type { Command } from '../../commands/Command';
import type { SortBy } from '../tasks/taskListModel';

export function executeReorderSwitchingToManual(reorderCmd: Command, sortBy: SortBy): void {
  const sortCmd = new UpdateBoardSettingsCommand({ sortBy: 'manual' }, { sortBy }, [], 'Switch to Manual sort');
  const batch = new BatchCommand('Reorder task (Manual sort)', [sortCmd, reorderCmd]);
  const boardId = historyStore.activeBoardId;
  void historyStore.execute(batch);
  uiStore.pushToast({
    text: 'Switched to Manual sort to reorder tasks',
    type: 'info',
    duration: 4000,
    actions: [
      {
        label: 'Undo',
        handler: () => {
          if (historyStore.undoIfLatest(batch, boardId)) return;
          uiStore.toast(
            "Couldn't undo the switch to Manual sort: other changes were made since. Use Undo (Ctrl+Z) to step back.",
            'info',
            5000,
          );
        },
      },
    ],
  });
}
