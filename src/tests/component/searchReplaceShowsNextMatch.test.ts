/**
 * Single Replace in the Search panel: after a Replace, the match the panel
 * jumps to and counts is the one the next Replace changes, and stays so once
 * the results refresh. Moving on in the list as it stands before the refresh
 * would show one note while the next Replace changes another, unseen.
 *
 * A component test: the real panel, the real Replace command and note writer,
 * over an in-memory set of files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SearchPanel from '@renderer/components/search/SearchPanel.svelte';
import { searchStore, NOTE_REFRESH_MS } from '@renderer/stores/search.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { navigateToTile } from '@renderer/lib/utils/navigation.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';

vi.mock('@renderer/lib/utils/navigation.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/utils/navigation.svelte')>()),
  navigateToTile: vi.fn(),
}));

const VAULT = '/test/vault';
let files: Record<string, string> = {};
let instance: ReturnType<typeof mount> | null = null;

function installFilo(): void {
  const mtimes: Record<string, number> = {};
  const stat = (p: string): { mtimeMs: number; size: number } => ({
    mtimeMs: mtimes[p] ?? 1,
    size: new TextEncoder().encode(files[p] ?? '').length,
  });
  const routes: Record<string, (rel: string, content?: string) => unknown> = {
    'vault:read-file-text': (rel) => files[rel] === undefined
      ? { success: false, error: 'ENOENT', code: 'ENOENT' }
      : { success: true, content: files[rel], ...stat(rel) },
    'vault:write-existing-file-text': (rel, content) => {
      files[rel] = String(content);
      mtimes[rel] = (mtimes[rel] ?? 1) + 1;
      return { success: true };
    },
    'vault:stat': (rel) => files[rel] === undefined
      ? { success: false, error: 'ENOENT', code: 'ENOENT' }
      : { success: true, ...stat(rel) },
    // This machine's crash-recovery sentinel, not a note.
    'vault:write-file-text': () => ({ success: true }),
    'vault:delete': () => ({ success: true }),
  };
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, _root: unknown, rel: unknown, content?: unknown) => {
      const route = routes[channel];
      return route ? route(String(rel), content === undefined ? undefined : String(content)) : { success: false, error: channel, code: 'EUNKNOWN' };
    },
    on: () => () => {},
    send: () => {},
  };
}

function textDef(id: string, filePath: string): Record<string, unknown> {
  return { id, type: 'text', style: { headerColor: '', bodyColor: '' }, filePath, createdAt: 0, updatedAt: 0 };
}

/** Notes a.md, b.md, c.md on one board, as tiles ta, tb, tc (in that order). */
function seed(contents: Record<string, string>): void {
  files = { ...contents };
  const defs: Record<string, unknown> = {};
  for (const [path, text] of Object.entries(contents)) {
    vaultIndexStore.restoreMetadata(path, parseMarkdown(path, text));
    defs[`t${path[0]}`] = textDef(`t${path[0]}`, path);
  }
  const board = {
    version: 8,
    board: { id: 'mm', name: 'Board', type: 'mindmap', placements: {}, inlineTiles: {}, waypoints: [], settings: {}, createdAt: 0, updatedAt: 0 },
    tileDefs: defs,
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
  boardCacheStore.hydrate({ mm: board }, { mm: 'Board.board.json' });
}

function openPanel(query: string, replacement: string): void {
  searchStore.openPanel('replace');
  searchStore.setQuery(query);
  searchStore.setReplaceText(replacement);
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(SearchPanel, { target });
  flushSync();
}

function clickReplace(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Replace actions"] button')]
    .find((b) => b.textContent?.trim() === 'Replace');
  if (!button) throw new Error('no Replace button');
  button.click();
}

function counter(): string {
  return (document.querySelector('.result-count')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The tile ids the panel jumped to, in order. */
function jumps(): string[] {
  return vi.mocked(navigateToTile).mock.calls.map((call) => String(call[1]));
}

function current(): string {
  const m = searchStore.currentMatch;
  return m ? `${m.filePath}@${m.matchStart}` : '';
}

function warnings(): string[] {
  return uiStore.toasts.filter((t) => t.type === 'warning' || t.type === 'error').map((t) => t.text);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  installFilo();
  Object.defineProperty(vaultStore, 'path', { configurable: true, get: () => VAULT });
  Object.defineProperty(vaultStore, 'project', { configurable: true, get: () => ({ id: 'p', name: 'V', boards: [{ id: 'mm', name: 'Board' }] }) });
  vaultIndexStore.clear();
  boardCacheStore.clear();
  historyStore.clear();
  searchStore.reset();
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration(VAULT);
  setActiveVaultPath(VAULT);
  noteStore.__resetForTests();
  historyStore.setActiveBoard('mm');
  vi.mocked(navigateToTile).mockClear();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  searchStore.reset();
  flushSync();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  noteStore.__resetForTests();
  setActiveVaultPath('');
  boardCacheStore.clear();
  vaultIndexStore.clear();
  delete (vaultStore as unknown as Record<string, unknown>).path;
  delete (vaultStore as unknown as Record<string, unknown>).project;
  document.body.innerHTML = '';
});

describe('Search panel: single Replace shows the match it will change next', () => {
  it('after replacing A it shows B, still B once the results refresh, and the next Replace changes B', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'sam');
    expect(counter()).toBe('1 / 3');

    clickReplace();
    await vi.waitFor(() => expect(jumps()).toEqual(['tb']));
    expect(files['a.md']).toBe('sam');
    expect(current()).toBe('b.md@0');
    expect(counter()).toBe('1 / 2');

    await pause(NOTE_REFRESH_MS + 100);
    flushSync();
    expect(current()).toBe('b.md@0');
    expect(counter()).toBe('1 / 2');

    clickReplace();
    await vi.waitFor(() => expect(files['b.md']).toBe('sam'));
    expect(files['c.md']).toBe('frodo');
    expect(warnings()).toEqual([]);
  });

  it('two Replace clicks 100 ms apart change A, then B, with no "match moved" warning', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'sam');

    clickReplace();
    await pause(100);
    clickReplace();
    await vi.waitFor(() => expect(files['b.md']).toBe('sam'));
    expect(files['a.md']).toBe('sam');
    expect(files['c.md']).toBe('frodo');
    expect(warnings()).toEqual([]);
    await vi.waitFor(() => expect(jumps()).toEqual(['tb', 'tc']));
  });

  it('two Replace clicks at once still change A, then B', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'sam');

    clickReplace();
    clickReplace();
    await vi.waitFor(() => expect(jumps()).toEqual(['tb', 'tc']));
    expect(files).toEqual({ 'a.md': 'sam', 'b.md': 'sam', 'c.md': 'frodo' });
    expect(warnings()).toEqual([]);
  });

  it('a second match in the same note is the next one shown and changed', async () => {
    seed({ 'a.md': 'frodo and frodo', 'b.md': 'frodo' });
    openPanel('frodo', 'sam');

    clickReplace();
    await vi.waitFor(() => expect(jumps()).toEqual(['ta']));
    expect(current()).toBe('a.md@8');
    await pause(NOTE_REFRESH_MS + 100);
    flushSync();
    expect(current()).toBe('a.md@8');
    expect(counter()).toBe('1 / 2');

    clickReplace();
    await vi.waitFor(() => expect(files['a.md']).toBe('sam and sam'));
    expect(files['b.md']).toBe('frodo');
  });

  it('a replacement that holds the search text moves on past it', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'frodo baggins');

    clickReplace();
    await vi.waitFor(() => expect(jumps()).toEqual(['tb']));
    expect(files['a.md']).toBe('frodo baggins');
    expect(current()).toBe('b.md@0');
    expect(counter()).toBe('2 / 3');

    clickReplace();
    await vi.waitFor(() => expect(files['b.md']).toBe('frodo baggins'));
    expect(files['c.md']).toBe('frodo');
  });

  // The note changes between Replace's read and its write, so the write is
  // skipped. The panel used to move on to the next note as if it had been
  // replaced, and left an undo step that had changed nothing.
  it('a Replace skipped because the note changed stays on that match, leaves no undo step, and the next Replace changes it', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'sam');
    const filo = (window as unknown as { filo: { invoke: (...args: unknown[]) => Promise<unknown> } }).filo;
    const invoke = filo.invoke;
    let reads = 0;
    filo.invoke = async (channel: unknown, root: unknown, rel: unknown, content?: unknown) => {
      const result = await invoke(channel, root, rel, content);
      // Another program edits a.md right after Replace has read it (after the match).
      if (channel === 'vault:read-file-text' && rel === 'a.md' && ++reads === 1) {
        files['a.md'] = 'frodo, edited';
        vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', 'frodo, edited'));
      }
      return result;
    };

    clickReplace();
    await vi.waitFor(() => expect(warnings().some((w) => w.startsWith('Replace skipped 1 note'))).toBe(true));
    await pause(50);
    flushSync();
    expect(files['a.md']).toBe('frodo, edited');
    expect(jumps()).toEqual([]);
    expect(historyStore.canUndo).toBe(false);
    expect(current()).toBe('a.md@0');
    expect(counter()).toBe('1 / 3');

    clickReplace();
    await vi.waitFor(() => expect(files['a.md']).toBe('sam, edited'));
    expect(files['b.md']).toBe('frodo');
  });

  it('replacing the last match goes back to the first', async () => {
    seed({ 'a.md': 'frodo', 'b.md': 'frodo', 'c.md': 'frodo' });
    openPanel('frodo', 'sam');
    searchStore.jumpTo(2);
    flushSync();
    vi.mocked(navigateToTile).mockClear();

    clickReplace();
    await vi.waitFor(() => expect(jumps()).toEqual(['ta']));
    expect(files['c.md']).toBe('sam');
    expect(current()).toBe('a.md@0');
    expect(counter()).toBe('1 / 2');
  });
});
