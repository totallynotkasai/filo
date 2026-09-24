import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMachineIdentity } from '../services/machineIdentity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { parseSentinelBasename, type SentinelKind } from '../../shared/sentinelPaths';

/**
 * Machine identity + the per-machine sentinel
 * listing for a synced vault's `.filo/`.
 */
export function registerMachineHandlers(): void {
  /**
   * This machine's id (userData) + hostname. Bare channel; the renderer fetches
   * it once at boot, before any vault opens, so every sentinel it names is its
   * own.
   */
  ipcMain.handle('app:machine-identity', () => getMachineIdentity());

  /**
   * Every crash-recovery sentinel in `.filo/` — this machine's and other
   * machines' — so the renderer can list foreign state without a
   * directory-read channel. Read-only.
   */
  ipcMain.handle('recovery:list-sentinels', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      const dir = join(vaultRoot, '.filo');
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const entries: Array<{
        kind: SentinelKind;
        machineId: string | null;
        hostname?: string;
        relPath: string;
        mtimeMs: number;
      }> = [];
      const hostnames = new Map<string, string | undefined>();
      const hostnameOf = async (id: string): Promise<string | undefined> => {
        if (!hostnames.has(id)) {
          try {
            const raw = JSON.parse(await fs.readFile(join(dir, 'machines', `${id}.json`), 'utf-8')) as { hostname?: unknown };
            hostnames.set(id, typeof raw.hostname === 'string' ? raw.hostname : undefined);
          } catch {
            hostnames.set(id, undefined);
          }
        }
        return hostnames.get(id);
      };
      for (const name of names) {
        const parsed = parseSentinelBasename(name);
        if (!parsed) continue;
        try {
          const st = await fs.stat(join(dir, name));
          if (!st.isFile()) continue;
          const hostname = await hostnameOf(parsed.machineId);
          entries.push({ ...parsed, ...(hostname ? { hostname } : {}), relPath: `.filo/${name}`, mtimeMs: st.mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
      return { success: true, entries };
    } catch (err) {
      logMainError('recovery:list-sentinels', err);
      return { success: false, error: String(err) };
    }
  });
}
