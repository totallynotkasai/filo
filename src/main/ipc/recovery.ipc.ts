import { ipcMain, shell } from 'electron';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { assertSafeRelativePath } from '../utils/pathSecurity';
import { toPosix } from '../../shared/pathUtils';
import { logMainError } from '../utils/mainLogger';
import { keepUnsavedCopies } from '../services/recoverySnapshot';
import { preservedEmergencyFilesIn } from '../services/quitFailureBreadcrumb';
import { deleteRecoveryCopies, openableRecoveryCopy } from '../services/recoveryCopies';
import { errorEnvelope } from './ipcErrorCode';

function isInFiloDir(relPath: string): boolean {
  return toPosix(relPath).split('/').filter(Boolean)[0]?.toLowerCase() === '.filo';
}

/** `.filo/recovery/x/Draft.md` → `_filo__recovery__x__Draft.md`: a copy name outside `.filo/`. */
function outsideFiloName(relPath: string): string {
  return `_filo__${toPosix(relPath).split('/').filter(Boolean).slice(1).join('__')}`;
}

/**
 * Rescue copies for close and quit: when the user leaves a vault with work
 * that couldn't be saved, the renderer hands over the text it holds and this
 * keeps it in `.filo/recovery/`, so "Close anyway" / "Quit anyway" never drops
 * it outright.
 */
export function registerRecoveryHandlers(): void {
  /**
   * Writes each item's text to `.filo/recovery/<timestamp>-unsaved/` (or,
   * with `keep`, `<timestamp>-keep/`: a version a note just replaced). Each
   * `relPath` is only the copy's name (flattened), but it must still be a safe
   * vault path, so a bad name can't steer the write. A name inside `.filo/`
   * (a note Filo was shown from there) is kept as `_filo__…`, as the renderer
   * names Filo's own state. Each item is checked on its own: one the check
   * refuses is reported in `failed` and the others are still written, since
   * every one may be the only copy of what the user typed.
   */
  ipcMain.handle(
    'recovery:keep-unsaved',
    async (_event, vaultRoot: string, items: Array<{ relPath: string; text: string }>, purpose?: 'keep') => {
      try {
        assertActiveVault(vaultRoot);
        const refused: string[] = [];
        const allowed: Array<{ relPath: string; text: string }> = [];
        // The copy's name back to the path the renderer named.
        const named = new Map<string, string>();
        for (const item of items) {
          try {
            assertSafeRelativePath(item.relPath);
            const name = isInFiloDir(item.relPath) ? outsideFiloName(item.relPath) : item.relPath;
            named.set(name, item.relPath);
            allowed.push({ relPath: name, text: item.text });
          } catch (err) {
            logMainError(`recovery:keep-unsaved ${item.relPath}`, err);
            refused.push(item.relPath);
          }
        }
        const kept = await keepUnsavedCopies(vaultRoot, allowed, purpose === 'keep' ? 'keep' : 'unsaved');
        const asNamed = (names: string[]): string[] => names.map((n) => named.get(n) ?? n);
        return { ok: true, dir: kept.dir, kept: asNamed(kept.kept), failed: [...refused, ...asNamed(kept.failed)] };
      } catch (err) {
        logMainError('recovery:keep-unsaved', err);
        const code = (err as NodeJS.ErrnoException | null)?.code;
        return { ok: false, ...(typeof code === 'string' ? { code } : {}), error: String(err) };
      }
    },
  );

  /**
   * Settings → Recovery's Open: a copy in `.filo/recovery` in the system's
   * app for it. `NO_APP` when the system has none (the renderer then shows the
   * copy in its folder instead).
   */
  ipcMain.handle('recovery:open', async (_event, vaultRoot: string, relPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      const problem = await shell.openPath(await openableRecoveryCopy(vaultRoot, relPath));
      return problem ? { ok: false, code: 'NO_APP', error: problem } : { ok: true };
    } catch (err) {
      logMainError('recovery:open', err);
      return errorEnvelope(err);
    }
  });

  /**
   * Settings → Recovery's Delete: copies in `.filo/recovery` to the Recycle
   * Bin. Those it refuses come back in `refused`, still on disk; with
   * `permanently` (the user answered "Delete permanently?") they are deleted
   * for good.
   */
  ipcMain.handle('recovery:delete', async (_event, vaultRoot: string, relPaths: string[], permanently?: boolean) => {
    try {
      assertActiveVault(vaultRoot);
      const result = await deleteRecoveryCopies(vaultRoot, relPaths, {
        permanently: permanently === true,
        trashItem: (absPath) => shell.trashItem(absPath),
      });
      return { ok: true, ...result };
    } catch (err) {
      logMainError('recovery:delete', err);
      return errorEnvelope(err);
    }
  });

  /**
   * How many partial `.tmp` files a failed write preserved in this vault this
   * session, so the quit dialog mentions them only when there are some.
   */
  ipcMain.handle('recovery:preserved-tmp', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return { ok: true, count: preservedEmergencyFilesIn(vaultRoot).length };
    } catch (err) {
      logMainError('recovery:preserved-tmp', err);
      return { ok: false, error: String(err) };
    }
  });
}
