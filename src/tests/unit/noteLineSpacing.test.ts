import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { noteLineSpacing, resolveLineSpacing, projectLineSpacing, LINE_SPACING_CHOICES, formatLineSpacing } from '@renderer/stores/noteMeta';
import { defaultProjectSettings, GeneralSettingsSchema, type Project } from '@renderer/schema/index';
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

  describe('resolution: the note, then the project default, then the schema default', () => {
    function withProjectSpacing(value: number | undefined): void {
      const settings = defaultProjectSettings();
      if (value === undefined) delete (settings.general as { defaultLineSpacing?: number }).defaultLineSpacing;
      else settings.general.defaultLineSpacing = value;
      vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({ settings } as Project);
    }
    function withNote(yaml: string): void {
      vaultIndexStore.clear();
      vaultIndexStore.restoreMetadata('X.md', parseMarkdown('X.md', `---\n${yaml}\n---\nBody\n`));
    }
    afterEach(() => { vi.restoreAllMocks(); });

    it("the note's own value wins", () => {
      withProjectSpacing(2.5);
      withNote('lineSpacing: 1.15');
      expect(resolveLineSpacing('X.md')).toBe(1.15);
    });

    it('a note without one (or with an unusable one) takes the project default', () => {
      withProjectSpacing(2.5);
      withNote('title: X');
      expect(resolveLineSpacing('X.md')).toBe(2.5);
      withNote('lineSpacing: 9');
      expect(resolveLineSpacing('X.md')).toBe(2.5);
      expect(resolveLineSpacing('')).toBe(2.5);
    });

    it('no vault, or no usable project value, falls back to the schema default (1.5)', () => {
      withNote('title: X');
      vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(null);
      expect(resolveLineSpacing('X.md')).toBe(1.5);
      vi.restoreAllMocks();
      withProjectSpacing(undefined);
      expect(projectLineSpacing()).toBe(1.5);
      vi.restoreAllMocks();
      withProjectSpacing(40);
      expect(projectLineSpacing()).toBe(1.5);
    });
  });

  it('the settings schema defaults to 1.5 and accepts only the range a note may hold', () => {
    expect(GeneralSettingsSchema.parse({}).defaultLineSpacing).toBe(1.5);
    expect(GeneralSettingsSchema.safeParse({ defaultLineSpacing: 0.7 }).success).toBe(false);
    expect(GeneralSettingsSchema.safeParse({ defaultLineSpacing: 4.1 }).success).toBe(false);
    for (const choice of LINE_SPACING_CHOICES) {
      expect(GeneralSettingsSchema.safeParse({ defaultLineSpacing: choice }).success, String(choice)).toBe(true);
    }
  });

  it('shows whole spacings with one decimal', () => {
    expect(LINE_SPACING_CHOICES.map(formatLineSpacing)).toEqual(['1.0', '1.15', '1.5', '1.75', '2.0', '2.5', '3.0']);
  });
});
