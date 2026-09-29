/**
 * The words Replace All shows before it runs: what it would change (body
 * matches only, and in which notes), and why it won't run on a capped list.
 */

/** Replace All refuses a result list cut short at the match cap. */
export const TOO_MANY_TO_REPLACE = 'Too many matches to replace safely; narrow the search.';

const NAMED_FILES = 5;

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * The confirm's body for `count` body matches in `files`. Title matches
 * aren't counted, since Replace All leaves titles alone; `titleMatches` says
 * how many there are, so the number the panel showed still adds up.
 */
export function replaceAllConfirmBody(count: number, files: readonly string[], titleMatches: number): string {
  const shown = files.slice(0, NAMED_FILES).map((f) => `• ${f}`).join('\n');
  const more = files.length > NAMED_FILES ? `\n…and ${files.length - NAMED_FILES} more` : '';
  const titles = titleMatches > 0
    ? `\n\n${plural(titleMatches, 'match', 'matches')} in a title ${titleMatches === 1 ? "isn't" : "aren't"} replaced; rename those from the tile.`
    : '';
  return `Replace ${plural(count, 'match', 'matches')} in ${plural(files.length, 'note')}?\n\n${shown}${more}${titles}\n\nYou can undo it from the notification that follows.`;
}
