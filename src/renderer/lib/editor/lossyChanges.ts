import { lineOfRoundTripChange, parseMarkdownFile, type RoundTripChange } from './markdownSync';

/**
 * Words for a read-only note: which of its lines a save from the editor
 * would change. The Document tab's banner names the first; Take ownership's
 * confirm lists them all (at most three), so the choice is made knowing
 * what it costs; and "Edit in Raw view" opens the file at the first.
 */

export interface LocatedChange extends RoundTripChange {
  /**
   * The line in the whole file, as the Raw view shows it: the changed or
   * dropped line, or for an added one the line it would go above. 0 when it
   * can't be found.
   */
  line: number;
}

/** Each change with the line it is on in `rawText` (the whole file). */
export function locateChanges(rawText: string, changes: readonly RoundTripChange[]): LocatedChange[] {
  const body = parseMarkdownFile(rawText).body;
  let from = rawText.endsWith(body) ? rawText.slice(0, rawText.length - body.length).split(/\r?\n/).length : 1;
  return changes.map((change) => {
    const added = isAddition(change);
    const line = lineOfRoundTripChange(rawText, added ? (change.above ?? '') : change.original, from);
    // An added line leaves the line it goes above for the next change to name.
    if (line) from = added ? line : line + 1;
    return { ...change, line };
  });
}

/** A line saving would add (a dropped blank line has neither text nor a place above). */
function isAddition(change: RoundTripChange): boolean {
  return !change.original && (change.filo !== '' || change.above !== undefined);
}

const SHOWN_CHARS = 60;

function quoted(text: string): string {
  return `“${text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS - 1)}…` : text}”`;
}

/** One change in words, e.g. `Line 12 would change from “- [ ]” to “- \[ \]”`. */
export function describeChange(change: LocatedChange): string {
  const where = change.line ? `Line ${change.line}` : 'A line';
  if (isAddition(change)) {
    const what = change.filo ? quoted(change.filo) : 'a blank line';
    return change.line ? `Saving would add ${what} above line ${change.line}` : `Saving would add ${what}`;
  }
  if (!change.original) return 'A blank line would be dropped';
  if (!change.filo) return `${where} (${quoted(change.original)}) would be dropped`;
  return `${where} would change from ${quoted(change.original)} to ${quoted(change.filo)}`;
}
