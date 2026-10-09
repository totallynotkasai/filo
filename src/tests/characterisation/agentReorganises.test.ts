/**
 * Characterisation — another program (an AI agent, a script) reorganising the
 * vault while Filo is open: moving a note into a new folder and fixing its
 * links in the same moment, renaming a folder while it writes a new note into
 * it or edits or deletes one inside, merging one note into another.
 *
 * Every note follows its move: tabs and tiles name the new path, typing lands
 * in the moved note, and nothing says a note that only moved was deleted or
 * "no longer exists". Where the other program changed the text too, the one
 * question is Reload / Keep mine on the moved note, with the other side kept
 * in `.filo/recovery/`. A real delete still asks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, renameSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { startApp, stopApp, waitFor, quiesce, settle, recoveryCopies, type CharApp } from './harness/app';
import { onLinux } from './harness/platform';
import {
  createBoard,
  placeNoteOnBoard,
  openNoteFromSidebar,
  boardFilesText,
  editors,
  typeAtEnd,
  errorToasts,
  toastTexts,
  diskConflictPrompt,
  keepMine,
  reloadFromDisk,
  chooseToastAction,
  activeTabName,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const body = (title: string, text: string): string => `---\ntitle: ${title}\n---\n${text} ${'word '.repeat(30)}\n`;

function docText(app: CharApp): string {
  return editors($$(app.el, '.document-board')[0])[0]?.getText() ?? '';
}

function saidGone(): boolean {
  return toastTexts().some((t) => t.includes('was deleted by another program') || t.includes('no longer exists'));
}

function notes(app: CharApp): string[] {
  return app.userFiles().filter((f) => f.endsWith('.md'));
}

/** The agent's move: a new folder, the note moved into it, then rewritten, all within one moment. */
function moveAndFixLinks(app: CharApp, from: string, folder: string): string {
  const to = `${folder}/${from.split('/').pop()}`;
  mkdirSync(app.abs(folder), { recursive: true });
  renameSync(app.abs(from), app.abs(to));
  writeFileSync(app.abs(to), readFileSync(app.abs(to), 'utf-8').replace('Plot text', 'Plot text (links fixed)'));
  return to;
}

/** A note open in a Document tab and placed on a Mind Map, with typing not yet on disk. */
async function openWithTyping(app: CharApp, rel: string, typed: string): Promise<void> {
  await createBoard(app, 'mindmap');
  await placeNoteOnBoard(app, 'mindmap', rel);
  await openNoteFromSidebar(app, rel);
  await quiesce(800);
  await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], typed);
}

describe('a note moved into a new folder and edited in the same moment', () => {
  it('with typing in it: one Reload / Keep mine question on the moved note; Keep mine keeps both sides', async () => {
    const app = await startApp({ 'Plot.md': body('Plot', 'Plot text that only Plot holds.') });
    await openWithTyping(app, 'Plot.md', ' TYPED');
    moveAndFixLinks(app, 'Plot.md', '01 Story');

    await waitFor(() => diskConflictPrompt(), 'the Reload / Keep mine question');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('01 Story/Plot.md')), 'the tile to follow the move');
    expect(saidGone()).toBe(false);
    expect(errorToasts()).toEqual([]);
    expect(activeTabName(app)).toBe('Plot');
    // Nothing is written over the other program's edit until the answer.
    expect(app.read('01 Story/Plot.md')).toContain('links fixed');

    await keepMine();
    await waitFor(() => app.read('01 Story/Plot.md').includes('TYPED'), 'the typing in the moved note');
    expect(notes(app)).toEqual(['01 Story/Plot.md']);
    expect([...recoveryCopies(app).values()].some((t) => t.includes('links fixed'))).toBe(true);
    expect(boardFilesText(app).some((t) => /"filePath":\s*"Plot\.md"/.test(t))).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('with typing in it: Reload shows the other program\'s edit and keeps the typing in .filo/recovery', async () => {
    const app = await startApp({ 'Plot.md': body('Plot', 'Plot text that only Plot holds.') });
    await openWithTyping(app, 'Plot.md', ' TYPED');
    moveAndFixLinks(app, 'Plot.md', '01 Story');

    await waitFor(() => diskConflictPrompt(), 'the Reload / Keep mine question');
    await reloadFromDisk();
    await waitFor(() => docText(app).includes('links fixed'), 'the Document tab to show the other version');
    expect(docText(app)).not.toContain('TYPED');
    expect([...recoveryCopies(app).values()].some((t) => t.includes('TYPED'))).toBe(true);
    await quiesce(1500);
    expect(notes(app)).toEqual(['01 Story/Plot.md']);
    expect(app.read('01 Story/Plot.md')).not.toContain('TYPED');
    expect(saidGone()).toBe(false);
  });

  it('without typing: followed with no question, and the tab shows the edit', async () => {
    const app = await startApp({ 'Plot.md': body('Plot', 'Plot text that only Plot holds.') });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plot.md');
    await openNoteFromSidebar(app, 'Plot.md');
    await quiesce(800);
    moveAndFixLinks(app, 'Plot.md', '01 Story');

    await waitFor(() => docText(app).includes('links fixed'), 'the Document tab to show the edit');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('01 Story/Plot.md')), 'the tile to follow the move');
    await quiesce(1500);
    expect(toastTexts()).toEqual([]);
    expect(notes(app)).toEqual(['01 Story/Plot.md']);
  });
});

