import { ipcMain, dialog } from 'electron';
import { LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import * as fs from 'fs';
import * as path from 'path';
import { logMainError } from '../utils/mainLogger';
import { relativePosix } from '../utils/pathHelpers';
import { getActiveWatcher, getVaultRoot } from './vault.ipc';
import {
  assertPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
} from '../utils/payloadLimits';

/**
 * Defence-in-depth: refuse export saves whose final
 * resolved path lands under `<vault>/.filo/`. Generic exports are user-
 * facing artefacts and have no business being written into the
 * configuration directory; the dedicated `config:save` / `theme:save` /
 * `templates:write` channels handle every legitimate `.filo/` write.
 *
 * The check is post-`showSaveDialog` (after the user picked the file)
 * because the renderer doesn't pre-validate the destination — the dialog
 * is the only point at which the path becomes concrete.
 */
function resolvesUnderFiloDir(target: string): boolean {
  const vaultRoot = getVaultRoot();
  if (!vaultRoot) return false;
  const resolvedTarget = path.resolve(target);
  const filoRoot = path.resolve(vaultRoot, '.filo');
  const isWin = process.platform === 'win32';
  const tgt = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;
  const root = isWin ? filoRoot.toLowerCase() : filoRoot;
  const sep = path.sep;
  return tgt === root || tgt.startsWith(root + sep);
}

/**
 * Registers IPC handlers for export operations.
 * Renderer sends the serialized data; main process writes to disk via save dialog.
 */
export function registerExportHandlers(): void {
  /**
   * export:save — Opens a save dialog and writes export data to disk.
   * @param format - 'png' | 'svg' | 'pdf' | 'md'
   * @param data - Base64 string (for binary) or plain text (for md/svg)
   */
  ipcMain.handle(
    'export:save',
    async (_event, format: string, data: string, defaultName?: string) => {
      // Cap the payload before any disk work. Binary formats (png/pdf)
      // arrive as base64 (~75 % decoded); the wire payload is capped against
      // PAYLOAD_LIMITS.MEDIA, the 200 MB single-file binary IPC ceiling.
      try {
        const wireBytes = typeof data === 'string'
          ? Buffer.byteLength(data, 'utf-8')
          : 0;
        assertPayloadByteSize(wireBytes, PAYLOAD_LIMITS.MEDIA, 'export:save');
      } catch (err) {
        logMainError('export:save', err);
        return {
          success: false,
          path: '',
          code: err instanceof PayloadTooLargeError ? 'FILE_TOO_LARGE' : undefined,
          error: String(err),
        };
      }

      const filterMap: Record<string, Electron.FileFilter[]> = {
        png: [{ name: 'PNG Image', extensions: ['png'] }],
        svg: [{ name: 'SVG Image', extensions: ['svg'] }],
        pdf: [{ name: 'PDF Document', extensions: ['pdf'] }],
        md: [{ name: 'Markdown', extensions: ['md'] }],
        html: [{ name: 'HTML Document', extensions: ['html'] }],
      };

      const filters = filterMap[format] ?? [{ name: 'All Files', extensions: ['*'] }];
      const ext = filters[0]?.extensions[0] ?? format;

      const result = await dialog.showSaveDialog({
        title: `Export as ${format.toUpperCase()}`,
        defaultPath: `${defaultName || 'export'}.${ext}`,
        filters,
      });

      if (result.canceled || !result.filePath) {
        // The user dismissed the save dialog. This is NOT a
        // write failure, so carry a `canceled` discriminator: the renderer
        // treats it as a no-op instead of raising a spurious "Export failed"
        // error toast (a real failure returns `{ success: false }` with NO
        // `canceled` flag, below).
        return { success: false, path: '', canceled: true };
      }

      // Defence-in-depth: never write a user-facing export
      // into `.filo/`. The renderer never points here intentionally; this
      // guards against a buggy renderer (or a future code path) that does.
      if (resolvesUnderFiloDir(result.filePath)) {
        return { success: false, path: '', code: 'FORBIDDEN', error: 'Cannot export into .filo/' };
      }

      // If the user picked a destination inside the active vault (e.g.
      // exporting a board as PNG into an `Exports/` subfolder), bracket
      // the write with watcher suppression so the create event doesn't
      // echo back into the renderer as a "tree updated" refresh while
      // the dialog is closing (same pattern as `vault:write-file-text`).
      const vaultRoot = getVaultRoot();
      const watcher = getActiveWatcher();
      let relForSuppress: string | null = null;
      if (vaultRoot && watcher) {
        const resolvedTarget = path.resolve(result.filePath);
        const resolvedRoot = path.resolve(vaultRoot);
        const isWin = process.platform === 'win32';
        const tgt = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;
        const rt = isWin ? resolvedRoot.toLowerCase() : resolvedRoot;
        const sep = isWin ? '\\' : path.sep;
        if (tgt === rt || tgt.startsWith(rt + sep)) {
          relForSuppress = relativePosix(resolvedRoot, resolvedTarget);
        }
      }

      try {
        if (relForSuppress) watcher?.suppress(relForSuppress, LOCK_AWARE_SUPPRESS_MS);
        if (format === 'png' || format === 'pdf') {
          // Binary data comes as base64
          const buffer = Buffer.from(data, 'base64');
          await fs.promises.writeFile(result.filePath, buffer);
        } else {
          // Text data (svg, md)
          await fs.promises.writeFile(result.filePath, data, 'utf-8');
        }
        if (relForSuppress) watcher?.suppress(relForSuppress, 1000);
        return { success: true, path: result.filePath };
      } catch (err) {
        logMainError('export:save', err);
        return { success: false, path: '', error: String(err) };
      }
    },
  );
}
