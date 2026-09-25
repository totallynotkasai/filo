import { describe, it, expect, vi } from 'vitest';
import jsyaml from 'js-yaml';
import {
  emptyTagsFile,
  parseTagsFile,
  loadTagsFile,
  tagsForFile,
  filesForTag,
  allTagNames,
  getTagDefinition,
  addTagToFile,
  removeTagFromFile,
  setFileTags,
  renameTag,
  deleteTag,
  setTagColor,
  dropFile,
  renameFile,
  renameFolderInTags,
  dropFolderInTags,
  isValidTagName,
  isSafeNewTagName,
} from '@renderer/lib/vault/tagsStorage';
import { CURRENT_TAGS_FILE_VERSION } from '@renderer/schema/tagsFile';
import {
  onError,
  __resetErrorBusForTests,
  type ReportedError,
} from '@renderer/lib/utils/errorBus';

// ── 1.5a ───────────────────────────────────────────────────────────────────
// Strict create/rename input guard. The frontmatter rewriter quotes scalars
// (1.5b/1.6) so any name is SAFE on disk, but the user shouldn't be able to
// MINT confusing tags (numbers, YAML keywords, leading indicator chars). This
// is scoped to the input boundary only — `isValidTagName` stays lenient so
// existing tags (e.g. a legacy numeric tag) are never disturbed.
describe('isSafeNewTagName (1.5a — strict create/rename input guard)', () => {
  it('accepts ordinary names (hierarchy, hyphens, mid-colon, on/yes/no)', () => {
    for (const name of [
      'project', 'todo', 'foo/bar', 'team/dev/lead', 'v2', '2024-q1', 'a:b', 'foo#bar', 'on', 'yes', 'no',
    ]) {
      expect(isSafeNewTagName(name)).toBe(true);
    }
  });

  it('strips a single leading # before validating', () => {
    expect(isSafeNewTagName('#todo')).toBe(true);
  });

  it('rejects empty / whitespace-bearing names', () => {
    for (const name of ['', '   ', '#', 'a b', 'two words']) {
      expect(isSafeNewTagName(name)).toBe(false);
    }
  });

  it('rejects names YAML reads as a non-string scalar (number / bool / null)', () => {
    for (const name of ['123', '2024', '3.14', 'true', 'false', 'null']) {
      expect(isSafeNewTagName(name)).toBe(false);
    }
  });

  it('rejects names starting with (or built from) a YAML indicator char', () => {
    for (const name of [
      '@home', '*anchor', '&anchor', '!tag', '%directive', '`tick', ':colon', '?question', '|pipe', '>gt',
      '[bracket', '{brace', ',comma',
    ]) {
      expect(isSafeNewTagName(name)).toBe(false);
    }
  });

  it('rejects dates and binary integers, which other YAML readers take as non-strings', () => {
    for (const name of ['2024-01-01', '2024-01-01T10:00:00Z', '0b1010', '0x1F', '.inf', '~']) {
      expect(isSafeNewTagName(name)).toBe(false);
    }
  });

  it('agrees with js-yaml (an independent reader, as Obsidian uses) on which bare names read as strings', () => {
    const names = [
      'project', 'v2', '2024-q1', 'a:b', 'on', 'yes', 'no', 'y', 'off', '123', '3.14', 'true', 'True', 'NULL', '~',
      '0x1F', '0o17', '0b1010', '1_000', '.inf', '.NaN', '1e3', '+12', '-5', '2024-01-01', '<<', '-', 'x-', '12:30',
      '0777', 'Infinity', '.5', '1,000', 'é', '日本', 'a,b', 'a]', 'a}', 'a"b', "a'b",
    ];
    for (const name of names) {
      let independent: boolean;
      try {
        independent = jsyaml.load(name) === name;
      } catch {
        independent = false;
      }
      expect({ name, safe: isSafeNewTagName(name) }).toEqual({ name, safe: independent && !/^[@`*&!%|>:?]/.test(name) });
    }
  });

  it('keeps isValidTagName lenient so existing tags are never disturbed', () => {
    expect(isValidTagName('2024')).toBe(true); // a legacy numeric tag stays valid
    expect(isSafeNewTagName('2024')).toBe(false); // but can't be freshly minted
  });
});

describe('tagsStorage — pure CRUD', () => {
  describe('parseTagsFile', () => {
    it('returns an empty file for null/empty input', () => {
      expect(parseTagsFile(null)).toEqual({ version: 1, tags: {}, fileTags: {} });
      expect(parseTagsFile('')).toEqual({ version: 1, tags: {}, fileTags: {} });
    });

    it('parses a well-formed tags.json', () => {
      const raw = JSON.stringify({
        version: 1,
        tags: { project: { color: '#abc' } },
        fileTags: { 'a.md': ['project'] },
      });
      const f = parseTagsFile(raw);
      expect(f.tags.project.color).toBe('#abc');
      expect(f.fileTags['a.md']).toEqual(['project']);
    });

    it('falls back to empty on malformed JSON', () => {
      __resetErrorBusForTests();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseTagsFile('{not json')).toEqual({ version: 1, tags: {}, fileTags: {} });
    });

    it('reports a parse failure to the errorBus on malformed JSON', () => {
      __resetErrorBusForTests();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errors: ReportedError[] = [];
      onError((e) => errors.push(e));
      parseTagsFile('{not json');
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe('tagsStorage.parse');
    });

    it('reports a schema failure to the errorBus when JSON parses but does not match', () => {
      __resetErrorBusForTests();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errors: ReportedError[] = [];
      onError((e) => errors.push(e));
      // Valid JSON but `tags` is the wrong shape — TagDefinitionSchema
      // requires `color: string`, so passing a number trips the schema
      // (passthrough only permits *extra* keys, not type mismatches).
      parseTagsFile(JSON.stringify({ version: 1, tags: { foo: { color: 42 } }, fileTags: {} }));
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe('tagsStorage.schema');
    });
  });

  // F6 (2026-05-28) — the version migrator was wired into the loader so a
  // from-future tags.json is detected (and surfaced read-only) instead of
  // being parsed + silently re-saved at the current version.
  describe('loadTagsFile — version migration', () => {
    it('flags a from-future tags.json without downgrading it', () => {
      __resetErrorBusForTests();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errors: ReportedError[] = [];
      onError((e) => errors.push(e));
      const raw = JSON.stringify({
        version: CURRENT_TAGS_FILE_VERSION + 5,
        tags: { project: { color: '#abc' } },
        fileTags: { 'a.md': ['project'] },
      });
      const result = loadTagsFile(raw);
      expect(result.fromFuture).toBe(true);
      expect(result.noMigrationPath).toBe(false);
      // Best-effort parse keeps the user's tags visible (read-only) — the
      // store's read-only gate is what prevents a re-save.
      expect(result.file.fileTags['a.md']).toEqual(['project']);
      expect(errors.some((e) => e.context === 'tagsStorage.fromFuture')).toBe(true);
    });

    it('flags a fractional version as no-migration-path', () => {
      __resetErrorBusForTests();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errors: ReportedError[] = [];
      onError((e) => errors.push(e));
      const raw = JSON.stringify({ version: 0.5, tags: {}, fileTags: {} });
      const result = loadTagsFile(raw);
      expect(result.noMigrationPath).toBe(true);
      expect(result.fromFuture).toBe(false);
      expect(errors.some((e) => e.context === 'tagsStorage.noMigrationPath')).toBe(true);
    });

    it('loads a current-version tags.json cleanly (no read-only flags)', () => {
      const raw = JSON.stringify({
        version: CURRENT_TAGS_FILE_VERSION,
        tags: { project: { color: '#abc' } },
        fileTags: { 'a.md': ['project'] },
      });
      const result = loadTagsFile(raw);
      expect(result.fromFuture).toBe(false);
      expect(result.noMigrationPath).toBe(false);
      expect(result.file.tags.project.color).toBe('#abc');
    });
  });

  describe('addTagToFile', () => {
    it('adds a tag and ensures a default definition exists', () => {
      const f = emptyTagsFile();
      const next = addTagToFile(f, 'a.md', 'project');
      expect(next.fileTags['a.md']).toEqual(['project']);
      expect(next.tags.project).toBeDefined();
    });

    it('is idempotent — adding the same tag twice does nothing', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      const before = f;
      f = addTagToFile(f, 'a.md', 'project');
      expect(f.fileTags['a.md']).toEqual(['project']);
      // Reference equality not required, but logical equivalence is.
      expect(f.fileTags['a.md'].length).toBe(before.fileTags['a.md'].length);
    });

    it('normalises Windows-style backslash paths to forward slashes', () => {
      const f = addTagToFile(emptyTagsFile(), 'notes\\sub\\a.md', 'x');
      expect(Object.keys(f.fileTags)[0]).toBe('notes/sub/a.md');
    });

    it('rejects empty or whitespace-only tag names', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', '   ');
      expect(f.fileTags).toEqual({});
    });

    it('treats casing as identity (case variant collapses to first-seen casing)', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'Project');
      f = addTagToFile(f, 'b.md', 'PROJECT');
      expect(Object.keys(f.tags)).toEqual(['Project']);
      expect(f.fileTags['a.md']).toEqual(['Project']);
      expect(f.fileTags['b.md']).toEqual(['Project']);
    });

    it('strips a leading # before storing', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', '#urgent');
      expect(f.fileTags['a.md']).toEqual(['urgent']);
      expect(f.tags.urgent).toBeDefined();
    });
  });

  describe('removeTagFromFile', () => {
    it('removes a tag and prunes the file entry when empty', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      f = removeTagFromFile(f, 'a.md', 'project');
      expect(f.fileTags['a.md']).toBeUndefined();
    });

    it('preserves remaining tags', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = addTagToFile(f, 'a.md', 'two');
      f = removeTagFromFile(f, 'a.md', 'one');
      expect(f.fileTags['a.md']).toEqual(['two']);
    });

    it('is a no-op for a tag not on the file', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      const next = removeTagFromFile(f, 'a.md', 'missing');
      expect(next.fileTags).toEqual(f.fileTags);
    });
  });

  describe('setFileTags', () => {
    it('replaces the tag list outright', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'old');
      f = setFileTags(f, 'a.md', ['new', 'another']);
      expect(f.fileTags['a.md']).toEqual(['new', 'another']);
    });

    it('deduplicates and trims', () => {
      const f = setFileTags(emptyTagsFile(), 'a.md', [' one ', 'one', 'two']);
      expect(f.fileTags['a.md']).toEqual(['one', 'two']);
    });

    it('prunes the file entry when given an empty array', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      f = setFileTags(f, 'a.md', []);
      expect(f.fileTags['a.md']).toBeUndefined();
    });

    it('collapses external case variants onto first-seen casing', () => {
      // Existing registry knows `Project`; a frontmatter sync that bring in
      // `PROJECT` and `project` should not introduce new definitions.
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'Project');
      f = setFileTags(f, 'b.md', ['PROJECT', 'project', 'fresh']);
      expect(Object.keys(f.tags).sort()).toEqual(['Project', 'fresh']);
      expect(f.fileTags['b.md']).toEqual(['Project', 'fresh']);
    });
  });

  describe('renameTag', () => {
    it('updates the definition key and all fileTags references', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      f = addTagToFile(f, 'b.md', 'project');
      const { file, touchedPaths } = renameTag(f, 'project', 'work');
      expect(file.tags.project).toBeUndefined();
      expect(file.tags.work).toBeDefined();
      expect(file.fileTags['a.md']).toEqual(['work']);
      expect(file.fileTags['b.md']).toEqual(['work']);
      expect(touchedPaths.sort()).toEqual(['a.md', 'b.md']);
    });

    it('is a no-op when old and new names are equal', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      const { file, touchedPaths } = renameTag(f, 'project', 'project');
      expect(touchedPaths).toEqual([]);
      expect(file).toBe(f);
    });

    it('merges into an existing target tag', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      f = addTagToFile(f, 'b.md', 'work');
      const { file } = renameTag(f, 'project', 'work');
      expect(file.fileTags['a.md']).toEqual(['work']);
      expect(file.fileTags['b.md']).toEqual(['work']);
      expect(file.tags.work).toBeDefined();
      expect(file.tags.project).toBeUndefined();
    });

    it('dedupes when a file already had both old and new tags', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      f = addTagToFile(f, 'a.md', 'work');
      const { file } = renameTag(f, 'project', 'work');
      expect(file.fileTags['a.md']).toEqual(['work']);
    });
  });

  describe('deleteTag', () => {
    it('strips the tag from every file and returns touched paths', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = addTagToFile(f, 'a.md', 'two');
      f = addTagToFile(f, 'b.md', 'one');
      const { file, touchedPaths } = deleteTag(f, 'one');
      expect(file.tags.one).toBeUndefined();
      expect(file.fileTags['a.md']).toEqual(['two']);
      expect(file.fileTags['b.md']).toBeUndefined();
      expect(touchedPaths.sort()).toEqual(['a.md', 'b.md']);
    });

    it('is a no-op for an unknown tag', () => {
      const f = emptyTagsFile();
      const { file, touchedPaths } = deleteTag(f, 'never-existed');
      expect(file).toBe(f);
      expect(touchedPaths).toEqual([]);
    });
  });

  describe('setTagColor', () => {
    it('creates a definition if one is missing', () => {
      const f = setTagColor(emptyTagsFile(), 'project', '#abc');
      expect(f.tags.project.color).toBe('#abc');
    });

    it('updates an existing definition without losing other fields', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'project');
      const originalCreatedAt = f.tags.project.createdAt;
      f = setTagColor(f, 'project', '#fff');
      expect(f.tags.project.color).toBe('#fff');
      expect(f.tags.project.createdAt).toBe(originalCreatedAt);
    });
  });

  describe('dropFile / renameFile', () => {
    it('drops a file entry on delete', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = dropFile(f, 'a.md');
      expect(f.fileTags['a.md']).toBeUndefined();
    });

    it('renames a file key and preserves its tags', () => {
      let f = addTagToFile(emptyTagsFile(), 'old.md', 'one');
      f = renameFile(f, 'old.md', 'new.md');
      expect(f.fileTags['old.md']).toBeUndefined();
      expect(f.fileTags['new.md']).toEqual(['one']);
    });

    it('is a no-op for unchanged paths', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      const next = renameFile(f, 'a.md', 'a.md');
      expect(next).toBe(f);
    });

    /**
     * Phase 1 / 1.5 — Windows OS file-watcher events frequently
     * round-trip path casing differently from the original write:
     * the user creates `Notes/Foo.md` from the app, but a later
     * filesystem-driven rename arrives as `notes/foo.md` because the
     * OS canonicalises through the case-insensitive volume table.
     * Pre-fix, `renameFile(f, 'notes/foo.md', 'Bar.md')` saw NO match
     * against the stored `Notes/Foo.md` key and left the entry
     * orphaned. With `normalizeVaultRelative`, both inputs collapse
     * to `notes/foo.md` and the rename succeeds.
     */
    it('matches case-insensitively on file rename (Windows path-case drift)', () => {
      let f = addTagToFile(emptyTagsFile(), 'Notes/Foo.md', 'project');
      // The original add already stored under the canonical lowercase key:
      expect(f.fileTags['notes/foo.md']).toEqual(['project']);
      // A rename arriving with different case still resolves to the
      // same entry.
      f = renameFile(f, 'notes/foo.md', 'Archive/Bar.md');
      expect(f.fileTags['notes/foo.md']).toBeUndefined();
      expect(f.fileTags['archive/bar.md']).toEqual(['project']);
    });

    it('matches case-insensitively on folder rename', () => {
      let f = addTagToFile(emptyTagsFile(), 'Notes/Foo.md', 'project');
      // Lowercase folder prefix on rename input — should still hit
      // every descendant.
      f = renameFolderInTags(f, 'notes', 'Archive');
      expect(f.fileTags['notes/foo.md']).toBeUndefined();
      expect(f.fileTags['archive/foo.md']).toEqual(['project']);
    });
  });

  describe('renameFolderInTags / dropFolderInTags', () => {
    // Phase 1 / 1.5 — fileTags keys are canonicalised through
    // `normalizeVaultRelative` (separator + lowercase), so an input of
    // `Old/a.md` is stored as `old/a.md`. Tests assert against the
    // canonical form.
    it('rewrites every nested key under the renamed folder', () => {
      let f = addTagToFile(emptyTagsFile(), 'Old/a.md', 'one');
      f = addTagToFile(f, 'Old/sub/b.md', 'two');
      f = addTagToFile(f, 'Other/c.md', 'three');
      const next = renameFolderInTags(f, 'Old', 'New');
      expect(next.fileTags['old/a.md']).toBeUndefined();
      expect(next.fileTags['old/sub/b.md']).toBeUndefined();
      expect(next.fileTags['new/a.md']).toEqual(['one']);
      expect(next.fileTags['new/sub/b.md']).toEqual(['two']);
      expect(next.fileTags['other/c.md']).toEqual(['three']);
    });

    it('is a no-op when no keys match the prefix', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      expect(renameFolderInTags(f, 'Sub', 'Other')).toBe(f);
    });

    it('does not mis-match a similarly-prefixed sibling (Old vs OldStuff)', () => {
      // Regression: a naive `startsWith('Old')` check would clobber
      // OldStuff/file.md. The implementation should match only the
      // exact name or `Old/` prefix.
      let f = addTagToFile(emptyTagsFile(), 'Old/a.md', 'one');
      f = addTagToFile(f, 'OldStuff/b.md', 'two');
      const next = renameFolderInTags(f, 'Old', 'New');
      expect(next.fileTags['new/a.md']).toEqual(['one']);
      expect(next.fileTags['oldstuff/b.md']).toEqual(['two']);
    });

    it('handles backslash-style prefixes by normalising', () => {
      const f = addTagToFile(emptyTagsFile(), 'A/B/c.md', 'one');
      const next = renameFolderInTags(f, 'A\\B', 'X/Y');
      expect(next.fileTags['x/y/c.md']).toEqual(['one']);
    });

    it('dropFolderInTags removes every key nested under the prefix', () => {
      let f = addTagToFile(emptyTagsFile(), 'Old/a.md', 'one');
      f = addTagToFile(f, 'Old/sub/b.md', 'two');
      f = addTagToFile(f, 'Other/c.md', 'three');
      const next = dropFolderInTags(f, 'Old');
      expect(next.fileTags['old/a.md']).toBeUndefined();
      expect(next.fileTags['old/sub/b.md']).toBeUndefined();
      expect(next.fileTags['other/c.md']).toEqual(['three']);
    });

    it('dropFolderInTags is a no-op when nothing matches', () => {
      const f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      expect(dropFolderInTags(f, 'Sub')).toBe(f);
    });
  });

  describe('lookups', () => {
    it('tagsForFile returns assigned tags', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = addTagToFile(f, 'a.md', 'two');
      expect(tagsForFile(f, 'a.md').sort()).toEqual(['one', 'two']);
      expect(tagsForFile(f, 'missing.md')).toEqual([]);
    });

    it('filesForTag returns every path carrying the tag', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = addTagToFile(f, 'b.md', 'one');
      expect(filesForTag(f, 'one').sort()).toEqual(['a.md', 'b.md']);
      expect(filesForTag(f, 'other')).toEqual([]);
    });

    it('allTagNames unions tags defined and tags merely referenced', () => {
      let f = addTagToFile(emptyTagsFile(), 'a.md', 'one');
      f = setTagColor(f, 'lonely', '#000'); // defined but not used
      expect(allTagNames(f)).toEqual(['lonely', 'one']);
    });

    it('getTagDefinition falls back to an accent-coloured default', () => {
      const f = emptyTagsFile();
      const def = getTagDefinition(f, 'unknown');
      expect(def.color).toBeTruthy();
    });
  });
});
