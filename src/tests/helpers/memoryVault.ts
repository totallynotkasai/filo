/**
 * An in-memory vault behind `window.filo.invoke`, for the note writer and
 * store unit tests. It answers the `.md` text channels the way the main
 * process does: reads carry mtime and size, `write-existing` refuses a
 * missing file (and, given the stat its caller read, a file that changed
 * since, with STALE), `create` refuses an existing one, and every write bumps
 * the mtime. Tests reach in to change a file "from another program", count
 * writes, or hold a write open.
 *
 * It also keeps a Filo trash: `vault:trash-move` takes a file (or every file
 * under a folder path) out of `files`, `vault:trash-restore` puts it back
 * (beside the original, as `… (restored).ext`, when that path is taken).
 * `recovery:keep-unsaved` copies land in `recovered`.
 */
import { vi } from 'vitest';

export interface MemoryVault {
  readonly root: string;
  files: Map<string, string>;
  /** Every write-channel call, in order: [channel, relPath, content]. */
  writes: Array<[string, string, string]>;
  /** Replace a file's bytes as another program would. */
  writeExternally(rel: string, text: string): void;
  remove(rel: string): void;
  read(rel: string): string | undefined;
  /** Bytes whose UTF-8 decoding failed, per path (reads report invalid-utf-8). */
  nonUtf8: Set<string>;
  /** Paths that are symbolic links (reads report `link`, writes fail NOTE_IS_LINK). */
  links: Set<string>;
  /** Called before a write lands; await it to hold the write open. */
  beforeWrite: ((rel: string, text: string) => Promise<void> | void) | null;
  /** Called before a read returns; lets a test change the file mid-flush. */
  afterRead: ((rel: string) => void) | null;
  /**
   * Called once a read has taken the file's bytes, before it returns them;
   * await it to hold the read open while something else lands.
   */
  duringRead: ((rel: string) => Promise<void> | void) | null;
  /** Fail the next write of `rel` with `code`. */
  failNextWrite(rel: string, code: string): void;
  /** Fail the next read of `rel` with `code` (e.g. EBUSY: a file held open). */
  failNextRead(rel: string, code: string): void;
  /** What is in the trash: id, the path it had, and its files (path → text). */
  trash: Map<string, { originalPath: string; files: Map<string, string> }>;
  /** Fail the next trash move of `rel` with `code` (e.g. a locked file). */
  failNextTrashMove(rel: string, code: string): void;
  /** Copies kept in `.filo/recovery/` (`recovery:keep-unsaved`), in order. */
  recovered: Array<{ dir: string; relPath: string; text: string }>;
  /** Fail every `recovery:keep-unsaved` call with this code while set. */
  failRecovery: string | null;
}

const key = (rel: string): string => rel.replace(/\\/g, '/').toLowerCase();

/**
 * Trash ids never repeat, as Filo's own (a timestamp and a counter) don't:
 * state keyed by trash id (where a restore landed) must not carry one test's
 * entry into the next test's vault.
 */
let trashSeq = 0;

