/**
 * Audit2 / 1.2 — body-only saves pass the frontmatter bytes through untouched.
 *
 * The document store captures the verbatim frontmatter source whenever an
 * authoritative disk read seeds the cache; the markdown write gateway emits
 * those bytes verbatim on a clean body-only save (preserving comments / key
 * order / line endings) and only re-dumps the object once the frontmatter has
 * actually been mutated. This also closes the 1.1 erasure end-to-end: an
 * unparseable block round-trips through a body edit instead of being dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMarkdownFile } from '../../renderer/lib/editor/markdownSync';
import { documentStore } from '../../renderer/stores/document.svelte';
import {
  markHydrated,
  writeMarkdownFile,
  __resetMarkdownFileWriterForTests,
} from '../../renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/boardSaver';

interface InvokeArgs {
  channel: string;
  args: unknown[];
}

function installFiloStub(): InvokeArgs[] {
  const captured: InvokeArgs[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

describe('documentStore raw-frontmatter cache (Audit2 1.2)', () => {
  afterEach(() => documentStore.clear());

  it('retains the raw bytes from a disk seed and exposes them', () => {
    documentStore.setFrontmatter('d', { title: 'X' }, 'title: X  # keep me');
    expect(documentStore.getRawFrontmatter('d')).toBe('title: X  # keep me');
  });

  it('invalidates the raw bytes on a frontmatter mutation (mergeFrontmatter)', () => {
    documentStore.setFrontmatter('d', { title: 'X' }, 'title: X');
    documentStore.mergeFrontmatter('d', { status: 'done' });
    expect(documentStore.getRawFrontmatter('d')).toBeUndefined();
  });

  it('invalidates the raw bytes on a setFrontmatter that carries no disk bytes', () => {
    documentStore.setFrontmatter('d', { title: 'X' }, 'title: X');
    documentStore.setFrontmatter('d', { title: 'Y' });
    expect(documentStore.getRawFrontmatter('d')).toBeUndefined();
  });

  it('treats an empty raw block as no usable bytes', () => {
    documentStore.setFrontmatter('d', {}, '');
    expect(documentStore.getRawFrontmatter('d')).toBeUndefined();
  });

  it('drops the raw bytes on unloadDocument', () => {
    documentStore.setFrontmatter('d', { a: 1 }, 'a: 1');
    documentStore.unloadDocument('d');
    expect(documentStore.getRawFrontmatter('d')).toBeUndefined();
  });
});

describe('writeMarkdownFile — body-only frontmatter passthrough (Audit2 1.2)', () => {
  let invokes: InvokeArgs[];

  beforeEach(() => {
    invokes = installFiloStub();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  function writtenText(invokeLog: InvokeArgs[]): string {
    const write = invokeLog.find((i) => i.channel === 'vault:write-existing-file-text');
    expect(write).toBeDefined();
    return write!.args[2] as string;
  }

  it('emits the frontmatter bytes verbatim on a clean body-only save', async () => {
    const disk = ['---', '# pinned — keep this', 'zeta: 1', 'alpha: 2', '---', 'old body'].join('\n');
    const parsed = parseMarkdownFile(disk);
    markHydrated('passthrough-clean.md', false);
    documentStore.setFrontmatter('passthrough-clean.md', parsed.frontmatter, parsed.rawFrontmatter);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'passthrough-clean.md',
      frontmatter: parsed.frontmatter,
      body: 'new body',
      callerId: 'c-clean',
      notePath: 'passthrough-clean.md',
    });

    expect(writtenText(invokes)).toBe(
      ['---', '# pinned — keep this', 'zeta: 1', 'alpha: 2', '---', 'new body', ''].join('\n'),
    );
  });

  it('source-preservingly patches frontmatter on a mutation (4.8 — comment kept)', async () => {
    const disk = ['---', '# pinned — keep this', 'zeta: 1', '---', 'old body'].join('\n');
    const parsed = parseMarkdownFile(disk);
    markHydrated('passthrough-dirty.md', false);
    documentStore.setFrontmatter('passthrough-dirty.md', parsed.frontmatter, parsed.rawFrontmatter);
    const merged = documentStore.mergeFrontmatter('passthrough-dirty.md', { status: 'done' });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'passthrough-dirty.md',
      frontmatter: merged,
      body: 'new body',
      callerId: 'c-dirty',
      notePath: 'passthrough-dirty.md',
    });

    const written = writtenText(invokes);
    // Audit2 4.8 — a mutation drops the clean-passthrough signal, but the engine
    // now patches the RETAINED disk baseline source-preservingly: the comment
    // and the untouched key survive, and only the new key is added (previously
    // this re-dumped the whole object and lost the comment).
    expect(written).toContain('# pinned — keep this');
    expect(written).toContain('status: done');
    expect(written).toContain('zeta: 1');
  });

  it('preserves an UNPARSEABLE frontmatter block on a clean body save (1.1 end-to-end)', async () => {
    const disk = ['---', 'title: Keep me', '\tbad: indentation', '---', 'old body'].join('\n');
    const parsed = parseMarkdownFile(disk);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0); // YAML didn't parse to an object
    markHydrated('passthrough-unparseable.md', false);
    documentStore.setFrontmatter('passthrough-unparseable.md', parsed.frontmatter, parsed.rawFrontmatter);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'passthrough-unparseable.md',
      frontmatter: parsed.frontmatter,
      body: 'new body',
      callerId: 'c-bad',
      notePath: 'passthrough-unparseable.md',
    });

    const written = writtenText(invokes);
    expect(written.startsWith('---')).toBe(true);
    expect(written).toContain('title: Keep me');
    expect(written).toContain('\tbad: indentation');
    expect(written).toContain('new body');
  });
});
