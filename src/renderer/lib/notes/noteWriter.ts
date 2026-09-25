/**
 * noteWriter — the only code that writes a `.md` note.
 *
 * One queue per note path. Changes wait out a 300 ms idle debounce, during
 * which the latest body wins and frontmatter deltas merge. Each flush then
 * runs inside the path's queue:
 *  1. read the file fresh (retrying a read that raced another writer);
 *  2. if the batch carries a body and the body on disk no longer matches the
 *     one the local body was built on, hand the conflict to the note store and
 *     keep the body pending (a change on disk that only touched frontmatter is
 *     not a conflict);
 *  3. apply the change to the fresh read: patch the frontmatter source, replace
 *     the body or keep the disk body;
 *  4. assemble with the fresh BOM and line ending, and skip the write when the
 *     bytes are unchanged;
 *  5. write atomically, then report the bytes to the store, which moves the
 *     note's base to them and refreshes the vault index.
 *
 * Creates are exclusive (an existing file is never overwritten; the name is
 * bumped to ` (n)` instead). `transform` rewrites a note from its fresh bytes
 * inside the queue (Replace All, tag sweeps). `hold` keeps a set of paths'
 * queues idle while a rename or delete runs.
 *
 * The writer knows nothing about views. The note store builds it with a host
 * that answers "what is this note's base" and receives the results.
 */
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { createScheduler } from '../boards/writeScheduler';
import { WRITE_TIMEOUT_MS } from '../boards/boardWriteDebounce';
import {
  beginWrite,
  clearFailedPathAfterLateSuccess,
  endWrite,
  markPathFailed,
  markRecentSelfWrite,
  notifyWriteError,
  trackComponentWrite,
  type TrackComponentWriteOptions,
} from '../boards/writeStateTracking';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';
import { noteReadEncoding } from '../vault/nonUtf8Paths.svelte';
import { mergeFrontmatterDelta, type FrontmatterDelta } from '../vault/frontmatterDelta';
import {
  assembleNoteText,
  noteTextHash,
  readNoteText,
  sameBody,
  snapshotBody,
  snapshotOf,
  type DiskSnapshot,
  type NoteText,
} from './noteFile';

export const NOTE_WRITE_DEBOUNCE_MS = 300;

/** Upper bound on one flush, so a wedged IPC can't hang save or quit. */
export const NOTE_WRITE_TIMEOUT_MS = WRITE_TIMEOUT_MS;

/** Delays before re-reading a file whose read raced another writer. */
const READ_RETRY_MS = [40, 120, 300];

/** Upper bound on ` (n)` bumps when creating a note. */
const MAX_CREATE_ATTEMPTS = 100;

/** How long a written hash is remembered as "our own write". */
const OWN_WRITE_TTL_MS = 10_000;

/** A fresh read of a note, with the disk identity the read saw. */
export interface FreshRead {
  text: NoteText;
  mtimeMs?: number;
  size?: number;
  nonUtf8: boolean;
}

/** What the note store tells the writer, and what the writer reports back. */
export interface NoteWriterHost {
  /** The bytes the note's local body was built on; undefined when no model holds the note. */
  baseOf(path: VaultPath): DiskSnapshot | undefined;
  /** Whether the note was last known to have frontmatter (its base, else the vault index). */
  hadFrontmatter(path: VaultPath): boolean;
  /** False while the body must not be written (lossy note, unresolved conflict). */
  canWriteBody(path: VaultPath): boolean;
  /** A pending body met a different body on disk. The body stays pending. */
  onBodyConflict(path: VaultPath, relPath: string, disk: FreshRead): void;
  /**
   * `written` is on disk now (written by us, or already there). `bodyVersion`
   * and `delta` are the parts of the queue it contained.
   */
  onWritten(
    path: VaultPath,
    relPath: string,
    written: NoteText,
    snapshot: DiskSnapshot,
    consumed: { bodyVersion?: number; delta?: FrontmatterDelta },
  ): void;
  /** The active vault root. */
  vaultRoot(): string | null;
}

