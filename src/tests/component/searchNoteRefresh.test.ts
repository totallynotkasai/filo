/**
 * The Search panel's results follow note edits on a short debounce, not on
 * every autosave: a whole-vault search on each save made typing hitch with
 * the panel open at 5,000 notes. The query, the options and the set of notes
 * (a note added, a tag changed) still re-run it at once.
 *
 * A component test: the Search panel reads the matches in its template, and
 * only the browser build of Svelte runs the effects that keeps alive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { searchStore, NOTE_REFRESH_MS } from '@renderer/stores/search.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { probeDerived, type DerivedProbe } from '../helpers/derivedProbe.svelte';

function note(path: string, text: string): void {
  vaultIndexStore.restoreMetadata(path, parseMarkdown(path, text));
}

describe('Search panel: note edits refresh on a debounce', () => {
  let shown: DerivedProbe<string[]> | null = null;

  function showPanel(query: string): DerivedProbe<string[]> {
    searchStore.openPanel();
    searchStore.setQuery(query);
    shown = probeDerived(() => searchStore.matches.map((m) => m.filePath ?? ''));
    return shown;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
    Object.defineProperty(vaultStore, 'project', { configurable: true, get: () => ({ id: 'p', name: 'V', boards: [] }) });
    vaultIndexStore.clear();
    boardCacheStore.clear();
    searchStore.reset();
    flushSync();
  });
  afterEach(() => {
    shown?.stop();
    shown = null;
    searchStore.reset();
    flushSync();
    vi.useRealTimers();
    delete (vaultStore as unknown as Record<string, unknown>).project;
  });

  it('a body edit re-runs the search only once edits pause', () => {
    note('a.md', 'frodo');
    note('b.md', 'nothing yet');
    const panel = showPanel('frodo');
    expect(panel.value()).toEqual(['a.md']);
    const runs = panel.runs();

    // Three autosaves of b.md, 100 ms apart: none re-runs the search.
    for (const text of ['f', 'fro', 'frodo too']) {
      note('b.md', text);
      vi.advanceTimersByTime(100);
      expect(panel.value()).toEqual(['a.md']);
    }
    expect(panel.runs()).toBe(runs);

    vi.advanceTimersByTime(NOTE_REFRESH_MS);
    expect(panel.value()).toEqual(['a.md', 'b.md']);
    expect(panel.runs()).toBe(runs + 1);

    // Settled, with nothing new: no further run.
    vi.advanceTimersByTime(NOTE_REFRESH_MS * 3);
    expect(panel.runs()).toBe(runs + 1);
  });

  it('a new note or a query change re-runs at once', () => {
    note('a.md', 'frodo');
    const panel = showPanel('frodo');
    expect(panel.value()).toEqual(['a.md']);

    note('c.md', 'frodo again');
    expect(panel.value()).toEqual(['a.md', 'c.md']);

    searchStore.setQuery('again');
    expect(panel.value()).toEqual(['c.md']);
  });

  it('with the panel closed, an edit starts no refresh', () => {
    note('a.md', 'frodo');
    const panel = showPanel('frodo');
    expect(panel.value()).toEqual(['a.md']);
    searchStore.closePanel();
    flushSync();
    const runs = panel.runs();

    note('a.md', 'frodo edited');
    vi.advanceTimersByTime(NOTE_REFRESH_MS * 3);
    expect(panel.runs()).toBe(runs);
  });
});
