import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../../main/vault/filenameUtils';

/**
 * `sanitizeFilename` strips trailing dots / spaces and
 * prefixes any Windows reserved device name with `_` so the sanitised
 * output clears `assertSafeFilename` instead of throwing downstream. The
 * `:` character is already stripped via the pre-existing ILLEGAL_CHARS
 * regex; `assertSafeFilename` itself is hardened for the same gap.
 */
describe('sanitizeFilename — trailing dots / spaces', () => {
  it('strips a single trailing dot', () => {
    expect(sanitizeFilename('Note.')).toBe('Note');
  });

  it('strips multiple trailing dots / mixed dot-space runs', () => {
    expect(sanitizeFilename('Plan...')).toBe('Plan');
    expect(sanitizeFilename('Plan . . . ')).toBe('Plan');
  });

  it('preserves interior dots (extension intact)', () => {
    expect(sanitizeFilename('Notes.tar.gz')).toBe('Notes.tar.gz');
  });

  it('drops a leading dot, since Filo never shows a dot-name', () => {
    expect(sanitizeFilename('.gitignore')).toBe('gitignore');
  });

  it('still falls back to "Untitled" when sanitisation empties the name', () => {
    expect(sanitizeFilename('...')).toBe('Untitled');
    expect(sanitizeFilename('   ')).toBe('Untitled');
  });
});

describe('sanitizeFilename — Windows reserved device names', () => {
  it('prefixes a bare reserved name', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('NUL')).toBe('_NUL');
    expect(sanitizeFilename('AUX')).toBe('_AUX');
    expect(sanitizeFilename('PRN')).toBe('_PRN');
  });

  it('prefixes lowercase reserved names (case-insensitive)', () => {
    expect(sanitizeFilename('con')).toBe('_con');
    expect(sanitizeFilename('nul')).toBe('_nul');
  });

  it('prefixes COM1..COM9 / LPT1..LPT9', () => {
    expect(sanitizeFilename('COM1')).toBe('_COM1');
    expect(sanitizeFilename('LPT9')).toBe('_LPT9');
  });

  it('prefixes reserved names that have an extension', () => {
    expect(sanitizeFilename('CON.md')).toBe('_CON.md');
    expect(sanitizeFilename('aux.tar.gz')).toBe('_aux.tar.gz');
    expect(sanitizeFilename('NUL.txt')).toBe('_NUL.txt');
  });

  it('does NOT prefix names that merely contain a reserved substring', () => {
    expect(sanitizeFilename('Console.md')).toBe('Console.md');
    expect(sanitizeFilename('Controller')).toBe('Controller');
    expect(sanitizeFilename('aux-data.json')).toBe('aux-data.json');
  });
});

describe('sanitizeFilename — `:` and other Windows-illegal chars', () => {
  it('strips `:` (ADS marker) via ILLEGAL_CHARS (pre-existing behaviour)', () => {
    expect(sanitizeFilename('note.md:hidden')).toBe('note.mdhidden');
  });

  it('strips other Win32-illegal chars (<>"|?*)', () => {
    expect(sanitizeFilename('foo<bar>baz?.md')).toBe('foobarbaz.md');
  });
});
