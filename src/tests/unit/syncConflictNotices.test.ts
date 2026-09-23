import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Audit-19 ERR-3 / EXT-2 — sync-conflict notices: main detects a board fork /
 * a refused conflict-copy rename and sends `vault:sync-conflict`; the renderer
 * shows one sticky notice and postpones the original's "deleted externally"
 * prompt while its other version is being downloaded.
 */

const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}));

const { announceSyncConflicts, boardForkNotices, __resetSyncConflictNotifierForTests } = await import(
  '../../main/services/syncConflictNotifier'
);
const { listenForSyncConflicts, syncConflictToast } = await import('@renderer/lib/vault/syncConflictNotices');
const { reappearanceWindowRemaining, _resetAttachmentDeleteGraceForTests } = await import(
  '@renderer/lib/vault/externalChangeWindows'
);
const { uiStore } = await import('@renderer/stores/ui.svelte');

describe('main — sync conflict announcements', () => {
  beforeEach(() => {
    sent.length = 0;
    __resetSyncConflictNotifierForTests();
  });

  it('a board fork next to its canonical board is announced once', () => {
    const exists = (rel: string): boolean => ['Plan.board.json', 'Plan.board-DESKTOP-1A2B3C4.json'].includes(rel);
    const events = [{ type: 'tree' as const, filename: 'Plan.board-DESKTOP-1A2B3C4.json', eventType: 'rename' }];
    announceSyncConflicts('/vault', events, exists);
    announceSyncConflicts('/vault', events, exists);
    expect(sent).toEqual([
      {
        channel: 'vault:sync-conflict',
        payload: { copyPath: 'Plan.board-DESKTOP-1A2B3C4.json', canonicalPath: 'Plan.board.json', client: 'onedrive' },
      },
    ]);
  });

  it('a fork whose canonical board is absent is not a conflict', () => {
    const events = [{ type: 'tree' as const, filename: 'Plan.board-DESKTOP-1A2B3C4.json', eventType: 'rename' }];
    expect(boardForkNotices('/vault', events, (r) => r === 'Plan.board-DESKTOP-1A2B3C4.json')).toEqual([]);
  });

  it('the correlator-refused pairs are forwarded', () => {
    announceSyncConflicts('/vault', [], () => false, [
      { copyPath: 'Note-DESKTOP-1A2B3C4.md', canonicalPath: 'Note.md', client: 'onedrive' },
    ]);
    expect(sent).toHaveLength(1);
  });
});

describe('renderer — sync conflict notice', () => {
  let handler: ((...args: unknown[]) => void) | null = null;
  beforeEach(() => {
    _resetAttachmentDeleteGraceForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    (window as unknown as { filo: unknown }).filo = {
      invoke: async () => true,
      on: (_c: string, cb: (...args: unknown[]) => void) => { handler = cb; return () => { handler = null; }; },
      send: () => {},
    };
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  it('shows one sticky notice and postpones the original\'s delete prompt', () => {
    const off = listenForSyncConflicts(() => '/vault');
    handler!({ copyPath: 'Note-DESKTOP-1A2B3C4.md', canonicalPath: 'Note.md', client: 'onedrive' });
    const toast = uiStore.toasts.find((t) => t.dedupeKey === 'sync-conflict:note.md');
    expect(toast?.sticky).toBe(true);
    expect(toast?.text).toMatch(/Sync conflict: "Note.md"/);
    expect(toast?.actions?.map((a) => a.label)).toEqual(['Show in folder', 'Dismiss']);
    expect(reappearanceWindowRemaining('Note.md')).toBeGreaterThan(0);
    off();
  });

  it('a board fork names the client and the board', () => {
    const spec = syncConflictToast('/vault', [
      { copyPath: 'Plan.board-DESKTOP-1A2B3C4.json', canonicalPath: 'Plan.board.json', client: 'onedrive' },
    ]);
    expect(spec.text).toMatch(/OneDrive kept a conflicting copy of the board "Plan"/);
  });
});
