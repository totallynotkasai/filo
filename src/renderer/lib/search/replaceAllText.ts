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

/** What Replace leaves alone inside a note, in the user's words. */
export const SYNTAX_KINDS = 'list markers, rules, table lines, link addresses and HTML tags';

/** The toast when every body match is in Markdown syntax. */
export const ONLY_SYNTAX_MATCHES = `Every match is part of the notes' Markdown formatting (${SYNTAX_KINDS}); Replace All leaves those alone.`;

/**
 * The confirm's body for `count` body matches in `files`. Title matches
 * aren't counted, since Replace All leaves titles alone; `titleMatches` says
 * how many there are, and `inSyntax` how many body matches sit in Markdown
 * syntax and are left alone too, so the number the panel showed still adds up.
 */
export function replaceAllConfirmBody(count: number, files: readonly string[], titleMatches: number, inSyntax = 0): string {
  const shown = files.slice(0, NAMED_FILES).map((f) => `• ${f}`).join('\n');
  const more = files.length > NAMED_FILES ? `\n…and ${files.length - NAMED_FILES} more` : '';
  const titles = titleMatches > 0
    ? `\n\n${plural(titleMatches, 'match', 'matches')} in a title ${titleMatches === 1 ? "isn't" : "aren't"} replaced; rename those from the tile.`
    : '';
  const syntax = inSyntax > 0
    ? `\n\n${plural(inSyntax, 'match', 'matches')} inside Markdown formatting (${SYNTAX_KINDS}) ${inSyntax === 1 ? 'is' : 'are'} left alone.`
    : '';
  return `Replace ${plural(count, 'match', 'matches')} in ${plural(files.length, 'note')}?\n\n${shown}${more}${titles}${syntax}\n\nYou can undo it from the notification that follows.`;
}
