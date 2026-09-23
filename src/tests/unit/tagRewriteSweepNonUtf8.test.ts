/**
 * Audit-19 ERR-7 — a vault-wide tag rename must never rewrite a note whose
 * bytes aren't UTF-8. Its decoded text carries U+FFFD for every non-ASCII
 * byte, so rewriting it (even for a tag the user never looked at) destroyed
 * the accented characters. The sweep now skips such notes and names them in
 * one toast.
 *
 * Bite: drop BOTH `encoding === 'invalid-utf-8'` skips in runSweep (the plan
 * read and the post-drain re-read — either alone still protects the file) →
 * the Legacy note is written (red) and no toast appears.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rewriteTagInAllMarkdown, __resetTagRewriteSweepForTests } from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

const withFm = (body: string): string => `---\ntags:\n  - draft\n---\n${body}\n`;

describe('tag rewrite sweep skips non-UTF-8 notes (Audit-19 ERR-7)', () => {
  let files: Map<string, string>;
  let invalid: Set<string>;
  let writes: string[];

  beforeEach(() => {
    files = new Map([
      ['Fine.md', withFm('ok')],
      ['Legacy.md', withFm('R�union')],
    ]);
    invalid = new Set(['Legacy.md']);
    writes = [];
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        const rel = args[1] as string;
        if (channel === 'vault:read-file-text') {
          const content = files.get(rel);
          if (content === undefined) return { success: false, code: 'ENOENT' };
          return { success: true, content, encoding: invalid.has(rel) ? 'invalid-utf-8' : 'utf-8' };
        }
        if (channel === 'vault:write-existing-file-text') {
          writes.push(rel);
          files.set(rel, args[2] as string);
          return { success: true };
        }
        if (channel === 'vault:write-file-text') {
          files.set(rel, args[2] as string);
          return { success: true };
        }
        if (channel === 'vault:file-exists') return files.has(rel);
        return { success: true };
      },
      on: () => () => {},
      send: () => {},
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).filo;
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });

  it('rewrites the UTF-8 note, leaves the non-UTF-8 one untouched, and names it in a toast', async () => {
    const metadata = ['Fine.md', 'Legacy.md'].map(
      (path): FileMetadata => ({ path, title: path, headings: [], tags: ['draft'], frontmatter: {}, links: [], content: '', lastModified: 0 }),
    );
    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata,
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(writes).toEqual(['Fine.md']);
    expect(files.get('Fine.md')).toContain('review');
    expect(files.get('Legacy.md')).toBe(withFm('R�union'));
    expect(result.succeeded).toEqual(['Fine.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes("aren't UTF-8"));
    expect(toast?.text).toContain('Legacy.md');
  });
});
