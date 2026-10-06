/**
 * noteStore — one model per open note, shared by every view of it.
 *
 * A note's vault path is its only name. Every view that shows a note (a text
 * tile, a Document tab, a Task List row) `acquire`s its model and reads
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
import { SvelteSet } from 'svelte/reactivity';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { onVaultSwap } from '../core/vaultLifecycle';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultIndexStore } from './vaultIndex.svelte';
import { KeyedSvelteMap } from '../lib/utils/keyedReactivity.svelte';
import { parseMarkdown } from '../lib/vault/vaultIndex';
import { applyFrontmatterDelta, type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import {
  createNoteWriter,
  isMissingFileError,
  NoteBusyError,
  readNoteFresh,
  readOfSnapshot,
  type FreshRead,
  type NoteWriter,
  type TransformOptions,
} from '../lib/notes/noteWriter';
import {
  localNoteText,
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
import { flushRawViews } from '../lib/notes/rawViews';
import { askUnlessMoved, dropGraceChecks, settleGraceChecksNow } from '../lib/notes/renameGrace';
import { unsavedNoteTexts } from '../lib/notes/unsavedNoteTexts';
import { createDiskChangeHandler } from './noteDiskChanges';
import { backupThenRead } from '../lib/vault/keepLocalBackup';
import { keepNoteVersion } from '../lib/notes/keepVersion';
import type { RoundTripChange } from '../lib/editor/markdownSync';
import {
  NoteModel,
  type NotePromptHandlers,
  type RawWriteResult,
  type SetBodyStatus,
  type ViewHooks,
  type ViewId,
} from './noteModel.svelte';
import {
  dropPendingPath,
  noteAdditionalPendingPath,
  registerUnsavedSource,
  type TrackComponentWriteOptions,
} from '../lib/boards/writeStateTracking';

export { NoteModel };
export type { NotePromptHandlers, NoteStatus, RawWriteResult, SetBodyStatus, ViewHooks, ViewId } from './noteModel.svelte';

/** Waits before re-reading a note caught mid-write by another program. */
const TORN_RETRY_MS = [500, 1500, 3000];

// Keyed: a view asking about a note that isn't open depends on that note alone,
// so opening one note doesn't re-run every card on a board.
const models = new KeyedSvelteMap<VaultPath, NoteModel>();
/** `writeBody` calls still waiting for their note to load (settled promises leave). */
// allow-module-state: transient; each entry settles with its note's first read
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const bodiesLoading = new Set<Promise<unknown>>();
const loadingBodyPaths = new SvelteSet<VaultPath>();
/** Queued frontmatter changes of notes no model holds, for display. */
const overlays = new KeyedSvelteMap<VaultPath, FrontmatterDelta>();

let prompts: NotePromptHandlers = {
  conflict: () => undefined,
  deletedWithUnsavedBody: () => undefined,
  writeTargetMissing: () => undefined,
  reloadShrank: () => undefined,
  reloadedOverTyping: () => undefined,
  confirmReloadWithoutCopy: async () => false,
  dismiss: () => undefined,
};
export function setNotePromptHandlers(handlers: NotePromptHandlers): void {
  prompts = handlers;
}

/**
 * Told about every note Filo creates. The main process hides our own creates
 * from the watcher, so without this the sidebar lists a new note late.
 */