describe('a folder renamed by another program while its contents change', () => {
  const places = {
    'Places/Castle.md': body('Castle', 'Castle text.'),
    'Places/Forest.md': body('Forest', 'Forest text.'),
  };

  it('a new note written into it: the open note inside follows at once with its typing, and nothing asks', async () => {
    const app = await startApp(places);
    await openWithTyping(app, 'Places/Castle.md', ' TYPED');
    const t0 = Date.now();
    renameSync(app.abs('Places'), app.abs('04 Worldbuilding'));
    writeFileSync(app.abs('04 Worldbuilding/Lake.md'), body('Lake', 'Lake text.'));

    await waitFor(() => app.exists('04 Worldbuilding/Castle.md') && app.read('04 Worldbuilding/Castle.md').includes('TYPED'), 'the typing in the moved note');
    // Inside the 3 s a "deleted?" question waits before it asks.
    expect(Date.now() - t0).toBeLessThan(3000);
    await quiesce(4000);
    expect(toastTexts()).toEqual([]);
    expect(app.exists('Places/Castle.md')).toBe(false);
    expect(boardFilesText(app).some((t) => t.includes('04 Worldbuilding/Castle.md'))).toBe(true);
  });

  it('the open note in it edited too: the moved note asks Reload / Keep mine, never "no longer exists"', async () => {
    const app = await startApp({ 'Ideas/Plot.md': body('Plot', 'Plot text that only Plot holds.') });
    await openWithTyping(app, 'Ideas/Plot.md', ' TYPED');
    renameSync(app.abs('Ideas'), app.abs('01 Story'));
    writeFileSync(app.abs('01 Story/Plot.md'), readFileSync(app.abs('01 Story/Plot.md'), 'utf-8').replace('Plot text', 'Plot text (links fixed)'));

    await waitFor(() => diskConflictPrompt(), 'the Reload / Keep mine question');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('01 Story/Plot.md')), 'the tile to follow the move');
    await quiesce(4000);
    expect(saidGone()).toBe(false);
    await keepMine();
    await waitFor(() => app.read('01 Story/Plot.md').includes('TYPED'), 'the typing in the moved note');
    expect(notes(app)).toEqual(['01 Story/Plot.md']);
    expect(errorToasts()).toEqual([]);
  });

  it.skipIf(onLinux)('one of its notes deleted: the open note inside is found by the walk it asks for, inside the wait', async () => {
    const app = await startApp(places);
    await openWithTyping(app, 'Places/Castle.md', ' TYPED');
    const t0 = Date.now();
    renameSync(app.abs('Places'), app.abs('04 Worldbuilding'));
    rmSync(app.abs('04 Worldbuilding/Forest.md'));

    await waitFor(() => app.exists('04 Worldbuilding/Castle.md') && app.read('04 Worldbuilding/Castle.md').includes('TYPED'), 'the typing in the moved note');
    expect(Date.now() - t0).toBeLessThan(5000);
    await quiesce(4000);
    expect(saidGone()).toBe(false);
    expect(app.exists('Places/Castle.md')).toBe(false);
    expect(boardFilesText(app).some((t) => t.includes('04 Worldbuilding/Castle.md'))).toBe(true);
  });
});

describe('a note merged into another and deleted, with typing in it', () => {
  it('asks Keep mine / Discard, and the same-named note it went into is not taken for its move', async () => {
    const app = await startApp({
      'Ideas/Plot.md': body('Plot ideas', 'Ideas text.'),
      'Story/Plot.md': body('Plot', 'Story text.'),
    });
    await openWithTyping(app, 'Ideas/Plot.md', ' TYPED');
    // The agent appends the ideas to the story's note and deletes the ideas.
    writeFileSync(app.abs('Story/Plot.md'), `${app.read('Story/Plot.md')}\nIdeas text, merged.\n`);
    rmSync(app.abs('Ideas/Plot.md'));

    await waitFor(() => toastTexts().some((t) => t.includes('was deleted by another program')), 'the deleted question');
    await settle(50);
    expect(boardFilesText(app).some((t) => t.includes('Ideas/Plot.md'))).toBe(true);
    expect(app.read('Story/Plot.md')).not.toContain('TYPED');
    await chooseToastAction('Keep mine');
    await waitFor(() => app.exists('Ideas/Plot.md') && app.read('Ideas/Plot.md').includes('TYPED'), 'the typing written back');
    expect(app.read('Story/Plot.md')).toContain('Ideas text, merged.');
    expect(app.read('Story/Plot.md')).not.toContain('TYPED');
  });
});
