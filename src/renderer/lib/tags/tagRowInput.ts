/**
 * Parsing for the tag row at the top of a note: the user types tags
 * separated by commas, and each one is matched against the tags the vault
 * already has.
 */
import { isSafeNewTagName } from '../vault/tagsStorage';

export interface ParsedTagInput {
  /** Tags to add, in the casing the vault already uses where it has one. */
  tags: string[];
  /** Entries that aren't usable tag names, as typed. */
  invalid: string[];
}

/** Case-folds for tag identity, pinned to en-US so a Turkish host doesn't split `I`/`i`. */
function fold(name: string): string {
  return name.toLocaleLowerCase('en-US');
}

/**
 * Splits `text` on commas and resolves each entry. A leading `#` is
 * dropped. An entry that matches a known tag ignoring case takes that tag's
 * casing (so `Project` and `project` never become two tags); a new name must
 * pass the same check as the Tags browser. Duplicates collapse to one.
 */
export function parseTagInput(text: string, known: readonly string[]): ParsedTagInput {
  const byFold = new Map<string, string>();
  for (const name of known) byFold.set(fold(name), name);
  const tags: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(',')) {
    const entry = raw.trim().replace(/^#/, '');
    if (!entry) continue;
    const existing = byFold.get(fold(entry));
    const name = existing ?? (isSafeNewTagName(entry) ? entry : null);
    if (name === null) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(fold(name))) continue;
    seen.add(fold(name));
    tags.push(name);
  }
  return { tags, invalid };
}

/** `current` with each of `added` appended unless it's already there (ignoring case). */
export function withTagsAdded(current: readonly string[], added: readonly string[]): string[] {
  const have = new Set(current.map(fold));
  const next = [...current];
  for (const name of added) {
    if (have.has(fold(name))) continue;
    have.add(fold(name));
    next.push(name);
  }
  return next;
}

/**
 * Known tags offered for the entry being typed (the text after the last
 * comma): those containing it, ignoring case, minus tags already on the note.
 */
export function tagSuggestions(
  text: string,
  known: readonly string[],
  applied: readonly string[],
  limit = 8,
): string[] {
  const query = fold((text.split(',').pop() ?? '').trim().replace(/^#/, ''));
  if (!query) return [];
  const skip = new Set(applied.map(fold));
  const out: string[] = [];
  for (const name of known) {
    const folded = fold(name);
    if (skip.has(folded) || !folded.includes(query)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/** `text` with its last entry replaced by `name`, ready for the next entry. */
export function completeLastEntry(text: string, name: string): string {
  const cut = text.lastIndexOf(',');
  const head = cut >= 0 ? `${text.slice(0, cut + 1)} ` : '';
  return `${head}${name}, `;
}
