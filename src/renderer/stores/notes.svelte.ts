/**
 * noteStore — one model per open note, shared by every view of it.
 *
 * A note's vault path is its only name. Every view that shows a note (a text
 * tile, a Document tab, a Properties popup) `acquire`s its model and reads
 * the body and frontmatter from it; edits go back through `setBody` and
 * `patchFrontmatter`, which queue them on the note writer. Nothing else holds
 * a copy of a note, so two views can't disagree.
 *
 * The one who types owns the text: a view that calls `setBody` becomes the
 * note's `editorOwner`, and every other view follows the model. A view
 * serialises its editor at most every ~150 ms of idle and on blur, so the
 * model trails the keystrokes by that much.
 *
 * Views that only show metadata (Kanban cards, Task List rows) never load a
 * note: `frontmatter(path)` answers from the model when one is loaded, else
 * from the vault index with any queued frontmatter change laid over it.
 *
 * Disk changes come in through `onDiskChanged` (see `notes/noteDiskChange.ts`
 * for the decision table): our own writes are recognised by their hash, a
 * clean note follows the disk, and the one prompt appears only when an unsaved
 * body edit meets a body change on disk.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { onVaultSwap } from '../core/vaultLifecycle';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultIndexStore } from './vaultIndex.svelte';
import { parseMarkdown } from '../lib/vault/vaultIndex';
import { isNonUtf8 } from '../lib/vault/nonUtf8Paths.svelte';
import { applyFrontmatterDelta, type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import {
  createNoteWriter,
  isMissingFileError,
  readNoteFresh,
  type FreshRead,
  type NoteWriter,
} from '../lib/notes/noteWriter';
import {
  noteTextHash,
  sameBody,
  snapshotBody,
  snapshotOf,
  readNoteText,
  rawTextForDisk,
  type DiskSnapshot,
  type NoteText,
} from '../lib/notes/noteFile';
import { looksTorn } from '../lib/notes/noteWriter';
import { decideDiskChange } from '../lib/notes/noteDiskChange';
import {
  dropPendingPath,
  noteAdditionalPendingPath,
  type TrackComponentWriteOptions,
} from '../lib/boards/writeStateTracking';

export type ViewId = string;

/**
 * - `loading`: the first read hasn't finished.
 * - `ready`: the model holds the note.
 * - `missing`: the file isn't there (never was, or was deleted).
 * - `unreadable`: the read failed for another reason; editing waits for a retry.
 * - `conflict`: an unsaved body met a different body on disk; a prompt is up.
 */
export type NoteStatus = 'loading' | 'ready' | 'missing' | 'unreadable' | 'conflict';

/** What a view hands the store when it acquires a note. */
export interface ViewHooks {
  /** Push any keystrokes the view hasn't serialised yet into the model, now. */
  serialize?: () => void;
}

/** One open note. Reactive fields re-render every view that reads them. */
export class NoteModel {
  /** The note's path in its on-disk spelling. */
  relPath = $state('');
  status = $state<NoteStatus>('loading');
  /** Frontmatter on disk with any queued change laid over it. */
  frontmatter = $state.raw<Record<string, unknown>>({});
  /** The body every view shows (Markdown without frontmatter). */
  body = $state('');
  /** Bumps whenever `body` changes; `bodySource` says who changed it. */
  bodyRevision = $state(0);
  bodySource: ViewId | 'disk' = 'disk';
  /** True while an edited body hasn't reached disk. */
  hasUnsavedBody = $state(false);
  /** The view typing in the note (D7). */
  editorOwner = $state<ViewId | null>(null);
  /** The body can't round-trip through the editor, so it isn't written. */
  lossy = $state(false);
  /** Why the last read failed (status `unreadable`). */
  readError = $state<unknown>(null);
  /** The bytes the local state was built on. */
  base: DiskSnapshot | undefined = undefined;
  localBodyVersion = 0;
  /** The disk version waiting for the user's decision (status `conflict`). */
  conflictDisk: FreshRead | null = null;
  readonly views = new SvelteMap<ViewId, ViewHooks>();
  loaded: Promise<void> = Promise.resolve();

  constructor(relPath: string) {
    this.relPath = relPath;
  }

  get path(): VaultPath {
    return vaultPath(this.relPath);
  }

  /** Lossy or not UTF-8: shown, never written from an editor. */
  get readOnly(): boolean {
    return this.lossy || isNonUtf8(this.relPath);
  }
}

