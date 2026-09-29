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
 * query and the underlying vault state, so any edit to the vault index or
 * board cache automatically refreshes the result set. The store does NOT
 * own its own re-run timer.
 */

import { parseQuery, isEmptyQuery, type ParsedQuery } from '../lib/search/queryParser';
import { runVaultSearch, MAX_MATCHES, type SearchMatch, type SearchOptions } from '../lib/search/runSearch';
import { onVaultSwap } from '../core/vaultLifecycle';

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

/**
 * The parsed form of the current query. Empty queries return an "isEmpty"
 * marker so the panel can render a different state (e.g. show recent
 * searches instead of zero results).
 */
const parsedQuery = $derived(parseQuery(query));

/**
 * Result set + truncation flag. Recomputed whenever the parsed query
 * changes OR the vault index / board cache changes. Empty queries return
 * an empty array so the panel can short-circuit on `matches.length === 0`.
 */
const searchResult = $derived.by(() => {
  if (isEmptyQuery(parsedQuery)) {
    return { matches: [] as SearchMatch[], truncated: false };
  }
  return runVaultSearch(parsedQuery, { matchCase, wholeWord });
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
  togglePanel(initialMode: SearchMode = 'find') {
    if (open) {
      open = false;
    } else {
      open = true;
      mode = initialMode;
    }
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