export function installMemoryVault(initial: Record<string, string> = {}, root = '/vault'): MemoryVault {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const spelling = new Map<string, string>();
  let clock = 1000;
  const failures = new Map<string, string>();
  const readFailures = new Map<string, string>();
  const trashFailures = new Map<string, string>();
  const enc = new TextEncoder();
  const put = (rel: string, text: string): void => {
    files.set(key(rel), text);
    spelling.set(key(rel), rel);
    mtimes.set(key(rel), (clock += 10));
  };
  for (const [rel, text] of Object.entries(initial)) put(rel, text);

  const vault: MemoryVault = {
    root,
    files,
    writes: [],
    nonUtf8: new Set(),
    links: new Set(),
    beforeWrite: null,
    afterRead: null,
    duringRead: null,
    failNextRead: (rel, code) => readFailures.set(key(rel), code),
    writeExternally: (rel, text) => put(rel, text),
    remove: (rel) => {
      files.delete(key(rel));
      mtimes.delete(key(rel));
    },
    read: (rel) => files.get(key(rel)),
    failNextWrite: (rel, code) => failures.set(key(rel), code),
    trash: new Map(),
    failNextTrashMove: (rel, code) => trashFailures.set(key(rel), code),
    recovered: [],
    failRecovery: null,
  };
  let recoverySeq = 0;

  const under = (k: string): string[] => [...files.keys()].filter((f) => f === k || f.startsWith(`${k}/`));
  const restoredName = (rel: string): string => {
    const slash = rel.lastIndexOf('/');
    const name = rel.slice(slash + 1);
    const dot = name.toLowerCase().endsWith('.board.json') ? name.length - '.board.json'.length : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${rel.slice(0, slash + 1)}${stem} (restored)${ext}`;
  };

  const statMatches = (k: string, expect: { mtimeMs: number; size: number } | undefined): boolean =>
    !expect || (mtimes.get(k) === expect.mtimeMs && enc.encode(files.get(k) ?? '').length === expect.size);

  const write = async (
    channel: string,
    rel: string,
    text: string,
    mode: 'existing' | 'any' | 'create',
    expect?: { mtimeMs: number; size: number },
  ) => {
    const k = key(rel);
    if (mode === 'existing' && !files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
    if (mode === 'create' && files.has(k)) return { success: false, code: 'EEXIST', error: 'EEXIST' };
    if (vault.links.has(k)) return { success: false, code: 'NOTE_IS_LINK', error: 'NOTE_IS_LINK' };
    await vault.beforeWrite?.(rel, text);
    // Checked after the hook too: the main process re-checks right before the rename.
    if (!statMatches(k, expect)) return { success: false, code: 'STALE', error: 'STALE' };
    const fail = failures.get(k);
    if (fail) {
      failures.delete(k);
      return { success: false, code: fail, error: fail };
    }
    vault.writes.push([channel, rel, text]);
    put(rel, text);
    return { success: true, path: `${root}/${rel}` };
  };

  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const rel = args[1] as string;
    const k = typeof rel === 'string' ? key(rel) : '';
    switch (channel) {
      case 'vault:read-file-text': {
        if (!files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
        const readFail = readFailures.get(k);
        if (readFail) {
          readFailures.delete(k);
          return { success: false, code: readFail, error: readFail };
        }
        vault.afterRead?.(rel);
        const content = files.get(k) ?? '';
        const mtimeMs = mtimes.get(k);
        await vault.duringRead?.(rel);
        return {
          success: true,
          content,
          mtimeMs,
          size: enc.encode(content).length,
          encoding: vault.nonUtf8.has(k) ? 'invalid-utf-8' : 'utf-8',
          ...(vault.links.has(k) ? { link: true } : {}),
        };
      }
      case 'vault:stat':
        if (!files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
        return { success: true, mtimeMs: mtimes.get(k), size: enc.encode(files.get(k) ?? '').length };
      case 'vault:write-existing-file-text':
        return write(channel, rel, args[2] as string, 'existing', args[3] as { mtimeMs: number; size: number } | undefined);
      case 'vault:write-file-text':
        return write(channel, rel, args[2] as string, 'any');
      case 'vault:create-file-text':
        return write(channel, rel, args[2] as string, 'create');
      case 'vault:file-exists':
        return files.has(k);
      case 'vault:trash-move': {
        const fail = trashFailures.get(k);
        if (fail) {
          trashFailures.delete(k);
          return { success: false, code: fail, error: fail };
        }
        const moving = under(k);
        if (moving.length === 0) return { success: false, code: 'ENOENT', error: 'ENOENT' };
        const trashId = `20260925T000000Z-${(++trashSeq).toString(16).padStart(6, '0')}`;
        const kept = new Map<string, string>();
        for (const f of moving) {
          kept.set(spelling.get(f) ?? f, files.get(f) ?? '');
          vault.remove(f);
        }
        vault.trash.set(trashId, { originalPath: rel, files: kept });
        return { success: true, trashId, kind: moving.length === 1 && moving[0] === k ? 'file' : 'folder' };
      }
      case 'vault:trash-restore': {
        const entry = vault.trash.get(rel);
        if (!entry) return { success: false, code: 'TRASH_ITEM_MISSING', error: 'gone' };
        vault.trash.delete(rel);
        const taken = under(key(entry.originalPath)).length > 0;
        const restoredPath = taken ? restoredName(entry.originalPath) : entry.originalPath;
        for (const [path, text] of entry.files) put(restoredPath + path.slice(entry.originalPath.length), text);
        return {
          success: true,
          restoredPath,
          originalPath: entry.originalPath,
          kind: entry.files.size === 1 && entry.files.has(entry.originalPath) ? 'file' : 'folder',
          alongside: taken,
        };
      }
      case 'vault:trash-list':
        return {
          success: true,
          machineId: 'aaaaaaaaaaaa',
          entries: [...vault.trash].map(([trashId, t]) => ({
            trashId,
            originalPath: t.originalPath,
            deletedAt: '2026-09-25T00:00:00.000Z',
            machineId: 'aaaaaaaaaaaa',
            kind: 'file',
            present: true,
          })),
        };
      case 'vault:trash-purge':
      case 'vault:trash-delete-permanently': {
        const ids = Array.isArray(args[1]) ? (args[1] as string[]) : [...vault.trash.keys()];
        for (const id of ids) vault.trash.delete(id);
        return channel === 'vault:trash-purge' ? { success: true, purged: ids } : { success: true, deleted: ids };
      }
      case 'recovery:keep-unsaved': {
        if (vault.failRecovery) return { ok: false, code: vault.failRecovery, error: vault.failRecovery };
        const items = args[1] as Array<{ relPath: string; text: string }>;
        const dir = `.filo/recovery/2026-09-25T00-00-00.${(++recoverySeq).toString().padStart(3, '0')}${args[2] === 'keep' ? '-keep' : '-unsaved'}`;
        for (const item of items) vault.recovered.push({ dir, relPath: item.relPath, text: item.text });
        return { ok: true, dir, kept: items.map((i) => i.relPath), failed: [] };
      }
      default:
        return undefined;
    }
  });
  (window as unknown as { filo: unknown }).filo = { invoke, on: () => () => undefined, send: () => undefined };
  return vault;
}
