import { describe, it, expect } from 'vitest';
import { fileStemFromTitle, fileNameProblem, safeFileName } from '../../shared/fileNames';
import { sanitizeFilename } from '../../main/vault/filenameUtils';
import { shouldIgnorePath } from '../../main/services/fileWatcherClassify';
import { hasHiddenSegment } from '../../shared/pathUtils';
import { fileNameSafe, nextUniqueMdPath } from '../../renderer/lib/vault/conventionPaths';
import { boardNameProblem } from '../../renderer/lib/boards/boardNaming';

// Main (folder / font names) and the renderer (note stems, the board-name
// check in the loader) must derive the same name from the same input, or a
// name one side produces is one the other side refuses or doesn't recognise.
describe('one file-name rule', () => {
  const inputs = [
    'Plan',
    'What? / Why',
    'a\u007fb',
    'tab\there',
    'CON',
    'aux.tar.gz',
    'Notes. . .',
    '   ',
    '.hidden',
    `${'x'.repeat(199)}\u{1F600}tail`,
  ];

  it('sanitizeFilename is the rule with illegal characters dropped', () => {
    for (const name of inputs) expect(sanitizeFilename(name)).toBe(safeFileName(name, ''));
  });

  it('fileStemFromTitle is the rule with illegal characters as dashes', () => {
    for (const name of inputs) expect(fileStemFromTitle(name)).toBe(safeFileName(name, '-'));
  });

  it('drops DEL like every other control character', () => {
    expect(sanitizeFilename('a\u007fb')).toBe('ab');
    expect(fileStemFromTitle('a\u007fb')).toBe('a-b');
  });

  it('cuts a long name on a code-point boundary, never half an emoji', () => {
    const cut = sanitizeFilename(`${'x'.repeat(199)}\u{1F600}tail`);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('\u{1F600}')).toBe(true);
  });

  it('whatever the rule derives, the name check accepts', () => {
    for (const name of inputs) {
      expect(fileNameProblem(safeFileName(name, ''))).toBeNull();
      expect(fileNameProblem(safeFileName(name, '-'))).toBeNull();
    }
  });
});

// A dot-name is hidden: the sidebar, the watcher and the vault index all skip
// it, so a note titled "...and then" must not become `...and then.md`.
describe('a title that starts with a dot', () => {
  it.each([
    ['...and then she ran', 'and then she ran'],
    ['.NET notes', 'NET notes'],
    ['. intro', 'intro'],
    [' .. spaced', 'spaced'],
    ['...', 'Untitled'],
  ])('"%s" gives the stem "%s"', (title, stem) => {
    expect(fileStemFromTitle(title)).toBe(stem);
    expect(sanitizeFilename(title)).toBe(stem);
  });

  it('gives a note path the sidebar, watcher and index can see', () => {
    for (const title of ['...and then she ran', '.NET notes', '. intro']) {
      const rel = nextUniqueMdPath({}, 'Scenes', fileNameSafe(title));
      expect(hasHiddenSegment(rel)).toBe(false);
      expect(shouldIgnorePath(rel)).toBe(false);
    }
  });

  it('keeps dots inside and before the extension', () => {
    expect(fileStemFromTitle('Act 1. The road')).toBe('Act 1. The road');
    expect(fileStemFromTitle('v2.0 notes')).toBe('v2.0 notes');
  });

  it('a typed file or board name may not start with a dot', () => {
    expect(fileNameProblem('.Ideas')).toMatch(/start with a dot/);
    expect(fileNameProblem('.hidden.md')).toMatch(/start with a dot/);
    expect(boardNameProblem('.Ideas')).toMatch(/start with a dot/);
    expect(fileNameProblem('Ideas.md')).toBeNull();
  });
});
