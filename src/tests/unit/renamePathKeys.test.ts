import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerPathRenamable,
  renameAllPathKeys,
  __getRegisteredPathRenamableNames,
  __resetRenamePathKeysForTests,
} from '@renderer/lib/vault/renamePathKeys';
import {
  markHydrated,
  isHydrated,
  clearHydrated,
  renameFileStatePath,
  __clearFileStateForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  getBaseline,
  noteBaseline,
  renameBaselinePath,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';

/**
 * Phase 6.1.R4 — `renameAllPathKeys` registry + the three new canonical
 * sweeps it ships with.
 *
 *   - `markdownFileWriter.fileState` — the hydrate gate. The audit's
 *     canonical missed example. Without rename transfer, every post-
 *     rename body keystroke throws "refusing to write — not hydrated".
 *   - `fileBaselineRegistry.baselines` — the per-file (mtime, size)
 *     drift baseline. Without rename transfer, the post-rename drift
 *     check no-ops because the new path has no baseline AND the old
 *     path's baseline becomes a phantom leak.
 *   - `vaultExternalChanges.inFlightDriftPrompts` — the per-path
 *     Reload/Keep-local promise dedupe map. Without rename transfer, an
 *     in-flight toast that resolved after the rename leaves the new
 *     path stranded (no caller awaits the old key any more) or opens a
 *     duplicate prompt for the new path.
 */

describe('Phase 6.1.R4 — renameAllPathKeys helper', () => {
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

describe('Phase 6.1.R4 — markdownFileWriter.fileState rename transfer', () => {
  beforeEach(() => {
    __clearFileStateForTests();
  });
  afterEach(() => {
    __clearFileStateForTests();
  });

  it('transfers an exact-match hydrate from oldRel to newRel', () => {
    markHydrated('Notes.md', true);
    expect(isHydrated('Notes.md')).toBe(true);
    renameFileStatePath('Notes.md', 'Renamed.md');
    expect(isHydrated('Notes.md')).toBe(false);
    expect(isHydrated('Renamed.md')).toBe(true);
  });

  it('transfers descendants under a folder rename', () => {
    markHydrated('Sub/a.md', false);
    markHydrated('Sub/b.md', false);
    markHydrated('Unrelated/c.md', false);
    renameFileStatePath('Sub', 'Archive');
    expect(isHydrated('Sub/a.md')).toBe(false);
    expect(isHydrated('Sub/b.md')).toBe(false);
    expect(isHydrated('Archive/a.md')).toBe(true);
    expect(isHydrated('Archive/b.md')).toBe(true);
    // Untouched.
    expect(isHydrated('Unrelated/c.md')).toBe(true);
  });

  it("doesn't materialise a hydrate entry when oldRel was never hydrated", () => {
    renameFileStatePath('Missing.md', 'NewMissing.md');
    expect(isHydrated('NewMissing.md')).toBe(false);
  });
});

describe('Phase 6.1.R4 — fileBaselineRegistry.baselines rename transfer', () => {
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

describe('Phase 6.1.R4 — end-to-end via renameAllPathKeys', () => {
  beforeEach(() => {
    // Earlier describe-block `afterEach`s cleared the registry — re-wire
    // the canonical owners by hand so the e2e block exercises the real
    // sweep chain. (Re-importing the module wouldn't help: ESM caches
    // the module evaluation, so its module-init `registerPathRenamable`
    // call doesn't fire again.)
    __clearFileStateForTests();
    __resetBaselinesForTests();
    registerPathRenamable('markdownFileWriter.fileState', renameFileStatePath);
    registerPathRenamable('fileBaselineRegistry', renameBaselinePath);
  });
  afterEach(() => {
    __clearFileStateForTests();
    __resetBaselinesForTests();
    __resetRenamePathKeysForTests();
  });

  it('a single renameAllPathKeys call moves fileState AND baseline together', () => {
    markHydrated('Old.md', true, 123, 456);
    // markHydrated above seeds baseline as a side effect when mtime/size are
    // provided — confirm both maps are populated.
    expect(isHydrated('Old.md')).toBe(true);
    expect(getBaseline('Old.md')).toEqual({ mtimeMs: 123, size: 456 });

    renameAllPathKeys('Old.md', 'Renamed.md');

    expect(isHydrated('Old.md')).toBe(false);
    expect(isHydrated('Renamed.md')).toBe(true);
    expect(getBaseline('Old.md')).toBeUndefined();
    expect(getBaseline('Renamed.md')).toEqual({ mtimeMs: 123, size: 456 });

    // Sanity: clearHydrated still works on the renamed entry.
    clearHydrated('Renamed.md');
    expect(isHydrated('Renamed.md')).toBe(false);
  });

  it('the canonical owners appear in the registry at module load', () => {
    const names = __getRegisteredPathRenamableNames();
    expect(names.has('markdownFileWriter.fileState')).toBe(true);
    expect(names.has('fileBaselineRegistry')).toBe(true);
  });
});