/** Waits before re-reading a note caught mid-write by another program. */
const TORN_RETRY_MS = [500, 1500, 3000];

const models = new SvelteMap<VaultPath, NoteModel>();
/** `writeBody` calls still waiting for their note to load (settled promises leave). */
// allow-module-state: transient; each entry settles with its note's first read
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const bodiesLoading = new Set<Promise<void>>();
const loadingBodyPaths = new SvelteSet<VaultPath>();
/** Queued frontmatter changes of notes no model holds, for display. */
const overlays = new SvelteMap<VaultPath, FrontmatterDelta>();

/** Conflict and deletion prompts, installed by `notePrompts.ts`. */
export interface NotePromptHandlers {
  conflict(model: NoteModel): void;
  deletedWithUnsavedBody(model: NoteModel): void;
  /**
   * A queued change couldn't be saved because the file is gone. `model` is
   * set when a body is among it (it can be saved as a new file).
   */
  writeTargetMissing(relPath: string, model: NoteModel | undefined): void;
  reloadShrank(model: NoteModel, priorBody: string): void;
  dismiss(relPath: string): void;
}
let prompts: NotePromptHandlers = {
  conflict: () => undefined,
  deletedWithUnsavedBody: () => undefined,
  writeTargetMissing: () => undefined,
  reloadShrank: () => undefined,
  dismiss: () => undefined,
};
export function setNotePromptHandlers(handlers: NotePromptHandlers): void {
  prompts = handlers;
}

const writer: NoteWriter = createNoteWriter({
  vaultRoot: () => getActiveVaultPath() || null,
  baseOf: (path) => models.get(path)?.base,
  hadFrontmatter: (path) => hadFrontmatter(path),
  canWriteBody: (path) => {
    const m = models.get(path);
    return !!m && m.status !== 'conflict' && !m.readOnly;
  },
  onBodyConflict: (path, _relPath, disk) => {
    const m = models.get(path);
    if (!m) return;
    enterConflict(m, disk);
  },
  onWritten: (path, relPath, written, snapshot, consumed) => {
    afterWrite(path, relPath, written, snapshot, consumed);
  },
  onTargetMissing: (path, relPath, hasBody) => {
    const m = models.get(path);
    prompts.writeTargetMissing(relPath, hasBody && m ? m : undefined);
  },
});

function afterWrite(
  path: VaultPath,
  relPath: string,
  written: NoteText,
  snapshot: DiskSnapshot,
  consumed: { bodyVersion?: number; delta?: FrontmatterDelta },
): void {
  try {
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, written.raw));
  } catch (err) {
    console.warn('[noteStore] index refresh after a write failed:', err);
  }
  syncOverlay(path);
  const m = models.get(path);
  if (!m) return;
  m.relPath = relPath;
  m.base = snapshot;
  m.frontmatter = withQueued(path, written.frontmatter);
  if (consumed.bodyVersion !== undefined) {
    // Our own body landed; the views already show it.
    if (consumed.bodyVersion === m.localBodyVersion) m.hasUnsavedBody = false;
  } else if (!m.hasUnsavedBody && !writer.hasPendingBody(path) && !sameBody(m.body, written.body)) {
    // A rewrite from the file's bytes (Replace All, a restore): views follow.
    setModelBody(m, written.body, 'disk');
  }
  if (m.status === 'loading' || m.status === 'missing' || m.status === 'unreadable') m.status = 'ready';
  // The write is still in flight here; look again once it has settled.
  setTimeout(() => evictIfIdle(m), 0);
}

/**
 * Whether the note was last known to have frontmatter: its base when a model
 * holds one, else the vault index. A read that contradicts this may be torn.
 */
function hadFrontmatter(path: VaultPath): boolean {
  const base = models.get(path)?.base;
  if (base) return readNoteText(base.rawText).hasFrontmatter;
  return (vaultIndexStore.getMetadata(path)?.rawFrontmatter ?? '') !== '';
}

/** `fm` with the note's still-queued frontmatter change applied. */
function withQueued(path: VaultPath, fm: Record<string, unknown>): Record<string, unknown> {
  const queued = writer.pendingDelta(path);
  return queued ? applyFrontmatterDelta(fm, queued) : fm;
}

function syncOverlay(path: VaultPath): void {
  const queued = writer.pendingDelta(path);
  if (queued) overlays.set(path, queued);
  else overlays.delete(path);
}

