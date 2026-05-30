import { ipcMain, dialog, BrowserWindow } from 'electron';
import { z } from 'zod';
import { logMainError } from '../utils/mainLogger';

/**
 * Phase 8 / 8.4 — narrow validation for the `dialog:*` options bag.
 *
 * Electron's `showMessageBox` / `showOpenDialog` are forgiving when the
 * caller hands them garbage (a string where `defaultId` should be a
 * number, etc.) and either coerce or silently ignore the bad field. That
 * forgiveness used to be a backstop, but a Zod gate at handler entry
 * gives a typed `BAD_DIALOG_OPTIONS` rejection that the renderer can
 * surface as a real error instead of a confusingly-mis-rendered dialog.
 */
const DialogChoiceOptionsSchema = z
  .object({
    title: z.string().optional(),
    detail: z.string().optional(),
    defaultId: z.number().int().nonnegative().optional(),
    cancelId: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const DialogOpenFileOptionsSchema = z
  .object({
    title: z.string().optional(),
    filters: z
      .array(
        z
          .object({
            name: z.string().min(1),
            // `extensions: ['*']` is Electron's "all files" wildcard; allow it.
            extensions: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .optional(),
    multiSelect: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Registers native dialog IPC handlers.
 */
export function registerDialogHandlers(): void {
  /**
   * Shows a confirmation dialog. Returns true if the user clicked "OK"/"Yes".
   */
  ipcMain.handle(
    'dialog:confirm',
    async (_event, message: string, title?: string, detail?: string) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return false;

      const result = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        cancelId: 1,
        title: title || 'Confirm',
        message,
        detail,
      });

      return result.response === 0;
    },
  );

  /**
   * Multi-button choice dialog. Returns the 0-based index of the button the
   * user clicked, or -1 if the dialog closed without a selection (Esc / X).
   *
   * Phase 31 A2.1 — backs the three-way "Save / Don't Save / Cancel" prompt
   * on vault swap so each branch can be wired distinctly (Save: flush;
   * Don't Save: preserve sentinel; Cancel: abort the swap entirely).
   */
  ipcMain.handle(
    'dialog:choice',
    async (
      _event,
      message: string,
      buttons: string[],
      options?: { title?: string; detail?: string; defaultId?: number; cancelId?: number },
    ) => {
      // Phase 8 / 8.4 — narrow validation of the options bag before it
      // reaches Electron. A bad payload returns -1 (the same value the
      // dialog returns when the user dismisses without a selection) so
      // the renderer's existing "user cancelled" branch handles it
      // gracefully.
      const parsed = DialogChoiceOptionsSchema.safeParse(options);
      if (!parsed.success) {
        logMainError('dialog:choice', parsed.error);
        return -1;
      }
      const safeOptions = parsed.data;
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return -1;
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        buttons,
        defaultId: safeOptions?.defaultId ?? 0,
        cancelId: safeOptions?.cancelId ?? buttons.length - 1,
        title: safeOptions?.title || 'Confirm',
        message,
        detail: safeOptions?.detail,
      });
      return result.response;
    },
  );

  /**
   * Opens a file picker dialog. Returns the selected file path(s) or null.
   */
  ipcMain.handle(
    'dialog:open-file',
    async (
      _event,
      options?: {
        title?: string;
        filters?: { name: string; extensions: string[] }[];
        multiSelect?: boolean;
      },
    ) => {
      // Phase 8 / 8.4 — narrow validation of the options bag. A bad
      // payload returns null (the same value the dialog returns when the
      // user cancels) so the renderer's existing "no file picked" branch
      // handles it gracefully.
      const parsed = DialogOpenFileOptionsSchema.safeParse(options);
      if (!parsed.success) {
        logMainError('dialog:open-file', parsed.error);
        return null;
      }
      const safeOptions = parsed.data;
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return null;

      const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
      if (safeOptions?.multiSelect) properties.push('multiSelections');

      const result = await dialog.showOpenDialog(win, {
        title: safeOptions?.title || 'Open File',
        filters: safeOptions?.filters || [{ name: 'All Files', extensions: ['*'] }],
        properties,
      });

      if (result.canceled) return null;
      return result.filePaths;
    },
  );
}
