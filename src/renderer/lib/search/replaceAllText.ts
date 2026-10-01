/**
 * The words Replace All shows before it runs: what it would change (body
 * matches only, and in which notes), and why it won't run on a capped list.
 */

import type { ParsedQuery } from './queryParser';

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
 * Every space as a no-break space: the dialog collapses a run of ordinary
 * ones, so a double space would read as one.
 */
function keepSpaces(text: string): string {
  return text.replace(/ /g, String.fromCharCode(0xa0));
}

/** `text` in quotes, every space kept; text that is only spaces says how many. */
function quoted(text: string): string {
  const q = `"${keepSpaces(text)}"`;
  return /^ +$/.test(text) ? `${q} (${plural(text.length, 'space')})` : q;
}

/**
 * The search as the confirm names it: a `/regex/` as typed, otherwise the
 * text it finds in quotes, so a stray or missing space shows before anything
 * is changed.
 */
export function searchedText(query: ParsedQuery): string {
  return query.regex ? keepSpaces(query.raw.trim()) : quoted(query.freeText);
}

/** What Replace All is about to do, for its confirm. */
export interface ReplaceAllPreview {
  /** The search, from `searchedText`. */
  find: string;
  /** The replacement as typed. */
  replace: string;
  /** Body matches it would change. */
  count: number;
  /** The notes they are in. */
  files: readonly string[];
  /** Title matches, which it leaves alone. */
  titleMatches: number;
  /** Body matches in Markdown syntax, which it leaves alone too. */
  inSyntax?: number;
}

/**
 * The confirm's body. Title matches aren't counted, since Replace All leaves
 * titles alone; `titleMatches` says how many there are, and `inSyntax` how
 * many body matches sit in Markdown syntax and are left alone too, so the
 * number the panel showed still adds up.
 */
export function replaceAllConfirmBody(p: ReplaceAllPreview): string {
  const { count, files, titleMatches } = p;
  const inSyntax = p.inSyntax ?? 0;
  const replaceWith = p.replace === '' ? 'nothing' : quoted(p.replace);
  const list = files.slice(0, NAMED_FILES).map((f) => `• ${f}`).join('\n');
  const more = files.length > NAMED_FILES ? `\n…and ${files.length - NAMED_FILES} more` : '';
  const titles = titleMatches > 0
    ? `\n\n${plural(titleMatches, 'match', 'matches')} in a title ${titleMatches === 1 ? "isn't" : "aren't"} replaced; rename those from the tile.`
    : '';
  const syntax = inSyntax > 0
    ? `\n\n${plural(inSyntax, 'match', 'matches')} inside Markdown formatting (${SYNTAX_KINDS}) ${inSyntax === 1 ? 'is' : 'are'} left alone.`
    : '';
  return `Replace ${p.find} with ${replaceWith} (${plural(count, 'match', 'matches')} in ${plural(files.length, 'note')})?\n\n${list}${more}${titles}${syntax}\n\nYou can undo it from the notification that follows.`;
}
