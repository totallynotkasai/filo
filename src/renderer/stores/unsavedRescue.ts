/**
 * unsavedRescue — what is left unsaved when the user leaves a vault, and the
 * rescue copies that keep it.
 *
 * Close, open-another-vault and quit all save first. Whatever is still in
 * `unsavedWork()` afterwards is described here with its cause (for the
 * dialog), and on "Close anyway" / "Quit anyway" copied to
 * `.filo/recovery/<timestamp>-unsaved/` before the vault is let go:
 *  - a note: its last frontmatter with the queued change, over the local body;
 *  - a board: its in-memory file, as JSON;
 *  - a raw view's text: the whole file as typed;
 *  - Filo's own `.filo/` state (the tag registry, the only copy of attachment
 *    tags; settings, layout, viewports, hotkeys, sidebar order): each file's
 *    unsaved content as `_filo__<name>.json`, a name outside `.filo/` so
 *    the rescue channel accepts it.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { noteStore } from './notes.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { isNonUtf8 } from '../lib/vault/nonUtf8Paths.svelte';
import { invokeOk } from '../lib/utils/invokeOk';
import { unsavedWork, type UnsavedWork } from '../lib/boards/writeStateTracking';
import type { RescueResult, UnsavedCause, UnsavedItem } from '../lib/vault/unsavedMessages';
import { dirtyRawViews, rawViewInConflict, takeRawRescueItems } from '../lib/notes/rawViews';
import { notesBoxDraftPath, notesBoxInConflict, takeNotesBoxRescueItems } from '../lib/tasklist/notesBox.svelte';
import { unsavedConfigPayloads } from '../lib/boards/configWriteScheduler';
import { isBoardDriftHeld } from '../lib/boards/boardDriftHold';
import { unsavedMiscPayloads } from '../lib/boards/miscWriteScheduler';
import { unsavedComponentPayloads } from '../lib/boards/componentWriteRetry';

/** A `.filo/` file's rescue copy name: `.filo/tags.json` → `_filo__tags.json`. */
export function filoRescueName(relPath: string): string {
  return `_filo__${relPath.replace(/^\.filo[\\/]/, '').replace(/[\\/]+/g, '__')}`;
}

/** Unsaved `.filo/` files as rescue items, and the ledger keys they cover. */
function filoRescueItems(unsaved: Set<VaultPath>): { items: Array<{ relPath: string; text: string }>; covers: VaultPath[] } {
  const items: Array<{ relPath: string; text: string }> = [];
  const covers: VaultPath[] = [];
  try {
    const configs = unsavedConfigPayloads();
    for (const { name, json } of configs) items.push({ relPath: filoRescueName(`.filo/${name}`), text: `${json}\n` });
    // A failed config write is tracked under `.filo/` as a whole.
    if (configs.length > 0) covers.push(vaultPath('.filo/'));
    for (const { relPath, json } of unsavedMiscPayloads((p) => unsaved.has(vaultPath(p)))) {
      items.push({ relPath: filoRescueName(relPath), text: `${json}\n` });
      covers.push(vaultPath(relPath));
    }
    // A theme or template save kept for Retry.
    for (const { relPath, text } of unsavedComponentPayloads()) {
      items.push({ relPath: filoRescueName(relPath), text });
      covers.push(vaultPath(relPath));
    }
  } catch (err) {
    console.error('[unsavedRescue] collecting unsaved .filo/ state failed:', err);
  }
  return { items, covers };
}

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
  return noteStore.get(key)?.relPath ?? boards.get(key)?.relPath ?? notesBoxDraftPath(key) ?? key;
}

async function fileExists(vaultRoot: string, relPath: string): Promise<boolean> {
  try {
    return (await window.filo.invoke('vault:file-exists', vaultRoot, relPath)) === true;
  } catch {
    // Can't tell: don't claim it's gone.
    return true;
  }
}

/** The question a change waits on, if any. */
function answerCause(key: VaultPath, relPath: string): UnsavedCause | null {
  if (noteStore.get(key)?.status === 'conflict' || notesBoxInConflict(relPath)) return 'conflict';
  if (rawViewInConflict(relPath)) return 'raw-conflict';
  if (isBoardDriftHeld(relPath)) return 'board-drift';
  return null;
}

async function causeOf(key: VaultPath, relPath: string, vaultRoot: string | null): Promise<UnsavedCause> {
  const answer = answerCause(key, relPath);
  if (answer) return answer;
  if (isNonUtf8(relPath)) return 'non-utf8';
  if (vaultRoot && !(await fileExists(vaultRoot, relPath))) return 'missing';
  return 'write-failed';
}

/**
 * The unsaved paths as the files are spelled on disk (the ledger folds case),
 * so the crash sentinel's list names, and opens, the real files.
 */
export function unsavedPathsAsSpelled(work: UnsavedWork = unsavedWork()): string[] {
  const boards = boardPathsByKey();
  const raw = new Map(dirtyRawViews().map((v) => [vaultPath(v.path()), v.path()] as const));
  return [...new Set([...work.failed, ...work.pending])].map((key) => raw.get(key) ?? displayPath(key, boards));
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
    items.push({ path, cause: answerCause(key, path) ?? 'pending' });
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
  // A raw view's text is the user's latest version of the whole file. It is
  // kept even when the note also has a copy above (the two are numbered apart).
  const raws = takeRawRescueItems();
  for (const raw of raws.items) {
    items.push(raw);
    covered.add(vaultPath(raw.relPath));
  }
  // A Task List notes box's draft: typed text the note doesn't have yet.
  for (const draft of takeNotesBoxRescueItems()) {
    items.push(draft);
    covered.add(vaultPath(draft.relPath));
  }
  const filo = filoRescueItems(new Set([...work.failed, ...work.pending]));
  items.push(...filo.items);
  for (const key of filo.covers) covered.add(key);
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
    raws.commit(result.kept);
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
