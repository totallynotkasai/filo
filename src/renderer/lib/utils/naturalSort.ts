/**
 * The one order for names a person reads: the sidebar, and the Task List and
 * Kanban title sorts. Digits compare as numbers, so "Chapter 2" comes before
 * "Chapter 10", as in File Explorer; case and accents don't order names
 * ("apple" beside "Apple"). Names equal by that measure fall back to their
 * characters, so the order never depends on the order the names arrived in.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}
