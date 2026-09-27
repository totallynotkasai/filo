/**
 * Characterisation — a note of scenes separated by rules keeps every scene.
 *
 * A note with no frontmatter that opens with a scene-break rule and has more
 * of them further down is saved so that its next read still shows every
 * scene, with no frontmatter made up from the first one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, reopenVault } from './harness/app';
import { openNoteFromSidebar, editors, typeAtEnd, $$ } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('scene breaks', () => {
  it('an edit keeps the first scene in the body after a reload', async () => {
    const app = await startApp({ 'Story.md': '***\n\nScene one.\n\n***\n\nScene two.\n' });
    await openNoteFromSidebar(app, 'Story.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' The end.');
    await quiesce();

    const saved = app.read('Story.md');
    expect(saved.startsWith('***')).toBe(true);
    expect(saved).toContain('Scene one.');
    expect(saved).toContain('Scene two. The end.');

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Story.md');
    const [again] = editors($$(app.el, '.document-board')[0]);
    expect(again.getText()).toContain('Scene one.');
    expect(again.getText()).toContain('Scene two. The end.');
  });
});
