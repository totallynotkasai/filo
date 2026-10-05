/**
 * The system file dialog, as a user answers it: the next dialog Filo opens
 * picks the path given here. Used by the pickers that bring a file into a
 * board (a card's cover, a File tile, a background image).
 */
import { folderPicks } from './electronFake';
import { $, click } from './actions';
import { quiesce } from './app';

/** A Kanban card's "Add cover image" → the dialog picks `absPath`. */
export async function pickCardCover(card: HTMLElement, absPath: string): Promise<void> {
  folderPicks.answers.push(absPath);
  click($(card, 'button.cover-toggle-btn[title="Add cover image"]'));
  await quiesce(1200);
}
