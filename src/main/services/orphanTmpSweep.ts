/**
 * Audit-19 EXT-5 / ERR-9 (plan D6, step 6) — sweep orphaned atomic-write temps
 * out of the synced vault.
 *
 * When `atomicWriteFile` exhausts its lock retry it PRESERVES the fully-written
 * tmp as `<file>.<12 hex>.tmp` next to the target (the bytes are the user's last
 * edit). The tree and watcher hide those names, but the sync client uploads
 * them and nothing ever removed them — so they accumulated on every machine.
 * A stranded Windows case-only rename leaves `<file>.case-rename-<ms>` the same
 * way.
 *
 * On vault open (after the quit-failure breadcrumb has been surfaced) the
 * renderer calls `vault:sweep-orphan-tmp`, which MOVES — never deletes
 * (DECISION) — each orphan into `.filo/recovery/orphan-tmp/<ISO ts>/` as
 * `<flattened target rel>.recovered`. Spared:
 *   - anything younger than 10 minutes (another process's or machine's
 *     in-flight write);
 *   - anything a `.filo/quit-failure*.json` breadcrumb (any machine) lists;
 *   - anything this process's emergency registry still tracks.
 * An EPERM / EBUSY on a move is skipped silently (retried next open).
 */
import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { join, relative, sep } from 'path';
import { ensureDir } from '../vault/filenameUtils';
import { listPreservedEmergencyFiles } from './emergencyFileRegistry';
import { flattenSnapshotName } from './recoverySnapshot';
import { logMainError } from '../utils/mainLogger';

export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;
const NONCE_TMP_RE = /\.[0-9a-f]{12}\.tmp$/;
const CASE_RENAME_RE = /\.case-rename-\d{10,}$/;
const SKIP_DIRS = new Set(['.filo', '.git', 'node_modules']);
const MAX_ENTRIES = 200_000;

export interface OrphanTmpMove {
  from: string;
  to: string;
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Absolute preserved paths listed by any machine's quit-failure breadcrumb. */
async function breadcrumbListedPaths(vaultRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = await fs.readdir(join(vaultRoot, '.filo'));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^quit-failure.*\.json$/i.test(name)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(join(vaultRoot, '.filo', name), 'utf-8')) as {
        files?: Array<{ preservedPath?: unknown }>;
      };
      for (const f of raw.files ?? []) {
        if (typeof f.preservedPath === 'string') out.add(norm(f.preservedPath));
      }
    } catch {
      // Unreadable / half-synced breadcrumb — conservative: it can't protect
      // anything, but the 10-minute age floor still spares fresh temps.
    }
  }
  return out;
}

/** Target rel path an orphan belongs to (nonce / case-rename suffix stripped). */
export function orphanTargetRel(rel: string): string {
  return rel.replace(NONCE_TMP_RE, '').replace(CASE_RENAME_RE, '');
}

export function isOrphanTmpName(name: string): boolean {
  return NONCE_TMP_RE.test(name) || CASE_RENAME_RE.test(name);
}

export async function sweepOrphanTmpFiles(
  vaultRoot: string,
  opts: { now?: number; minAgeMs?: number } = {},
): Promise<{ moved: OrphanTmpMove[] }> {
  const now = opts.now ?? Date.now();
  const minAge = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const protectedPaths = await breadcrumbListedPaths(vaultRoot);
  for (const f of listPreservedEmergencyFiles()) protectedPaths.add(norm(f.preservedPath));

  const candidates: string[] = [];
  const stack: string[] = [vaultRoot];
  let seen = 0;
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links out of the vault
      if (entry.isDirectory()) {
        // `.filo` is Filo's own dir only at the vault root; `.git` / `node_modules` anywhere.
        if (entry.name === '.filo' ? dir === vaultRoot : SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && isOrphanTmpName(entry.name)) candidates.push(abs);
    }
  }

  const moved: OrphanTmpMove[] = [];
  if (candidates.length === 0) return { moved };
  const stamp = new Date(now).toISOString().replace(/[:]/g, '-').replace(/Z$/, '');
  const destDir = join(vaultRoot, '.filo', 'recovery', 'orphan-tmp', stamp);
  let destReady = false;

  for (const abs of candidates) {
    if (protectedPaths.has(norm(abs))) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(abs)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < minAge) continue;
    const rel = relative(vaultRoot, abs).split(sep).join('/');
    const baseName = `${flattenSnapshotName(orphanTargetRel(rel))}.recovered`;
    try {
      if (!destReady) {
        await ensureDir(destDir);
        destReady = true;
      }
      let dest = join(destDir, baseName);
      for (let n = 2; await fs.access(dest).then(() => true, () => false); n++) {
        dest = join(destDir, `${n}-${baseName}`);
      }
      await fs.rename(abs, dest);
      moved.push({ from: rel, to: relative(vaultRoot, dest).split(sep).join('/') });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOENT') {
        logMainError(`orphanTmpSweep ${rel}`, err);
      }
    }
  }
  return { moved };
}
