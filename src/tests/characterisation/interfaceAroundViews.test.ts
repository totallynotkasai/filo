/**
 * Characterisation — the interface around the views, after Audit-28 Phase 5:
 *
 * - Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab work while typing, and the edit ends
 *   first; Ctrl+Shift+F opens Search from a text field;
 * - Escape closes the Search panel wherever the focus is, once whatever lies
 *   above it (a menu, a title being edited) has had the key;
 * - the toolbar has a Settings button, and every Settings tab says how it
 *   saves; Current Board says why it is off for a note;
 * - the formatting toolbar shows disabled with no editor to act on;
 * - focus moving into a split pane makes it the active one;
 * - a Mind Map remembers its minimap per board, after reopening too;
 * - "Copy link to …" puts a link on the clipboard, and a link to a note in a
 *   note opens it;
 * - at a laptop width the docked sidebar pushes the workspace aside.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, reopenVault } from './harness/app';
import {
  activeTabName,
  addMindMapTextTile,
  closeModal,
  createBoard,
  mindMapTiles,
  openNoteFromSidebar,
  openTabs,
  quickAddTask,
  sidebarRow,
  splitActiveTabRight,
  startTaskTitleEdit,
  taskRows,
} from './harness/actions';
import {
  activePaneIndex,
  clickMindMapCanvas,
  contextMenuOpen,
  copyLinkFromMenu,
  currentBoardTab,
  focusNoteText,
  focusPane,
  focusQuickAdd,
  followLinkInNote,
  formattingControlsEnabled,
  minimapShown,
  openCanvasMenu,
  openSearchPanel,
  openSettingsFromToolbar,
  pressEscape,
  recordClipboard,
  savedWorkspace,
  searchPanelOpen,
  setWindowWidth,
  settingsSavingRules,
  showTab,
  spellingButtonEnabled,
  toggleMinimap,
  toggleSidebarFromToolbar,
  workspacePushedBy,
} from './harness/interfaceChrome';
import { pressAtFocus, typeAtFocus } from './harness/typingFocus';

const startWidth = window.innerWidth;

afterEach(async () => {
  await setWindowWidth(startWidth);
  await stopApp();
});

const note = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}\n`;

describe('the interface around the views', () => {
  it('Ctrl+W while a task title is being typed closes the tab and keeps the title', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'Alpha');
    const row = taskRows(app).find((r) => r.title === 'Alpha');
    if (!row) throw new Error('no Alpha row');
    await startTaskTitleEdit(row.el);
    await typeAtFocus(' two');
    await pressAtFocus('w', { ctrlKey: true });
    await waitFor(() => openTabs(app).length === 0, 'the tab to close');
    await quiesce(800);
    const saved = app.userFiles().filter((f) => f.endsWith('.md')).map((f) => app.read(f));
    expect(saved.some((text) => text.includes('title: Alpha two')), `${rel}: ${saved.join(' | ')}`).toBe(true);
  });

  it('Ctrl+Tab and Ctrl+Shift+Tab switch tabs from inside a note, which keeps what was typed', async () => {
    const app = await startApp({ 'One.md': note('One', 'First.'), 'Two.md': note('Two', 'Second.') });
    await openNoteFromSidebar(app, 'One.md');
    await openNoteFromSidebar(app, 'Two.md');
    await focusNoteText(app);
    await typeAtFocus('More ');
    await pressAtFocus('Tab', { ctrlKey: true });
    expect(activeTabName(app)).toBe('One');
    await quiesce(800);
    expect(app.read('Two.md')).toContain('Second.More');
    await focusNoteText(app);
    await pressAtFocus('Tab', { ctrlKey: true, shiftKey: true });
    expect(activeTabName(app)).toBe('Two');
  });

  it('Ctrl+Shift+F opens Search from the quick-add box', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await focusQuickAdd(app);
    await openSearchPanel();
    expect(searchPanelOpen()).toBe(true);
  });

  it('Escape closes the Search panel once a click on the board has taken the focus out of it', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await openSearchPanel();
    await clickMindMapCanvas(app);
    expect(searchPanelOpen()).toBe(true);
    await pressEscape();
    expect(searchPanelOpen()).toBe(false);
  });

  it('Escape closes a menu or ends a title edit before it closes the Search panel', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await openSearchPanel();
    await clickMindMapCanvas(app);
    await openCanvasMenu(app);
    await pressEscape();
    expect(contextMenuOpen()).toBe(false);
    expect(searchPanelOpen()).toBe(true);

    await addMindMapTextTile(app, { keepOpen: true });
    await typeAtFocus('Siege');
    await pressEscape();
    expect(mindMapTiles(app).map((t) => t.title)).toContain('Siege');
    expect(searchPanelOpen()).toBe(true);

    await pressEscape();
    expect(searchPanelOpen()).toBe(false);
  });

  it('the toolbar opens Settings, and every tab says how it saves', async () => {
    const app = await startApp();
    await openSettingsFromToolbar(app);
    expect(await settingsSavingRules()).toEqual({
      General: 'Changes here save as you make them.',
      'Global Defaults': 'No changes. Changes here wait for Apply.',
      Themes: 'Picking a theme applies it at once. The theme editor saves when you click Save.',
      Trash: 'Restore and Empty trash act at once.',
    });
    await closeModal();
  });

  it("Settings' Current Board says why it is off while a note is shown", async () => {
    const app = await startApp({ 'Plan.md': note('Plan', 'Text.') });
    await openNoteFromSidebar(app, 'Plan.md');
    await openSettingsFromToolbar(app);
    expect(currentBoardTab()).toEqual({
      enabled: false,
      hint: 'A note has no board settings: its page follows Global Defaults → Document',
    });
    await closeModal();
  });

  it('the formatting toolbar is disabled with no editor to act on, and Spelling stays', async () => {
    const app = await startApp({ 'Plan.md': note('Plan', 'Text.') });
    expect(formattingControlsEnabled(app)).toBe(false);
    expect(spellingButtonEnabled(app)).toBe(true);
    await openNoteFromSidebar(app, 'Plan.md');
    await focusNoteText(app);
    expect(formattingControlsEnabled(app)).toBe(true);
  });

  it('focus moving into a split pane makes it the active pane', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await splitActiveTabRight(app);
    await focusPane(app, 0);
    expect(activePaneIndex(app)).toBe(0);
    await focusPane(app, 1);
    expect(activePaneIndex(app)).toBe(1);
  });

  it('a Mind Map remembers its minimap, for that board only, after reopening the vault too', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await toggleMinimap(app);
    expect(minimapShown(app)).toBe(false);
    await createBoard(app, 'mindmap');
    expect(minimapShown(app)).toBe(true);
    await showTab(app, 'Mind Map 1');
    expect(minimapShown(app)).toBe(false);
    await quiesce(800);
    expect(Object.values(savedWorkspace(app).mindMapPanels as Record<string, unknown>)).toEqual([{ minimap: false, waypoints: true }]);

    await reopenVault(app);
    await showTab(app, 'Mind Map 2');
    expect(minimapShown(app)).toBe(true);
    await showTab(app, 'Mind Map 1');
    expect(minimapShown(app)).toBe(false);
  });

  it('Copy link to tile and to note put a link on the clipboard, and a link to a note opens it', async () => {
    const clip = recordClipboard();
    try {
      const app = await startApp({
        'Other.md': note('Other', 'The other note.'),
        'Hub.md': note('Hub', 'See [the other one](filo://note/Other.md).'),
      });
      await createBoard(app, 'mindmap');
      await addMindMapTextTile(app, { title: 'Siege' });
      const tile = mindMapTiles(app).find((t) => t.title === 'Siege');
      if (!tile) throw new Error('no Siege tile');
      await copyLinkFromMenu(app, tile.el, 'Copy link to tile');
      expect(clip.text()).toMatch(/^filo:\/\/tile\/[\w-]+\/[\w-]+$/);
      expect(clip.html()).toBe(`<a href="${clip.text()}">Siege</a>`);

      await copyLinkFromMenu(app, sidebarRow(app, 'Other.md'), 'Copy link to note');
      expect(clip.text()).toBe('filo://note/Other.md');

      await openNoteFromSidebar(app, 'Hub.md');
      await followLinkInNote(app, 'the other one');
      await waitFor(() => activeTabName(app) === 'Other', 'the linked note to open');
    } finally {
      clip.restore();
    }
  });

  it('at a laptop width the docked sidebar pushes the workspace aside instead of covering it', async () => {
    const app = await startApp({ 'Plan.md': note('Plan', 'Shikara working.') });
    await openNoteFromSidebar(app, 'Plan.md');
    await setWindowWidth(1100);
    expect(workspacePushedBy(app)).toBe('240px');
    // At 1,366 the page already clears the sidebar, which lies over the workspace.
    await setWindowWidth(1366);
    expect(workspacePushedBy(app)).toBe('');
    await setWindowWidth(1280);
    expect(workspacePushedBy(app)).toBe('240px');
    await toggleSidebarFromToolbar(app);
    expect(workspacePushedBy(app)).toBe('');
    await toggleSidebarFromToolbar(app);
  });
});
