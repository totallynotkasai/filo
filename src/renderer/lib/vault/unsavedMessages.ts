/**
 * unsavedMessages — the words for "these changes couldn't be saved", shared by
 * the close / open-another-vault dialog and the quit dialog.
 *
 * Each unsaved path carries the reason it isn't on disk, so the message tells
 * the user what is actually wrong: a file held by another program, a file that
 * no longer exists, a question waiting for an answer (a note or board changed
 * elsewhere), or a note Filo won't overwrite. Pure: no IPC, stores or DOM.
 */
import { vaultPath } from '../../../shared/vaultPath';

/** Why a change isn't on disk. */
export type UnsavedCause =
  | 'pending'
  | 'conflict'
  | 'raw-conflict'
  | 'board-drift'
  | 'config-drift'
  | 'missing'
  | 'non-utf8'
  | 'write-failed';

/** The causes that wait for the user's answer: no retry saves them. */
// allow-module-state: a constant, never changed
const ANSWER_CAUSES: ReadonlySet<UnsavedCause> = new Set(['conflict', 'raw-conflict', 'board-drift', 'config-drift']);

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
  'raw-conflict': 'changed while you were editing it as text: Use the new version or Keep mine',
  'board-drift': 'changed outside Filo, waiting for Reload or Keep local',
  'config-drift': 'these settings were changed outside Filo, waiting for Reload or Keep local',
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
      `"${anyway}" keeps a copy of each unsaved file in .filo/recovery, then ${kind === 'close' ? 'closes the vault' : 'opens the other vault'}. ` +
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

const QUIT_CHOICES = '"Quit anyway" keeps a copy of each unsaved file in .filo/recovery. "Stay open" lets you keep editing.';

/**
 * The quit dialog when changes aren't on disk. `decisions` are the paths
 * (case-folded vault paths) held for the user's answer (a conflict, a note
 * deleted with unsaved edits, a board changed outside Filo, a raw view's
 * conflict); no retry saves those. When they are all that
 * is left, the dialog says it is waiting for a decision and offers
 * **Show decisions** instead of **Retry now** (`decisionsOnly`). Otherwise
 * it is "Save failed", and names the ones waiting among the rest.
 */
export function quitDialog(
  items: readonly UnsavedItem[],
  preservedTmp: number,
  decisions: ReadonlySet<string> = new Set(),
): { title: string; body: string; decisionsOnly: boolean } {
  const isDecision = (i: UnsavedItem): boolean => decisions.has(vaultPath(i.path));
  const decisionsOnly = decisions.size > 0 && preservedTmp === 0 && items.every(isDecision);
  if (!decisionsOnly) {
    return { title: 'Save failed', body: quitFailureBody(items, preservedTmp, items.filter(isDecision).length), decisionsOnly };
  }
  const n = Math.max(items.length, 1);
  const parts = [`${plural(n, 'change is', 'changes are')} waiting for your decision.`];
  const list = unsavedListText(items);
  if (list) parts.push(list);
  parts.push('"Show decisions" keeps Filo open and lists them under the save indicator, where each can be answered.');
  parts.push(QUIT_CHOICES);
  return { title: 'Waiting for your decision', body: parts.join('\n\n'), decisionsOnly };
}

/**
 * The quit "Save failed" dialog body, worded by cause. It mentions `.tmp`
 * files only when a failed write actually preserved some. `waiting` counts
 * the items held for the user's answer.
 */
export function quitFailureBody(items: readonly UnsavedItem[], preservedTmp: number, waiting = 0): string {
  const parts: string[] = [];
  parts.push(items.length === 0 ? "Filo couldn't finish writing your latest changes to disk." : unsavedHeadline(items));
  const list = unsavedListText(items);
  if (list) parts.push(list);
  const causes = new Set(items.map((i) => i.cause));
  if (causes.has('write-failed') || causes.has('pending') || items.length === 0) {
    parts.push('"Retry now" may work once the other program lets go of the file.');
  }
  if (waiting > 0) {
    parts.push(
      `${waiting === items.length ? (waiting === 1 ? 'It is' : 'They are') : `${waiting} of them ${waiting === 1 ? 'is' : 'are'}`} ` +
        'waiting for your decision, which no retry makes: stay open and answer from the save indicator.',
    );
  } else if (causes.has('conflict')) {
    parts.push('Answer the "changed by another program" prompt to save or drop that edit.');
  } else if ([...causes].some((c) => ANSWER_CAUSES.has(c))) {
    parts.push('Answer its question (Reload or keep yours) to save or drop that edit.');
  }
  if (preservedTmp > 0) {
    parts.push(
      `A failed write also left ${plural(preservedTmp, 'partial .tmp file', 'partial .tmp files')} in the vault that you can recover by hand.`,
    );
  }
  parts.push(QUIT_CHOICES);
  return parts.join('\n\n');
}

/**
 * What a Retry came to, for the toast after it (one paragraph: a toast shows
 * no line breaks). `items` are the changes that still failed after it,
 * `saved` how many it got onto disk. Each kind of failure says what happens
 * next: a board or note write is tried again
 * on every save and asked about before leaving; a theme or template save
 * (`componentKeys`) only by retrying again from here; a held decision
 * (`decisionKeys`) only once it is answered. Keys are case-folded vault paths.
 * `retryAgain` is true when another Retry could still help.
 */
export function retryResultText(
  items: readonly UnsavedItem[],
  saved: number,
  keys: { componentKeys?: ReadonlySet<string>; decisionKeys?: ReadonlySet<string> } = {},
): { text: string; type: 'success' | 'error'; retryAgain: boolean } {
  if (items.length === 0) {
    return {
      text: saved > 0 ? `Saved: ${plural(saved, 'change is', 'changes are')} on disk now.` : 'Everything is saved.',
      type: 'success',
      retryAgain: false,
    };
  }
  const isComponent = (i: UnsavedItem): boolean => keys.componentKeys?.has(vaultPath(i.path)) ?? false;
  const isDecision = (i: UnsavedItem): boolean =>
    (keys.decisionKeys?.has(vaultPath(i.path)) ?? false) || ANSWER_CAUSES.has(i.cause);
  const rest = items.filter((i) => !isDecision(i));
  const retriable = rest.filter((i) => i.cause === 'write-failed' || i.cause === 'pending');
  const groups: Array<[UnsavedItem[], (itThey: string) => string]> = [
    [
      retriable.filter((i) => !isComponent(i)),
      () => 'another program may be holding it. Filo tries again on every save, and asks before you close the vault or quit.',
    ],
    [
      retriable.filter(isComponent),
      () => 'a theme or template save is tried again only from here, so Retry again once the file is free.',
    ],
    [items.filter(isDecision), (itThey) => `waiting for your decision, saved once you answer (the save indicator lists ${itThey}).`],
    [rest.filter((i) => i.cause === 'missing'), () => 'the file no longer exists; its prompt offers to save the change as a new file or drop it.'],
    [rest.filter((i) => i.cause === 'non-utf8'), () => "it isn't UTF-8 text, so Filo won't overwrite it."],
  ];
  const sentences = groups
    .filter(([group]) => group.length > 0)
    .map(([group, why]) => `${quotedNames(group.map((i) => i.path))}: ${why(group.length === 1 ? 'it' : 'them')}`);
  return {
    text: `${saved > 0 ? `${plural(saved, 'change', 'changes')} saved. ` : ''}Still not saved: ${sentences.join(' ')}`,
    type: 'error',
    retryAgain: retriable.length > 0,
  };
}

/** Up to three names in quotes, then "and N more". */
function quotedNames(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map((p) => `"${p}"`).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
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
