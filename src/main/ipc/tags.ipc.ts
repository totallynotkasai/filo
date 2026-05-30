import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { atomicWriteFile, ensureDir } from '../vault/filenameUtils';
import { assertWithinVault } from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { getActiveWatcher } from './vault.ipc';
import { assertPayloadByteSize, PAYLOAD_LIMITS } from '../utils/payloadLimits';

const TAGS_REL_PATH = '.filo/tags.json';

function tagsFilePath(vaultRoot: string): string {
  return join(vaultRoot, TAGS_REL_PATH);
}

/**
 * Registers IPC handlers that load/save `<vault>/.filo/tags.json`.
 *
 * The handlers do not enforce a schema — that's the renderer's job (via
 * `tagsStorage.parseTagsFile`). The main process is purely transport, so a
 * corrupted file can still be surfaced to the user with a precise diagnostic
 * instead of being silently rewritten.
 */
export function registerTagsHandlers(): void {
  ipcMain.handle('tags:load', async (_event, vaultRoot: string): Promise<string | null> => {
    assertActiveVault(vaultRoot);
    const filePath = tagsFilePath(vaultRoot);
    assertWithinVault(vaultRoot, filePath);
    // Phase 8 / 8.1 — stat-first so a hand-edited or corrupted multi-GB
    // tags.json aborts before the whole file is buffered into memory.
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > PAYLOAD_LIMITS.TAGS) {
        const err = new Error(
          `tags.json is ${stat.size} bytes; cap is ${PAYLOAD_LIMITS.TAGS} bytes`,
        );
        logMainError('tags:load', err);
        throw err;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return null;
      throw err;
    }
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      // ENOENT is expected for a brand-new vault. Other errors are surfaced.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return null;
      logMainError('tags:load', err);
      throw err;
    }
  });

  ipcMain.handle('tags:save', async (_event, vaultRoot: string, json: string): Promise<void> => {
    assertActiveVault(vaultRoot);
    assertPayloadByteSize(
      Buffer.byteLength(json, 'utf-8'),
      PAYLOAD_LIMITS.TAGS,
      'tags:save',
    );
    const filePath = tagsFilePath(vaultRoot);
    assertWithinVault(vaultRoot, filePath);
    await ensureDir(join(vaultRoot, '.filo'));
    // Phase 19 S3 — atomicWriteFile generates a rename event for `.filo/tags.json`.
    // Without suppression the watcher would flag the self-write as a tree
    // change and trigger an unnecessary full sidebar refresh on every tag mutation.
    const watcher = getActiveWatcher();
    watcher?.suppress(TAGS_REL_PATH, 2000);
    await atomicWriteFile(filePath, json);
    watcher?.suppress(TAGS_REL_PATH, 1000);
  });
}
