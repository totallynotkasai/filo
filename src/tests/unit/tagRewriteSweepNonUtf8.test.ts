/**
 * A vault-wide tag rename must never rewrite a note whose bytes aren't UTF-8.
 * Its decoded text carries U+FFFD for every non-ASCII byte, so rewriting it
 * (even for a tag the user never looked at) would destroy the accented
 * characters. The sweep skips such notes and names them in one toast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rewriteTagInAllMarkdown, __resetTagRewriteSweepForTests } from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const withFm = (body: string): string => `---\ntags:\n  - draft\n---\n${body}\n`;

describe('tag rewrite sweep skips non-UTF-8 notes', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({
      'Fine.md': withFm('ok'),
      'Legacy.md': withFm('R�union'),
    });
    vault.nonUtf8.add('legacy.md');
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });

  it('rewrites the UTF-8 note, leaves the non-UTF-8 one untouched, and names it in a toast', async () => {
    const metadata = ['Fine.md', 'Legacy.md'].map(
      (path): FileMetadata => ({ path, title: path, tags: ['draft'], frontmatter: {}, content: '', lastModified: 0, rawFrontmatter: '' }),
    );
    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata,
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, rel]) => rel)).toEqual(['Fine.md']);
    expect(vault.read('Fine.md')).toContain('review');
    expect(vault.read('Legacy.md')).toBe(withFm('R�union'));
    expect(result.succeeded).toEqual(['Fine.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes("aren't UTF-8"));
    expect(toast?.text).toContain('Legacy.md');
  });
});
