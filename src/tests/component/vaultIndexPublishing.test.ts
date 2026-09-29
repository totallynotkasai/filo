import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteBody, noteFrontmatter } from '@renderer/stores/noteMeta';
import { noteStore } from '@renderer/stores/notes.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type { FileTreeNode } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { probeDerived } from '../helpers/derivedProbe.svelte';

/**
 * The vault index's reactivity grains: a view that shows one note re-runs
 * when that note changes, not on every save in the vault; tag readers re-run
 * when tags change; and a rebuild shows notes as they are read, not all at
 * the end.
 */

const note = (tags: string, body: string): string => `---\ntags: [${tags}]\n---\n${body}\n`;

function tree(n: number): FileTreeNode[] {
  return Array.from({ length: n }, (_, i) => ({ name: `n${i}.md`, path: `/vault/n${i}.md`, isDirectory: false, extension: '.md' }));
}

describe('vault index reactivity', () => {
  beforeEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    vaultIndexStore.clear();
  });
  afterEach(() => {
    vaultIndexStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('an autosave of note A re-runs A\'s readers only, and not the tag readers', () => {
    vaultIndexStore.restoreMetadata('A.md', parseMarkdown('A.md', note('x', 'a1')));
    vaultIndexStore.restoreMetadata('B.md', parseMarkdown('B.md', note('y', 'b1')));
    const a = probeDerived(() => noteBody('A.md'));
    const b = probeDerived(() => noteFrontmatter('B.md'));
    const tags = probeDerived(() => [...vaultIndexStore.allTags().keys()].sort().join(','));
    const list = probeDerived(() => vaultIndexStore.listVersion);

    vaultIndexStore.restoreMetadata('A.md', parseMarkdown('A.md', note('x', 'a2')));
    expect(a.value()).toBe('a2\n');
    expect(a.runs()).toBe(2);
    expect(b.runs()).toBe(1);
    expect(tags.runs()).toBe(1);
    expect(list.runs()).toBe(1);

    // A tag change reaches the tag readers.
    vaultIndexStore.restoreMetadata('A.md', parseMarkdown('A.md', note('x, z', 'a2')));
    expect(tags.value()).toBe('x,y,z');
    expect(b.runs()).toBe(1);
    for (const p of [a, b, tags, list]) p.stop();
  });

  it('with 400 task rows showing, saving one note re-runs one row', () => {
    const paths = Array.from({ length: 400 }, (_, i) => `Tasks/t${i}.md`);
    for (const p of paths) vaultIndexStore.restoreMetadata(p, parseMarkdown(p, note('task', `notes ${p}`)));
    // What each row reads: its note's fields and its notes box body.
    const rows = paths.map((p) => probeDerived(() => [noteFrontmatter(p).tags, noteBody(p)]));
    vaultIndexStore.restoreMetadata(paths[7] as string, parseMarkdown(paths[7] as string, note('task', 'typed')));
    const rerun = rows.map((r, i) => (r.runs() > 1 ? i : -1)).filter((i) => i >= 0);
    expect(rerun).toEqual([7]);
    for (const r of rows) r.stop();
  });

  it('a note that arrives later reaches the view waiting for it', () => {
    const c = probeDerived(() => noteBody('C.md'));
    expect(c.value()).toBe('');
    vaultIndexStore.restoreMetadata('Other.md', parseMarkdown('Other.md', note('x', 'o')));
    expect(c.runs()).toBe(1);
    vaultIndexStore.restoreMetadata('C.md', parseMarkdown('C.md', note('x', 'c')));
    expect(c.value()).toBe('c\n');
    c.stop();
  });

  it('a rename tells the readers of both paths', () => {
    vaultIndexStore.restoreMetadata('Old.md', parseMarkdown('Old.md', note('x', 'body')));
    const oldR = probeDerived(() => noteBody('Old.md'));
    const newR = probeDerived(() => noteBody('New.md'));
    vaultIndexStore.renameKey('Old.md', 'New.md');
    expect(oldR.value()).toBe('');
    expect(newR.value()).toBe('body\n');
    oldR.stop();
    newR.stop();
  });

  it('a rebuild publishes notes as it reads them, before it finishes', async () => {
    installFiloMock(async (channel: unknown, ...args: unknown[]) => {
      if (channel !== 'vault:read-file-text') return { ok: true, success: true };
      await new Promise((r) => setTimeout(r, 4));
      const rel = String(args[1]);
      return { ok: true, success: true, content: note('t', `body of ${rel}`), mtimeMs: 1 };
    });
    const first = probeDerived(() => noteBody('n0.md'));
    const list = probeDerived(() => vaultIndexStore.listVersion);
    const runsBefore = list.runs();
    const done = vaultIndexStore.rebuild(tree(1000));
    let seenWhileBuilding = false;
    while (vaultIndexStore.isBuilding) {
      if (first.value() === 'body of n0.md\n') seenWhileBuilding = true;
      await new Promise((r) => setTimeout(r, 20));
    }
    await done;
    expect(seenWhileBuilding).toBe(true);
    // The vault-wide version went up during the read, not only at the end.
    expect(list.runs() - runsBefore).toBeGreaterThan(2);
    expect(vaultIndexStore.allMetadata().length).toBe(1000);
    first.stop();
    list.stop();
  });
});
