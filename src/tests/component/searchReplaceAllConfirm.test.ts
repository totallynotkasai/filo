/**
 * The Search panel's Replace All says what it will change before it runs:
 * the body matches (a title match isn't replaced, so it isn't counted as one)
 * and the notes they are in. On a result list cut short at the cap it doesn't
 * run at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SearchPanel from '@renderer/components/search/SearchPanel.svelte';
import { searchStore } from '@renderer/stores/search.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';

let instance: ReturnType<typeof mount> | null = null;

function board(defs: Record<string, unknown>): BoardFileData {
  return {
    version: 8,
    board: { id: 'mm', name: 'Board', type: 'mindmap', placements: {}, inlineTiles: {}, waypoints: [], settings: {}, createdAt: 0, updatedAt: 0 },
    tileDefs: defs,
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

function textDef(id: string, filePath: string): Record<string, unknown> {
  return { id, type: 'text', style: { headerColor: '', bodyColor: '' }, filePath, createdAt: 0, updatedAt: 0 };
}

function replaceAllButton(): HTMLButtonElement {
  const b = [...document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((x) => x.textContent?.trim() === 'Replace All');
  if (!b) throw new Error('no Replace All button');
  return b;
}

describe('Search panel: Replace All', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
    vaultIndexStore.clear();
    boardCacheStore.clear();
    // A.md's title "The Dragon" is a title match.
    vaultIndexStore.restoreMetadata('A.md', parseMarkdown('A.md', '---\ntitle: The Dragon\n---\nA dragon and a Dragon.'));
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', 'One dragon.'));
    boardCacheStore.hydrate({ mm: board({ t1: textDef('t1', 'A.md'), t2: textDef('t2', 'b.md') }) }, { mm: 'Board.board.json' });
    searchStore.reset();
    searchStore.openPanel('replace');
    searchStore.setQuery('dragon');
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(SearchPanel, { target });
    flushSync();
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    uiStore.closeConfirm();
    searchStore.reset();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    document.body.innerHTML = '';
  });

  it('the confirm counts body matches only and names the notes', () => {
    expect(searchStore.matches).toHaveLength(4);
    searchStore.setReplaceText('wyvern');
    replaceAllButton().click();
    flushSync();
    const cfg = uiStore.confirmDialog;
    expect(cfg?.body).toMatch(/^Replace "dragon" with "wyvern" \(3 matches in 2 notes\)\?\n\n• (?:A\.md\n• b\.md|b\.md\n• A\.md)\n\n1 match in a title isn't replaced/);
  });

  it('a spaced hyphen is searched with its spaces, and the confirm shows them', () => {
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', 'A well-known dragon - and a well-read one.'));
    searchStore.setQuery(' - ');
    searchStore.setReplaceText(' – ');
    flushSync();
    expect(searchStore.matches.map((m) => m.matchText)).toEqual([' - ']);
    replaceAllButton().click();
    flushSync();
    const nbsp = String.fromCharCode(0xa0);
    expect(uiStore.confirmDialog?.body).toMatch(new RegExp(`^Replace "${nbsp}-${nbsp}" with "${nbsp}–${nbsp}" \\(1 match in 1 note\\)\\?\\n\\n• b\\.md\\n`));
  });

  it('Match case narrows the matches the panel shows', () => {
    const matchCase = [...document.querySelectorAll<HTMLLabelElement>('.search-panel label.option')]
      .find((l) => l.textContent?.includes('Match case'))!.querySelector('input')!;
    matchCase.click();
    flushSync();
    // The title and one body match have a capital D.
    expect(searchStore.matches.map((m) => m.matchText)).toEqual(['dragon', 'dragon']);
  });
});
