import { describe, it, expect } from 'vitest';
import { fileStemFromTitle, fileNameProblem, safeFileName } from '../../shared/fileNames';
import { sanitizeFilename } from '../../main/vault/filenameUtils';

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
