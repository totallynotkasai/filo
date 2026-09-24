import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { atomicWriteFile, ensureDir, LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import { assertWithinVault } from '../utils/pathSecurity';
import { assertActiveVault, NoActiveVaultError } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { getActiveWatcher } from './vault.ipc';
import { assertPayloadByteSize, PAYLOAD_LIMITS, PayloadTooLargeError } from '../utils/payloadLimits';

const TAGS_REL_PATH = '.filo/tags.json';

function tagsFilePath(vaultRoot: string): string {
  return join(vaultRoot, TAGS_REL_PATH);
}

/**
 * Failure envelope for the tags channels. On the happy path the handlers
 * return a bare value (`string | null` for load, `void` for save); on error
 * they resolve with this `{ ok: false }` shape so NO_ACTIVE_VAULT (a write
 * fired mid vault-swap) / FILE_TOO_LARGE surface as a typed code rather than
 * an opaque "Error invoking remote method" string. The renderer routes every
 * tags call through `assertIpcOk`, which re-throws on `{ ok: false }`, so the
 * miscScheduler / try-catch pipelines still see a rejection.
 */
type TagsFailure = { ok: false; code?: string; error?: string };

function classifyTagsError(err: unknown): string | undefined {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  return undefined;
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
  ipcMain.handle(
    'tags:load',
    async (_event, vaultRoot: string): Promise<string | null | TagsFailure> => {
      try {
        assertActiveVault(vaultRoot);
        const filePath = tagsFilePath(vaultRoot);
        assertWithinVault(vaultRoot, filePath);
        // Stat-first so a hand-edited or corrupted multi-GB
        // tags.json aborts before the whole file is buffered into memory.
        try {
          const stat = await fs.stat(filePath);
          if (stat.size > PAYLOAD_LIMITS.TAGS) {
            throw new Error(
              `tags.json is ${stat.size} bytes; cap is ${PAYLOAD_LIMITS.TAGS} bytes`,
            );
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
          throw err;
        }
      } catch (err) {
        // Typed envelope on error (see TagsFailure above). ENOENT
        // already short-circuits to `null` inside; anything reaching here is a
        // real failure (NO_ACTIVE_VAULT / oversize / EACCES on a locked share).
        logMainError('tags:load', err);
        return { ok: false, code: classifyTagsError(err), error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'tags:save',
    async (_event, vaultRoot: string, json: string): Promise<void | TagsFailure> => {
      try {
        assertActiveVault(vaultRoot);
        assertPayloadByteSize(
          Buffer.byteLength(json, 'utf-8'),
          PAYLOAD_LIMITS.TAGS,
          'tags:save',
        );
        const filePath = tagsFilePath(vaultRoot);
        assertWithinVault(vaultRoot, filePath);
        await ensureDir(join(vaultRoot, '.filo'));
        // atomicWriteFile generates a rename event for `.filo/tags.json`.
        // Without suppression the watcher would flag the self-write as a tree
        // change and trigger an unnecessary full sidebar refresh on every tag mutation.
        const watcher = getActiveWatcher();
        watcher?.suppress(TAGS_REL_PATH, LOCK_AWARE_SUPPRESS_MS);
        await atomicWriteFile(filePath, json);
        watcher?.suppress(TAGS_REL_PATH, 1000);
      } catch (err) {
        // Typed envelope on error. `fileTags.scheduleSave` routes this through
        // `assertIpcOk`, so `{ ok: false }` re-throws into the miscScheduler,
        // preserving the dirty-flag / retry behaviour.
        logMainError('tags:save', err);
        return { ok: false, code: classifyTagsError(err), error: String(err) };
      }
    },
  );
}
