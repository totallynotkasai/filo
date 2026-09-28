/**
 * Characterisation — a vault synced between machines (Syncthing): changes
 * arrive from outside as plain file operations, seen through the real
 * watcher.
 *
 * A moved attachment of any kind keeps its tags; the sync client's
 * `.stversions/` archive never shows up in the vault's tags.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import { openTagsBrowser, tagsBrowserRows, errorToasts } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const DOCX = 'PK'.padEnd(600, 'x');

function fileTagKeys(read: (rel: string) => string): string[] {
  const parsed = JSON.parse(read('.filo/tags.json')) as { fileTags: Record<string, string[]> };
  return Object.keys(parsed.fileTags).map((k) => k.toLowerCase()).sort();
}

describe('an attachment moved by another program', () => {
  it('a tagged Report.docx keeps its tag at the new path', async () => {
    const app = await startApp({
      'Report.docx': DOCX,
      '.filo/tags.json': JSON.stringify({ version: 1, tags: { work: { color: '#3a86ff' } }, fileTags: { 'Report.docx': ['work'] } }),
    });
    await quiesce();

    app.renameExternally('Report.docx', 'Archive/Report.docx');

    await waitFor(() => fileTagKeys(app.read).includes('archive/report.docx'), 'the tag entry to follow the move');
    await quiesce(2500);
    expect(fileTagKeys(app.read)).toEqual(['archive/report.docx']);
    expect(errorToasts()).toEqual([]);
  });
});

describe('the sync client\'s archive folder', () => {
  it('an old version under .stversions adds no tag to the vault', async () => {
    const app = await startApp({ 'Note.md': '---\ntags: [real]\n---\nBody\n' });
    await quiesce();

    app.writeExternally('.stversions/Note~20260928-101112.md', '---\ntags: [ghost]\n---\nOld body\n');
    app.writeExternally('Other.md', '---\ntags: [later]\n---\nBody\n');

    await openTagsBrowser();
    await waitFor(() => tagsBrowserRows().includes('later'), 'the note created alongside it to be indexed');
    expect(tagsBrowserRows()).not.toContain('ghost');
    expect(tagsBrowserRows()).toContain('real');
  });
});
