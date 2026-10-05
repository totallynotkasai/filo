import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { atomicWriteFile, ensureDir } from './filenameUtils';
import { createExclusiveFile } from './exclusiveCreate';
import { relativePosix } from '../utils/pathHelpers';
import { detectConflictCopyPath } from '../../shared/conflictCopy';

/**
 * Board file operations for the vault-centric architecture.
 *
 * Each board is stored as a `.board.json` file within the vault.
 * Board files can be at the vault root or nested in subfolders.
 */

const BOARD_EXTENSION = '.board.json';

// ── Read ──

/**
 * Loads and returns the parsed board object of a .board.json file.
 * Caller is responsible for version and Zod validation.
 */
export async function loadBoardFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as unknown;
}

/**
 * The renderer sends the board already serialised; write that
 * string VERBATIM so the on-disk size equals the renderer's payload byte length
 * (the post-write drift-baseline check depends on it). Non-string data (tests,
 * internal callers) is serialised here. A cheap sniff refuses a string that
 * isn't a JSON object without re-parsing a multi-MB board on the hot path.
 */
export function serializeBoardPayload(data: unknown): string {
  if (typeof data !== 'string') return JSON.stringify(data, null, 2);
  if (data.trimStart()[0] !== '{') throw new Error('board payload is not a JSON object');
  return data;
}

// ── Write ──

/**
 * A save of a board whose folder isn't there (moved or deleted since the board
 * was loaded). Code `BOARD_FOLDER_MISSING` crosses IPC so the renderer keeps
 * the write for a retry instead of recreating the folder.
 */
export class BoardFolderMissingError extends Error {
  readonly code = 'BOARD_FOLDER_MISSING';
  constructor(filePath: string) {
    super(`The folder of board "${filePath}" doesn't exist; not recreating it.`);
    this.name = 'BoardFolderMissingError';
  }
}

/**
 * Saves board data to a .board.json file using atomic write. A string payload
 * (the renderer's serialised board) is written verbatim — see
 * serializeBoardPayload. Returns the text written, for the watcher's record of
 * Filo's own bytes.
 *
 * Only `board:create` makes folders. A save lands in a folder that exists: a
 * save racing a rename of its folder would otherwise recreate the old folder,
 * or make the new one before the rename and turn it into a name clash.
 * `recreate` is the user's explicit "Save at original location" for a board
 * whose folder went missing.
 */
export async function saveBoardFile(filePath: string, data: unknown, opts: { recreate?: boolean } = {}): Promise<string> {
  if (opts.recreate) await ensureDir(dirname(filePath));
  else if (!(await isDirectory(dirname(filePath)))) throw new BoardFolderMissingError(filePath);
  const json = serializeBoardPayload(data);
  await atomicWriteFile(filePath, json);
  return json;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    // Anything else (a lock, a share hiccup) is left to the write to report.
    return true;
  }
}

// ── Create ──

/**
 * Creates `<name>.board.json` in the vault and returns its full path. The
 * name is used as given: a board's name and its file name are one value, so
 * a taken name is refused (code `EEXIST`) rather than bumped to ` (2)`,
 * which would leave the board named differently from its file.
 */
/** Where `createBoardFile` puts a board named `name` (in `subfolder` when given). */
export function boardFilePath(vaultRoot: string, name: string, subfolder?: string): string {
  return join(subfolder ? join(vaultRoot, subfolder) : vaultRoot, `${name}${BOARD_EXTENSION}`);
}

export async function createBoardFile(
  vaultRoot: string,
  name: string,
  data: unknown,
  subfolder?: string,
): Promise<string> {
  const targetDir = subfolder ? join(vaultRoot, subfolder) : vaultRoot;
  const json = serializeBoardPayload(data);
  await ensureDir(targetDir);
  const filePath = boardFilePath(vaultRoot, name, subfolder);
  await createExclusiveFile(filePath, json);
  return filePath;
}

// ── Scan ──

/**
 * Recursively scans a vault directory for all .board.json files.
 * Returns vault-relative paths sorted alphabetically.
 */
