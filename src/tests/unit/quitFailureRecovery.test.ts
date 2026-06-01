import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { consumeQuitFailureBreadcrumb } from '@renderer/lib/vault/quitFailureRecovery';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * 6.2.H4 (follow-up) — renderer consume of `.filo/quit-failure.json`.
 *
 * Mirrors the `.filo/.dirty` read/clear pattern: a relative-path read through
 * `vault:read-file-text`, then a best-effort `vault:delete` so the recovery
 * notice surfaces once. ENOENT / malformed / empty payloads return null.
 */
describe('6.2.H4 (follow-up) — consumeQuitFailureBreadcrumb', () => {
  let diskFiles: Map<string, string>;
  let deletes: string[];

  beforeEach(() => {
    diskFiles = new Map();
    deletes = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const rel = args[1] as string;
        const content = diskFiles.get(rel);
        if (content === undefined) return { success: false, code: 'ENOENT' };
        return { success: true, content, mtimeMs: 1, size: content.length };
      }
      if (channel === 'vault:delete') {
        const full = String(args[1]);
        deletes.push(full);
        for (const key of [...diskFiles.keys()]) {
          if (full.endsWith(key)) diskFiles.delete(key);
        }
        return { success: true };
      }
      return { ok: true, success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
  });

  it('returns null when no breadcrumb exists (ENOENT) and does not delete', async () => {
    const res = await consumeQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  it('reads, parses, and deletes the breadcrumb (surfaces once)', async () => {
    diskFiles.set(
      '.filo/quit-failure.json',
      JSON.stringify({
        version: 1,
        savedAt: '2026-06-01T00:00:00.000',
        files: [
          { preservedPath: '/vault/Notes.md', targetPath: '/vault/Notes.md', code: 'ENOSPC', at: 5 },
        ],
      }),
    );
    const res = await consumeQuitFailureBreadcrumb('/vault');
    expect(res).not.toBeNull();
    expect(res!.files).toHaveLength(1);
    expect(res!.files[0].preservedPath).toBe('/vault/Notes.md');
    // Deleted so the notice shows once.
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('.filo/quit-failure.json');
    expect(diskFiles.has('.filo/quit-failure.json')).toBe(false);
  });

  it('returns null on malformed JSON (and still clears the breadcrumb)', async () => {
    diskFiles.set('.filo/quit-failure.json', 'not json {');
    const res = await consumeQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(1);
  });

  it('returns null when the files array is empty', async () => {
    diskFiles.set('.filo/quit-failure.json', JSON.stringify({ version: 1, files: [] }));
    const res = await consumeQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
  });

  it('drops malformed file entries but keeps well-formed ones', async () => {
    diskFiles.set(
      '.filo/quit-failure.json',
      JSON.stringify({
        version: 1,
        files: [{ nonsense: true }, { preservedPath: '/vault/Good.md' }],
      }),
    );
    const res = await consumeQuitFailureBreadcrumb('/vault');
    expect(res!.files).toHaveLength(1);
    expect(res!.files[0].preservedPath).toBe('/vault/Good.md');
  });

  it('returns null for an empty vault root without touching IPC', async () => {
    const res = await consumeQuitFailureBreadcrumb('');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(0);
  });
});
