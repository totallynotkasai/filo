import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import {
  registerPathRenamable,
  renameAllPathKeys,
  __getRegisteredPathRenamableNames,
  __resetRenamePathKeysForTests,
} from '@renderer/lib/vault/renamePathKeys';
import {
  getBaseline,
  noteBaseline,
  renameBaselinePath,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { noteStore } from '@renderer/stores/notes.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `renameAllPathKeys` is the one rename sweep every owner of path-keyed state
 * subscribes to at module load. An owner that doesn't is stranded after a
 * rename: its entries sit under the old path while every later lookup uses the
 * new one. The note store (models, the writer's queues, frontmatter overlays),
 * the board/config drift baselines and the Document tabs subscribe.
 */

// Captured before any test resets the registry: what module load registered.
const REGISTERED_AT_LOAD = __getRegisteredPathRenamableNames();

describe('owners registered at module load', () => {
  it('the note store, drift baselines and Document tabs subscribe', () => {
    for (const name of ['noteStore', 'fileBaselineRegistry', 'tabs.documentTabs', 'nonUtf8Paths']) {
      expect(REGISTERED_AT_LOAD.has(name)).toBe(true);
    }
  });

  it('no sweep of the removed note stores is left behind', () => {
    for (const name of REGISTERED_AT_LOAD) {
      expect(name).not.toMatch(/^(documentStore|markdownFileWriter|frontmatterWriteScheduler)/);
    }
  });
});

describe('end-to-end via renameAllPathKeys (production sweeps)', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    installMemoryVault({ 'Old.md': '---\ntitle: Old\n---\nbody\n' });
    noteStore.__resetForTests();
    __resetBaselinesForTests();
    tabStore.closeAll();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetBaselinesForTests();
    tabStore.closeAll();
    setActiveVaultPath('');
    restoreFiloDefault();
  });

  it('one call moves the note model, its queued change, the baseline and the tab together', async () => {
    const m = noteStore.acquire('Old.md', 'doc');
    await m.loaded;
    noteStore.patchFrontmatter('Old.md', { set: { status: 'done' }, unset: [] });
    noteBaseline('Old.md', 123, 456);
    const tab = tabStore.openNote('Old.md', 'Old');

    renameAllPathKeys('Old.md', 'Renamed.md');

    expect(noteStore.get('Old.md')).toBeUndefined();
    expect(noteStore.get('Renamed.md')).toBe(m);
    expect(noteStore.hasPendingWrites('Old.md')).toBe(false);
    expect(noteStore.hasPendingWrites('Renamed.md')).toBe(true);
    expect(getBaseline('Old.md')).toBeUndefined();
    expect(getBaseline('Renamed.md')).toEqual({ mtimeMs: 123, size: 456 });
    expect(tabStore.tabs.find((t) => t.id === tab.id)?.notePath).toBe('Renamed.md');
  });
});

describe('fileBaselineRegistry.baselines rename transfer', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
  });
  afterEach(() => {
    __resetBaselinesForTests();
  });

  it('transfers an exact-match baseline from oldRel to newRel', () => {
    noteBaseline('Notes.md', 100, 500);
    expect(getBaseline('Notes.md')).toEqual({ mtimeMs: 100, size: 500 });
    renameBaselinePath('Notes.md', 'Renamed.md');
    expect(getBaseline('Notes.md')).toBeUndefined();
    expect(getBaseline('Renamed.md')).toEqual({ mtimeMs: 100, size: 500 });
  });

  it('transfers descendants under a folder rename', () => {
    noteBaseline('Sub/a.md', 100, 500);
    noteBaseline('Sub/b.md', 200, 600);
    noteBaseline('Unrelated/c.md', 300, 700);
    renameBaselinePath('Sub', 'Archive');
    expect(getBaseline('Sub/a.md')).toBeUndefined();
    expect(getBaseline('Sub/b.md')).toBeUndefined();
    expect(getBaseline('Archive/a.md')).toEqual({ mtimeMs: 100, size: 500 });
    expect(getBaseline('Archive/b.md')).toEqual({ mtimeMs: 200, size: 600 });
    expect(getBaseline('Unrelated/c.md')).toEqual({ mtimeMs: 300, size: 700 });
  });
});

// Runs last: it empties the registry, and module load doesn't re-register.
describe('renameAllPathKeys helper', () => {
  beforeEach(() => {
    __resetRenamePathKeysForTests();
  });

  afterEach(() => {
    __resetRenamePathKeysForTests();
  });

  it('fires every registered sweep in registration order', () => {
    const log: Array<[string, string, string]> = [];
    registerPathRenamable('a', (o, n) => log.push(['a', o, n]));
    registerPathRenamable('b', (o, n) => log.push(['b', o, n]));
    registerPathRenamable('c', (o, n) => log.push(['c', o, n]));
    renameAllPathKeys('Old.md', 'New.md');
    expect(log).toEqual([
      ['a', 'Old.md', 'New.md'],
      ['b', 'Old.md', 'New.md'],
      ['c', 'Old.md', 'New.md'],
    ]);
  });

  it('is a no-op when oldRel equals newRel (or either is empty)', () => {
    let fired = 0;
    registerPathRenamable('noop', () => {
      fired++;
    });
    renameAllPathKeys('Same.md', 'Same.md');
    renameAllPathKeys('', 'New.md');
    renameAllPathKeys('Old.md', '');
    expect(fired).toBe(0);
  });

  it('continues firing the remaining sweeps when one throws', () => {
    const log: string[] = [];
    registerPathRenamable('first', () => {
      log.push('first');
    });
    registerPathRenamable('thrower', () => {
      throw new Error('boom');
    });
    registerPathRenamable('after', () => {
      log.push('after');
    });
    renameAllPathKeys('Old.md', 'New.md');
    expect(log).toEqual(['first', 'after']);
  });

  it('reports a throwing sweep and returns false, so the cascade keeps its recovery sentinel', () => {
    const reported: ReportedError[] = [];
    const off = onError((e) => reported.push(e));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      registerPathRenamable('fine', () => undefined);
      registerPathRenamable('thrower', () => {
        throw new Error('boom');
      });
      expect(renameAllPathKeys('Old.md', 'New.md')).toBe(false);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toMatch(/thrower/);
    } finally {
      off();
      errSpy.mockRestore();
    }
  });

  it('returns true when every sweep ran (and for a no-op rename)', () => {
    registerPathRenamable('fine', () => undefined);
    expect(renameAllPathKeys('Old.md', 'New.md')).toBe(true);
    expect(renameAllPathKeys('Same.md', 'Same.md')).toBe(true);
  });

  it('unsubscribe removes the sweep from the registry', () => {
    const log: string[] = [];
    const unsub = registerPathRenamable('temp', () => log.push('fired'));
    expect(__getRegisteredPathRenamableNames().has('temp')).toBe(true);
    unsub();
    expect(__getRegisteredPathRenamableNames().has('temp')).toBe(false);
    renameAllPathKeys('Old.md', 'New.md');
    expect(log).toEqual([]);
  });
});
