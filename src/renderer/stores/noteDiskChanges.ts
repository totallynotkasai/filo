/**
 * noteDiskChanges — what a loaded note does when its file changes on disk
 * (the watcher). The decision itself is `decideDiskChange`
 * (`lib/notes/noteDiskChange.ts`); this runs it against a read of the file and
 * carries it out on the note store's model.
 *
 * - The read is taken again when one of Filo's own writes started or landed
 *   while it was out: deciding on the older bytes would roll that write back.
 * - A read that fails for a moment (a sync client or antivirus holding the
 *   file) is tried again a few times rather than dropping the change.
 * - Once another program's version is taken, Filo's last write is no longer
 *   an echo: the same bytes turning up again are someone else's restore.
 * - A clean note that took a much shorter version keeps a copy of what it
 *   had in `.filo/recovery/` (see `reloadShrank`).
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { isMissingFileError, looksTorn, readNoteFresh, type FreshRead, type NoteWriter } from '../lib/notes/noteWriter';
import { localNoteText, noteTextHash, sameBody, snapshotBody, snapshotOf } from '../lib/notes/noteFile';
import { decideDiskChange } from '../lib/notes/noteDiskChange';
import { askUnlessMoved } from '../lib/notes/renameGrace';
import type { NoteModel, NotePromptHandlers } from './noteModel.svelte';

/** Waits before reading again a note caught mid-write, or whose read failed. */
export const DISK_RETRY_MS = [500, 1500, 3000];

/** Extra reads when Filo's own write moved the note on while a read was out. */
const OWN_WRITE_REREADS = 2;

/** A body at least this long that comes back under half as long keeps a copy. */
const SHRINK_MIN_CHARS = 256;
const SHRINK_RATIO = 0.5;

/** What the handler needs from the note store. */
export interface DiskChangeHost {
  model(path: VaultPath): NoteModel | undefined;
  writer: NoteWriter;
  prompts(): NotePromptHandlers;
  /** Takes the disk version into the model: body, frontmatter and base. */
  adoptDisk(m: NoteModel, fresh: FreshRead): void;
  enterConflict(m: NoteModel, disk: FreshRead): void;
  /** `fm` with the note's still-queued frontmatter change applied. */
  withQueued(path: VaultPath, fm: Record<string, unknown>): Record<string, unknown>;
  /** Pulls the views' unserialised keystrokes into the model. */
  serializeViews(path: VaultPath): void;
  hadFrontmatter(path: VaultPath): boolean;
}

/** A read of the file: `fresh` null when it is gone; `error` when it couldn't be read. */
type DiskRead = { fresh: FreshRead | null; error?: unknown };

export function createDiskChangeHandler(host: DiskChangeHost): (relPath: string, attempt?: number) => Promise<void> {
  /**
   * Reads the note, again (up to twice) when one of our writes started or
   * landed meanwhile. Null when the model or the vault went away.
   */
  async function readSettled(m: NoteModel, key: VaultPath, vaultRoot: string, identity: VaultIdentity): Promise<DiskRead | null> {
    for (let reread = 0; ; reread++) {
      const baseHash = m.base?.hash;
      const started = host.writer.writeCount(key);
      let read: DiskRead;
      try {
        read = { fresh: await readNoteFresh(vaultRoot, m.relPath) };
      } catch (err) {
        read = isMissingFileError(err) ? { fresh: null } : { fresh: null, error: err };
      }
      if (host.model(key) !== m || !isStillSameVault(identity)) return null;
      const settled = m.base?.hash === baseHash && host.writer.writeCount(key) === started;
      if (settled || reread >= OWN_WRITE_REREADS) return read;
    }
  }

  async function onDiskChanged(relPath: string, attempt = 0): Promise<void> {
    const key = vaultPath(relPath);
    const m = host.model(key);
    if (!m) return;
    const { writer } = host;
    const identity = captureVaultIdentity();
    await m.loaded;
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot || !isStillSameVault(identity)) return;
    host.serializeViews(key);
    const read = await readSettled(m, key, vaultRoot, identity);
    if (!read) return;
    const retry = (): void => {
      setTimeout(() => void onDiskChanged(m.relPath, attempt + 1), DISK_RETRY_MS[attempt]);
    };
    if (read.error !== undefined) {
      // The next edit's own fresh read still catches the change if this gives up.
      if (attempt < DISK_RETRY_MS.length) retry();
      else console.warn(`[noteStore] couldn't read "${m.relPath}" after it changed on disk:`, read.error);
      return;
    }
    const fresh = read.fresh;
    // Keys typed while the read was out must count as unsaved, or the disk
    // version would replace the body they were typed into.
    host.serializeViews(key);
    const hash = fresh ? noteTextHash(fresh.text.raw) : null;
    const pendingBody = writer.pendingBody(key);
    const action = decideDiskChange({
      exists: fresh !== null,
      isOwnWrite: hash !== null && (hash === m.base?.hash || writer.isOwnWrite(key, hash)),
      hasUnsavedBody: m.hasUnsavedBody || pendingBody !== undefined,
      bodyChanged: fresh !== null && (!m.base || !sameBody(fresh.text.body, snapshotBody(m.base))),
      diskHasLocalBody: fresh !== null
        && sameBody(fresh.text.body, m.body)
        && (pendingBody === undefined || sameBody(fresh.text.body, pendingBody)),
      // After a few tries a file that still looks torn is taken as it is.
      torn: attempt < DISK_RETRY_MS.length && fresh !== null && looksTorn(fresh.text, host.hadFrontmatter(key)),
    });
    if (action === 'replace' || action === 'take-frontmatter' || action === 'conflict') writer.forgetOwnWrite(key);
    switch (action) {
      case 'ignore':
        return;
      case 'retry':
        retry();
        return;
      case 'replace': {
        if (!fresh) return;
        const prior = m.body;
        const priorText = localNoteText(m.base, m.frontmatter, prior);
        // Only a body the disk already holds can be pending here.
        if (pendingBody !== undefined) writer.dropBody(key);
        host.adoptDisk(m, fresh);
        host.prompts().dismiss(m.relPath);
        if (prior.length >= SHRINK_MIN_CHARS && fresh.text.body.length < prior.length * SHRINK_RATIO) {
          host.prompts().reloadShrank(m, prior, priorText);
        }
        return;
      }
      case 'take-frontmatter':
        if (!fresh) return;
        m.base = snapshotOf(fresh.text, fresh.mtimeMs, fresh.size);
        m.frontmatter = host.withQueued(key, fresh.text.frontmatter);
        return;
      case 'conflict':
        if (fresh) host.enterConflict(m, fresh);
        return;
      case 'missing': {
        m.fileGone = true;
        const unsaved = (): boolean => m.hasUnsavedBody || writer.hasPendingBody(key);
        if (!unsaved()) {
          m.status = 'missing';
          return;
        }
        askUnlessMoved(
          m.relPath,
          () => host.model(key) === m && unsaved(),
          () => host.prompts().deletedWithUnsavedBody(m),
          () => void onDiskChanged(m.relPath),
        );
        return;
      }
    }
  }

  return onDiskChanged;
}