function setModelBody(m: NoteModel, body: string, source: ViewId | 'disk'): void {
  m.body = body;
  m.bodySource = source;
  m.bodyRevision++;
}

function enterConflict(m: NoteModel, disk: FreshRead): void {
  m.conflictDisk = disk;
  if (m.status === 'conflict') return;
  m.status = 'conflict';
  prompts.conflict(m);
}

/** Takes the disk version into the model: body, frontmatter and base. */
function adoptDisk(m: NoteModel, fresh: FreshRead): void {
  m.base = snapshotOf(fresh.text, fresh.mtimeMs, fresh.size);
  m.frontmatter = withQueued(m.path, fresh.text.frontmatter);
  if (!sameBody(m.body, fresh.text.body) || m.status === 'loading') setModelBody(m, fresh.text.body, 'disk');
  m.hasUnsavedBody = false;
  m.conflictDisk = null;
  m.readError = null;
  m.status = 'ready';
}

async function load(m: NoteModel, force = false): Promise<void> {
  const vaultRoot = getActiveVaultPath();
  if (!vaultRoot) return;
  const identity = captureVaultIdentity();
  try {
    let fresh = await readNoteFresh(vaultRoot, m.relPath);
    // A first read caught mid-write by another program is read again; one
    // that stays torn is not taken as the note.
    for (let attempt = 0; looksTorn(fresh.text, hadFrontmatter(m.path)); attempt++) {
      if (attempt >= TORN_RETRY_MS.length || models.get(m.path) !== m || !isStillSameVault(identity)) {
        if (models.get(m.path) === m && isStillSameVault(identity)) {
          m.readError = new Error(`"${m.relPath}" looks half-written by another program`);
          m.status = 'unreadable';
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, TORN_RETRY_MS[attempt]));
      fresh = await readNoteFresh(vaultRoot, m.relPath);
    }
    if (models.get(m.path) !== m) return;
    if (!isStillSameVault(identity)) {
      // The read belongs to the previous vault. A model still held here (a
      // view of the new vault acquired it) reads again rather than staying
      // loading.
      if (m.status === 'loading') m.loaded = load(m);
      return;
    }
    // A write (a brand-new note's create) may have filled the model meanwhile.
    if (!force && m.status === 'ready' && m.base) return;
    adoptDisk(m, fresh);
  } catch (err) {
    if (models.get(m.path) !== m) return;
    if (!isStillSameVault(identity)) {
      if (m.status === 'loading') m.loaded = load(m);
      return;
    }
    if (isMissingFileError(err)) {
      if (m.status === 'loading') {
        m.status = 'missing';
        m.frontmatter = withQueued(m.path, {});
        setModelBody(m, '', 'disk');
      }
    } else {
      m.readError = err;
      m.status = 'unreadable';
    }
  }
}

function evictIfIdle(m: NoteModel): void {
  if (m.views.size > 0) return;
  if (m.hasUnsavedBody || writer.hasWork(m.relPath)) return;
  if (models.get(m.path) === m) models.delete(m.path);
}

/** Pulls every view's unserialised keystrokes into the models. */
function serializeViews(path?: VaultPath): void {
  const targets = path ? [models.get(path)].filter((m): m is NoteModel => !!m) : [...models.values()];
  for (const m of targets) {
    for (const hooks of [...m.views.values()]) {
      try {
        hooks.serialize?.();
      } catch (err) {
        console.warn('[noteStore] view serialise failed:', err);
      }
    }
  }
}

