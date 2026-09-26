/**
 * Characterisation — the vault is called a vault, and the keyboard reaches
 * the vault commands from anywhere.
 *
 * There is no native menu, so Ctrl+O opens a vault (from a board or Home, one
 * folder picker per press), Ctrl+Shift+W closes it, Ctrl+, opens Settings
 * and Ctrl+Shift+Z redoes like Ctrl+Y. Opening and closing save first and ask
 * before leaving anything unsaved behind, exactly as the buttons do. Help
 * lists all four.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, openVaultByShortcut, closeVaultByShortcut, recoveryCopies } from './harness/app';
import {
  $$,
  editors,
  typeAtEnd,
  createBoard,
  openNoteFromSidebar,
  mindMapTiles,
  pressShortcut,
  undo,
  goHome,
  homeShown,
  openModalTitle,
  closeModal,
  shortcutsListed,
  sidebarListing,
  click,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Note\n---\nFirst line\n';

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('wording', () => {
  it('Home explains a vault, and nothing there or in the vault menu says "project"', async () => {
    const app = await startApp({});
    expect(text(app.el.querySelector('.empty-workspace'))).toBe('Create or open a board');

    click($$(app.el, 'button.dropdown-trigger')[0]);
    await quiesce(100);
    const menu = $$(document, 'button.dropdown-item').map((b) => text(b));
    expect(menu).toEqual(expect.arrayContaining(['Rename Vault', 'Open Vault', 'Save', 'Settings']));
    pressShortcut('Escape');

    await goHome(app);
    const home = app.el.querySelector('.home-screen');
    expect(text(home?.querySelector('.home-explainer') ?? null)).toBe('A vault is a folder of your Markdown notes and board files.');
    expect(text(home?.querySelector('.return-card .action-title') ?? null)).toBe('Return to vault');
    expect(text(home)).toMatch(/Recent vaults|No recent vaults/);
    expect(text(home)).not.toMatch(/project/i);
    expect(menu.join(' ')).not.toMatch(/project/i);
  });
});

describe('vault shortcuts', () => {
  it('Help lists them, and Ctrl+S is plain "Save"', async () => {
    const app = await startApp({});
    await createBoard(app, 'mindmap');
    const rows = await shortcutsListed(app);
    expect(rows).toEqual(expect.arrayContaining([
      'Open Vault: Ctrl+O',
      'Close Vault: Ctrl+Shift+W',
      'Open Settings: Ctrl+,',
      'Redo (alternative): Ctrl+Shift+Z',
      'Save: Ctrl+S',
    ]));
    expect(rows.join('\n')).not.toMatch(/project/i);
  });

  it('Ctrl+Shift+Z redoes, like Ctrl+Y', async () => {
    const app = await startApp({});
    await createBoard(app, 'mindmap');
    pressShortcut('n', { ctrlKey: true });
    await waitFor(() => mindMapTiles(app).length === 1, 'a new tile');
    await undo(app);
    await waitFor(() => mindMapTiles(app).length === 0, 'the tile undone');

    pressShortcut('Z', { ctrlKey: true, shiftKey: true });
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile redone');
  });

  it('Ctrl+, opens Settings', async () => {
    const app = await startApp({});
    await createBoard(app, 'kanban');
    pressShortcut(',', { ctrlKey: true });
    await waitFor(() => openModalTitle() === 'Settings', 'the Settings dialog');
    await closeModal();
  });

  it('Ctrl+O on a board opens the picked vault', async () => {
    const app = await startApp({ 'Here.md': NOTE });
    await createBoard(app, 'mindmap');
    const result = await openVaultByShortcut(app, { 'There.md': NOTE });
    expect(result.done).toBe(true);
    expect(result.pickers).toBe(1);
    expect(result.dialogs).toEqual([]);
    expect(sidebarListing(app)).toEqual(['There.md']);
  });

  it('Ctrl+O on Home shows one folder picker, and the opened vault replaces Home', async () => {
    const app = await startApp({ 'Here.md': NOTE });
    await goHome(app);
    expect(homeShown(app)).toBe(true);

    const result = await openVaultByShortcut(app, { 'There.md': NOTE });
    expect(result.done).toBe(true);
    expect(result.pickers).toBe(1);
    expect(homeShown(app)).toBe(false);
    expect(sidebarListing(app)).toEqual(['There.md']);
  });

  it('Ctrl+N on Home over a Mind Map makes no tile on the hidden board', async () => {
    const app = await startApp({});
    await createBoard(app, 'mindmap');
    await goHome(app);
    pressShortcut('n', { ctrlKey: true });
    await quiesce(500);

    click(app.el.querySelector('.return-card') as HTMLElement);
    await quiesce(300);
    expect(mindMapTiles(app)).toHaveLength(0);
  });

  it('Ctrl+Shift+W from inside a note saves the typing first, then closes to Home', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' typed just now');

    const result = await closeVaultByShortcut(app);
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
    expect(app.read('Note.md')).toContain('typed just now');
    expect(homeShown(app)).toBe(true);
  });

  it("Ctrl+Shift+W asks when a change can't be saved, and Cancel stays in the vault", async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' unsaved words');
    app.deleteExternally('Note.md');

    const result = await closeVaultByShortcut(app, 'Cancel');
    expect(result.done).toBe(false);
    expect(result.dialogs).toHaveLength(1);
    expect(`${result.dialogs[0].message}\n${result.dialogs[0].detail ?? ''}`).toContain('Note.md');
    expect(recoveryCopies(app).size).toBe(0);
    expect(homeShown(app)).toBe(false);
  });
});
