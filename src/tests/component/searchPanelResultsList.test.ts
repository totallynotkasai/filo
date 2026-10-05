/**
 * The Search panel lists the notes that match under its box, grouped by
 * note, with each match's words around it: the count alone ("1 / 23") said
 * nothing about where. A click on a match shows it, as Next does; a note's
 * first matches show, and "N more" opens the rest.
 *
 * The real panel and search over an in-memory vault index (notes on no
 * board, which Find opens as documents).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SearchPanel from '@renderer/components/search/SearchPanel.svelte';
import { searchStore } from '@renderer/stores/search.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { openNoteInDocumentTab } from '@renderer/lib/notes/openNote';

vi.mock('@renderer/lib/notes/openNote', () => ({ openNoteInDocumentTab: vi.fn() }));

let instance: ReturnType<typeof mount> | null = null;

function seed(notes: Record<string, string>): void {
  for (const [path, text] of Object.entries(notes)) vaultIndexStore.restoreMetadata(path, parseMarkdown(path, text));
}

function openPanel(query: string): void {
  searchStore.openPanel('find');
  searchStore.setQuery(query);
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(SearchPanel, { target });
  flushSync();
}

function groupsShown(): Array<{ title: string; where: string; count: string; rows: string[] }> {
  return [...document.querySelectorAll('.search-panel .result-group')].map((g) => ({
    title: g.querySelector('.group-title')?.textContent?.trim() ?? '',
    where: g.querySelector('.group-where')?.textContent?.trim() ?? '',
    count: g.querySelector('.group-count')?.textContent?.trim() ?? '',
    rows: [...g.querySelectorAll('.result-row .row-snippet')].map((r) => (r.textContent ?? '').trim()),
  }));
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
  Object.defineProperty(vaultStore, 'project', { configurable: true, get: () => ({ id: 'p', name: 'V', boards: [] }) });
  vaultIndexStore.clear();
  boardCacheStore.clear();
  searchStore.reset();
  vi.mocked(openNoteInDocumentTab).mockClear();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  searchStore.reset();
  vaultIndexStore.clear();
  document.body.innerHTML = '';
});

describe('Search panel: the matches, grouped by note, under the box', () => {
  it('names each matching note, where it is, how many matches it has, and the words around each', () => {
    seed({
      'Siege.md': '---\ntitle: The Siege\n---\nThe walls held. The river rose by the walls.\n',
      'Notes/Map.md': '---\ntitle: Map\n---\nNorth of the walls is the forest.\n',
      'Other.md': '---\ntitle: Other\n---\nNothing here.\n',
    });
    openPanel('walls');
    expect(document.querySelector('.results-summary')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('3 matches in 2 notes');
    const groups = groupsShown();
    expect(groups.map((g) => [g.title, g.where, g.count])).toEqual([
      ['Map', 'On no board', '1'],
      ['The Siege', 'On no board', '2'],
    ]);
    expect(groups[1]!.rows[0]).toContain('The walls held.');
    expect(document.querySelector('.result-row mark')?.textContent).toBe('walls');
  });

  it('a click on a match shows it, and marks it as the current one', () => {
    seed({ 'Siege.md': '---\ntitle: The Siege\n---\nwalls one, walls two\n' });
    openPanel('walls');
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.result-row')];
    rows[1]!.click();
    flushSync();
    expect(searchStore.currentIndex).toBe(1);
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
    expect(openNoteInDocumentTab).toHaveBeenCalledWith('Siege.md');
    // One Tab stop: the current match's row.
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0]);
  });

  it("shows a note's first three matches, and \"N more\" opens the rest", () => {
    seed({ 'Long.md': '---\ntitle: Long\n---\n' + Array.from({ length: 7 }, (_, i) => `line ${i} has the word`).join('\n') + '\n' });
    openPanel('word');
    expect(groupsShown()[0]!.rows).toHaveLength(3);
    const more = document.querySelector<HTMLButtonElement>('.more-btn')!;
    expect(more.textContent?.trim()).toBe('4 more in this note');
    more.click();
    flushSync();
    expect(groupsShown()[0]!.rows).toHaveLength(7);
    expect(document.querySelector('.more-btn')).toBeNull();
  });

  it('shows no list with no matches', () => {
    seed({ 'A.md': 'alpha\n' });
    openPanel('zebra');
    expect(document.querySelector('.search-panel .results')).toBeNull();
  });
});
