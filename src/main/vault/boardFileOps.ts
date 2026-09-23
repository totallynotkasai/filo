import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { atomicWriteFile, ensureDir, pathExists, sanitizeFilename } from './filenameUtils';
import { relativePosix } from '../utils/pathHelpers';

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
 * Caller is responsible for Zod validation.
 *
 * Audit-19 ERR-1 — builds before Audit-19 JSON-encoded the renderer's already-
 * serialised payload a second time, so legacy files hold a JSON STRING literal.
 * Unwrap one level (the configOps precedent); a plain-JSON file (written by a
 * fixed build, or hand-edited) loads as-is. Each legacy file migrates to plain
 * JSON on its next save.
 */
export async function loadBoardFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

/**
 * Audit-19 ERR-1 — the renderer sends the board already serialised; write that
 * string VERBATIM so the on-disk size equals the renderer's payload byte length
 * (the post-write drift-baseline check depends on it). Non-string data (tests,
 * internal callers) is serialised here. A cheap sniff refuses a string that
 * isn't a JSON object without re-parsing a multi-MB board on the hot path.
 */
function serializeBoardPayload(data: unknown): string {
  if (typeof data !== 'string') return JSON.stringify(data, null, 2);
  if (data.trimStart()[0] !== '{') throw new Error('board payload is not a JSON object');
  return data;
}

// ── Write ──

/**
 * Saves board data to a .board.json file using atomic write.
 * Creates parent directories if they don't exist. A string payload (the
 * renderer's serialised board) is written verbatim — see serializeBoardPayload.
 */
export async function saveBoardFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(dirname(filePath));
  const json = serializeBoardPayload(data);
  await atomicWriteFile(filePath, json);
}

// ── Create ──

/**
 * Creates a new .board.json file in the vault.
 * Returns the full path to the created file.
 * If a file with the same name exists, appends (2), (3), etc.
 */
export async function createBoardFile(
  vaultRoot: string,
  name: string,
  data: unknown,
  subfolder?: string,
): Promise<string> {
  const targetDir = subfolder ? join(vaultRoot, subfolder) : vaultRoot;
  await ensureDir(targetDir);

  const sanitized = sanitizeFilename(name);
  let filePath = join(targetDir, `${sanitized}${BOARD_EXTENSION}`);

  if (await pathExists(filePath)) {
    let counter = 2;
    while (await pathExists(filePath)) {
      filePath = join(targetDir, `${sanitized} (${counter})${BOARD_EXTENSION}`);
      counter++;
    }
  }

  const json = serializeBoardPayload(data);
  await atomicWriteFile(filePath, json);
  return filePath;
}

// ── Delete ──

/**
 * Deletes a .board.json file.
 */
export async function deleteBoardFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
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

async function scanDir(
  dir: string,
  vaultRoot: string,
  results: string[],
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
      await scanDir(fullPath, vaultRoot, results);
    } else if (entry.name.toLowerCase().endsWith(BOARD_EXTENSION)) {
      // Audit-15 P1.3 — case-fold the extension match (siblings `fileOps`/the
      // watcher already do). Filo only ever CREATES lowercase `.board.json`, so
      // this is robustness against an external tool / cloud sync diverging the
      // casing: without it, such a board is silently excluded from `board:list`.
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