let noteCreated: (relPath: string) => void = () => undefined;
export function setNoteCreatedListener(listener: (relPath: string) => void): void {
  noteCreated = listener;
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
  lastKnown: (path) => vaultIndexStore.knownShape(path),
  onTargetMissing: (path, relPath, hasBody) => {
    askUnlessMoved(
      relPath,
      () => writer.isQueued(path),
      () => {
        const m = models.get(path);
        prompts.writeTargetMissing(relPath, hasBody && m ? m : undefined);
      },
      () => writer.schedule(relPath),
    );
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
  m.fileGone = false;
  if (
    consumed.bodyVersion === undefined
    && (m.hasUnsavedBody || writer.hasPendingBody(path))
    && m.base
    && !sameBody(written.body, snapshotBody(m.base))
  ) {
    // A rewrite (Replace All, the raw view) changed the body under an edit
    // built on the old one. Moving the base on would let that edit land over
    // the rewrite unseen; it becomes the one prompt instead.
    m.frontmatter = withQueued(path, written.frontmatter);
    enterConflict(m, readOfSnapshot(snapshot));
    return;
  }
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
  if (source === 'disk') m.diskRevision = m.bodyRevision;
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
  m.fileGone = false;
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

const onDiskChanged = createDiskChangeHandler({
  model: (path) => models.get(path),
  writer,
  prompts: () => prompts,
  adoptDisk,
  enterConflict,
  withQueued,
  serializeViews: (path) => serializeViews(path),
  hadFrontmatter,
});

function evictIfIdle(m: NoteModel): void {
  if (m.views.size > 0) return;
  if (m.hasUnsavedBody || writer.hasWork(m.relPath)) return;
  if (models.get(m.path) === m) models.delete(m.path);
}

/** True when a view of `m` holds keystrokes not yet in the model. */
function viewsUnserialised(m: NoteModel): boolean {
  return [...m.views.values()].some((hooks) => hooks.unserialised?.() === true);
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

/** The typed body a Reload drops, and the folder of its copy (null: the user went on without one). */
interface KeptTyping {
  body: string;
  dir: string | null;
}

/** How many times a copy is taken again because typing went on while it was written. */
const KEEP_TYPING_ATTEMPTS = 3;

/**
 * Reload throws away what was typed, so a copy of the note as typed goes to
 * `.filo/recovery/<ts>-keep/` first. The copy is of the body as it stands
 * once the copy is written: text typed while it was being written gets a
 * new copy. Resolves:
 *  - null: nothing typed to keep;
 *  - the body kept, and where;
 *  - `declined`: no copy could be written and the user chose not to reload;
 *  - `stop`: the note or the vault went away meanwhile.
 */
async function keepTypingBeforeReload(
  m: NoteModel,
  vaultRoot: string,
  identity: ReturnType<typeof captureVaultIdentity>,
): Promise<KeptTyping | null | 'declined' | 'stop'> {
  const current = (): boolean => models.get(m.path) === m && isStillSameVault(identity);
  let dir: string | null = null;
  let copied: string | null = null;
  for (let attempt = 0; attempt < KEEP_TYPING_ATTEMPTS; attempt++) {
    serializeViews(m.path);
    if (!m.hasUnsavedBody) return null;
    if (copied === m.body) break;
    copied = m.body;
    dir = await keepNoteVersion(vaultRoot, m.relPath, localNoteText(m.base, m.frontmatter, copied));
    if (!current()) return 'stop';
  }
  serializeViews(m.path);
  if (copied !== m.body) dir = null;
  if (dir) return { body: m.body, dir };
  if (!(await prompts.confirmReloadWithoutCopy(m))) return current() ? 'declined' : 'stop';
  if (!current()) return 'stop';
  serializeViews(m.path);
  return m.hasUnsavedBody ? { body: m.body, dir: null } : null;
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
   *
   * `fromDisk` reads the file even when a model is loaded: the model learns
   * of another program's save only after the watcher's debounce, so a check
   * for "changed outside since" must not trust it. The model's copy answers
   * only when that read fails.
   */
  async currentFrontmatter(relPath: string, opts: { fromDisk?: boolean } = {}): Promise<Record<string, unknown> | null> {
    const key = vaultPath(relPath);
    const identity = captureVaultIdentity();
    const m = models.get(key);
    if (m) await m.loaded;
    if (!isStillSameVault(identity)) return null;
    const usable = m && models.get(key) === m && m.status !== 'missing' && m.status !== 'unreadable' ? m : null;
    if (usable && !opts.fromDisk) return usable.frontmatter;
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot) return null;
    try {
      const fresh = await readNoteFresh(vaultRoot, relPath);
      if (!isStillSameVault(identity)) return null;
      return withQueued(key, fresh.text.frontmatter);
    } catch {
      return usable ? usable.frontmatter : null;
    }
  },

  /** A view's editor produced `markdown` as the note's body. */
  setBody(relPath: string, markdown: string, viewId: ViewId): SetBodyStatus {
    const m = models.get(vaultPath(relPath));
    // Only a view that holds this model may write through it: a view left
    // over from a closed vault must not reach a same-named note in the next.
    if (!m || !m.views.has(viewId)) return 'not-open';
    if (m.readOnly) return 'read-only';
    // A missing note has no version to build on: a body taken now would be written blind over whatever appears there.
    if (m.status === 'loading' || m.status === 'unreadable' || m.status === 'missing') return m.status;
    if (m.body === markdown && !m.hasUnsavedBody) return 'queued';
    m.editorOwner = viewId;
    setModelBody(m, markdown, viewId);
    m.localBodyVersion++;
    m.hasUnsavedBody = true;
    writer.queueBody(m.relPath, markdown, m.localBodyVersion);
    return 'queued';
  },

  /**
   * A view's editor produced `markdown` from a body the model has since
   * replaced (the disk changed, or a rewrite landed, while it held unsaved
   * keystrokes). Writing it would erase that change, so it is kept as an
   * unsaved body in conflict with what the model now holds: the one prompt
   * (Reload / Keep mine, which backs the other version up first) decides.
   */
  setBodyBuiltOn(relPath: string, markdown: string, viewId: ViewId, builtOn: string): SetBodyStatus {
    const m = models.get(vaultPath(relPath));
    if (!m || !m.views.has(viewId) || m.readOnly || m.status === 'loading' || m.status === 'unreadable' || m.status === 'missing') {
      return noteStore.setBody(relPath, markdown, viewId);
    }
    // Nothing of the other change is lost when the editor's text already
    // matches it, or when that change put back the very body it was built on.
    if (sameBody(markdown, m.body) || sameBody(builtOn, m.body)) return noteStore.setBody(relPath, markdown, viewId);
    const shown = m.base ? readOfSnapshot(m.base) : null;
    m.editorOwner = viewId;
    setModelBody(m, markdown, viewId);
    m.localBodyVersion++;
    m.hasUnsavedBody = true;
    writer.queueBody(m.relPath, markdown, m.localBodyVersion);
    if (shown) enterConflict(m, shown);
    return 'queued';
  },

  /**
   * Sets the note's body from a view that isn't an editor (the Task List
   * notes box): loads the note first, so the drift check has its base.
   * Anything but `queued` means the body was not taken, and the caller still
   * holds the only copy of it.
   */
  async writeBody(relPath: string, body: string): Promise<SetBodyStatus> {
    const viewId = `body:${vaultPath(relPath)}`;
    const identity = captureVaultIdentity();
    const vaultRoot = getActiveVaultPath() || undefined;
    const m = noteStore.acquire(relPath, viewId);
    // Until the note has loaded nothing is queued, yet the text is unsaved:
    // save and quit wait for it, and the crash sentinel names the path.
    noteAdditionalPendingPath(vaultRoot, relPath);
    const done = (async (): Promise<SetBodyStatus> => {
      await m.loaded;
      if (!isStillSameVault(identity)) return 'vault-changed';
      return noteStore.setBody(m.relPath, body, viewId);
    })();
    bodiesLoading.add(done);
    loadingBodyPaths.add(vaultPath(relPath));
    try {
      return await done;
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

  /**
   * Writes every queued change now (save, quit, before a rename). Raw views
   * save first: quit never unmounts one, so its text reaches disk only here.
   */
  async flushAll(): Promise<{ failed: string[]; rawNotSaved: string[] }> {
    const raw = await flushRawViews();
    await Promise.all([...bodiesLoading]);
    serializeViews();
    return { ...(await writer.flushAll()), rawNotSaved: raw.notSaved };
  },

  /** True while anything for `path` is queued, being written or failed. */
  hasPendingWrites(relPath: string): boolean {
    return loadingBodyPaths.has(vaultPath(relPath)) || writer.hasWork(relPath);
  },

  /**
   * Every note with a change that hasn't reached disk, as the text a rescue
   * copy holds: the note's last frontmatter with the queued change applied,
   * over the local body. A change to a note no model holds is laid over a
   * fresh read of the file (only the changed keys when it can't be read).
   */
  async unsavedTexts(): Promise<Array<{ relPath: string; text: string }>> {
    serializeViews();
    const out = await unsavedNoteTexts(models.values(), writer, getActiveVaultPath() || null);
    // Keystrokes the model refused are still only in their editor.
    for (const m of models.values()) {
      for (const hooks of m.views.values()) {
        const body = hooks.unserialisedBody?.();
        if (body != null) out.push({ relPath: m.relPath, text: localNoteText(m.base, m.frontmatter, body) });
      }
    }
    return out;
  },

  /**
   * A view's editor holds `markdown` for a note whose file is gone. It can't
   * be written there (nothing to build on), so it becomes the model's unsaved
   * body and the deleted-with-unsaved prompt asks **Keep mine** (writes it
   * back) or **Discard**; until then leave, quit and the rescue copy hold
   * it. False when the note
   * isn't a missing one this view holds.
   */
  holdBodyOfMissing(relPath: string, markdown: string, viewId: ViewId): boolean {
    const key = vaultPath(relPath);
    const m = models.get(key);
    if (!m || !m.views.has(viewId) || m.status !== 'missing') return false;
    const asked = m.hasUnsavedBody;
    if (m.body !== markdown) setModelBody(m, markdown, viewId);
    m.hasUnsavedBody = true;
    if (!asked) {
      askUnlessMoved(
        m.relPath,
        () => models.get(key) === m && m.hasUnsavedBody,
        () => prompts.deletedWithUnsavedBody(m),
        () => void noteStore.onDiskChanged(m.relPath),
      );
    }
    return true;
  },

  /** The editor found the body can't round-trip; it's shown but not written. */
  setLossy(relPath: string, lossy: boolean, changes: RoundTripChange[] = []): void {
    const m = models.get(vaultPath(relPath));
    if (!m) return;
    if (lossy && m.ownedDiskRevision === m.diskRevision) return;
    if (m.lossy !== lossy) m.lossy = lossy;
    m.lossyChanges = lossy ? changes : [];
  },

  /** The user accepted that saving may rewrite formatting Filo can't keep. */
  takeOwnership(relPath: string): void {
    const m = models.get(vaultPath(relPath));
    if (!m) return;
    m.ownedDiskRevision = m.diskRevision;
    m.lossy = false;
    m.lossyChanges = [];
  },

  /**
   * Re-reads a note (its read failed, or it was converted to UTF-8). With an
   * edit not saved yet, or a conflict open, the file goes through the check
   * every change on disk gets: a new body there meets the typed one as a
   * conflict, never under it.
   */
  async reload(relPath: string): Promise<void> {
    const key = vaultPath(relPath);
    const m = models.get(key);
    if (!m) return;
    serializeViews(key);
    if (m.status === 'conflict' || (m.status === 'ready' && (m.hasUnsavedBody || writer.hasPendingBody(key)))) {
      await onDiskChanged(m.relPath);
      return;
    }
    m.loaded = load(m, true);
    await m.loaded;
  },

  /** The file changed on disk (watcher). See `noteDiskChanges.ts`. */
  onDiskChanged(relPath: string, attempt = 0): Promise<void> {
    return onDiskChanged(relPath, attempt);
  },

  /**
   * The user's answer to a conflict. `keep-mine` backs up the version on disk
   * and writes the local body over exactly the bytes it backed up (a later
   * body change on disk is a new conflict, see the writer); `reload` keeps a
   * copy of the typed body in `.filo/recovery/<ts>-keep/` (asking before it
   * goes on without one), drops it and shows the disk version, and the
   * prompt then offers to undo the reload.
   */
  async resolveConflict(relPath: string, choice: 'keep-mine' | 'reload'): Promise<void> {
    const key = vaultPath(relPath);
    const m = models.get(key);
    const vaultRoot = getActiveVaultPath();
    if (!m || !vaultRoot) return;
    const identity = captureVaultIdentity();
    /**
     * Keeps the typed body before Reload drops it. The drop follows with no
     * await in between, so the copy holds exactly what is dropped. False
     * when the reload must not go on.
     */
    const keepTyping = async (): Promise<KeptTyping | null | false> => {
      const kept = await keepTypingBeforeReload(m, vaultRoot, identity);
      if (kept === 'stop') return false;
      if (kept === 'declined') {
        // The conflict stays open, to be answered again.
        prompts.conflict(m);
        return false;
      }
      return kept;
    };
    const announce = (typed: KeptTyping | null): void => {
      if (typed) prompts.reloadedOverTyping(m, typed.body, typed.dir);
    };
    let fresh: FreshRead;
    try {
      if (choice === 'reload') {
        fresh = await readNoteFresh(vaultRoot, m.relPath);
      } else {
        const got = await backupThenRead(vaultRoot, m.relPath, () => readNoteFresh(vaultRoot, m.relPath));
        if (!got.ok) {
          // Declined, or still being written: nothing is overwritten, and the
          // conflict stays open to be answered again.
          if (models.get(key) === m && isStillSameVault(identity)) prompts.conflict(m);
          return;
        }
        fresh = got.value;
      }
    } catch (err) {
      if (!isStillSameVault(identity)) return;
      if (!isMissingFileError(err)) throw err;
      if (models.get(key) !== m) return;
      if (choice === 'reload') {
        const typed = await keepTyping();
        if (typed === false) return;
        m.conflictDisk = null;
        m.fileGone = true;
        writer.dropBody(key);
        m.hasUnsavedBody = false;
        m.status = 'missing';
        announce(typed);
        return;
      }
      m.conflictDisk = null;
      m.fileGone = true;
      // Keep mine found the file gone: nothing to overwrite, and the body is
      // still only here. The conflict is over; the missing-file prompt offers
      // Save as new file (exclusive create) or Discard change.
      m.status = 'ready';
      prompts.writeTargetMissing(m.relPath, m);
      return;
    }
    if (models.get(key) !== m || !isStillSameVault(identity)) return;
    if (choice === 'reload') {
      const typed = await keepTyping();
      if (typed === false) return;
      writer.dropBody(key);
      m.editorOwner = null;
      adoptDisk(m, fresh);
      announce(typed);
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
    else noteCreated(relPath);
    return outcome;
  },

  /**
   * Puts `body` back as an unsaved edit that every view shows (undoing a
   * reload the user didn't want). A note no view holds any more is loaded
   * for it. Anything but `queued` means the body wasn't taken.
   */
  async restoreBody(relPath: string, body: string): Promise<SetBodyStatus> {
    const m = models.get(vaultPath(relPath));
    if (!m) return noteStore.writeBody(relPath, body);
    if (m.readOnly) return 'read-only';
    if (m.status === 'loading' || m.status === 'unreadable') return m.status;
    setModelBody(m, body, 'disk');
    m.localBodyVersion++;
    m.hasUnsavedBody = true;
    writer.queueBody(m.relPath, body, m.localBodyVersion);
    return 'queued';
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
  async createExclusive(relPath: string, text: string): Promise<'created' | 'exists'> {
    const outcome = await writer.createExclusive(relPath, text);
    if (outcome === 'created') noteCreated(relPath);
    return outcome;
  },

  /** Creates a note at the first free name from `firstCandidate` on. */
  async createUnique(
    firstCandidate: string,
    buildText: (finalStem: string) => string,
  ): Promise<{ relPath: string; stem: string; text: string }> {
    const created = await writer.createUnique(firstCandidate, buildText);
    noteCreated(created.relPath);
    return created;
  },

  /** Rewrites a note from its fresh bytes, inside its queue. */
  transform(
    relPath: string,
    fn: (fresh: NoteText) => string | null,
    track?: TrackComponentWriteOptions,
    options?: TransformOptions,
  ): Promise<string | null> {
    serializeViews(vaultPath(relPath));
    return writer.transform(relPath, fn, track, options);
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
   * made elsewhere meanwhile is never overwritten unseen (as it is while
   * another view's edit of the note can't be saved). The file's BOM and
   * line ending are kept. A note that isn't UTF-8 is never written.
   *
   * On success `hash` is of the bytes the file now holds from this write, so
   * the raw view's next save is checked against them, never against a later
   * read that a change queued meanwhile has already landed on.
   *
   * `skipped`: the writer left the file alone without comparing it (it is
   * no longer UTF-8, it is a link, or another vault opened), so the text is
   * not on disk.
   */
  async writeRaw(relPath: string, text: string, basedOnHash: string): Promise<RawWriteResult> {
    // Set inside the callbacks, so its type is widened here for the checks after them.
    let compared = 'no' as 'no' | 'conflict' | 'same' | 'changed';
    const written = await noteStore.transform(relPath, (fresh) => {
      if (noteTextHash(fresh.raw) !== basedOnHash) {
        compared = 'conflict';
        return null;
      }
      const next = rawTextForDisk(text, fresh);
      compared = next === fresh.raw ? 'same' : 'changed';
      return next;
    }, undefined, { userAuthored: true }).catch((err: unknown) => {
      // An edit elsewhere in the note isn't saved yet: the raw text waits too.
      if (!(err instanceof NoteBusyError)) throw err;
      compared = 'conflict';
      return null;
    });
    if (compared === 'conflict') return { status: 'conflict' };
    if (written !== null) return { status: 'written', hash: noteTextHash(written) };
    // Unchanged: the file already holds the bytes the hash names.
    if (compared === 'same') return { status: 'unchanged', hash: basedOnHash };
    return { status: 'skipped' };
  },

  /** Runs a rename or delete of `paths` (notes or folders) with every note queue under them held idle. */
  hold<T>(paths: string[], op: () => Promise<T>): Promise<T> {
    const roots = paths.map((p) => vaultPath(p));
    for (const key of [...models.keys()]) {
      if (roots.some((r) => key === r || key.startsWith(`${r}/`))) serializeViews(key);
    }
    return writer.hold(paths, op);
  },

  /** Test-only: every model and queue dropped. */
  __resetForTests(): void {
    writer.reset();
    models.clear();
    overlays.clear();
    loadingBodyPaths.clear();
    dropGraceChecks();
  },

  /**
   * Runs every "is it really gone?" check now instead of after the grace, and
   * waits for the ones a disk change or failed write is still about to start.
   */
  async __settleGraceChecksForTests(): Promise<void> {
    await settleGraceChecksNow();
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
    // A "deleted" or "couldn't save" prompt for the old name is answered: the
    // note moved. A conflict prompt still needs its answer.
    if (m.status !== 'conflict') prompts.dismiss(m.relPath);
    m.relPath = rel;
    const displaced = models.get(vaultPath(rel));
    if (displaced && displaced !== m) {
      for (const [viewId, hooks] of displaced.views) m.views.set(viewId, hooks);
    }
    models.set(vaultPath(rel), m);
    moved.add(m);
  }
  for (const [key, m] of models) {
    if (key !== newKey && !key.startsWith(newPrefix)) continue;
    // A moved note the watcher had already called missing (the delete came
    // before the rename) is read again at its new path.
    if (moved.has(m) ? m.status === 'missing' && !m.hasUnsavedBody : m.status === 'missing' || m.status === 'loading') {
      m.loaded = load(m, true);
    }
  }
  for (const [key, delta] of [...overlays]) {
    if (key === oldKey || key.startsWith(oldPrefix)) {
      overlays.delete(key);
      overlays.set(vaultPath(key === oldKey ? newRel : newRel + key.slice(oldKey.length)), delta);
    }
  }
}

registerPathRenamable('noteStore', renameNotePaths);

// A body held in memory with no write armed (a conflict waiting for its
// answer) is unsaved work the write ledger can't see.
function unsavedNotePaths(): string[] {
  return [
    ...[...models.values()].filter((m) => m.hasUnsavedBody || writer.hasPendingBody(m.path) || viewsUnserialised(m)).map((m) => m.relPath),
    ...writer.queuedPaths(),
    ...loadingBodyPaths,
  ];
}
registerUnsavedSource(unsavedNotePaths);

// A change queued after the save before leaving was copied by `leftBehind`
// (vaultLeaveGuard) before this reset.
onVaultSwap('pre-swap', 'noteStore', () => {
  writer.reset();
  models.clear();
  overlays.clear();
  loadingBodyPaths.clear();
  dropGraceChecks();
}, { runAfter: ['tabs', 'writeStateTracking'] });
