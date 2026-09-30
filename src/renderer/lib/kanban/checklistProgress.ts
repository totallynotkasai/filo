/**
 * A card's checklist progress: its note's task items (`- [ ]`, `- [x]`), as
 * the editor reads them. A `[x]` anywhere else (a link text, inline code, a
 * fenced code block, mid-line) is text, not an item, and isn't counted.
 */

/** A list item opening with a checkbox, inside any number of quotes. */
const TASK_ITEM = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;
const FENCE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/;

export interface ChecklistProgress {
  checked: number;
  total: number;
}

/** The note's checked and total task items, or null when it has none. */
export function checklistProgress(body: string): ChecklistProgress | null {
  let checked = 0;
  let total = 0;
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line)?.[1];
    if (fence !== null) {
      // A fence closes on a run of its own character at least as long.
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    const mark = TASK_ITEM.exec(line)?.[1];
    if (mark === undefined) continue;
    total++;
    if (mark !== ' ') checked++;
  }
  return total === 0 ? null : { checked, total };
}
