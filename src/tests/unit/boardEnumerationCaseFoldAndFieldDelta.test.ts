import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { scanBoardFiles } from '../../main/vault/boardFileOps';
import { classifyChange } from '../../main/services/fileWatcherClassify';

import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-15 Phase 1 — the sibling-parity MEDIUM fixes that need a unit guard.
 *
 *   P1.3  `.board.json` enumeration (`scanBoardFiles`) + classification
 *         (`classifyChange`) now case-fold the extension, so an externally
 *         case-mangled board isn't silently dropped from the project / routed
 *         past the board reconciler.
 *   P1.4  a field delta keeps the body from FRESH disk when there is no live
 *         editor for the note (orphan / card-only file), so a Properties field
 *         save can't revert an external body edit `fs.watch` missed; with an
 *         editor open, its typed body and the delta land together.
 *   P1.5  a deny-by-default permission handler is installable on the session.
 *
 * P1.1 (scheduler parked early-return) lives in `audit14Phase1.test.ts` beside
 * its 1.1 siblings; P1.2 is CSS-only (no unit cover — see P0.1).
 */

describe('Audit-15 P1.3 — .board.json enumeration + classification case-fold', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-p13-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scanBoardFiles includes boards whose extension casing diverged', async () => {
    await fs.writeFile(join(dir, 'Plan.Board.json'), '{}', 'utf8');
    await fs.writeFile(join(dir, 'normal.board.json'), '{}', 'utf8');
    await fs.mkdir(join(dir, 'sub'));
    await fs.writeFile(join(dir, 'sub', 'Deep.BOARD.JSON'), '{}', 'utf8');
    // A non-board file must NOT be picked up.
    await fs.writeFile(join(dir, 'notes.md'), '# x', 'utf8');

    const found = await scanBoardFiles(dir);

    expect(found).toContain('Plan.Board.json'); // case-mangled root board
    expect(found).toContain('normal.board.json'); // ordinary board (regression)
    expect(found).toContain('sub/Deep.BOARD.JSON'); // case-mangled nested board
    expect(found).not.toContain('notes.md');
  });

  it('classifyChange routes a case-variant .board.json to "board"', () => {
    expect(classifyChange('My.BOARD.JSON')).toBe('board');
    expect(classifyChange('Folder/Plan.Board.json')).toBe('board');
    // Regression: ordinary lowercase board + a non-board still classify correctly.
    expect(classifyChange('notes/x.board.json')).toBe('board');
    expect(classifyChange('notes/Note.md')).toBe('document');
  });
});


describe('Audit-15 P1.4 — a field delta keeps the fresh disk body when no editor is open', () => {
  let vault: MemoryVault;
  const lastWrite = (rel: string): string | undefined =>
    vault.writes.filter(([, r]) => r === rel).at(-1)?.[2];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('writes the FRESH disk body for a never-opened file', async () => {
    vault = installMemoryVault({ 'Card.md': '---\ncompleted: false\n---\nold body\n' });
    // An external edit the watcher never reported.
    vault.writeExternally('Card.md', '---\ncompleted: false\n---\nFRESH external body\n');

    noteStore.patchFrontmatter('Card.md', patchToFrontmatterDelta({ completed: true }));
    expect(await noteStore.flush('Card.md')).toBe(true);

    const written = lastWrite('Card.md');
    expect(written).toBeDefined();
    expect(written).toContain('FRESH external body'); // disk body preserved
    expect(written).not.toContain('old body');
    expect(written).toContain('completed: true'); // the field delta still applied
  });

  it('keeps the LIVE editor body when an editor IS open for the note', async () => {
    vault = installMemoryVault({ 'Open.md': '---\ncompleted: false\n---\nold disk body\n' });
    const m = noteStore.acquire('Open.md', 'text-tile:open');
    await m.loaded;
    noteStore.setBody('Open.md', 'LIVE editor body', 'text-tile:open');

    noteStore.patchFrontmatter('Open.md', patchToFrontmatterDelta({ completed: true }));
    expect(await noteStore.flush('Open.md')).toBe(true);

    const written = lastWrite('Open.md');
    expect(written).toBeDefined();
    expect(written).toContain('LIVE editor body'); // live body wins over disk
    expect(written).not.toContain('old disk body');
    expect(written).toContain('completed: true');
    noteStore.release('Open.md', 'text-tile:open');
  });
});
