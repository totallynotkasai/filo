/**
 * unsavedMessages — the words for "these changes couldn't be saved", shared by
 * the close / open-another-vault dialog and the quit dialog.
 *
 * Each unsaved path carries the reason it isn't on disk, so the message tells
 * the user what is actually wrong: a file held by another program, a file that
 * no longer exists, a conflict waiting for an answer, or a note Filo won't
 * overwrite. Pure: no IPC, stores or DOM.
 */

/** Why a change isn't on disk. */
export type UnsavedCause = 'pending' | 'conflict' | 'missing' | 'non-utf8' | 'write-failed';

export interface UnsavedItem {
  /** Vault path, in its on-disk spelling where known. */
  path: string;
  cause: UnsavedCause;
}

/** What a set of rescue copies came to. */
export interface RescueResult {
  /** Vault-relative folder holding the copies; null when none was written. */
  dir: string | null;
  /** Paths whose copy was written. */
  kept: string[];
  /** Paths whose unsaved change has no copy (it couldn't be written, or can't be copied). */
  notKept: string[];
}

/** How many paths a message lists before "…and N more". */
const MAX_LISTED = 6;

const CAUSE_TEXT: Record<UnsavedCause, string> = {
  pending: 'still being written',
  conflict: 'waiting for your answer: another program changed it while you were editing',
  missing: 'the file no longer exists',
  'non-utf8': "it isn't UTF-8 text, so Filo won't overwrite it",
  'write-failed': "the file couldn't be written (another program, such as OneDrive or antivirus, may be holding it)",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line per path with its reason, capped at {@link MAX_LISTED}. */
function unsavedListText(items: readonly UnsavedItem[]): string {
  const lines = items.slice(0, MAX_LISTED).map((i) => `• ${i.path}: ${CAUSE_TEXT[i.cause]}`);
  if (items.length > MAX_LISTED) lines.push(`…and ${items.length - MAX_LISTED} more`);
  return lines.join('\n');
}

/** The headline: how many changes aren't on disk. */
function unsavedHeadline(items: readonly UnsavedItem[]): string {
  if (items.length === 0) return 'Filo is still writing a change to disk.';
  return `${plural(items.length, "change couldn't be saved", "changes couldn't be saved")}.`;
}

/** Dialog text for closing the vault or opening another with changes that couldn't be saved. */
export function leaveVaultDialog(
  items: readonly UnsavedItem[],
  kind: 'close' | 'open',
): { title: string; message: string; detail: string; anyway: string } {
  const anyway = kind === 'close' ? 'Close anyway' : 'Open anyway';
  const list = unsavedListText(items);
  return {
    title: kind === 'close' ? 'Close Vault' : 'Open Vault',
    message: unsavedHeadline(items),
    detail:
      (list ? `${list}\n\n` : '') +
      `"${anyway}" keeps a copy of each unsaved note in .filo/recovery, then ${kind === 'close' ? 'closes the vault' : 'opens the other vault'}. ` +
      '"Cancel" keeps this vault open so you can deal with them first.',
    anyway,
  };
}

/** Dialog text when rescue copies couldn't be written for some paths. */
export function rescueFailedDialog(
  notKept: readonly string[],
  anyway: string,
): { message: string; detail: string; anyway: string } {
  const listed = notKept.slice(0, MAX_LISTED).map((p) => `• ${p}`);
  if (notKept.length > MAX_LISTED) listed.push(`…and ${notKept.length - MAX_LISTED} more`);
  return {
    message: `Filo couldn't keep a copy of ${plural(notKept.length, 'change', 'changes')}.`,
    detail: `${listed.join('\n')}\n\nIf you continue, ${notKept.length === 1 ? 'it is' : 'they are'} lost.`,
    anyway: `${anyway} and lose ${notKept.length === 1 ? 'it' : 'them'}`,
  };
}

/** Where rescue copies went, for a toast after leaving. */
export function rescueKeptText(result: RescueResult): string | null {
  if (!result.dir || result.kept.length === 0) return null;
  return `${plural(result.kept.length, 'unsaved change was', 'unsaved changes were')} kept in ${result.dir}.`;
}

/**
 * The quit "Save failed" dialog body, worded by cause. It mentions `.tmp`
 * files only when a failed write actually preserved some.
 */
export function quitFailureBody(items: readonly UnsavedItem[], preservedTmp: number): string {
  const parts: string[] = [];
  parts.push(items.length === 0 ? "Filo couldn't finish writing your latest changes to disk." : unsavedHeadline(items));
  const list = unsavedListText(items);
  if (list) parts.push(list);
  const causes = new Set(items.map((i) => i.cause));
  if (causes.has('write-failed') || causes.has('pending') || items.length === 0) {
    parts.push('"Retry now" may work once the other program lets go of the file.');
  }
  if (causes.has('conflict')) {
    parts.push('Answer the "changed by another program" prompt to save or drop that edit.');
  }
  if (preservedTmp > 0) {
    parts.push(
      `A failed write also left ${plural(preservedTmp, 'partial .tmp file', 'partial .tmp files')} in the vault that you can recover by hand.`,
    );
  }
  parts.push('"Quit anyway" keeps a copy of each unsaved note in .filo/recovery. "Stay open" lets you keep editing.');
  return parts.join('\n\n');
}

/**
 * Closing a tab whose files still have unsaved changes. Closing loses
 * nothing (the changes stay in memory and keep being retried), so this only
 * says so: the real decision comes at quit or close vault.
 */
export function closeTabDialog(paths: readonly string[]): { title: string; body: string; confirmLabel: string; cancelLabel: string } {
  const names = paths.length <= 3
    ? paths.map((p) => `"${p}"`).join(', ')
    : `${paths.slice(0, 3).map((p) => `"${p}"`).join(', ')} and ${paths.length - 3} more`;
  return {
    title: 'Unsaved changes',
    body:
      `${names} still ${paths.length === 1 ? 'has' : 'have'} unsaved changes. ` +
      'Filo will keep trying, and will ask again when you quit or close the vault.',
    confirmLabel: 'Close tab',
    cancelLabel: 'Cancel',
  };
}
