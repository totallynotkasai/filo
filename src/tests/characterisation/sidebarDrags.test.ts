/**
 * Characterisation — dragging rows in the vault sidebar.
 *
 * A file or folder picked up and put back down where it was moves nothing and
 * leaves no drop highlight behind. A note in a folder put back on its own row
 * stays in its folder (the tree took it as a drop on the vault root and moved
 * it out). A real move into a folder clears the highlight too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor } from './harness/app';
import {
  dragIntoSidebarFolder,
  putBackInSidebar,
  revealInSidebar,
  sidebarDropHighlighted,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const FILES = {
  'Chapters/Inner.md': '# Inner\n',
  'Top.md': '# Top\n',
};

describe('sidebar drags leave nothing behind', () => {
  it('a folder put back where it was: no highlight, nothing moved', async () => {
    const app = await startApp(FILES);
    await putBackInSidebar(app, 'Chapters');
    expect(sidebarDropHighlighted(app)).toBe(false);
    expect(app.userFiles()).toEqual(['Chapters/Inner.md', 'Top.md']);
  });

  it('a note in a folder put back on its own row stays in its folder', async () => {
    const app = await startApp(FILES);
    await putBackInSidebar(app, 'Chapters/Inner.md');
    expect(sidebarDropHighlighted(app)).toBe(false);
    expect(app.userFiles()).toEqual(['Chapters/Inner.md', 'Top.md']);
  });

  it('a note at the vault root put back where it was: no highlight, nothing moved', async () => {
    const app = await startApp(FILES);
    await putBackInSidebar(app, 'Top.md');
    expect(sidebarDropHighlighted(app)).toBe(false);
    expect(app.userFiles()).toEqual(['Chapters/Inner.md', 'Top.md']);
  });

  it('a note dragged into a folder moves there and leaves no highlight', async () => {
    const app = await startApp(FILES);
    await dragIntoSidebarFolder(app, 'Top.md', 'Chapters');
    await waitFor(() => app.exists('Chapters/Top.md'), 'Top.md moved into Chapters');
    await revealInSidebar(app, 'Chapters/Top.md');
    expect(sidebarDropHighlighted(app)).toBe(false);
    expect(app.userFiles()).toEqual(['Chapters/Inner.md', 'Chapters/Top.md']);
  });
});
