import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Sync-conflict notices: main detects a board fork /
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

const { announceSyncConflicts, boardForkNotices, noteConflictNotices, __resetSyncConflictNotifierForTests } = await import(
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

  it("a note's conflict copy beside its note is announced, once", () => {
    const copy = 'Book/Chapter.sync-conflict-20261004-120000-ABCDEFG.md';
    const exists = (rel: string): boolean => ['Book/Chapter.md', copy].includes(rel);
    const events = [{ type: 'document' as const, filename: copy, eventType: 'rename' }];
    announceSyncConflicts('/vault', events, exists);
    announceSyncConflicts('/vault', events, exists);
    expect(sent).toEqual([
      { channel: 'vault:sync-conflict', payload: { copyPath: copy, canonicalPath: 'Book/Chapter.md', client: 'syncthing' } },
    ]);
  });

  it('a numbered note, or a copy whose note is gone, is not announced', () => {
    const events = [
      { type: 'document' as const, filename: 'Chapter 2.md', eventType: 'rename' },
      { type: 'document' as const, filename: 'Chapter (1).md', eventType: 'rename' },
      { type: 'document' as const, filename: 'Lost.sync-conflict-20261004-120000-ABCDEFG.md', eventType: 'rename' },
    ];
    const exists = (rel: string): boolean => rel !== 'Lost.md';
    expect(noteConflictNotices('/vault', events, exists)).toEqual([]);
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
    expect(toast?.text).toMatch(/OneDrive kept two versions of the note "Note.md": the other is Note-DESKTOP-1A2B3C4.md/);
    expect(toast?.actions?.map((a) => a.label)).toEqual(['Open the copy', 'Show in folder', 'Dismiss']);
    expect(reappearanceWindowRemaining('Note.md')).toBeGreaterThan(0);
    off();
  });

  it("a note's notice names the copy and opens it", async () => {
    const spec = syncConflictToast('/vault', [
      { copyPath: 'Chapter.sync-conflict-20261004-120000-ABCDEFG.md', canonicalPath: 'Chapter.md', client: 'syncthing' },
    ]);
    expect(spec.text).toBe(
      'Syncthing kept two versions of the note "Chapter.md": the other is Chapter.sync-conflict-20261004-120000-ABCDEFG.md. ' +
        'Filo shows Chapter.md and leaves the copy alone; open the copy to take what you need from it.',
    );
    const { tabStore } = await import('@renderer/stores/tabs.svelte');
    const openNote = vi.spyOn(tabStore, 'openNote').mockImplementation(() => undefined as never);
    spec.actions.find((a) => a.label === 'Open the copy')!.handler();
    expect(openNote.mock.calls[0]?.[0]).toBe('Chapter.sync-conflict-20261004-120000-ABCDEFG.md');
    openNote.mockRestore();
  });

  it("an attachment's copy is named as a file, with nothing to open in Filo", () => {
    const spec = syncConflictToast('/vault', [
      { copyPath: 'photo-DESKTOP-1A2B3C4.png', canonicalPath: 'photo.png', client: 'onedrive' },
    ]);
    expect(spec.text).toMatch(/^OneDrive kept two versions of the file "photo.png"/);
    expect(spec.actions.map((a) => a.label)).toEqual(['Show in folder', 'Dismiss']);
  });

  it('a board fork names the client and the board', () => {
    const spec = syncConflictToast('/vault', [
      { copyPath: 'Plan.board-DESKTOP-1A2B3C4.json', canonicalPath: 'Plan.board.json', client: 'onedrive' },
    ]);
    expect(spec.text).toMatch(/OneDrive kept a conflicting copy of the board "Plan"/);
  });
});
