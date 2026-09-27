/**
 * Characterisation: the sidebar's Hide Vault button hides the sidebar and
 * leaves the vault open, docked or floating. The toolbar's sidebar toggle,
 * right after Undo / Redo in the global toolbar, brings it back, and the
 * hidden state is saved per machine so it survives a restart.
 * Closing the vault is Ctrl+Shift+W; the vault menu has no item for it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp } from './harness/app';
import {
  sidebarView,
  hideVault,
  hideVaultReachable,
  floatSidebar,
  toolbarToggleState,
  clickToolbarToggle,
  vaultMenuItems,
  closeVaultWithShortcut,
  savedSidebarState,
  resetSidebar,
} from './harness/sidebar';

afterEach(async () => {
  await resetSidebar();
  await stopApp();
});

describe('Hide Vault', () => {
  it('hides the docked sidebar without closing the vault, and the toolbar toggle brings it back', async () => {
    const app = await startApp({ 'Note.md': 'Hello\n' });
    expect(sidebarView(app)).toBe('docked');
    expect(toolbarToggleState(app)).toEqual({ shown: true, afterRedo: true, pressed: true });

    await hideVault(app);
    expect(sidebarView(app)).toBe('hidden');
    expect(hideVaultReachable(app)).toBe(false);
    // The vault is still open: its toolbar toggle is still there.
    expect(toolbarToggleState(app)).toEqual({ shown: true, afterRedo: true, pressed: false });
    expect((await savedSidebarState()).open).toBe(false);

    await clickToolbarToggle(app);
    expect(sidebarView(app)).toBe('docked');
    expect((await savedSidebarState()).open).toBe(true);
  });

  it('hides the floating panel too, and it comes back floating', async () => {
    const app = await startApp({ 'Note.md': 'Hello\n' });
    await floatSidebar(app, true);
    expect(sidebarView(app)).toBe('floating');

    await hideVault(app);
    expect(sidebarView(app)).toBe('hidden');
    expect(await savedSidebarState()).toMatchObject({ open: false, floating: true });

    await clickToolbarToggle(app);
    expect(sidebarView(app)).toBe('floating');
  });
});

describe('closing the vault', () => {
  it('is not in the vault menu; Ctrl+Shift+W closes it, and the sidebar toggle goes with the vault', async () => {
    const app = await startApp({ 'Note.md': 'Hello\n' });
    expect(await vaultMenuItems(app)).not.toContain('Close Vault');
    await closeVaultWithShortcut();
    expect(toolbarToggleState(app).shown).toBe(false);
  });
});
