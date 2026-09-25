/**
 * An in-memory vault behind `window.filo.invoke`, for the note writer and
 * store unit tests. It answers the `.md` text channels the way the main
 * process does: reads carry mtime and size, `write-existing` refuses a
 * missing file, `create` refuses an existing one, and every write bumps the
 * mtime. Tests reach in to change a file "from another program", count
 * writes, or hold a write open.
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
  /** Called before a write lands; await it to hold the write open. */
  beforeWrite: ((rel: string, text: string) => Promise<void> | void) | null;
  /** Called before a read returns; lets a test change the file mid-flush. */
  afterRead: ((rel: string) => void) | null;
  /** Fail the next write of `rel` with `code`. */
  failNextWrite(rel: string, code: string): void;
}

const key = (rel: string): string => rel.replace(/\\/g, '/').toLowerCase();

export function installMemoryVault(initial: Record<string, string> = {}, root = '/vault'): MemoryVault {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const spelling = new Map<string, string>();
  let clock = 1000;
  const failures = new Map<string, string>();
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
    beforeWrite: null,
    afterRead: null,
    writeExternally: (rel, text) => put(rel, text),
    remove: (rel) => {
      files.delete(key(rel));
      mtimes.delete(key(rel));
    },
    read: (rel) => files.get(key(rel)),
    failNextWrite: (rel, code) => failures.set(key(rel), code),
  };

  const write = async (channel: string, rel: string, text: string, mode: 'existing' | 'any' | 'create') => {
    const k = key(rel);
    if (mode === 'existing' && !files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
    if (mode === 'create' && files.has(k)) return { success: false, code: 'EEXIST', error: 'EEXIST' };
    await vault.beforeWrite?.(rel, text);
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
    const k = rel ? key(rel) : '';
    switch (channel) {
      case 'vault:read-file-text': {
        if (!files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
        vault.afterRead?.(rel);
        const content = files.get(k) ?? '';
        return {
          success: true,
          content,
          mtimeMs: mtimes.get(k),
          size: enc.encode(content).length,
          encoding: vault.nonUtf8.has(k) ? 'invalid-utf-8' : 'utf-8',
        };
      }
      case 'vault:stat':
        if (!files.has(k)) return { success: false, code: 'ENOENT', error: 'ENOENT' };
        return { success: true, mtimeMs: mtimes.get(k), size: enc.encode(files.get(k) ?? '').length };
      case 'vault:write-existing-file-text':
        return write(channel, rel, args[2] as string, 'existing');
      case 'vault:write-file-text':
        return write(channel, rel, args[2] as string, 'any');
      case 'vault:create-file-text':
        return write(channel, rel, args[2] as string, 'create');
      case 'vault:file-exists':
        return files.has(k);
      default:
        return undefined;
    }
  });
  (window as unknown as { filo: unknown }).filo = { invoke, on: () => () => undefined, send: () => undefined };
  return vault;
}
