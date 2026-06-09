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
 * Loads and returns the raw parsed JSON of a .board.json file.
 * Caller is responsible for Zod validation.
 */
export async function loadBoardFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

// ── Write ──

/**
 * Saves board data to a .board.json file using atomic write.
 * Creates parent directories if they don't exist.
 */
export async function saveBoardFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(dirname(filePath));
  const json = JSON.stringify(data, null, 2);
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

  const json = JSON.stringify(data, null, 2);
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
