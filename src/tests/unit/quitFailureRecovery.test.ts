import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readQuitFailureBreadcrumb,
  clearQuitFailureBreadcrumb,
} from '@renderer/lib/vault/quitFailureRecovery';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * 6.2.H4 (follow-up) — renderer read/clear of `.filo/quit-failure.a1b2c3d4e5f6.json`.
 *
 * Audit-8 L4 — the read and the clear are SEPARATE: `readQuitFailureBreadcrumb`
 * parses but NEVER deletes (so a second crash before the user acknowledges
 * re-surfaces the location); `clearQuitFailureBreadcrumb` does the best-effort
 * delete once the surfacing toast is dismissed.
 */
describe('Audit-8 L4 — quit-failure breadcrumb read/clear split', () => {
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

  // ── readQuitFailureBreadcrumb — never deletes ──────────────────────────────

  it('returns null when no breadcrumb exists (ENOENT) and does not delete', async () => {
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  it('reads + parses the breadcrumb WITHOUT deleting it (survives a second crash)', async () => {
    diskFiles.set(
      '.filo/quit-failure.a1b2c3d4e5f6.json',
      JSON.stringify({
        version: 1,
        savedAt: '2026-06-01T00:00:00.000',
        files: [
          { preservedPath: '/vault/Notes.md', targetPath: '/vault/Notes.md', code: 'ENOSPC', at: 5 },
        ],
      }),
    );
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res).not.toBeNull();
    expect(res!.files).toHaveLength(1);
    expect(res!.files[0].preservedPath).toBe('/vault/Notes.md');
    // Read must NOT consume the breadcrumb.
    expect(deletes).toHaveLength(0);
    expect(diskFiles.has('.filo/quit-failure.a1b2c3d4e5f6.json')).toBe(true);
  });

  it('returns null on malformed JSON without deleting', async () => {
    diskFiles.set('.filo/quit-failure.a1b2c3d4e5f6.json', 'not json {');
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  it('returns null when the files array is empty', async () => {
    diskFiles.set('.filo/quit-failure.a1b2c3d4e5f6.json', JSON.stringify({ version: 1, files: [] }));
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res).toBeNull();
  });

  it('drops malformed file entries but keeps well-formed ones', async () => {
    diskFiles.set(
      '.filo/quit-failure.a1b2c3d4e5f6.json',
      JSON.stringify({
        version: 1,
        files: [{ nonsense: true }, { preservedPath: '/vault/Good.md' }],
      }),
    );
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res!.files).toHaveLength(1);
    expect(res!.files[0].preservedPath).toBe('/vault/Good.md');
  });

  it('returns null for an empty vault root without touching IPC', async () => {
    const res = await readQuitFailureBreadcrumb('');
    expect(res).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  // ── clearQuitFailureBreadcrumb — deletes only ──────────────────────────────

  it('deletes the breadcrumb at the absolute path', async () => {
    diskFiles.set('.filo/quit-failure.a1b2c3d4e5f6.json', JSON.stringify({ version: 1, files: [{ preservedPath: '/vault/x.md' }] }));
    await clearQuitFailureBreadcrumb('/vault');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('.filo/quit-failure.a1b2c3d4e5f6.json');
    expect(diskFiles.has('.filo/quit-failure.a1b2c3d4e5f6.json')).toBe(false);
  });

  it('is a no-op for an empty vault root', async () => {
    await clearQuitFailureBreadcrumb('');
    expect(deletes).toHaveLength(0);
  });

  it('swallows a delete ENOENT (already gone)', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:delete') return { success: false, code: 'ENOENT' };
      return { ok: true, success: true };
    });
    await expect(clearQuitFailureBreadcrumb('/vault')).resolves.toBeUndefined();
  });

  // ── read-then-clear integration (the sequencer's surface→acknowledge flow) ──

  it('read surfaces the payload, a later clear consumes it', async () => {
    diskFiles.set(
      '.filo/quit-failure.a1b2c3d4e5f6.json',
      JSON.stringify({ version: 1, files: [{ preservedPath: '/vault/Notes.md' }] }),
    );
    const res = await readQuitFailureBreadcrumb('/vault');
    expect(res).not.toBeNull();
    expect(diskFiles.has('.filo/quit-failure.a1b2c3d4e5f6.json')).toBe(true); // still there after read

    await clearQuitFailureBreadcrumb('/vault'); // user dismissed the toast
    expect(diskFiles.has('.filo/quit-failure.a1b2c3d4e5f6.json')).toBe(false);
    // A second open now finds nothing to surface.
    expect(await readQuitFailureBreadcrumb('/vault')).toBeNull();
  });
});
