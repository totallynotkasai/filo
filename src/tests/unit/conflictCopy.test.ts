import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalPathFor,
  detectConflictCopy,
  detectConflictCopyPath,
} from '@shared/conflictCopy';

/**
 * Table-driven coverage of the shared sync-conflict detector: a positive row
 * per documented client scheme (both `.md` and `.board*.json`) and a negative
 * corpus of names users genuinely pick.
 */

const always = (): boolean => true;
const never = (): boolean => false;

describe('detectConflictCopy — positive rows', () => {
  const rows: Array<[string, string, string, 'strong' | 'weak']> = [
    ['Note-DESKTOP-1A2B3C4.md', 'Note.md', 'onedrive', 'strong'],
    ['Plan.board-DESKTOP-1A2B3C4.json', 'Plan.board.json', 'onedrive', 'strong'],
    ['Note-LAPTOP-ZZ99AB1.md', 'Note.md', 'onedrive', 'strong'],
    ["Note (Andrew's conflicted copy 2026-09-23).md", 'Note.md', 'dropbox', 'strong'],
    ["Plan.board (Andrew's conflicted copy 2026-09-23).json", 'Plan.board.json', 'dropbox', 'strong'],
    ['Note (conflicted copy 2026-09-23 101112).md', 'Note.md', 'dropbox', 'strong'],
    ['Note (Case Conflict).md', 'Note.md', 'dropbox', 'strong'],
    ['Note (Selective Sync Conflict).md', 'Note.md', 'dropbox', 'strong'],
    ['Note.sync-conflict-20260923-101112-ABCDEFG.md', 'Note.md', 'syncthing', 'strong'],
  ];
  for (const [name, canonical, client, strength] of rows) {
    it(`${name} → ${canonical}`, () => {
      const hit = detectConflictCopy(name);
      expect(hit).toEqual({ canonicalName: canonical, client, strength });
    });
  }

  it('weak Google Drive / iCloud shapes count only with the sibling present', () => {
    expect(detectConflictCopy('Note (1).md', { exists: always })).toEqual({
      canonicalName: 'Note.md', client: 'gdrive', strength: 'weak',
    });
    expect(detectConflictCopy('Plan.board (1).json', { exists: always })?.canonicalName).toBe(
      'Plan.board.json',
    );
    expect(detectConflictCopy('Note 2.md', { exists: always })).toEqual({
      canonicalName: 'Note.md', client: 'icloud', strength: 'weak',
    });
    expect(detectConflictCopy('Plan.board 2.json', { exists: always })?.canonicalName).toBe(
      'Plan.board.json',
    );
    // Board carve-out: suffix before the compound `.board.json`.
    expect(detectConflictCopy('Plan (1).board.json', { exists: always })?.canonicalName).toBe(
      'Plan.board.json',
    );
  });

  it('the weak probe receives the canonical name', () => {
    const seen: string[] = [];
    detectConflictCopy('Report (2).md', { exists: (n) => { seen.push(n); return false; } });
    expect(seen).toEqual(['Report.md']);
  });

  it('known hosts match case-insensitively and hyphen-safely', () => {
    const knownHosts = ['JOHNS-SURFACE'];
    expect(detectConflictCopy('Note-JOHNS-SURFACE.md', { knownHosts })?.canonicalName).toBe('Note.md');
    expect(detectConflictCopy('Note-johns-surface.md', { knownHosts })?.canonicalName).toBe('Note.md');
    expect(detectConflictCopy('Note-JOHNS-SURFACE-2.md', { knownHosts })?.canonicalName).toBe('Note.md');
    expect(detectConflictCopy('Note-SURFACE.md', { knownHosts })).toBeNull();
    // Regex metacharacters in a hostname are escaped.
    expect(detectConflictCopy('Note-A.B.md', { knownHosts: ['A.B'] })?.canonicalName).toBe('Note.md');
    expect(detectConflictCopy('Note-AxB.md', { knownHosts: ['A.B'] })).toBeNull();
  });
});

describe('detectConflictCopy — negative corpus', () => {
  const negatives = [
    'Report (2).md',
    'Chapter 2.md',
    'Meeting-Notes.md',
    'Plan-B.md',
    'Q3-2024.md',
    'my-LAPTOP-notes.md',
    'Notes - Copy.md',
    'Plan (2).board.json',
    'DESKTOP-1A2B3C4.md',
    'Note-desktop-1a2b3c4.md', // default-hostname rule is uppercase only
    'README',
    '.gitignore',
    'Plan.board.json',
  ];
  for (const name of negatives) {
    it(`${name} is not a conflict copy (sibling absent)`, () => {
      expect(detectConflictCopy(name, { exists: never, knownHosts: ['MY-PC'] })).toBeNull();
    });
  }
  it('a weak match without any probe is never counted', () => {
    expect(detectConflictCopy('Note (1).md')).toBeNull();
    expect(detectConflictCopy('Note 2.md')).toBeNull();
  });
  it('an arbitrary -WORD suffix never matches, even with a sibling', () => {
    expect(detectConflictCopy('Meeting-Notes.md', { exists: always })).toBeNull();
  });
});

describe('canonicalPathFor', () => {
  it('preserves the directory', () => {
    expect(canonicalPathFor('A/B/Plan.board-DESKTOP-1A2B3C4.json')).toBe('A/B/Plan.board.json');
    expect(canonicalPathFor('Notes/Note (1).md', { exists: (p) => p === 'Notes/Note.md' })).toBe(
      'Notes/Note.md',
    );
    expect(canonicalPathFor('Notes/Note (1).md', { exists: (p) => p === 'Note.md' })).toBeNull();
    expect(canonicalPathFor('Notes/Plain.md')).toBeNull();
  });
  it('detectConflictCopyPath reports the client alongside the rel path', () => {
    expect(detectConflictCopyPath('X/Note-DESKTOP-1A2B3C4.md')).toEqual({
      canonicalName: 'X/Note.md', client: 'onedrive', strength: 'strong',
    });
  });
});

describe('module hygiene', () => {
  it('has zero imports (bundled into both processes)', () => {
    const src = readFileSync(resolve(__dirname, '../../shared/conflictCopy.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });
});
