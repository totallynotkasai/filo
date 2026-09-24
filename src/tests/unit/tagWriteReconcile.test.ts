import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  cancelAllMarkdownWrites,
  runSerializedMarkdownWrite,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { reconcileOpenEditorFrontmatter } from '@renderer/lib/vault/syncOpenEditorsAfterDiskMutation';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit5 R2 — sealing the single-tag write boundary (#4 / #8).
 *
 * The single-tag fast path writes a `.md` file directly (not through the editor
 * gateway). Two latent bugs:
 *   #4 — it never reconciled an open editor's frontmatter cache, so the editor's
 *        next body save passed through its stale pre-tag frontmatter and dropped
 *        the tag.
 *   #8 — it wasn't enrolled in the per-path write chain, so it could race a
 *        concurrent body write to the same file.
 *
 * These tests target the two fix mechanisms directly:
 *   - `reconcileOpenEditorFrontmatter` refreshes the FM cache WITHOUT touching
 *     the body (so a still-dirty editor's unsaved keystrokes survive), and the
 *     gateway's next body save then keeps the tag.
 *   - `runSerializedMarkdownWrite` serialises writes per resolved path so two
 *     writers to one file can't interleave.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWriteContent(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function bodyWriteArgs(
  relPath: string,
  body: string,
): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    // Editor body writers source frontmatter from the live cache; the gateway
    // re-reads the cache at fire time anyway, so this is only a fallback.
    frontmatter: documentStore.getFrontmatter(relPath) ?? {},
    body,
    callerId: `text-tile:${relPath}`,
    notePath: relPath,
  };
}

describe('Audit5 R2 — reconcileOpenEditorFrontmatter (#4)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });
  });

  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('updates the frontmatter cache to the written bytes WITHOUT touching the editor body', () => {
    const relPath = 'Notes/A.md';
    documentStore.loadDocument({
      filename: relPath,
      title: 'A',
      body: 'unsaved local edits the user is still typing',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'A' }, 'title: A');
    // Simulate an in-flight edit so the doc is dirty — a body reload here would
    // clobber it; the FM-only reconcile must not.
    documentStore.updateContent(relPath, '<p>x</p>', 'unsaved local edits the user is still typing', 'w1');

    // The tag write landed `tags: [foo]` on disk; the bytes carry the OLD body
    // (disk lags the still-typing editor). Reconcile must take the FM only.
    const onDisk = '---\ntitle: A\ntags:\n  - foo\n---\nstale disk body\n';
    reconcileOpenEditorFrontmatter([{ path: relPath, content: onDisk }]);

    // Body preserved (the unsaved edits), frontmatter cache refreshed with the tag.
    expect(documentStore.getDocument(relPath)?.body).toBe('unsaved local edits the user is still typing');
    expect(documentStore.getFrontmatter(relPath)).toEqual({ title: 'A', tags: ['foo'] });
    expect(documentStore.getRawFrontmatter(relPath)).toBe('title: A\ntags:\n  - foo');
  });

  it('lets the editor body save KEEP the reconciled tag (the #4 fix end-to-end)', async () => {
    const relPath = 'Notes/B.md';
    documentStore.loadDocument({
      filename: relPath,
      title: 'B',
      body: 'original body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'B' }, 'title: B'); // clean, NO tag yet
    markHydrated(relPath, false);

    // Tag write lands `tags: [foo]` + reconciles the open editor's FM cache.
    reconcileOpenEditorFrontmatter([
      { path: relPath, content: '---\ntitle: B\ntags:\n  - foo\n---\noriginal body\n' },
    ]);

    // User keeps editing the body → debounced gateway save fires.
    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited body'));
    await flushMarkdownWrite(`text-tile:${relPath}`);

    const written = lastWriteContent(captured);
    expect(written, 'no write captured').toBeDefined();
    // The body save kept the tag (#4 would have dropped it) AND applied the edit.
    expect(written).toContain('tags:');
    expect(written).toContain('foo');
    expect(written).toContain('edited body');
  });

  it('demonstrates the bug WITHOUT the reconcile: a body save drops the tag', async () => {
    const relPath = 'Notes/C.md';
    documentStore.loadDocument({
      filename: relPath,
      title: 'C',
      body: 'original body',
      htmlContent: '',
      richText: [],
    });
    // Editor's FM cache never learns about the tag (no reconcile).
    documentStore.setFrontmatter(relPath, { title: 'C' }, 'title: C');
    markHydrated(relPath, false);

    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited body'));
    await flushMarkdownWrite(`text-tile:${relPath}`);

    const written = lastWriteContent(captured);
    expect(written).toBeDefined();
    expect(written).not.toContain('foo'); // tag lost — exactly what R2's reconcile prevents
  });
});

describe('Audit5 R2 — runSerializedMarkdownWrite (#8)', () => {
  beforeEach(() => {
    cancelAllMarkdownWrites();
  });
  afterEach(() => {
    cancelAllMarkdownWrites();
  });

  it('serialises two writes to the SAME path — the second waits for the first', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = runSerializedMarkdownWrite('Notes/Same.md', async () => {
      order.push('op1:start');
      await firstGate; // hold the chain open
      order.push('op1:end');
    });
    const p2 = runSerializedMarkdownWrite('Notes/Same.md', async () => {
      order.push('op2:start');
      order.push('op2:end');
    });

    // op2 must NOT have started while op1 is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['op1:start']);

    releaseFirst();
    await Promise.all([p1, p2]);
    // Strict ordering: op1 fully completes before op2 begins.
    expect(order).toEqual(['op1:start', 'op1:end', 'op2:start', 'op2:end']);
  });

  it('does NOT serialise writes to DIFFERENT paths (they overlap)', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const pa = runSerializedMarkdownWrite('Notes/A.md', async () => {
      order.push('a:start');
      await gateA;
      order.push('a:end');
    });
    const pb = runSerializedMarkdownWrite('Notes/B.md', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.resolve();
    await Promise.resolve();
    // B ran to completion while A is still blocked → different paths overlap.
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    releaseA();
    await Promise.all([pa, pb]);
    expect(order).toContain('a:end');
  });

  it('a rejecting write does not wedge the next write on the same path', async () => {
    const order: string[] = [];
    const p1 = runSerializedMarkdownWrite('Notes/X.md', async () => {
      order.push('op1');
      throw new Error('boom');
    }).catch(() => order.push('op1:rejected'));
    const p2 = runSerializedMarkdownWrite('Notes/X.md', async () => {
      order.push('op2');
    });
    await Promise.allSettled([p1, p2]);
    expect(order).toContain('op2'); // op2 still ran despite op1 rejecting
  });
});
