/**
 * Vault-wide Search store.
 *
 * Drives the Search panel: holds the query, derives matches from the
 * vault index + board cache, owns the current-match cursor, and exposes
 * Find / Find All / Replace / Replace All entry points.
 *
 * State is intentionally session-scoped — search is a transient UI mode.
 *
 * Reactive contract: components read `searchStore.matches` /
 * `searchStore.currentMatch` directly. Both are `$derived` of the parsed
 * query, the options, the board cache and the set of notes and their tags
 * (`listVersion`), so those re-run the search at once. A note's text,
 * title or fields changing (every autosave) re-runs it only after
 * `NOTE_REFRESH_MS` without another change, and only while the panel is
 * open with a query: a whole-vault search on each save made typing hitch.
 * A single Replace re-reads them at once (`showMatchAfterReplace`), since the
 * next Replace acts on the match the panel shows.
 */

import { untrack } from 'svelte';
import { parseQuery, isEmptyQuery, type ParsedQuery } from '../lib/search/queryParser';
import { runVaultSearch, MAX_MATCHES, type SearchMatch, type SearchOptions } from '../lib/search/runSearch';
import { onVaultSwap } from '../core/vaultLifecycle';
import { vaultIndexStore } from './vaultIndex.svelte';
import { vaultPath } from '../../shared/vaultPath';

/** A match single Replace just changed: where it was in the list, and what it became. */
export interface ReplacedMatch {
  match: SearchMatch;
  index: number;
  replacement: string;
}

/** How long notes must stay unchanged before an open search reads their text again. */
export const NOTE_REFRESH_MS = 400;

export type SearchMode = 'find' | 'replace';

let query = $state('');
let replaceText = $state('');
let mode = $state<SearchMode>('find');
let open = $state(false);
let currentIndex = $state(0);
// Match case / Whole word: apply to free text, not to a /regex/ (its own flags).
let matchCase = $state(false);
let wholeWord = $state(false);
// Pending "jump to this match" — surfaced to navigation listeners. Set by
// `searchStore.next()` / `previous()` / `jumpTo(index)`; cleared when the
// listener picks it up. Decoupled from `currentIndex` so a navigation
// consumer can subscribe via $effect without re-running on every index
// change unrelated to a jump (e.g. a result reorder after a vault edit
// would otherwise refire the navigation).
let pendingJump = $state<{ match: SearchMatch; tick: number } | null>(null);
let jumpTick = 0;
// Bumped once notes have settled after a change, so the search reads their
// text again (see NOTE_REFRESH_MS).
let noteTick = $state(0);
// The index version the last search read (a refresh with nothing new is skipped).
let searchedAt = -1;

/**
 * The parsed form of the current query. Empty queries return an "isEmpty"
 * marker so the panel can render a different state (e.g. show recent
 * searches instead of zero results).
 */
const parsedQuery = $derived(parseQuery(query));

/**
 * Result set + truncation flag. Recomputed when the query, the options, the
 * board cache or the set of notes changes, and once notes settle after an
 * edit (`noteTick`). Empty queries return an empty array so the panel can
 * short-circuit on `matches.length === 0`.
 */
const searchResult = $derived.by(() => {
  if (isEmptyQuery(parsedQuery)) {
    return { matches: [] as SearchMatch[], truncated: false };
  }
  void noteTick;
  // allow-global-index-version: read untracked, to skip a refresh that has nothing new
  searchedAt = untrack(() => vaultIndexStore.version);
  return runVaultSearch(parsedQuery, { matchCase, wholeWord });
});

// The note-change debounce. Watches every index change, but only while a
// search is showing, and each change only restarts a timer.
$effect.root(() => {
  $effect(() => {
    if (!open || isEmptyQuery(parsedQuery)) return;
    // allow-global-index-version: the search matches every note's text; this only restarts a timer
    const seen = vaultIndexStore.version;
    if (seen === searchedAt) return;
    const timer = setTimeout(() => {
      // The search may have run meanwhile (the panel opened, a tag changed).
      if (seen !== searchedAt) noteTick += 1;
    }, NOTE_REFRESH_MS);
    return () => clearTimeout(timer);
  });
});

/**
 * Clamps the current index against the latest match set so a vault edit
 * that shrinks the result count doesn't leave the cursor dangling past
 * the end. Components read this directly.
 */
const clampedIndex = $derived.by(() => {
  const len = searchResult.matches.length;
  if (len === 0) return 0;
  if (currentIndex >= len) return len - 1;
  if (currentIndex < 0) return 0;
  return currentIndex;
});

