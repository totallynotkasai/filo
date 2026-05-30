import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { assertWithinVault, assertSafeFilename } from '../utils/pathSecurity';
import { assertActiveVault, NoActiveVaultError } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { getActiveWatcher } from './vault.ipc';
import { atomicWriteFile } from '../vault/filenameUtils';
import {
  assertPayloadByteSize,
  jsonPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
} from '../utils/payloadLimits';

/**
 * IPC handlers for Layout Templates persisted as JSON files inside
 * `<vault>/.filo/templates/`. Each template is one `*.template.json`
 * file. The `.filo/templates/` directory is created lazily on first
 * write.
 *
 * Files use the on-disk format defined by `LayoutTemplateSchema`. Zod
 * validation runs renderer-side; the main process treats the contents
 * as opaque JSON and only enforces path containment.
 */

function templatesDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.filo', 'templates');
}

async function ensureTemplatesDir(vaultRoot: string): Promise<string> {
  const dir = templatesDir(vaultRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function registerTemplateHandlers(): void {
  /**
   * Lists all layout templates in `<vault>/.filo/templates/`. Returns a
   * bare array of `{ filename, content }` records — `content` is the
   * parsed JSON for each `*.template.json` file. Returns `[]` if the
   * directory does not exist yet. Renderer-side code is expected to
   * validate `content` against `LayoutTemplateSchema` and discard
   * anything that fails.
   *
   * Shape matches the other list IPCs (`board:list`, `theme:list`) which
   * also return bare arrays — keeping the envelope-free shape consistent
   * across list handlers means callers don't have to branch on shape.
   */
  ipcMain.handle('templates:layout:list', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
    } catch {
      // Fail closed: no active vault means there's no templates dir to list.
      return [];
    }
    const dir = templatesDir(vaultRoot);
    assertWithinVault(vaultRoot, dir);
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        return [];
      }
      logMainError('templates:layout:list', err);
      return [];
    }
    const out: { filename: string; content: unknown }[] = [];
    for (const name of entries) {
      if (!name.endsWith('.template.json')) continue;
      const full = path.join(dir, name);
      try {
        // Phase 8 / 8.1 — pre-stat against `PAYLOAD_LIMITS.TEMPLATE` so a
        // hand-edited multi-GB template file is skipped instead of being
        // buffered into memory only to fail `JSON.parse` after the fact.
        const stat = await fs.promises.stat(full);
        if (stat.size > PAYLOAD_LIMITS.TEMPLATE) {
          console.warn(
            `[templates] skipping oversize file ${name} (${stat.size} bytes > ${PAYLOAD_LIMITS.TEMPLATE})`,
          );
          continue;
        }
        const raw = await fs.promises.readFile(full, 'utf-8');
        out.push({ filename: name, content: JSON.parse(raw) });
      } catch (err) {
        console.warn(`[templates] skipping unreadable file ${name}:`, err);
      }
    }
    return out;
  });

  /**
   * Writes (creates or overwrites) a layout template file. `filename`
   * must be a bare `*.template.json` filename — no directory components.
   */
  ipcMain.handle(
    'templates:layout:write',
    async (_event, vaultRoot: string, filename: string, content: unknown) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeFilename(filename);
        if (!filename.endsWith('.template.json')) {
          throw new Error('Filename must end with .template.json');
        }
        assertPayloadByteSize(
          jsonPayloadByteSize(content),
          PAYLOAD_LIMITS.TEMPLATE,
          `templates:layout:write ${filename}`,
        );
        const dir = await ensureTemplatesDir(vaultRoot);
        assertWithinVault(vaultRoot, dir);
        const full = path.join(dir, filename);
        assertWithinVault(vaultRoot, full);
        const relPath = `.filo/templates/${filename}`;
        const watcher = getActiveWatcher();
        watcher?.suppress(relPath, 2000);
        // Phase 4 / 4.3 — atomicWriteFile: open → fsync → rename → fsync(dir).
        // A crash mid-write would otherwise leave the template file as
        // half-written JSON that fails to parse on next load.
        await atomicWriteFile(full, JSON.stringify(content, null, 2));
        watcher?.suppress(relPath, 1000);
        return { success: true, filename };
      } catch (err) {
        logMainError('templates:layout:write', err);
        const code =
          err instanceof NoActiveVaultError
            ? 'NO_ACTIVE_VAULT'
            : err instanceof PayloadTooLargeError
              ? 'FILE_TOO_LARGE'
              : undefined;
        return { success: false, ...(code ? { code } : {}), error: String(err) };
      }
    },
  );

  /**
   * Renames a layout template file. Both filenames must end in
   * `.template.json` and contain no directory components.
   */
  ipcMain.handle(
    'templates:layout:rename',
    async (_event, vaultRoot: string, oldFilename: string, newFilename: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeFilename(oldFilename);
        assertSafeFilename(newFilename);
        if (!oldFilename.endsWith('.template.json') || !newFilename.endsWith('.template.json')) {
          throw new Error('Filenames must end with .template.json');
        }
        const dir = templatesDir(vaultRoot);
        const oldFull = path.join(dir, oldFilename);
        const newFull = path.join(dir, newFilename);
        assertWithinVault(vaultRoot, oldFull);
        assertWithinVault(vaultRoot, newFull);
        const watcher = getActiveWatcher();
        watcher?.suppress(`.filo/templates/${oldFilename}`, 2000);
        watcher?.suppress(`.filo/templates/${newFilename}`, 2000);
        await fs.promises.rename(oldFull, newFull);
        watcher?.suppress(`.filo/templates/${oldFilename}`, 1000);
        watcher?.suppress(`.filo/templates/${newFilename}`, 1000);
        return { success: true };
      } catch (err) {
        logMainError('templates:layout:rename', err);
        const code = err instanceof NoActiveVaultError ? 'NO_ACTIVE_VAULT' : undefined;
        return { success: false, ...(code ? { code } : {}), error: String(err) };
      }
    },
  );

  /**
   * Deletes a layout template file.
   */
  ipcMain.handle(
    'templates:layout:delete',
    async (_event, vaultRoot: string, filename: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeFilename(filename);
        if (!filename.endsWith('.template.json')) {
          throw new Error('Filename must end with .template.json');
        }
        const dir = templatesDir(vaultRoot);
        const full = path.join(dir, filename);
        assertWithinVault(vaultRoot, full);
        const relPath = `.filo/templates/${filename}`;
        const watcher = getActiveWatcher();
        watcher?.suppress(relPath, 2000);
        await fs.promises.unlink(full);
        watcher?.suppress(relPath, 1000);
        return { success: true };
      } catch (err) {
        logMainError('templates:layout:delete', err);
        const code = err instanceof NoActiveVaultError ? 'NO_ACTIVE_VAULT' : undefined;
        return { success: false, ...(code ? { code } : {}), error: String(err) };
      }
    },
  );
}
