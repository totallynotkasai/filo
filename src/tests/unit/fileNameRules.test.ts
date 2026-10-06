import { describe, it, expect } from 'vitest';
import { fileStemFromTitle, fileNameProblem, safeFileName, utf8Length } from '../../shared/fileNames';
import { assertSafeFilename } from '../../main/utils/pathSecurity';
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

  it('cuts a long name to 200 UTF-8 bytes between characters, never half an emoji', () => {
    // The emoji (4 bytes) would take the stem to 203 bytes, so it goes whole.
    expect(sanitizeFilename(`${'x'.repeat(199)}\u{1F600}tail`)).toBe('x'.repeat(199));
    expect(sanitizeFilename(`${'x'.repeat(196)}\u{1F600}tail`)).toBe(`${'x'.repeat(196)}\u{1F600}`);
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

// Windows allows 255 UTF-16 units in a name and Android 255 UTF-8 bytes. A
// title of 128 emoji passed the old 200-character cap but not Windows; a long
// Chinese title passes Windows but not a phone the vault syncs to.
describe('long names, counted as Windows and Android count them', () => {
  const emoji = '\u{1F600}'.repeat(128);
  const chinese = '中'.repeat(100);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';

  it('a derived name fits 255 bytes with " (n)" and the longest extension, and the name check accepts it', () => {
    for (const title of [emoji, chinese, 'x'.repeat(400), `${'é'.repeat(150)}`]) {
      const stem = fileStemFromTitle(title);
      expect(utf8Length(stem)).toBeLessThanOrEqual(200);
      expect(utf8Length(`${stem} (999).board.json`)).toBeLessThanOrEqual(255);
      expect(fileNameProblem(`${stem} (12).md`)).toBeNull();
      expect(boardNameProblem(stem)).toBeNull();
    }
    expect(fileStemFromTitle(emoji)).toBe('\u{1F600}'.repeat(50));
    expect(fileStemFromTitle(chinese)).toBe('中'.repeat(66));
  });

  it('never cuts inside a character made of several (an emoji family)', () => {
    const stem = fileStemFromTitle(`${'x'.repeat(190)}${family}`);
    expect(stem).toBe('x'.repeat(190));
    expect(fileStemFromTitle(`${'x'.repeat(170)}${family}`)).toBe(`${'x'.repeat(170)}${family}`);
  });

  it('refuses a typed name over 255 UTF-8 bytes, though Windows would take it', () => {
    expect('中'.repeat(90).length).toBeLessThanOrEqual(255);
    expect(fileNameProblem(`${'中'.repeat(90)}.md`)).toBe('That name is too long.');
    expect(fileNameProblem(`${'中'.repeat(80)}.md`)).toBeNull();
  });

  it('a board name leaves room for .board.json', () => {
    expect(boardNameProblem('x'.repeat(244))).toBeNull();
    expect(boardNameProblem('x'.repeat(245))).toBe('That name is too long.');
  });

  it('main refuses a new name over 255 UTF-8 bytes, and still reaches an existing one', () => {
    const long = `${'中'.repeat(90)}.md`;
    expect(() => assertSafeFilename(long, { forCreation: true })).toThrow(/255 UTF-8 bytes/);
    expect(() => assertSafeFilename(long)).not.toThrow();
  });
});