export async function scanBoardFiles(vaultRoot: string): Promise<string[]> {
  const results: string[] = [];
  await scanDir(vaultRoot, vaultRoot, results);
  results.sort();
  return results;
}

/**
 * Sync-client conflict copies of a board or a note.
 *
 * OneDrive, Dropbox and iCloud put their suffix before the LAST extension, so a
 * fork of `Plan.board.json` is `Plan.board-DESKTOP-1A2B3C4.json` /
 * `Plan.board (… conflicted copy …).json` / `Plan.board 2.json` — names
 * `board:list` never sees, so the diverged edits would sit on disk unnoticed.
 * Returns each such copy whose canonical `*.board.json` exists alongside
 * (weak ` (n)` / ` n` shapes only count with the sibling).
 *
 * A note's copy (`Chapter.sync-conflict-20261004-120000-ABCDEFG.md`) shows in
 * the sidebar like any note, but nothing says which note it split from. It
 * counts only on a strong name, never a weak one (`Chapter 2.md` beside
 * `Chapter.md` is an ordinary book), and only beside its original.
 */
export async function scanSyncConflicts(
  vaultRoot: string,
  knownHosts: readonly string[],
): Promise<Array<{ copyPath: string; canonicalPath: string; client: string }>> {
  const boards: string[] = [];
  const others: string[] = [];
  const notes: string[] = [];
  await scanDir(vaultRoot, vaultRoot, boards, others, notes);
  const canonical = new Set(boards.map((b) => b.toLowerCase()));
  const out: Array<{ copyPath: string; canonicalPath: string; client: string }> = [];
  for (const rel of others) {
    const hit = detectConflictCopyPath(rel, { knownHosts, exists: (c) => canonical.has(c.toLowerCase()) });
    if (!hit || !hit.canonicalName.toLowerCase().endsWith(BOARD_EXTENSION)) continue;
    if (!canonical.has(hit.canonicalName.toLowerCase())) continue;
    out.push({ copyPath: rel, canonicalPath: hit.canonicalName, client: hit.client });
  }
  const noteNames = new Set(notes.map((n) => n.toLowerCase()));
  for (const rel of notes) {
    const hit = detectConflictCopyPath(rel, { knownHosts });
    if (!hit || hit.strength !== 'strong' || !noteNames.has(hit.canonicalName.toLowerCase())) continue;
    out.push({ copyPath: rel, canonicalPath: hit.canonicalName, client: hit.client });
  }
  out.sort((a, b) => (a.copyPath < b.copyPath ? -1 : 1));
  return out;
}

async function scanDir(
  dir: string,
  vaultRoot: string,
  results: string[],
  // Optional sink for `*.board<suffix>.json` names (possible
  // sync conflict forks) that `board:list` deliberately excludes.
  others?: string[],
  // Optional sink for every note (`.md`), for its conflict copies.
  notes?: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories (.filo, .git, etc.) and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await scanDir(fullPath, vaultRoot, results, others, notes);
    } else if (notes && entry.name.toLowerCase().endsWith('.md')) {
      notes.push(relativePosix(vaultRoot, fullPath));
    } else if (others && /\.board.+\.json$/i.test(entry.name) && !entry.name.toLowerCase().endsWith(BOARD_EXTENSION)) {
      others.push(relativePosix(vaultRoot, fullPath));
    } else if (entry.name.toLowerCase().endsWith(BOARD_EXTENSION)) {
      // Case-fold the extension match (as `fileOps` / the watcher do). Filo
      // only CREATES lowercase `.board.json`, but an external tool / cloud
      // sync may diverge the casing, and such a board would otherwise be
      // silently excluded from `board:list`.
      results.push(relativePosix(vaultRoot, fullPath));
    }
  }
}

// ── Utilities ──

/**
 * Returns the full absolute path from a vault root and a vault-relative board path.
 */
export function resolveBoardPath(vaultRoot: string, relativePath: string): string {
  return join(vaultRoot, relativePath);
}