export const noteStore = {
  /** Registers `viewId` as showing the note, loading it on first use. */
  acquire(relPath: string, viewId: ViewId, hooks: ViewHooks = {}): NoteModel {
    const key = vaultPath(relPath);
    let m = models.get(key);
    if (!m) {
      m = new NoteModel(relPath);
      models.set(key, m);
      m.loaded = load(m);
    }
    m.views.set(viewId, hooks);
    return m;
  },

  /** `viewId` no longer shows the note. The model goes once idle and unviewed. */
  release(relPath: string, viewId: ViewId): void {
    const m = models.get(vaultPath(relPath));
    if (!m) return;
    m.views.delete(viewId);
    if (m.editorOwner === viewId) m.editorOwner = null;
    // The last view is going: write what it left now (this also retries a
    // write that failed earlier) rather than waiting for the next save.
    if (m.views.size === 0 && m.hasUnsavedBody) void writer.flush(m.relPath);
    evictIfIdle(m);
  },

  /** The loaded model for `path`, if any view holds it. */
  get(path: string): NoteModel | undefined {
    return path ? models.get(vaultPath(path)) : undefined;
  },

  /** The note's frontmatter: the model's, else the index's with queued changes. */
  frontmatter(path: string): Readonly<Record<string, unknown>> {
    if (!path) return {};
    const key = vaultPath(path);
    const m = models.get(key);
    if (m && m.status !== 'loading') return m.frontmatter;
    const indexed = (vaultIndexStore.getMetadata(path)?.frontmatter as Record<string, unknown> | undefined) ?? {};
    const queued = overlays.get(key);
    return queued ? applyFrontmatterDelta(indexed, queued) : indexed;
  },

  /**
   * The note's frontmatter as it stands, for a decision about to change it:
   * the model's when loaded, else a fresh read of the file with any queued
   * change laid over it (the index may lag the disk). Null when the file
   * can't be read.
   */
  async currentFrontmatter(relPath: string): Promise<Record<string, unknown> | null> {
    const key = vaultPath(relPath);
    const identity = captureVaultIdentity();
    const m = models.get(key);
    if (m) await m.loaded;
    if (!isStillSameVault(identity)) return null;
    if (m && models.get(key) === m && m.status !== 'missing' && m.status !== 'unreadable') return m.frontmatter;
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot) return null;
    try {
      const fresh = await readNoteFresh(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return null;
      return withQueued(key, fresh.text.frontmatter);
    } catch {
      return null;
    }
  },

  /** A view's editor produced `markdown` as the note's body. */
  setBody(relPath: string, markdown: string, viewId: ViewId): void {
    const m = models.get(vaultPath(relPath));
    // Only a view that holds this model may write through it: a view left
    // over from a closed vault must not reach a same-named note in the next.
    if (!m || !m.views.has(viewId)) return;
    if (m.readOnly || m.status === 'loading' || m.status === 'unreadable') return;
    if (m.body === markdown && !m.hasUnsavedBody) return;
    m.editorOwner = viewId;
    setModelBody(m, markdown, viewId);
    m.localBodyVersion++;
    m.hasUnsavedBody = true;
    writer.queueBody(m.relPath, markdown, m.localBodyVersion);
  },

  /**
   * Sets the note's body from a view that isn't an editor (the Task List
   * notes box): loads the note first, so the drift check has its base.
   */
  async writeBody(relPath: string, body: string): Promise<void> {
    const viewId = `body:${vaultPath(relPath)}`;
    const identity = captureVaultIdentity();
    const vaultRoot = getActiveVaultPath() || undefined;
    const m = noteStore.acquire(relPath, viewId);
    // Until the note has loaded nothing is queued, yet the text is unsaved:
    // save and quit wait for it, and the crash sentinel names the path.
    noteAdditionalPendingPath(vaultRoot, relPath);
    const done = (async () => {
      await m.loaded;
      if (isStillSameVault(identity)) noteStore.setBody(m.relPath, body, viewId);
    })();
    bodiesLoading.add(done);
    loadingBodyPaths.add(vaultPath(relPath));
    try {
      await done;
    } finally {
      bodiesLoading.delete(done);
      loadingBodyPaths.delete(vaultPath(relPath));
      dropPendingPath(vaultRoot, relPath);
      // The model stays while the body is unsaved.
      noteStore.release(m.relPath, viewId);
    }
  },

  /**
   * Queues a frontmatter change. It lands on a fresh read of the file, so
   * keys it doesn't name (including ones another program added) are kept.
   */
  patchFrontmatter(relPath: string, delta: FrontmatterDelta): void {
    if (!relPath) return;
    const key = vaultPath(relPath);
    writer.queueDelta(relPath, delta);
    const m = models.get(key);
    if (m) m.frontmatter = applyFrontmatterDelta(m.frontmatter, delta);
    syncOverlay(key);
  },

  /** Writes `path`'s queued changes now. */
  async flush(relPath: string): Promise<boolean> {
    await Promise.all([...bodiesLoading]);
    serializeViews(vaultPath(relPath));
    return (await writer.flush(relPath)).ok;
  },

  /** Writes every queued change now (save, quit, before a rename). */
  async flushAll(): Promise<{ failed: string[] }> {
    await Promise.all([...bodiesLoading]);
    serializeViews();
    return writer.flushAll();
  },

  /** True while anything for `path` is queued, being written or failed. */
  hasPendingWrites(relPath: string): boolean {
    return loadingBodyPaths.has(vaultPath(relPath)) || writer.hasWork(relPath);
  },

  /** The editor found the body can't round-trip; it's shown but not written. */
  setLossy(relPath: string, lossy: boolean): void {
    const m = models.get(vaultPath(relPath));
    if (m && m.lossy !== lossy) m.lossy = lossy;
  },

  /** The user accepted that saving may rewrite formatting Filo can't keep. */
  takeOwnership(relPath: string): void {
    const m = models.get(vaultPath(relPath));
    if (m) m.lossy = false;
  },

  /** Re-reads a note whose read failed. */
  async reload(relPath: string): Promise<void> {
    const m = models.get(vaultPath(relPath));
    if (!m) return;
    m.loaded = load(m, true);
    await m.loaded;
  },

  /** The file changed on disk (watcher). Decides per the C.5 table. */
  async onDiskChanged(relPath: string, attempt = 0): Promise<void> {
    const key = vaultPath(relPath);
    const m = models.get(key);
    if (!m) return;
    const identity = captureVaultIdentity();
    await m.loaded;
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot || !isStillSameVault(identity)) return;
    serializeViews(key);
    let fresh: FreshRead | null = null;
    try {
      fresh = await readNoteFresh(vaultRoot, m.relPath);
    } catch (err) {
      if (!isMissingFileError(err)) return;
    }
    if (models.get(key) !== m || !isStillSameVault(identity)) return;
    const hash = fresh ? noteTextHash(fresh.text.raw) : null;
    const action = decideDiskChange({
      exists: fresh !== null,
      isOwnWrite: hash !== null && (hash === m.base?.hash || writer.isOwnWrite(key, hash)),
      hasUnsavedBody: m.hasUnsavedBody || writer.hasPendingBody(key),
      bodyChanged: fresh !== null && (!m.base || !sameBody(fresh.text.body, snapshotBody(m.base))),
      // After a few tries a file that still looks torn is taken as it is.
      torn: attempt < TORN_RETRY_MS.length && fresh !== null && looksTorn(fresh.text, hadFrontmatter(key)),
    });
    switch (action) {
      case 'ignore':
        return;
      case 'retry':
        setTimeout(() => void noteStore.onDiskChanged(m.relPath, attempt + 1), TORN_RETRY_MS[attempt]);
        return;
      case 'replace': {
        if (!fresh) return;
        const prior = m.body;
        adoptDisk(m, fresh);
        prompts.dismiss(m.relPath);
        if (prior.length >= 256 && fresh.text.body.length < prior.length * 0.5) prompts.reloadShrank(m, prior);
        return;
      }
      case 'take-frontmatter':
        if (!fresh) return;
        m.base = snapshotOf(fresh.text, fresh.mtimeMs, fresh.size);
        m.frontmatter = withQueued(key, fresh.text.frontmatter);
        return;
      case 'conflict':
        if (fresh) enterConflict(m, fresh);
        return;
      case 'missing':
        if (m.hasUnsavedBody || writer.hasPendingBody(key)) prompts.deletedWithUnsavedBody(m);
        else m.status = 'missing';
        return;
    }
  },

  /**
   * The user's answer to a conflict. `keep-mine` backs nothing up itself (the
   * prompt does that first) and writes the local body over the disk version;
   * `reload` drops the unsaved body and shows the disk version.
   */
  async resolveConflict(relPath: string, choice: 'keep-mine' | 'reload'): Promise<void> {
    const key = vaultPath(relPath);
    const m = models.get(key);
    const vaultRoot = getActiveVaultPath();
    if (!m || !vaultRoot) return;
    const identity = captureVaultIdentity();
    let fresh: FreshRead;
    try {
      fresh = await readNoteFresh(vaultRoot, m.relPath);
    } catch (err) {
      if (!isStillSameVault(identity)) return;
      if (!isMissingFileError(err)) throw err;
      if (choice === 'reload') {
        writer.dropBody(key);
        m.hasUnsavedBody = false;
        m.conflictDisk = null;
        m.status = 'missing';
      }
      return;
    }
    if (models.get(key) !== m || !isStillSameVault(identity)) return;
    if (choice === 'reload') {
      writer.dropBody(key);
      m.editorOwner = null;
      adoptDisk(m, fresh);
      return;
    }
    // Keep mine: the local body is now built on what's on disk.
    m.base = snapshotOf(fresh.text, fresh.mtimeMs, fresh.size);
    m.frontmatter = withQueued(key, fresh.text.frontmatter);
    m.conflictDisk = null;
    m.status = 'ready';
    if (m.hasUnsavedBody && !writer.hasPendingBody(key)) {
      writer.queueBody(m.relPath, m.body, m.localBodyVersion);
    }
    await writer.flush(key);
  },

  /**
   * Re-creates a note deleted on disk while it had unsaved edits, from the
   * model (create-exclusive: if something is there again, nothing is
   * overwritten and the result is `exists`).
   */
  async recreate(relPath: string, text: string): Promise<'created' | 'exists'> {
    const m = models.get(vaultPath(relPath));
    if (m) {
      // The recreated text carries the local body; nothing is left to queue.
      writer.dropBody(relPath);
      m.hasUnsavedBody = false;
    }
    const keepPending = (): void => {
      if (!m) return;
      m.hasUnsavedBody = true;
      writer.queueBody(m.relPath, m.body, m.localBodyVersion);
    };
    let outcome: 'created' | 'exists';
    try {
      outcome = await writer.createExclusive(relPath, text);
    } catch (err) {
      // The create failed (reported by the writer): the edit is still unsaved.
      keepPending();
      throw err;
    }
    // Something is back at the path: keep the local body pending so the
    // conflict check compares it with what's there now.
    if (outcome === 'exists') keepPending();
    return outcome;
  },

  /**
   * Puts `body` back as an unsaved edit that every view shows (undoing a
   * reload the user didn't want).
   */
  restoreBody(relPath: string, body: string): void {
    const m = models.get(vaultPath(relPath));
    if (!m || m.readOnly) return;
    setModelBody(m, body, 'disk');
    m.localBodyVersion++;
    m.hasUnsavedBody = true;
    writer.queueBody(m.relPath, body, m.localBodyVersion);
  },

  /**
   * The user deleted `relPath` (a note, or a folder of them) in the app:
   * whatever was queued for those notes is dropped and their models go
   * missing. The watcher doesn't report our own deletes.
   */
  forgetDeleted(relPath: string): void {
    const key = vaultPath(relPath);
    const prefix = `${key}/`;
    for (const [path, m] of [...models]) {
      if (path !== key && !path.startsWith(prefix)) continue;
      writer.drop(path);
      m.hasUnsavedBody = false;
      m.status = 'missing';
      evictIfIdle(m);
    }
    for (const path of [...overlays.keys()]) {
      if (path === key || path.startsWith(prefix)) {
        writer.drop(path);
        overlays.delete(path);
      }
    }
  },

  /**
   * `relPath` (a note, or a folder of them) is back on disk after a restore
   * from Filo's trash: every open view of a note there that went missing
   * reads it again. The watcher doesn't report our own restores.
   */
  restoredFromTrash(relPath: string): void {
    const key = vaultPath(relPath);
    const prefix = `${key}/`;
    for (const [path, m] of models) {
      if (path !== key && !path.startsWith(prefix)) continue;
      if (m.status === 'missing' || m.status === 'loading') m.loaded = load(m, true);
    }
  },

  /** The unsaved body of a note deleted on disk is dropped. */
  discardDeleted(relPath: string): void {
    const m = models.get(vaultPath(relPath));
    if (!m) return;
    writer.dropBody(relPath);
    m.hasUnsavedBody = false;
    m.status = 'missing';
    evictIfIdle(m);
  },

  /**
   * Everything still queued for `relPath` is dropped (the user discarded a
   * change that can't be saved because the file is gone), so the failure no
   * longer blocks anything or reads as unsaved work.
   */
  discardQueued(relPath: string): void {
    writer.drop(relPath);
    const key = vaultPath(relPath);
    overlays.delete(key);
    const m = models.get(key);
    if (!m) return;
    m.hasUnsavedBody = false;
    evictIfIdle(m);
  },

  /** Creates `relPath` exclusively (never overwrites). */
  createExclusive(relPath: string, text: string): Promise<'created' | 'exists'> {
    return writer.createExclusive(relPath, text);
  },

  /** Creates a note at the first free name from `firstCandidate` on. */
  createUnique(
    firstCandidate: string,
    buildText: (finalStem: string) => string,
  ): Promise<{ relPath: string; stem: string; text: string }> {
    return writer.createUnique(firstCandidate, buildText);
  },

  /** Rewrites a note from its fresh bytes, inside its queue. */
  transform(
    relPath: string,
    fn: (fresh: NoteText) => string | null,
    track?: TrackComponentWriteOptions,
  ): Promise<string | null> {
    serializeViews(vaultPath(relPath));
    return writer.transform(relPath, fn, track);
  },

  /**
   * The file's full text as it is on disk, for the raw view, once every
   * queued change to it has been written. Null when it can't be read.
   */
  async readRaw(relPath: string): Promise<{ raw: string; hash: string; nonUtf8: boolean } | null> {
    const identity = captureVaultIdentity();
    await noteStore.flush(relPath);
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot || !isStillSameVault(identity)) return null;
    try {
      const fresh = await readNoteFresh(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return null;
      return { raw: fresh.text.raw, hash: noteTextHash(fresh.text.raw), nonUtf8: fresh.nonUtf8 };
    } catch {
      return null;
    }
  },

  /**
   * Replaces the whole file with `text` from the raw view. It lands only if
   * the file still holds the bytes the raw view started from (`basedOnHash`);
   * otherwise nothing is written and the result is `conflict`, so a change
   * made elsewhere meanwhile is never overwritten unseen. The file's BOM and
   * line ending are kept. A note that isn't UTF-8 is never written.
   */
  async writeRaw(relPath: string, text: string, basedOnHash: string): Promise<'written' | 'unchanged' | 'conflict'> {
    let conflict = false;
    const written = await noteStore.transform(relPath, (fresh) => {
      if (noteTextHash(fresh.raw) !== basedOnHash) {
        conflict = true;
        return null;
      }
      return rawTextForDisk(text, fresh);
    });
    if (conflict) return 'conflict';
    return written === null ? 'unchanged' : 'written';
  },

  /** Writes a deleted note back (undo of a delete). */
  restore(relPath: string, text: string, track?: TrackComponentWriteOptions): Promise<void> {
    return writer.restore(relPath, text, track);
  },

  /** Runs a rename or delete of `paths` with their queues held idle. */
  hold<T>(paths: string[], op: () => Promise<T>): Promise<T> {
    for (const p of paths) serializeViews(vaultPath(p));
    return writer.hold(paths, op);
  },

  /** Test-only: every model and queue dropped. */
  __resetForTests(): void {
    writer.reset();
    models.clear();
    overlays.clear();
    loadingBodyPaths.clear();
  },
};