export const searchStore = {
  // ── Read-only reactive accessors ──
  get query() { return query; },
  get replaceText() { return replaceText; },
  get mode() { return mode; },
  get open() { return open; },
  get parsed(): ParsedQuery { return parsedQuery; },
  get matches(): SearchMatch[] { return searchResult.matches; },
  get truncated(): boolean { return searchResult.truncated; },
  get maxMatches(): number { return MAX_MATCHES; },
  get matchCase(): boolean { return matchCase; },
  get wholeWord(): boolean { return wholeWord; },
  /** The options the matches were found with (Replace re-runs the search with them). */
  get options(): SearchOptions { return { matchCase, wholeWord }; },
  get currentIndex() { return clampedIndex; },
  /**
   * The query run now, against every note as it stands: the shown matches
   * can trail an edit by `NOTE_REFRESH_MS`, so Replace works from this.
   */
  searchNow(): { matches: SearchMatch[]; truncated: boolean } {
    return isEmptyQuery(parsedQuery)
      ? { matches: [], truncated: false }
      : runVaultSearch(parsedQuery, { matchCase, wholeWord });
  },
  get currentMatch(): SearchMatch | null {
    const list = searchResult.matches;
    return list.length > 0 ? (list[clampedIndex] ?? null) : null;
  },
  /**
   * The most recent "jump to this match" request. Components watching this
   * via `$effect` should call `consumeJump()` once they've acted on it.
   */
  get pendingJump() { return pendingJump; },

  // ── Mutations ──
  setQuery(next: string) {
    if (next === query) return;
    query = next;
    // Reset the cursor to the head of the new result list, so the user isn't
    // left mid-way through the old one.
    currentIndex = 0;
  },
  setMatchCase(next: boolean) {
    matchCase = next;
    currentIndex = 0;
  },
  setWholeWord(next: boolean) {
    wholeWord = next;
    currentIndex = 0;
  },
  setReplaceText(next: string) {
    replaceText = next;
  },
  setMode(next: SearchMode) {
    mode = next;
  },
  openPanel(initialMode: SearchMode = 'find') {
    open = true;
    mode = initialMode;
  },
  closePanel() {
    open = false;
  },

  // ── Cycling ──
  next() {
    const len = searchResult.matches.length;
    if (len === 0) {
      pendingJump = null;
      return;
    }
    currentIndex = (clampedIndex + 1) % len;
    requestJump();
  },
  previous() {
    const len = searchResult.matches.length;
    if (len === 0) {
      pendingJump = null;
      return;
    }
    currentIndex = (clampedIndex - 1 + len) % len;
    requestJump();
  },
  jumpTo(index: number) {
    const len = searchResult.matches.length;
    if (len === 0) return;
    const clamped = Math.max(0, Math.min(len - 1, index));
    currentIndex = clamped;
    requestJump();
  },
  consumeJump() {
    pendingJump = null;
  },

  /** Reads every note's text again now, rather than once edits pause. */
  refreshNow() {
    noteTick += 1;
  },

  /**
   * After single Replace: the list is read again at once, then the match
   * after the replaced one is shown. Moving on in the list as it stands
   * would show one match while the refresh, a moment later, makes the next
   * Replace act on another. The replaced match has left the list, so its
   * index now holds the match after it; a match that starts inside the
   * replacement (`foo` replaced by `foobar`) is passed over, as an editor's
   * Replace does.
   */
  showMatchAfterReplace(replaced: ReplacedMatch) {
    noteTick += 1;
    const list = searchResult.matches;
    if (list.length === 0) {
      currentIndex = 0;
      pendingJump = null;
      return;
    }
    const file = replaced.match.filePath === null ? null : vaultPath(replaced.match.filePath);
    const end = replaced.match.matchStart + replaced.replacement.length;
    let i = replaced.index;
    while (i < list.length) {
      const m = list[i]!;
      const inReplacement = m.matchKind === 'body'
        && m.filePath !== null
        && vaultPath(m.filePath) === file
        && m.matchStart < end;
      if (!inReplacement) break;
      i++;
    }
    currentIndex = i < list.length ? i : 0;
    requestJump();
  },

  /**
   * Drops every transient piece of state so the panel reopens against
   * a fresh slate. Called by the vault-swap reset and by the panel's
   * "Clear" button.
   */
  reset() {
    query = '';
    replaceText = '';
    matchCase = false;
    wholeWord = false;
    currentIndex = 0;
    pendingJump = null;
    open = false;
    mode = 'find';
  },
};

function requestJump(): void {
  const match = searchStore.currentMatch;
  if (!match) {
    pendingJump = null;
    return;
  }
  jumpTick++;
  pendingJump = { match, tick: jumpTick };
}

// Vault-swap reset: drops the entire search session — the outgoing query
// refers to paths that won't resolve under the new vault's index.
onVaultSwap('pre-swap', 'searchStore', () => {
  searchStore.reset();
});
