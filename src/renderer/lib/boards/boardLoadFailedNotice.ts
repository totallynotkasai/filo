/**
 * The notice for a board file that is there and readable but can't be used
 * (broken JSON, a field Filo doesn't understand, another Filo version). The
 * vault opens without it, so the notice has to say what is wrong in plain
 * words and what to do next, and lead to the copy Filo kept in
 * `.filo/recovery/` before anything else could be written.
 */
import type { FailedBoardEntry } from './boardLoader';
import { normalizePath } from '../utils/path';

export interface BoardLoadFailedToast {
  text: string;
  type: 'error';
  duration: number;
  sticky: true;
  dedupeKey: string;
  actions: Array<{ label: string; handler: () => void }>;
}

/** What went wrong, in words that don't need the error kind to make sense. */
function whatWentWrong(entry: FailedBoardEntry): string {
  const name = `"${entry.path}"`;
  switch (entry.errorKind) {
    case 'parse-error':
      return `Filo couldn't open the board ${name}: the file isn't valid JSON (it may have been cut short or edited by hand).`;
    case 'schema-invalid':
      return `Filo couldn't open the board ${name}: a value in it isn't one Filo understands (${entry.message}).`;
    default:
      // The version, size and snapshot messages are already plain words.
      return `Filo couldn't open the board ${name}. ${entry.message}`;
  }
}

/** The next step, which depends on whether a copy was kept. */
function nextStep(entry: FailedBoardEntry, copyKept: boolean): string {
  // These messages carry their own next step.
  if (entry.errorKind === 'snapshot-failed' || entry.errorKind === 'too-large') return '';
  if (entry.errorKind === 'from-future') {
    return copyKept ? 'A copy is in .filo/recovery. Update Filo, then reopen the vault.' : 'Update Filo, then reopen the vault.';
  }
  if (!copyKept) return 'Fix the file in a text editor, then reopen the vault.';
  return 'A copy is in .filo/recovery. Fix the file in a text editor, then reopen the vault.';
}

/**
 * The notice as a toast spec, buffered by the vault-open candidate and shown on
 * commit. `snapshotAbs` is the recovery copy (absolute), or null when none was
 * made; Show in folder then selects the board file itself.
 */
export function boardLoadFailedToast(
  vaultRoot: string,
  entry: FailedBoardEntry,
  snapshotAbs: string | null,
): BoardLoadFailedToast {
  const target = snapshotAbs ?? `${normalizePath(vaultRoot)}/${entry.path}`;
  return {
    text: [whatWentWrong(entry), nextStep(entry, snapshotAbs !== null)].filter(Boolean).join(' '),
    type: 'error',
    duration: 0,
    sticky: true,
    dedupeKey: `board-load-failed:${entry.path.toLowerCase()}`,
    actions: [
      {
        label: 'Show in folder',
        handler: () => {
          void window.filo.invoke('shell:show-item-in-folder', target);
        },
      },
    ],
  };
}
