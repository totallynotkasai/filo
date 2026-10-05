/**
 * The names Filo gives a note it makes before the user has named it: a new
 * card, tile or task, a subtask, an untitled note. The file has to exist at
 * once (the card shows it), so it is made under such a name and renamed after
 * the first title the user gives it, and the vault reads by title in any
 * other app too. Titles otherwise never rename a file.
 */
import { BatchCommand, RenamePlaceholderCommand } from '../../commands/index';
import type { Command } from '../../commands/Command';
import { closeDrainGate } from '../editor/closeDrainGate.svelte';
import { noteStem } from '../../stores/noteMeta';
import { fileNameSafe } from '../vault/conventionPaths';
import { pathForTitle } from './renameToTitle';

// "New Card", "New Tile 4", "New Task 2", "Untitled", "Plot - Subtask 1",
// each perhaps bumped to " (n)" past a name already taken.
const PLACEHOLDER_STEM = /^(?:New (?:Card|Tile|Task)(?: \d+)?|Untitled|.+ - Subtask \d+)(?: \(\d+\))?$/;

/** Whether a file name (without its extension) is one Filo gave a note it made. */
export function isPlaceholderStem(stem: string): boolean {
  return PLACEHOLDER_STEM.test(stem);
}

/**
 * Where a note still under a placeholder name moves once titled `title`, or
 * null: it has a name of its own, or the title would make another
 * placeholder (an empty title, "New Card" typed back).
 */
export function placeholderRenameTarget(notePath: string, title: string): string | null {
  if (!isPlaceholderStem(noteStem(notePath))) return null;
  if (isPlaceholderStem(fileNameSafe(title))) return null;
  return pathForTitle(notePath, title);
}

/**
 * `titleStep` (the edit that sets the note's title to `title`) and, for a
 * note still under its placeholder name, the rename after that title, as one
 * undo step. Leaving the vault (close, open another, quit) saves a title
 * typed but moves no file: the next title edit renames it.
 */
export function withPlaceholderRename(titleStep: Command, notePath: string | null, title: string, boardId: string): Command {
  if (!notePath || closeDrainGate.draining) return titleStep;
  const target = placeholderRenameTarget(notePath, title);
  if (!target) return titleStep;
  return new BatchCommand(titleStep.description, [titleStep, new RenamePlaceholderCommand(notePath, target)], boardId);
}
