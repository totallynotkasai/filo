/**
 * Parsing for the tag row at the top of a note: the user types tags
 * separated by commas, and each one is matched against the tags the vault
 * already has.
 */
import { cleanTagName, isSafeNewTagName } from '../vault/tagsStorage';

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
 * Splits `text` on commas and resolves each entry, so a tag may hold
 * spaces (`Book 1`). A leading `#` is dropped. An entry that matches a known tag ignoring case takes that tag's
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
    const entry = cleanTagName(raw);
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

/** The entry being typed: the text after the last comma, without a leading `#`. */
function lastEntry(text: string): string {
  return fold((text.split(',').pop() ?? '').trim().replace(/^#/, ''));
}

/**
 * Known tags offered for the entry being typed (the text after the last
 * comma), minus tags already applied, ignoring case: the tag it names
 * exactly first, then tags starting with it, then tags containing it.
 */
export function tagSuggestions(
  text: string,
  known: readonly string[],
  applied: readonly string[],
  limit = 8,
): string[] {
  const query = lastEntry(text);
  if (!query) return [];
  const skip = new Set(applied.map(fold));
  const ranked: Array<{ name: string; rank: number; order: number }> = [];
  known.forEach((name, order) => {
    const folded = fold(name);
    if (skip.has(folded) || !folded.includes(query)) return;
    const rank = folded === query ? 0 : folded.startsWith(query) ? 1 : 2;
    ranked.push({ name, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, limit).map((r) => r.name);
}

/**
 * Which suggestion Enter takes before the user picks one: the first, only
 * when it is exactly the typed entry (ignoring case). Otherwise -1, so Enter
 * adds exactly what was typed (`urgent` never becomes `not-urgent`) and
 * ArrowDown picks a suggestion.
 */
export function preselectedSuggestion(text: string, suggestions: readonly string[]): number {
  const first = suggestions[0];
  return first !== undefined && fold(first) === lastEntry(text) ? 0 : -1;
}

/** `text` with its last entry replaced by `name`, ready for the next entry. */
export function completeLastEntry(text: string, name: string): string {
  const cut = text.lastIndexOf(',');
  const head = cut >= 0 ? `${text.slice(0, cut + 1)} ` : '';
  return `${head}${name}, `;
}
