/**
 * Characterisation — a Document tab's zoom.
 *
 * The zoom control on a Document tab sets one level for every note. It is
 * kept with the vault's layout, so a note opened later, or the vault opened
 * again, shows at the same size; back at 100% the layout file no longer
 * names it. Zooming writes nothing to the note.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, reopenVault, waitFor } from './harness/app';
import { clickDocumentZoom, documentZoomShown, openNoteFromSidebar } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const ARIA = '---\ntitle: Aria\n---\nAria Kasai rode north.\n';
const NOTES = {
  'Aria.md': ARIA,
  'Vel.md': '---\ntitle: Vel\n---\nThe Vel river.\n',
};

describe('Document tab zoom', () => {
  it('is kept for every note and for the next time the vault opens', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Aria.md');
    expect(documentZoomShown(app)).toEqual({ label: '100%', cssZoom: '' });

    await clickDocumentZoom(app, 'Zoom in');
    await clickDocumentZoom(app, 'Zoom in');
    expect(documentZoomShown(app)).toEqual({ label: '125%', cssZoom: '1.25' });
    await waitFor(() => /"documentZoom": 1.25/.test(app.read('.filo/workspace.json')), 'workspace.json keeps the zoom');

    await openNoteFromSidebar(app, 'Vel.md');
    expect(documentZoomShown(app).label).toBe('125%');

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Aria.md');
    expect(documentZoomShown(app)).toEqual({ label: '125%', cssZoom: '1.25' });
    expect(app.read('Aria.md')).toBe(ARIA);
  });

  it('back at 100%, the layout file no longer names it', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Aria.md');
    await clickDocumentZoom(app, 'Zoom out');
    expect(documentZoomShown(app).label).toBe('90%');
    await waitFor(() => /"documentZoom": 0.9/.test(app.read('.filo/workspace.json')), 'workspace.json keeps the zoom');

    await clickDocumentZoom(app, 'level');
    expect(documentZoomShown(app)).toEqual({ label: '100%', cssZoom: '' });
    await waitFor(() => !app.read('.filo/workspace.json').includes('documentZoom'), 'workspace.json back to its usual keys');
  });
});
