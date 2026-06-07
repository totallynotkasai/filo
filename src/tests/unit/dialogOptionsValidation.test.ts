import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Phase 8 / 8.4 — `dialog:choice` and `dialog:open-file` each accept an
 * `options` bag that is forwarded verbatim to `showMessageBox` /
 * `showOpenDialog`. Electron silently coerces (or ignores) garbage in
 * those fields, which used to mask a buggy renderer — the user sees an
 * oddly-rendered dialog instead of a real error.
 *
 * The validation runs at handler entry: a bad payload returns the same
 * sentinel the dialog would have returned on a user-dismiss (`-1` for
 * `dialog:choice`, `null` for `dialog:open-file`) so the renderer's
 * existing "cancelled" branch handles it without a new error path.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

// Track what gets handed to Electron after validation passes. The dialog
// mocks resolve immediately with a canceled response — we just want to
// confirm the handler reached the call (or didn't).
let lastMessageBoxOpts: unknown = null;
let lastOpenDialogOpts: unknown = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    // Audit-12 S1 — registerDialogHandlers now also registers the preload-internal
    // `vault:register-source-path` listener via ipcMain.on; stub it so the mock
    // doesn't throw `ipcMain.on is not a function` during registration.
    on: () => {},
    once: () => {},
  },
  BrowserWindow: {
    getFocusedWindow: () => ({}),
  },
  dialog: {
    showMessageBox: async (_win: unknown, opts: unknown) => {
      lastMessageBoxOpts = opts;
      return { response: 0 };
    },
    showOpenDialog: async (_win: unknown, opts: unknown) => {
      lastOpenDialogOpts = opts;
      return { canceled: true, filePaths: [] };
    },
  },
}));

const { registerDialogHandlers } = await import('../../main/ipc/dialog.ipc');

describe('dialog:* options validation (Phase 8 / 8.4)', () => {
  let choiceHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let openHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerDialogHandlers();
    const choice = handlers.get('dialog:choice');
    const open = handlers.get('dialog:open-file');
    if (!choice || !open) throw new Error('dialog handlers not registered');
    choiceHandler = choice;
    openHandler = open;
  });

  beforeEach(() => {
    lastMessageBoxOpts = null;
    lastOpenDialogOpts = null;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy?.mockRestore();
  });

  describe('dialog:choice', () => {
    it('accepts a well-formed options bag', async () => {
      const result = await choiceHandler(
        {},
        'Discard changes?',
        ['Save', 'Discard', 'Cancel'],
        { title: 'Confirm', defaultId: 0, cancelId: 2 },
      );
      expect(result).toBe(0);
      expect(lastMessageBoxOpts).not.toBeNull();
    });

    it('accepts omitted options entirely', async () => {
      const result = await choiceHandler({}, 'Pick one', ['A', 'B']);
      expect(result).toBe(0);
    });

    it('returns -1 when defaultId is a string ("0" instead of 0)', async () => {
      const result = await choiceHandler({}, 'x', ['A', 'B'], { defaultId: '0' });
      expect(result).toBe(-1);
      expect(lastMessageBoxOpts).toBeNull();
    });

    it('returns -1 when defaultId is negative', async () => {
      const result = await choiceHandler({}, 'x', ['A', 'B'], { defaultId: -1 });
      expect(result).toBe(-1);
      expect(lastMessageBoxOpts).toBeNull();
    });

    it('returns -1 when options contains an unknown field', async () => {
      const result = await choiceHandler({}, 'x', ['A', 'B'], { evil: 'inject' });
      expect(result).toBe(-1);
      expect(lastMessageBoxOpts).toBeNull();
    });
  });

  describe('dialog:open-file', () => {
    it('accepts a well-formed options bag with filters', async () => {
      const result = await openHandler({}, {
        title: 'Open',
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        multiSelect: false,
      });
      // Dialog mock returns canceled=true → handler returns null even when valid.
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).not.toBeNull();
    });

    it('accepts omitted options entirely', async () => {
      const result = await openHandler({});
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).not.toBeNull();
    });

    it('returns null when a filter is missing extensions', async () => {
      const result = await openHandler({}, {
        filters: [{ name: 'Bad' }], // no extensions
      });
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).toBeNull();
    });

    it('returns null when a filter has empty extensions array', async () => {
      const result = await openHandler({}, {
        filters: [{ name: 'Bad', extensions: [] }],
      });
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).toBeNull();
    });

    it('returns null when multiSelect is a string instead of boolean', async () => {
      const result = await openHandler({}, { multiSelect: 'yes' });
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).toBeNull();
    });

    it('returns null when options contains an unknown field', async () => {
      const result = await openHandler({}, { evil: 'inject' });
      expect(result).toBeNull();
      expect(lastOpenDialogOpts).toBeNull();
    });
  });
});
