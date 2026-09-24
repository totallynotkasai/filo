/**
 * This machine's identity, so the crash-recovery
 * sentinels in a SYNCED vault's `.filo/` never cross machines.
 *
 * `userData/machine-id.json` = `{ id, createdAt }` is created on first launch
 * (12 hex chars, the tmp-nonce alphabet) and cached for the process. It lives in
 * userData — per machine, never synced — alongside window/sidebar geometry (see
 * CLAUDE.md "Persistence Boundary"). An unreadable / corrupt file is replaced
 * with a fresh id; that only orphans this machine's OLD sentinels, which the
 * foreign-sentinel listing still shows.
 *
 * `registerMachineInVault` writes `.filo/machines/<id>.json` =
 * `{ hostname, firstSeen }` on vault open (only when missing or the hostname
 * changed). Each machine owns its own file, so the registry never
 * sync-conflicts; it labels foreign sentinels and feeds the conflict-copy
 * detector's known OneDrive device names.
 */
import { app } from 'electron';
import { promises as fs, readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { logMainError } from '../utils/mainLogger';
import { MACHINE_ID_RE } from '../../shared/sentinelPaths';

export interface MachineIdentity {
  machineId: string;
  hostname: string;
}

let cached: MachineIdentity | null = null;

function userDataFile(): string | null {
  try {
    // `app` is undefined outside Electron (unit tests import this module).
    const dir = app?.getPath?.('userData');
    return dir ? join(dir, 'machine-id.json') : null;
  } catch {
    return null;
  }
}

/**
 * tmp + rename write. Deliberately NOT `atomicWriteFile`: pathSecurity imports
 * this module, and filenameUtils imports pathSecurity (an import cycle).
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function mint(): string {
  return randomBytes(6).toString('hex');
}

/**
 * The cached identity; loads (or creates) `userData/machine-id.json` on first
 * use. Synchronous so the IPC path guards can call it without awaiting.
 */
export function getMachineIdentity(): MachineIdentity {
  if (cached) return cached;
  const file = userDataFile();
  let id: string | null = null;
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { id?: unknown };
      if (typeof raw.id === 'string' && MACHINE_ID_RE.test(raw.id)) id = raw.id;
    } catch {
      // missing / corrupt → mint below
    }
  }
  if (!id) {
    id = mint();
    if (file) {
      void writeJson(file, { id, createdAt: new Date().toISOString() }).catch((err) =>
        logMainError('machineIdentity:write', err),
      );
    }
  }
  cached = { machineId: id, hostname: hostname() };
  return cached;
}

/** Writes `.filo/machines/<id>.json` when missing or the hostname changed. Best-effort. */
export async function registerMachineInVault(vaultRoot: string): Promise<void> {
  const me = getMachineIdentity();
  const dir = join(vaultRoot, '.filo', 'machines');
  const file = join(dir, `${me.machineId}.json`);
  try {
    const existing = JSON.parse(await fs.readFile(file, 'utf-8')) as { hostname?: unknown };
    if (existing.hostname === me.hostname) return;
  } catch {
    // missing or unreadable → (re)write
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await writeJson(file, { hostname: me.hostname, firstSeen: new Date().toISOString() });
  } catch (err) {
    logMainError('machineIdentity:register', err);
  }
}

/** Test-only — pins (or clears) the cached identity. */
export function __setMachineIdentityForTests(identity: MachineIdentity | null): void {
  cached = identity;
}
