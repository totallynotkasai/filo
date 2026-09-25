/**
 * noteFile — the pure read/assemble of one note. Every write the note writer
 * makes goes through `assembleNoteText` over a fresh read, so these pin the
 * byte rules: untouched frontmatter stays byte-for-byte, BOM and line endings
 * follow the file, the body is kept when only frontmatter changes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readNoteText,
  assembleNoteText,
  noteTextHash,
  snapshotOf,
  snapshotBody,
  sameBody,
  newNoteText,
} from '../../renderer/lib/notes/noteFile';

const BOM = '﻿';

describe('readNoteText', () => {
  it('splits frontmatter and body and records BOM and line ending', () => {
    const t = readNoteText(`${BOM}---\r\ntitle: A\r\n---\r\nBody\r\n`);
    expect(t.frontmatter).toEqual({ title: 'A' });
    expect(t.body).toBe('Body\r\n');
    expect(t.hadBom).toBe(true);
    expect(t.eol).toBe('\r\n');
    expect(t.hasFrontmatter).toBe(true);
  });

  it('reads a note without frontmatter as all body', () => {
    const t = readNoteText('Just text\n');
    expect(t.hasFrontmatter).toBe(false);
    expect(t.body).toBe('Just text\n');
    expect(t.eol).toBe('\n');
  });
});

describe('assembleNoteText', () => {
  it('a frontmatter delta rewrites only its key; comments, order and the body survive', () => {
    const raw = '---\ntitle: T # the title\npriority: low\nextra: [a, b]\n---\nBody text\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: { priority: 'high' }, unset: [] } });
    expect(out).toBe('---\ntitle: T # the title\npriority: high\nextra: [a, b]\n---\nBody text\n');
  });

  it('a key another program added is kept, because the change applies to the fresh read', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\nB\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: { completed: true }, unset: [] } });
    expect(out).toContain('status: draft');
    expect(out).toContain('completed: true');
  });

  it('an unset removes the key', () => {
    const raw = '---\ntitle: T\ndue: 2026-01-01\n---\nB\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: {}, unset: ['due'] } });
    expect(out).toBe('---\ntitle: T\n---\nB\n');
  });

  it('a body change keeps the frontmatter block byte-for-byte', () => {
    const raw = '---\n# comment\ntitle:   "Spaced"\n---\nOld\n';
    const out = assembleNoteText(readNoteText(raw), { body: 'New' });
    expect(out).toBe('---\n# comment\ntitle:   "Spaced"\n---\nNew\n');
  });

  it('a body and a delta land together in one text', () => {
    const raw = '---\ntitle: T\n---\nOld\n';
    const out = assembleNoteText(readNoteText(raw), { body: 'New', delta: { set: { tags: ['x'] }, unset: [] } });
    expect(out).toBe('---\ntitle: T\ntags:\n  - x\n---\nNew\n');
  });

  it('keeps a BOM and writes a CRLF note back as CRLF throughout, body included', () => {
    const raw = `${BOM}---\r\ntitle: T\r\n---\r\nOld\r\n`;
    const out = assembleNoteText(readNoteText(raw), { body: 'Line one\nLine two' });
    expect(out).toBe(`${BOM}---\r\ntitle: T\r\n---\r\nLine one\r\nLine two\r\n`);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a CRLF note with a one-line frontmatter keeps CRLF on a metadata edit', () => {
    const raw = '---\r\ntitle: T\r\n---\r\nBody\r\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: { priority: 'low' }, unset: [] } });
    expect(out).toBe('---\r\ntitle: T\r\npriority: low\r\n---\r\nBody\r\n');
  });

  it('without a new body, the disk body is kept exactly (no editor round trip)', () => {
    const raw = '---\ntitle: T\n---\n_under_ and  two  spaces\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: { a: 1 }, unset: [] } });
    expect(out.endsWith('---\n_under_ and  two  spaces\n')).toBe(true);
  });

  it('an empty change reproduces the file', () => {
    const raw = `${BOM}---\r\ntitle: T # c\r\n---\r\nB\r\n`;
    expect(assembleNoteText(readNoteText(raw), {})).toBe(raw);
  });

  it('a note without frontmatter keeps its final newline when the body changes', () => {
    const out = assembleNoteText(readNoteText('Monday\n'), { body: 'Monday Tuesday' });
    expect(out).toBe('Monday Tuesday\n');
  });

  it('a frontmatter change keeps a body without a final newline byte-exact', () => {
    const out = assembleNoteText(readNoteText('---\ntitle: T\n---\nreal body'), { delta: { set: { a: 1 }, unset: [] } });
    expect(out).toBe('---\ntitle: T\na: 1\n---\nreal body');
  });

  it('a note without frontmatter and without a final newline stays that way', () => {
    const out = assembleNoteText(readNoteText('Monday'), { body: 'Monday Tuesday' });
    expect(out).toBe('Monday Tuesday');
  });

  it('refuses a metadata edit over unparseable YAML and keeps the block', () => {
    const raw = '---\ntitle: [unclosed\n---\nBody\n';
    const refused = vi.fn();
    const out = assembleNoteText(readNoteText(raw), { delta: { set: { a: 1 }, unset: [] } }, refused);
    expect(out).toBe(raw);
    expect(refused).toHaveBeenCalledOnce();
  });

  it('a body starting with a thematic break is not mistaken for frontmatter', () => {
    const raw = '---\ntitle: T\n---\n---\n\nAfter rule\n';
    const t = readNoteText(raw);
    expect(t.body).toBe('---\n\nAfter rule\n');
    expect(assembleNoteText(t, { delta: { set: { a: 1 }, unset: [] } })).toContain('---\n\nAfter rule\n');
  });
});

describe('hashes and snapshots', () => {
  it('matches the main-process watcher digest (FNV-1a over UTF-8 bytes)', () => {
    // FNV-1a 32 of "" is the offset basis; of "a" is 0xe40c292c.
    expect(noteTextHash('')).toBe('811c9dc5');
    expect(noteTextHash('a')).toBe('e40c292c');
    expect(noteTextHash('é')).not.toBe(noteTextHash('e'));
  });

  it('a snapshot remembers the bytes and gives back its body', () => {
    const t = readNoteText('---\ntitle: T\n---\nBody\n');
    const s = snapshotOf(t, 5, 22);
    expect(s.hash).toBe(noteTextHash(t.raw));
    expect(snapshotBody(s)).toBe('Body\n');
    expect(s.mtimeMs).toBe(5);
  });

  it('sameBody ignores line-ending style only', () => {
    expect(sameBody('a\r\nb', 'a\nb')).toBe(true);
    expect(sameBody('a\nb', 'a\nc')).toBe(false);
  });

  it('newNoteText writes title first as frontmatter', () => {
    expect(newNoteText({ title: 'What? / Why' }, '')).toBe('---\ntitle: What? / Why\n---\n\n');
  });
});
