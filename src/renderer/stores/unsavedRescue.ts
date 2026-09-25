/**
 * unsavedRescue — what is left unsaved when the user leaves a vault, and the
 * rescue copies that keep it.
 *
 * Close, open-another-vault and quit all save first. Whatever is still in
 * `unsavedWork()` afterwards is described here with its cause (for the
 * dialog), and on "Close anyway" / "Quit anyway" copied to
 * `.filo/recovery/<timestamp>-unsaved/` before the vault is let go:
 *  - a note: its last frontmatter with the queued change, over the local body;
 *  - a board: its in-memory file, as JSON.
 * `.filo/` config can't be copied there; it is reported as not kept.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { noteStore } from './notes.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { isNonUtf8 } from '../lib/vault/nonUtf8Paths.svelte';
import { invokeOk } from '../lib/utils/invokeOk';
import { unsavedWork, type UnsavedWork } from '../lib/boards/writeStateTracking';
import type { RescueResult, UnsavedCause, UnsavedItem } from '../lib/vault/unsavedMessages';

/** Board paths (on-disk spelling) by case-folded key. */
function boardPathsByKey(): Map<VaultPath, { boardId: string; relPath: string }> {
  const out = new Map<VaultPath, { boardId: string; relPath: string }>();
  for (const [boardId, relPath] of Object.entries(boardCacheStore.paths)) {
    if (relPath) out.set(vaultPath(relPath), { boardId, relPath });
  }
  return out;
}

/** The path as the user knows it: a note's or board's on-disk spelling, else the key. */
function displayPath(key: VaultPath, boards: Map<VaultPath, { relPath: string }>): string {
  return noteStore.get(key)?.relPath ?? boards.get(key)?.relPath ?? key;
}

async function fileExists(vaultRoot: string, relPath: string): Promise<boolean> {
  try {
    return (await window.filo.invoke('vault:file-exists', vaultRoot, relPath)) === true;
  } catch {
    // Can't tell: don't claim it's gone.
    return true;
  }
}

async function causeOf(key: VaultPath, relPath: string, vaultRoot: string | null): Promise<UnsavedCause> {
  if (noteStore.get(key)?.status === 'conflict') return 'conflict';
  if (isNonUtf8(relPath)) return 'non-utf8';
  if (vaultRoot && !(await fileExists(vaultRoot, relPath))) return 'missing';
  return 'write-failed';
}

/** Each unsaved path with the reason it isn't on disk. */
export async function describeUnsaved(work: UnsavedWork = unsavedWork()): Promise<UnsavedItem[]> {
  const vaultRoot = getActiveVaultPath() || null;
  const boards = boardPathsByKey();
  const items: UnsavedItem[] = [];
  for (const key of work.failed) {
    const path = displayPath(key, boards);
    items.push({ path, cause: await causeOf(key, path, vaultRoot) });
  }
  for (const key of work.pending) {
    const path = displayPath(key, boards);
    // A held body shows as pending to the ledger; say what holds it.
    items.push({ path, cause: noteStore.get(key)?.status === 'conflict' ? 'conflict' : 'pending' });
  }
  return items;
}

/**
 * Copies every unsaved note and board into `.filo/recovery/`. Never throws:
 * whatever couldn't be copied is in `notKept`, so the caller can ask again
 * before letting it go.
 */
export async function keepRescueCopies(work: UnsavedWork = unsavedWork()): Promise<RescueResult> {
  const vaultRoot = getActiveVaultPath();
  const boards = boardPathsByKey();
  const items: Array<{ relPath: string; text: string }> = [];
  const covered = new Set<VaultPath>();
  const notKept: string[] = [];
  try {
    for (const note of await noteStore.unsavedTexts()) {
      items.push(note);
      covered.add(vaultPath(note.relPath));
    }
  } catch (err) {
    console.error('[unsavedRescue] collecting unsaved notes failed:', err);
  }
  for (const key of [...work.failed, ...work.pending]) {
    if (covered.has(key)) continue;
    covered.add(key);
    const board = boards.get(key);
    const cached = board ? boardCacheStore.cache[board.boardId] : undefined;
    if (board && cached) items.push({ relPath: board.relPath, text: `${JSON.stringify(cached, null, 2)}\n` });
    else notKept.push(displayPath(key, boards));
  }
  if (!vaultRoot || items.length === 0) {
    return { dir: null, kept: [], notKept: [...notKept, ...items.map((i) => i.relPath)] };
  }
  try {
    const result = await invokeOk('recovery:keep-unsaved', vaultRoot, items);
    return { dir: result.dir, kept: result.kept, notKept: [...notKept, ...result.failed] };
  } catch (err) {
    console.error('[unsavedRescue] writing rescue copies failed:', err);
    return { dir: null, kept: [], notKept: [...notKept, ...items.map((i) => i.relPath)] };
  }
}

/** How many partial `.tmp` files a failed write preserved in this vault this session. */
export async function preservedTmpCount(): Promise<number> {
  const vaultRoot = getActiveVaultPath();
  if (!vaultRoot) return 0;
  try {
    return (await invokeOk('recovery:preserved-tmp', vaultRoot)).count;
  } catch {
    return 0;
  }
}
