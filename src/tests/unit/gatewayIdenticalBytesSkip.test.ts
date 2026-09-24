/**
 * Audit-19 MD-2 (layer 2) — the markdown gateway skips a write whose assembled
 * bytes equal the bytes last CONFIRMED on disk (hydrate read or matched
 * read-back), but only on a NON-drifted pre-write stat. The skip must never
 * swallow a Keep-local overwrite, a post-reload write, or a large note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import {
  readMarkdownForHydrate,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
  setExternalEditPromptHandler,
  MARKDOWN_READBACK_BYTE_THRESHOLD,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests, getBaseline } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const VAULT = '/vault';
const REL = 'Note.md';

let disk: string;
let mtime: number;
let writes: string[];

function install(initial: string): void {
  disk = initial;
  mtime = 100;
  writes = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    const ch = String(channel);
    if (ch === 'vault:read-file-text') return { success: true, content: disk, mtimeMs: mtime, size: disk.length };
    if (ch === 'vault:stat') return { success: true, mtimeMs: mtime, size: disk.length };
    if (ch === 'vault:write-existing-file-text') {
      disk = String(args[2]);
      mtime += 10;
      writes.push(disk);
      return { success: true };
    }
    return { success: true };
  });
}

async function hydrate(): Promise<void> {
  const r = await readMarkdownForHydrate(VAULT, REL);
  documentStore.loadDocument({ filename: REL, title: 'Note', body: r.body, htmlContent: '', richText: [] });
  documentStore.setFrontmatter(REL, r.frontmatter, r.rawFrontmatter);
}

function write(body: string): Promise<void> {
  documentStore.markDirty(REL, 'c1');
  return writeMarkdownFile({
    vaultRoot: VAULT,
    relPath: REL,
    frontmatter: documentStore.getFrontmatter(REL) ?? {},
    body,
    callerId: 'c1',
    notePath: REL,
  });
}

describe('gateway identical-bytes skip (Audit-19 MD-2)', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    vaultIndexStore.clear();
  });
  afterEach(() => {
    setExternalEditPromptHandler(null);
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('hydrate → identical write: no IPC, writer marked clean', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    await write('Hello\n');
    expect(writes).toEqual([]);
    expect(documentStore.isWriterDirty(REL, 'c1')).toBe(false);
  });

  it('a changed body still writes', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    await write('Hello world\n');
    expect(writes).toEqual(['---\na: 1\n---\nHello world\n']);
  });

  it('after a confirmed write, the next identical write skips', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    await write('Changed\n');
    expect(writes.length).toBe(1);
    await write('Changed\n');
    expect(writes.length).toBe(1);
  });

  it('drift + Keep-local with identical bytes still writes', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    // External tool rewrites the file; local bytes equal the OLD baseline text.
    disk = '---\na: 1\n---\nExternal\n';
    mtime += 50;
    setExternalEditPromptHandler(async () => 'keep-local');
    await write('Hello\n');
    expect(writes).toEqual(['---\na: 1\n---\nHello\n']);
  });

  it('a baseline re-stamped by an external reload drops the text, so the write fires', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    documentStore.applyReloadFromDisk(REL, 'Hello\n', [], { a: 1 }, 'a: 1', { mtimeMs: mtime, size: disk.length });
    expect(getBaseline(REL)?.text).toBeUndefined();
    await write('Hello\n');
    expect(writes.length).toBe(1);
  });

  it('a note of 1 MB or more never skips', async () => {
    const big = `${'x'.repeat(MARKDOWN_READBACK_BYTE_THRESHOLD + 10)}\n`;
    install(big);
    await hydrate();
    await write(big);
    expect(writes.length).toBe(1);
  });

  it('an unconfirmed write (read-back mismatch) drops the baseline text', async () => {
    install('---\na: 1\n---\nHello\n');
    await hydrate();
    expect(getBaseline(REL)?.text).toBeDefined();
    // Every read after the write returns foreign bytes of the same length.
    const spy = vi.fn();
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      const ch = String(channel);
      if (ch === 'vault:write-existing-file-text') {
        spy(args[2]);
        disk = String(args[2]);
        return { success: true };
      }
      if (ch === 'vault:read-file-text') return { success: true, content: disk.replace(/./g, 'q'), mtimeMs: mtime, size: disk.length };
      if (ch === 'vault:stat') return { success: true, mtimeMs: mtime, size: disk.length };
      return { success: true };
    });
    await write('Other\n');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getBaseline(REL)?.text).toBeUndefined();
  });
});
