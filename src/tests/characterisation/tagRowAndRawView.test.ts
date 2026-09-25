/**
 * Characterisation — the tag row and the raw view of a note (Document tab).
 *
 * The tag row edits the note's frontmatter `tags:` and nothing else in the
 * file; board undo takes an edit back. The raw view shows the whole file,
 * frontmatter included, and saves it as typed, keeping the file's BOM and line
 * endings. A raw save never overwrites a change made elsewhere unseen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import {
  openNoteFromSidebar,
  tagRowTags,
  typeInTagRow,
  removeFromTagRow,
  toggleRawView,
  rawTextArea,
  editRawText,
  rawConflictShown,
  chooseRawConflict,
  undo,
  editors,
  $,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('tag row', () => {
  it('shows the note tags, and adding comma-separated tags writes only the tags key', async () => {
    const note = '---\ntitle: Plan\npriority: high # keep\ntags:\n  - work\n---\nBody text\n';
    const app = await startApp({ 'Plan.md': note });
    await openNoteFromSidebar(app, 'Plan.md');
    expect(tagRowTags(app)).toEqual(['work']);

    await typeInTagRow(app, 'alpha, #beta');
    await waitFor(() => app.read('Plan.md').includes('beta'), 'the new tags on disk');
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\npriority: high # keep\ntags:\n  - work\n  - alpha\n  - beta\n---\nBody text\n');
    expect(tagRowTags(app)).toEqual(['work', 'alpha', 'beta']);
  });

  it('removing a tag writes it out of the frontmatter, and board undo puts it back', async () => {
    const note = '---\ntitle: Plan\ntags: [work, home]\n---\nBody text\n';
    const app = await startApp({ 'Plan.md': note });
    await openNoteFromSidebar(app, 'Plan.md');

    await removeFromTagRow(app, 'work');
    await waitFor(() => !app.read('Plan.md').includes('work'), 'the tag gone from disk');
    expect(tagRowTags(app)).toEqual(['home']);
    expect(app.read('Plan.md')).toContain('Body text');

    await undo(app);
    await waitFor(() => app.read('Plan.md').includes('work'), 'the tag back on disk');
    expect(tagRowTags(app).sort()).toEqual(['home', 'work']);
  });

  it('removing the last tag removes the key', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\ntags: [solo]\n---\nBody\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await removeFromTagRow(app, 'solo');
    await waitFor(() => app.read('Plan.md') === '---\ntitle: Plan\n---\nBody\n', 'the tags key gone');
  });
});

describe('raw view', () => {
  it('shows the whole file and saves an edit to the frontmatter and body as typed', async () => {
    const note = '---\ntitle: Plan\ntags: [work]\n---\nBody text\n';
    const app = await startApp({ 'Plan.md': note });
    await openNoteFromSidebar(app, 'Plan.md');

    await toggleRawView(app);
    expect((await rawTextArea(app)).value).toBe(note);

    const edited = '---\ntitle: Plan v2\ntags: [work]\nstatus: draft\n---\nBody text, edited raw\n';
    await editRawText(app, edited);
    await waitFor(() => app.read('Plan.md') === edited, 'the raw edit on disk');

    await toggleRawView(app);
    await waitFor(() => editors(app.el)[0]?.getText().includes('edited raw') ?? false, 'the editor to show the raw edit');
  });

  it('keeps the file BOM and CRLF line endings', async () => {
    const note = '\uFEFF---\r\ntitle: Win\r\n---\r\nLine one\r\nLine two\r\n';
    const app = await startApp({ 'Win.md': note });
    await openNoteFromSidebar(app, 'Win.md');
    await toggleRawView(app);
    expect((await rawTextArea(app)).value).toBe('---\ntitle: Win\n---\nLine one\nLine two\n');

    await editRawText(app, '---\ntitle: Win\n---\nLine one\nLine 2\n');
    await waitFor(() => app.read('Win.md').includes('Line 2'), 'the raw edit on disk');
    expect(app.read('Win.md')).toBe('\uFEFF---\r\ntitle: Win\r\n---\r\nLine one\r\nLine 2\r\n');
  });

  it('follows a change made elsewhere while nothing is typed in it', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nOld\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await rawTextArea(app);

    app.writeExternally('Plan.md', '---\ntitle: Plan\n---\nNew from elsewhere\n');
    await waitFor(() => $(app.el, '.document-board .raw-text').matches('textarea') && (app.el.querySelector('.document-board .raw-text') as HTMLTextAreaElement).value.includes('New from elsewhere'), 'the raw view to follow');
  });

  it('a change made elsewhere during a raw edit is not overwritten; Keep mine backs it up first', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nOriginal\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    const ta = await rawTextArea(app);

    // The user starts typing, then another program changes the file.
    ta.focus();
    ta.value = '---\ntitle: Plan\n---\nMine\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await quiesce(200);
    app.writeExternally('Plan.md', '---\ntitle: Plan\n---\nTheirs\n');
    await quiesce(1200);

    ta.blur();
    await waitFor(() => rawConflictShown(app), 'the raw conflict banner');
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\n---\nTheirs\n');

    await chooseRawConflict(app, 'Keep mine');
    await waitFor(() => app.read('Plan.md') === '---\ntitle: Plan\n---\nMine\n', 'my version on disk');
    // Their version was copied to .filo/recovery/ before mine replaced it.
    expect(app.bridge.calls.some((c) => c.channel === 'recovery:snapshot')).toBe(true);
  });
});
