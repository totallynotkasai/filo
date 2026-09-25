/**
 * Characterisation — the Tags browser's vault-wide delete and rename can be
 * undone from the toast that reports them.
 *
 * Undo of a delete puts the tag back in exactly the notes the delete
 * rewrote, on each note as it stands then (an edit made in between is kept),
 * and brings back the tag's colour. Undo of a rename renames it back. A
 * rename into an existing tag merges the two and offers no Undo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import {
  deleteTagEverywhere,
  renameTagEverywhere,
  chooseToastAction,
  toastActions,
  closeModal,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const tagsJson = (colors: Record<string, string>): string =>
  JSON.stringify({
    version: 1,
    tags: Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, { color }])),
    fileTags: {},
  });

describe('tag delete, then Undo', () => {
  it('puts the tag back in exactly the notes it was taken from, keeping edits made in between', async () => {
    const a = '---\ntitle: A\ntags:\n  - work\n---\nBody A\n';
    const b = '---\ntitle: B\ntags: [home, work]\n---\nBody B\n';
    const c = '---\ntitle: C\ntags: [home]\n---\nBody C\n';
    const app = await startApp({ 'A.md': a, 'B.md': b, 'C.md': c });

    await deleteTagEverywhere(app, 'work');
    await waitFor(() => !app.read('A.md').includes('work') && !app.read('B.md').includes('work'), 'the tag gone from both notes');
    expect(app.read('C.md')).toBe(c);
    expect(toastActions()).toContain('Undo');

    // Another program edits A's body before the user clicks Undo.
    const edited = app.read('A.md').replace('Body A', 'Body A, edited elsewhere');
    app.writeExternally('A.md', edited);
    await quiesce(800);

    await chooseToastAction('Undo');
    await waitFor(() => app.read('A.md').includes('work') && app.read('B.md').includes('work'), 'the tag back in both notes');
    expect(app.read('A.md')).toContain('Body A, edited elsewhere');
    expect(app.read('A.md')).toBe('---\ntitle: A\ntags:\n  - work\n---\nBody A, edited elsewhere\n');
    // B comes back with the same tags and body; the tag list may be re-written
    // in block style.
    expect(app.read('B.md')).toMatch(/^---\ntitle: B\ntags:(?: \[home, work\]|\n  - home\n  - work)\n---\nBody B\n$/);
    expect(app.read('C.md')).toBe(c);
  });

  it('brings back the tag with its colour', async () => {
    const app = await startApp({
      'A.md': '---\ntitle: A\ntags: [work]\n---\nBody\n',
      '.filo/tags.json': tagsJson({ work: '#123456' }),
    });

    await deleteTagEverywhere(app, 'work');
    await waitFor(() => !app.read('A.md').includes('work'), 'the tag gone');
    await chooseToastAction('Undo');
    await waitFor(() => app.read('A.md').includes('work'), 'the tag back');
    await waitFor(() => app.read('.filo/tags.json').includes('#123456'), 'the colour back in tags.json');
    expect(JSON.parse(app.read('.filo/tags.json')).tags.work.color).toBe('#123456');
  });
});

describe('tag rename, then Undo', () => {
  it('renames the tag back in every note', async () => {
    const a = '---\ntitle: A\ntags:\n  - old\n  - other\n---\nBody A\n';
    const b = '---\ntitle: B\ntags: [old]\n---\nBody B\n';
    const app = await startApp({ 'A.md': a, 'B.md': b });

    await renameTagEverywhere(app, 'old', 'fresh');
    await waitFor(() => app.read('B.md').includes('fresh'), 'the rename on disk');
    await closeModal();
    await chooseToastAction('Undo');
    await waitFor(() => app.read('A.md') === a && app.read('B.md') === b, 'both notes back to the old name');
  });

  it('a rename into an existing tag (a merge) offers no Undo', async () => {
    const app = await startApp({
      'A.md': '---\ntitle: A\ntags: [draft]\n---\nBody\n',
      'B.md': '---\ntitle: B\ntags: [final]\n---\nBody\n',
    });

    const renaming = renameTagEverywhere(app, 'draft', 'final');
    // The merge asks first; confirm it.
    await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'the merge confirm');
    const confirmBtn = document.querySelector('.confirm-dialog .confirm-actions .confirm-btn:not(.cancel):not(.secondary)') as HTMLElement;
    confirmBtn.click();
    await renaming;
    await waitFor(() => app.read('A.md').includes('final'), 'the merge on disk');
    await quiesce(500);
    expect(toastActions()).not.toContain('Undo');
  });
});