/**
 * The rename sweep: each model, queued change and overlay under the old path
 * moves to the new one, so every view keeps its note and later writes land
 * on the renamed file.
 *
 * A board can point its tiles at the new path before the file is renamed on
 * disk, so a view may already have acquired a model there (found missing). The
 * moved model takes its place and its views. A model at the new path that
 * nothing moved onto is read again, now that the file is there.
 */
function renameNotePaths(oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const newKey = vaultPath(newRel);
  const oldPrefix = `${oldKey}/`;
  const newPrefix = `${newKey}/`;
  writer.renamePath(oldRel, newRel);
  // A local scratch set, never read reactively.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const moved = new Set<NoteModel>();
  for (const [key, m] of [...models]) {
    let rel: string | null = null;
    if (key === oldKey) rel = newRel;
    else if (key.startsWith(oldPrefix)) rel = newRel + m.relPath.slice(oldRel.length);
    if (rel === null) continue;
    models.delete(key);
    m.relPath = rel;
    const displaced = models.get(vaultPath(rel));
    if (displaced && displaced !== m) {
      for (const [viewId, hooks] of displaced.views) m.views.set(viewId, hooks);
    }
    models.set(vaultPath(rel), m);
    moved.add(m);
  }
  for (const [key, m] of models) {
    if (moved.has(m) || (key !== newKey && !key.startsWith(newPrefix))) continue;
    if (m.status === 'missing' || m.status === 'loading') m.loaded = load(m, true);
  }
  for (const [key, delta] of [...overlays]) {
    if (key === oldKey || key.startsWith(oldPrefix)) {
      overlays.delete(key);
      overlays.set(vaultPath(key === oldKey ? newRel : newRel + key.slice(oldKey.length)), delta);
    }
  }
}

registerPathRenamable('noteStore', renameNotePaths);

onVaultSwap('pre-swap', 'noteStore', () => {
  writer.reset();
  models.clear();
  overlays.clear();
  loadingBodyPaths.clear();
});