/** Thrown when every candidate name up to ` (MAX_CREATE_ATTEMPTS)` exists. */
export class NameExhaustedError extends Error {
  constructor(base: string) {
    super(`Could not find a free file name for "${base}"`);
    this.name = 'NameExhaustedError';
  }
}

/** A body waiting to be written, and the local version it carries. */
interface PendingBody {
  markdown: string;
  version: number;
}

interface Pending {
  relPath: string;
  body?: PendingBody;
  delta?: FrontmatterDelta;
}

interface FlushArgs {
  path: VaultPath;
  relPath: string;
  vaultRoot: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(err: unknown): string | undefined {
  return err instanceof IpcEnvelopeError ? err.code : (err as { code?: string } | null)?.code;
}

/** Reads `relPath` fresh, retrying a read that overlapped another writer. */
export async function readNoteFresh(vaultRoot: string, relPath: string): Promise<FreshRead> {
  for (let attempt = 0; ; attempt++) {
    const result = await invokeOk('vault:read-file-text', vaultRoot, relPath);
    noteReadEncoding(relPath, result.encoding);
    const coherent = result.mtimeMs !== undefined && result.size !== undefined;
    if (coherent || attempt >= READ_RETRY_MS.length) {
      return {
        text: readNoteText(result.content),
        mtimeMs: result.mtimeMs,
        size: result.size,
        nonUtf8: result.encoding === 'invalid-utf-8',
      };
    }
    await sleep(READ_RETRY_MS[attempt] ?? 300);
  }
}

/**
 * A read that shows an opening fence but no closing one, of a note last
 * known to have frontmatter, is another program's write caught half way.
 * Assembling against it would drop the frontmatter.
 */
export function looksTorn(fresh: NoteText, hadFrontmatter: boolean): boolean {
  if (fresh.hasFrontmatter || !hadFrontmatter) return false;
  const raw = fresh.hadBom ? fresh.raw.slice(1) : fresh.raw;
  return /^---[ \t]*\r?\n/.test(raw);
}

export interface NoteWriter {
  /** Queues `markdown` as the note's body (latest wins within the debounce). */
  queueBody(relPath: string, markdown: string, version: number): void;
  /** Queues a frontmatter change (merged with any already queued). */
  queueDelta(relPath: string, delta: FrontmatterDelta): void;
  /** The frontmatter change still waiting to be written, if any. */
  pendingDelta(path: string): FrontmatterDelta | undefined;
  /** True while a body for `path` waits to be written. */
  hasPendingBody(path: string): boolean;
  /** True while anything for `path` is queued, being written or failed. */
  hasWork(path: string): boolean;
  /** Drops the queued body (a Reload discarded it). */
  dropBody(path: string): void;
  /** Drops everything queued for `path` (the user deleted the note). */
  drop(path: string): void;
  /** Writes `path`'s queue now. `ok` is false when the write failed or a conflict holds the body. */
  flush(path: string): Promise<{ ok: boolean }>;
  /** Writes every queue now. */
  flushAll(): Promise<{ failed: string[] }>;
  /** Re-arms `path`'s queue (after a conflict is resolved). */
  schedule(path: string): void;
  /**
   * Rewrites a note from its fresh bytes, after writing anything queued for
   * it. `fn` returns the new text, or null to leave the file alone. Resolves
   * with the text written (null when unchanged or skipped).
   */
  transform(
    relPath: string,
    fn: (fresh: NoteText) => string | null,
    track?: TrackComponentWriteOptions,
  ): Promise<string | null>;
  /** Creates `relPath` with `text` only if nothing is there. */
  createExclusive(relPath: string, text: string): Promise<'created' | 'exists'>;
  /**
   * Creates a new note at the first free name among `firstCandidate`,
   * `<base> (2).md`, `<base> (3).md`…; `buildText` receives the final stem.
   */
  createUnique(
    firstCandidate: string,
    buildText: (finalStem: string) => string,
  ): Promise<{ relPath: string; stem: string; text: string }>;
  /** Writes `text` to `relPath`, creating it (and its folders) if needed. For undoing a delete. */
  restore(relPath: string, text: string, track?: TrackComponentWriteOptions): Promise<void>;
  /** Runs `op` while no write for any of `paths` can start. Queued writes land first. */
  hold<T>(paths: string[], op: () => Promise<T>): Promise<T>;
  /** Moves queued work from one path to another (rename sweep). */
  renamePath(oldRel: string, newRel: string): void;
  /** True when `hash` is a write we made to `path` in the last few seconds. */
  isOwnWrite(path: string, hash: string): boolean;
  /** Drops every queue and timer (vault swap). */
  reset(): void;
}

export function createNoteWriter(host: NoteWriterHost): NoteWriter {
  const pending = new Map<VaultPath, Pending>();
  const chains = new Map<VaultPath, Promise<void>>();
  const ownWrites = new Map<VaultPath, Array<{ hash: string; until: number }>>();

  function rememberOwnWrite(path: VaultPath, hash: string): void {
    const now = Date.now();
    const list = (ownWrites.get(path) ?? []).filter((e) => e.until > now);
    list.push({ hash, until: now + OWN_WRITE_TTL_MS });
    ownWrites.set(path, list.slice(-8));
  }

  /** Runs `op` after every earlier operation on `path` has settled. */
  function onPath<T>(path: VaultPath, op: () => Promise<T>): Promise<T> {
    const prior = chains.get(path);
    const run = (async () => {
      if (prior) await prior.catch(() => undefined);
      return op();
    })();
    const settled = run.then(() => undefined, () => undefined);
    chains.set(path, settled);
    void settled.then(() => {
      if (chains.get(path) === settled) chains.delete(path);
    });
    return run;
  }

  const scheduler = createScheduler<FlushArgs>({
    name: 'noteWriter',
    debounceMs: NOTE_WRITE_DEBOUNCE_MS,
    performWrite: (args) => onPath(args.path, () => writePending(args)),
    getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.relPath }),
    getFailureId: (args) => args.relPath,
    // The write wraps its IPC in trackComponentWrite (in-flight counter); the
    // scheduler tracks only the pending path during the debounce, so a crash
    // mid-typing still leaves the dirty sentinel.
    sentinelMode: 'pending-path',
    writeTimeoutMs: NOTE_WRITE_TIMEOUT_MS,
  });

  function argsFor(path: VaultPath): FlushArgs | null {
    const entry = pending.get(path);
    const vaultRoot = host.vaultRoot();
    if (!entry || !vaultRoot) return null;
    return { path, relPath: entry.relPath, vaultRoot };
  }

  function arm(path: VaultPath): void {
    scheduler.schedule(path, () => argsFor(path));
  }

  function entryFor(relPath: string): { path: VaultPath; entry: Pending } {
    const path = vaultPath(relPath);
    let entry = pending.get(path);
    if (!entry) {
      entry = { relPath };
      pending.set(path, entry);
    }
    return { path, entry };
  }

  async function writePending(args: FlushArgs): Promise<void> {
    const { path, vaultRoot } = args;
    const identity = captureVaultIdentity();
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = pending.get(path);
      if (!entry) return;
      const relPath = entry.relPath;
      const delta = entry.delta;
      let body = entry.body && host.canWriteBody(path) ? entry.body : undefined;
      if (!body && !delta) {
        // Only a body that can't be written right now is queued. Keep it, and
        // fail so save and quit report it instead of calling the note saved.
        if (entry.body) failHeldBody(vaultRoot, relPath);
        return;
      }
      let fresh: FreshRead;
      try {
        fresh = await readNoteFresh(vaultRoot, relPath);
      } catch (err) {
        // Gone or unreadable: the change can't land, and a deleted file is
        // never recreated from memory. Keep it queued and say so.
        markPathFailed(vaultRoot, relPath);
        reportError(
          isMissingFileError(err) ? 'note.missing' : 'note.unreadable',
          isMissingFileError(err) ? null : err,
          isMissingFileError(err)
            ? `Couldn't save changes to "${relPath}": the file no longer exists.`
            : `Couldn't save changes to "${relPath}": the file couldn't be read.`,
        );
        throw err;
      }
      if (!isStillSameVault(identity)) return;
      if (fresh.nonUtf8) {
        reportError(
          'note.nonUtf8',
          null,
          `Couldn't save "${relPath}": it isn't UTF-8 text, so Filo won't overwrite it. Use "Convert to UTF-8" first.`,
        );
        markPathFailed(vaultRoot, relPath);
        throw new Error(`noteWriter: "${relPath}" is not UTF-8`);
      }
      const base = host.baseOf(path);
      if (looksTorn(fresh.text, host.hadFrontmatter(path))) {
        await sleep(READ_RETRY_MS[attempt] ?? 300);
        continue;
      }
      let heldBody = false;
      if (body && base && !sameBody(fresh.text.body, snapshotBody(base))) {
        // Someone else changed the body since this one was built on it.
        host.onBodyConflict(path, relPath, fresh);
        body = undefined;
        heldBody = true;
        if (!delta) {
          failHeldBody(vaultRoot, relPath);
          return;
        }
      }
      const text = assembleNoteText(fresh.text, { body: body?.markdown, delta }, () => {
        reportError(
          'frontmatter.unparseable',
          null,
          `Couldn't update metadata for "${relPath}": its YAML frontmatter is malformed, so the change wasn't saved. Fix the frontmatter in that file to re-enable metadata edits.`,
        );
      });
      if (text !== fresh.text.raw) {
        // A write that landed after our read would be overwritten unseen.
        // Re-check the file's identity and start over if it moved.
        if (fresh.mtimeMs !== undefined) {
          const now = await invokeOk('vault:stat', vaultRoot, relPath).catch(() => undefined);
          if (!isStillSameVault(identity)) return;
          if (now && (now.mtimeMs !== fresh.mtimeMs || now.size !== fresh.size)) continue;
        }
        rememberOwnWrite(path, noteTextHash(text));
        await trackComponentWrite(vaultRoot, relPath, () =>
          invokeOk('vault:write-existing-file-text', vaultRoot, relPath, text),
        );
        if (!isStillSameVault(identity)) return;
      }
      // Drop what landed, unless a newer change replaced it meanwhile.
      const now = pending.get(path);
      if (now) {
        if (body && now.body === body) now.body = undefined;
        if (delta && now.delta === delta) now.delta = undefined;
        if (!now.body && !now.delta) pending.delete(path);
      }
      const written = text === fresh.text.raw ? fresh.text : readNoteText(text);
      host.onWritten(path, relPath, written, snapshotOf(written), {
        bodyVersion: body?.version,
        delta,
      });
      if (heldBody || (pending.get(path)?.body && !host.canWriteBody(path))) failHeldBody(vaultRoot, relPath);
      return;
    }
    markPathFailed(vaultRoot, args.relPath);
    throw new Error(`noteWriter: "${args.relPath}" kept changing on disk; not overwriting it`);
  }

  /**
   * Nothing is left to write for `relPath` (the user discarded it), so an
   * earlier failure no longer means unsaved work.
   */
  function settled(relPath: string): void {
    clearFailedPathAfterLateSuccess(host.vaultRoot() ?? undefined, relPath);
  }

  function failHeldBody(vaultRoot: string, relPath: string): never {
    markPathFailed(vaultRoot, relPath);
    throw new Error(`noteWriter: the edit to "${relPath}" waits for a decision about the version on disk`);
  }

  async function createExclusive(relPath: string, text: string): Promise<'created' | 'exists'> {
    const vaultRoot = host.vaultRoot();
    if (!vaultRoot) throw new Error('noteWriter: no vault is open');
    // A losing attempt targets someone else's file, so the in-flight window is
    // tracked without a path: a path mark would hide that file's next change.
    const identity = captureVaultIdentity();
    beginWrite(vaultRoot);
    const raw = await window.filo
      .invoke('vault:create-file-text', vaultRoot, relPath, text)
      .catch((err: unknown) => ({ success: false as const, thrown: err }));
    const result = raw as { success?: boolean; code?: string; error?: string; thrown?: unknown };
    if (result.success) {
      // After a vault swap the path means a file in another vault.
      if (isStillSameVault(identity)) {
        rememberOwnWrite(vaultPath(relPath), noteTextHash(text));
        markRecentSelfWrite(relPath);
      }
      endWrite(vaultRoot);
      return 'created';
    }
    if (result.code === 'EEXIST') {
      endWrite(vaultRoot);
      return 'exists';
    }
    const error =
      result.thrown ?? new IpcEnvelopeError('vault:create-file-text', result.error ?? 'create failed', result.code);
    notifyWriteError({ kind: 'component', path: relPath, error });
    markPathFailed(vaultRoot, relPath);
    endWrite(vaultRoot, undefined, false);
    throw error;
  }

  return {
    queueBody(relPath, markdown, version) {
      const { path, entry } = entryFor(relPath);
      entry.body = { markdown, version };
      arm(path);
    },

    queueDelta(relPath, delta) {
      const { path, entry } = entryFor(relPath);
      entry.delta = entry.delta ? mergeFrontmatterDelta(entry.delta, delta) : delta;
      arm(path);
    },

    pendingDelta(path) {
      return pending.get(vaultPath(path))?.delta;
    },

    hasPendingBody(path) {
      return pending.get(vaultPath(path))?.body !== undefined;
    },

    hasWork(path) {
      const key = vaultPath(path);
      return pending.has(key) || scheduler.hasWork(key);
    },

    dropBody(path) {
      const key = vaultPath(path);
      const entry = pending.get(key);
      if (!entry) return;
      entry.body = undefined;
      if (entry.delta) {
        arm(key);
        return;
      }
      pending.delete(key);
      scheduler.cancel(key, undefined, true);
      settled(entry.relPath);
    },

    drop(path) {
      const key = vaultPath(path);
      const entry = pending.get(key);
      pending.delete(key);
      scheduler.cancel(key);
      settled(entry?.relPath ?? path);
    },

    async flush(path) {
      const key = vaultPath(path);
      if (!pending.has(key) && !scheduler.hasWork(key)) return { ok: true };
      if (pending.has(key)) arm(key);
      return scheduler.flush(key, () => argsFor(key));
    },

    async flushAll() {
      // Anything queued but not armed (a conflict held it) is re-armed so the
      // drain reports it.
      for (const key of pending.keys()) {
        if (!scheduler.hasWork(key)) arm(key);
      }
      const result = await scheduler.flushAll();
      return { failed: result.failed };
    },

    schedule(path) {
      const key = vaultPath(path);
      if (pending.has(key)) arm(key);
    },

    async transform(relPath, fn, track) {
      const path = vaultPath(relPath);
      if (pending.has(path) || scheduler.hasWork(path)) await this.flush(relPath);
      return onPath(path, async () => {
        const vaultRoot = host.vaultRoot();
        if (!vaultRoot) return null;
        const identity = captureVaultIdentity();
        let fresh: FreshRead;
        try {
          fresh = await readNoteFresh(vaultRoot, relPath);
        } catch (err) {
          // Present but unreadable: the change is unsaved, so say so. A note
          // that's gone has nothing left to change.
          if (!isMissingFileError(err) && isStillSameVault(identity)) markPathFailed(vaultRoot, relPath);
          throw err;
        }
        if (!isStillSameVault(identity) || fresh.nonUtf8) return null;
        if (looksTorn(fresh.text, host.hadFrontmatter(path))) {
          throw new Error(`noteWriter: "${relPath}" was mid-write by another program; try again`);
        }
        const next = fn(fresh.text);
        if (next === null || next === fresh.text.raw) return null;
        rememberOwnWrite(path, noteTextHash(next));
        await trackComponentWrite(
          vaultRoot,
          relPath,
          () => invokeOk('vault:write-existing-file-text', vaultRoot, relPath, next),
          track ?? {},
        );
        if (!isStillSameVault(identity)) return null;
        const written = readNoteText(next);
        host.onWritten(path, relPath, written, snapshotOf(written), {});
        return next;
      });
    },

    async createExclusive(relPath, text) {
      const path = vaultPath(relPath);
      const identity = captureVaultIdentity();
      const outcome = await onPath(path, () => createExclusive(relPath, text));
      if (outcome === 'created' && isStillSameVault(identity)) {
        const written = readNoteText(text);
        host.onWritten(path, relPath, written, snapshotOf(written), {});
      }
      return outcome;
    },

    async createUnique(firstCandidate, buildText) {
      const slash = firstCandidate.lastIndexOf('/');
      const prefix = slash >= 0 ? firstCandidate.slice(0, slash + 1) : '';
      const firstStem = firstCandidate.slice(prefix.length).replace(/\.md$/i, '');
      // "Notes (2)" resumes at 3; "Notes" at 2.
      const m = /^(.*) \((\d+)\)$/.exec(firstStem);
      const base = m?.[1] ?? firstStem;
      let n = m ? Number(m[2]) + 1 : 2;
      let stem = firstStem;
      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
        const relPath = `${prefix}${stem}.md`;
        const text = buildText(stem);
        if ((await this.createExclusive(relPath, text)) === 'created') return { relPath, stem, text };
        stem = `${base} (${n})`;
        n++;
      }
      throw new NameExhaustedError(base);
    },

    async restore(relPath, text, track) {
      const path = vaultPath(relPath);
      await onPath(path, async () => {
        const vaultRoot = host.vaultRoot();
        if (!vaultRoot) throw new Error('noteWriter: no vault is open');
        const identity = captureVaultIdentity();
        rememberOwnWrite(path, noteTextHash(text));
        await trackComponentWrite(
          vaultRoot,
          relPath,
          () => invokeOk('vault:write-file-text', vaultRoot, relPath, text),
          track ?? {},
        );
        if (!isStillSameVault(identity)) return;
        const written = readNoteText(text);
        host.onWritten(path, relPath, written, snapshotOf(written), {});
      });
    },

    async hold(paths, op) {
      const keys = [...new Set(paths.map((p) => vaultPath(p)))];
      await Promise.all(keys.map((k) => (pending.has(k) || scheduler.hasWork(k) ? this.flush(k) : null)));
      // Enter every path's queue (after whatever is running there) and keep it
      // occupied until `op` settles, so no write for them can start meanwhile.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await Promise.all(
        keys.map((k) => new Promise<void>((entered) => {
          void onPath(k, () => {
            entered();
            return gate;
          });
        })),
      );
      try {
        return await op();
      } finally {
        release();
      }
    },

    renamePath(oldRel, newRel) {
      const oldKey = vaultPath(oldRel);
      const oldPrefix = `${oldKey}/`;
      const moves: Array<[VaultPath, VaultPath, Pending]> = [];
      for (const [key, entry] of pending) {
        if (key === oldKey) moves.push([key, vaultPath(newRel), { ...entry, relPath: newRel }]);
        else if (key.startsWith(oldPrefix)) {
          const rel = newRel + entry.relPath.slice(oldRel.length);
          moves.push([key, vaultPath(rel), { ...entry, relPath: rel }]);
        }
      }
      for (const [from, to, entry] of moves) {
        pending.delete(from);
        scheduler.cancel(from, undefined, true);
        const existing = pending.get(to);
        pending.set(to, existing
          ? { relPath: entry.relPath, body: entry.body ?? existing.body, delta: existing.delta && entry.delta ? mergeFrontmatterDelta(entry.delta, existing.delta) : (entry.delta ?? existing.delta) }
          : entry);
        arm(to);
        const own = ownWrites.get(from);
        if (own) {
          ownWrites.delete(from);
          ownWrites.set(to, own);
        }
      }
    },

    isOwnWrite(path, hash) {
      const now = Date.now();
      return (ownWrites.get(vaultPath(path)) ?? []).some((e) => e.hash === hash && e.until > now);
    },

    reset() {
      scheduler.reset();
      pending.clear();
      chains.clear();
      ownWrites.clear();
    },
  };
}

/** True when `err` means the file isn't there. */
export function isMissingFileError(err: unknown): boolean {
  return errorCode(err) === 'ENOENT';
}
