import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { noteLineSpacing } from '@renderer/stores/noteMeta';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { SetLineSpacingCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Line spacing belongs to the whole note and lives in its frontmatter
 * (`lineSpacing:`), so every view of the note shows it and it travels with the
 * file. Setting it is one undoable step that changes only that key.
 */
describe('note line spacing', () => {
  let vault: MemoryVault;
  const NOTE = ['---', '# keep this comment', 'title: Note', 'lineSpacing: 1.5', '---', 'Body text.'].join('\n');

  function lastWrite(): string {
    const write = vault.writes.filter(([, rel]) => rel === 'Note.md').pop();
    expect(write, 'the change must reach disk').toBeDefined();
    return write?.[2] ?? '';
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Note.md': NOTE });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
  });

  it('SetLineSpacingCommand: execute sets it, undo puts the old value back, nothing else changes', async () => {
    const cmd = new SetLineSpacingCommand('doc-tab', 'Note.md', 2, 1.5);
    await cmd.execute();
    await noteStore.flushAll();
    expect(lastWrite()).toBe(['---', '# keep this comment', 'title: Note', 'lineSpacing: 2', '---', 'Body text.'].join('\n'));

    await cmd.undo();
    await noteStore.flushAll();
    expect(lastWrite()).toBe(NOTE);
  });

  it('SetLineSpacingCommand with null removes the key (the view default), and undo restores it', async () => {
    const cmd = new SetLineSpacingCommand('doc-tab', 'Note.md', null, 1.5);
    await cmd.execute();
    await noteStore.flushAll();
    expect(lastWrite()).not.toContain('lineSpacing');
    expect(lastWrite()).toContain('# keep this comment');

    await cmd.undo();
    await noteStore.flushAll();
    expect(lastWrite()).toContain('lineSpacing: 1.5');
  });

  it('reads numbers and numeric strings in range; anything else means the view default', () => {
    // The YAML as it would sit in the file.
    const cases: Array<[string, number | null]> = [
      ['lineSpacing: 1.15', 1.15],
      ['lineSpacing: "2"', 2],
      ['lineSpacing: " 1.5 "', 1.5],
      ['lineSpacing: 0.5', null],
      ['lineSpacing: 9', null],
      ['lineSpacing: wide', null],
      ['lineSpacing: ""', null],
      ['lineSpacing: true', null],
      ['title: None', null],
    ];
    for (const [yaml, expected] of cases) {
      vaultIndexStore.clear();
      vaultIndexStore.restoreMetadata('X.md', parseMarkdown('X.md', `---\n${yaml}\n---\nBody\n`));
      expect(noteLineSpacing('X.md'), yaml).toBe(expected);
    }
    expect(noteLineSpacing('')).toBeNull();
  });
});
