/**
 * Characterisation — spell check, turned off, stays off.
 *
 * The toolbar's Spelling button reached only the editors already open: a
 * note opened afterwards checked its spelling again (squiggles under every
 * invented name), and the choice was gone at the next launch. It now applies
 * to every editor, and is kept with the vault's layout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, reopenVault, waitFor, type CharApp } from './harness/app';
import {
  $$,
  editors,
  openNoteFromSidebar,
  spellCheckButtonOn,
  spellCheckedIn,
  toggleSpellCheck,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTES = {
  'Aria.md': '---\ntitle: Aria\n---\nAria Kasai rode north.\n',
  'Vel.md': '---\ntitle: Vel\n---\nThe Vel river.\n',
};

/** The editor of the Document tab showing now. */
function documentEditor(app: CharApp): ReturnType<typeof editors>[number] {
  const boards = $$(app.el, '.document-board');
  const [ed] = editors(boards[boards.length - 1]!);
  if (!ed) throw new Error('no Document editor');
  return ed;
}

describe('spell check turned off', () => {
  it('is off in a note opened afterwards, and after the vault is opened again', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Aria.md');
    expect(spellCheckedIn(documentEditor(app))).toBe(true);

    await toggleSpellCheck(app);
    expect(spellCheckButtonOn(app)).toBe(false);
    expect(spellCheckedIn(documentEditor(app))).toBe(false);

    await openNoteFromSidebar(app, 'Vel.md');
    expect(spellCheckedIn(documentEditor(app))).toBe(false);
    await waitFor(() => /"spellcheck": false/.test(app.read('.filo/workspace.json')), 'workspace.json keeps spell check off');

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Aria.md');
    expect(spellCheckButtonOn(app)).toBe(false);
    expect(spellCheckedIn(documentEditor(app))).toBe(false);
  });

  it('turned on again, is on everywhere, and the layout file no longer names it', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Aria.md');
    await toggleSpellCheck(app);
    await waitFor(() => /"spellcheck": false/.test(app.read('.filo/workspace.json')), 'workspace.json keeps spell check off');

    await toggleSpellCheck(app);
    expect(spellCheckButtonOn(app)).toBe(true);
    await openNoteFromSidebar(app, 'Vel.md');
    expect(spellCheckedIn(documentEditor(app))).toBe(true);
    await waitFor(() => !app.read('.filo/workspace.json').includes('spellcheck'), 'workspace.json back to its usual keys');
  });
});
