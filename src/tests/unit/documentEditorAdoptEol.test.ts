import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  markHydrated,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __clearFileStateForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { documentStore } from '@renderer/stores/document.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-13 M8 — the DocumentEditor adopt-path hydrate must thread the file's
 * line ending into the write gateway, mirroring TextTile's twin.
 *
 * Root cause: TextTile's adopt path sniffs CRLF from the adopted body and threads
 * it into `markHydrated(..., eol)`; DocumentEditor's equivalent left `eol`
 * undefined. A single-line frontmatter (`title: x`) carries no internal `\r\n`,
 * and the editor body is LF, so `detectFrontmatterEol` mis-detected LF and the
 * first body save flipped a CRLF file whole-file to LF. The fix sniffs the eol on
 * the adopt path and threads it.
 *
 * The guard lives in DocumentEditor.svelte (not mountable in this jsdom env), so
 * these tests lock the GATEWAY contract the fix relies on: `markHydrated` with a
 * threaded `eol` keeps a single-line-FM file's line ending on the first write,
 * and WITHOUT it the same write flips to LF — proving the threaded eol is
 * load-bearing. The component-side token pin lives in `ci:eol-preservation`.
 */
describe('Audit-13 M8 — DocumentEditor adopt-path threads file eol (gateway contract)', () => {
  let diskFiles: Map<string, string>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearFileStateForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    diskFiles = new Map();
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const rel = args[1] as string;
        const content = diskFiles.get(rel);
        if (content === undefined) return { success: false, code: 'ENOENT' };
        return { success: true, content, mtimeMs: 100, size: content.length };
      }
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        const rel = args[1] as string;
        diskFiles.set(rel, args[2] as string);
        return { success: true };
      }
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 100, size: 100 };
      return { ok: true, success: true };
    });
  });

  afterEach(() => {
    cancelAllMarkdownWrites();
    __clearFileStateForTests();
    restoreFiloDefault();
  });

  it('an adopt with a sniffed CRLF eol keeps a single-line-FM file CRLF on the first write', async () => {
    const rel = 'Notes/Crlf.md';
    // This is exactly what the fixed adopt path does: sniff CRLF from the adopted
    // body and thread it into markHydrated (no mtime → no drift baseline).
    markHydrated(rel, false, undefined, undefined, '\r\n');
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: rel,
      frontmatter: { title: 'Note' }, // single-line FM — no internal \r\n
      body: 'Edited body line', // LF/no-newline editor body (tiptap normalises to LF)
      callerId: `document-editor:${rel}`,
      notePath: null,
    });
    const out = diskFiles.get(rel) ?? '';
    expect(out).toContain('\r\n');
    // No lone LF anywhere — every newline is CRLF.
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(out.startsWith('---\r\n')).toBe(true);
  });

  it('WITHOUT the adopt eol, the same single-line-FM write flips to LF (load-bearing)', async () => {
    const rel = 'Notes/NoEol.md';
    // Pre-M8 behaviour: the adopt path marked hydrated with NO eol. A single-line
    // FM carries no internal \r\n and the editor body is LF, so detection picks
    // LF and an on-disk CRLF file would flip whole-file to LF.
    markHydrated(rel, false);
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: rel,
      frontmatter: { title: 'Note' },
      body: 'Edited body line',
      callerId: `document-editor:${rel}`,
      notePath: null,
    });
    const out = diskFiles.get(rel) ?? '';
    // A lone LF exists (the flip) — confirming the threaded eol is what prevents it.
    expect(/[^\r]\n/.test(out)).toBe(true);
    expect(out.includes('\r\n')).toBe(false);
  });
});
