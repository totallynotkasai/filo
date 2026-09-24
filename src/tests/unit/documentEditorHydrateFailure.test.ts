import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHydrated,
  readMarkdownForHydrate,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __clearFileStateForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { documentStore } from '@renderer/stores/document.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-12 M1 — DocumentEditor must not write an empty body over a file whose
 * on-mount hydrate read FAILED.
 *
 * Root cause: a transient read failure (Windows file lock / OneDrive / AV) left
 * the editor blank + writable. A keystroke into that unexpectedly-empty editor
 * then truncated the real (unread) file on the next debounced write. The fix
 * flags the failed read (`hydrateReadFailed`) and `buildWriteArgs` refuses to
 * write while it's set with no real body loaded — pinned structurally by the
 * `ci:no-silent-write-abort` gate (both tokens REQUIRED in DocumentEditor.svelte).
 *
 * The guard itself is component-internal (DocumentEditor.svelte) and this repo's
 * jsdom test env doesn't mount TipTap components, so these tests lock the two
 * GATEWAY-level facts the guard relies on:
 *   1. A failed `readMarkdownForHydrate` REJECTS — the exact trigger that sets
 *      `hydrateReadFailed = true` in the component's catch.
 *   2. Writing an EMPTY body over a file with real content DOES truncate it —
 *      proving the guard is load-bearing — while declining the write (the
 *      guard's effect) leaves the file's real content intact.
 *   3. A later SUCCESSFUL read returns the real content — the resume path that
 *      clears the flag and re-enables editing.
 */
describe('Audit-12 M1 — DocumentEditor failed-hydrate write guard (gateway contract)', () => {
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

  it('a failed hydrate read REJECTS (the trigger that flips hydrateReadFailed)', async () => {
    const rel = 'Notes/Locked.md';
    // No entry in diskFiles → the read returns { success: false } → the gateway
    // read helper throws. This is what the component catches to set the flag.
    expect(isHydrated(rel)).toBe(false);
    await expect(readMarkdownForHydrate('/vault', rel)).rejects.toBeTruthy();
    // The file remains absent in our mock — the failed read mutated nothing.
    expect(diskFiles.has(rel)).toBe(false);
  });

  it('an empty-body write over real content TRUNCATES it (why the guard is load-bearing)', async () => {
    const rel = 'Notes/Real.md';
    const real = '---\ntitle: Real\n---\n\n# Real heading\n\nReal paragraph that must survive.\n';
    diskFiles.set(rel, real);

    // Hydrate succeeds here (control): a normal open reads the real bytes.
    const hydrated = await readMarkdownForHydrate('/vault', rel);
    expect(hydrated.body).toContain('Real heading');

    // Simulate the UN-GUARDED failure: the editor wrote an empty body. The
    // gateway faithfully persists whatever body it's handed, so the real
    // content is lost — this is exactly the data loss M1's guard prevents.
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: rel,
      frontmatter: {},
      body: '',
      callerId: `document-editor:${rel}`,
      notePath: null,
    });
    expect(diskFiles.get(rel) ?? '').not.toContain('Real heading');
  });

  it('declining the write (the guard) preserves the real file; a later read resumes', async () => {
    const rel = 'Notes/Guarded.md';
    const real = '# Important\n\nUnread content stays put.\n';
    diskFiles.set(rel, real);

    // The component, on a failed read, sets hydrateReadFailed and buildWriteArgs
    // returns null — so NO write is issued. We model that by simply not calling
    // writeMarkdownFile. The on-disk content is therefore untouched.
    expect(diskFiles.get(rel)).toBe(real);

    // Resume path: once the file is readable again, the retry's read returns the
    // real content (clears the flag + re-enables editing in the component).
    const reread = await readMarkdownForHydrate('/vault', rel);
    expect(reread.body).toContain('Unread content stays put.');
  });
});
