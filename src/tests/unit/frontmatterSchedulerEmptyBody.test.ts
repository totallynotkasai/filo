/**
 * 6.2.H5 — `writeFrontmatter` empty-body fall-through.
 *
 * Pre-fix the body resolution was:
 *   body = docState?.body ?? vaultIndexStore.getMetadata(relPath)?.content ?? ''
 *
 * If `docState` was undefined at fire time (the doc unloaded mid-debounce),
 * the `??` fell through to the index's `content` — which is body-only AND
 * potentially hours stale — or `''` if the index didn't carry an entry.
 * Either fallback could clobber the disk file with an empty body.
 *
 * The fix:
 *   (a) note path set + docState undefined → abort the write (editor vanished;
 *       preserving disk truth is safer than writing stale bytes).
 *   (b) note path null → hydrate from disk fresh and use that body (no eager
 *       stale-index fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatterWriteScheduler — 6.2.H5 empty-body fall-through', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    vaultIndexStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    vaultIndexStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('aborts the write when a note path is set but the doc was unloaded mid-debounce', async () => {
    // Set up: load a doc, set FM, schedule the write, then unload before
    // the timer fires. Pre-fix: the timer fires, docState is undefined, body
    // falls through to '' (or stale vaultIndex.content), and the file's body
    // gets clobbered.
    const writes: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntitle: T\n---\nreal body', mtimeMs: 1 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 16 };
      return { success: true };
    });

    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'live body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { title: 'T' });

    scheduleFrontmatterWrite('Notes.md', 'Notes.md');

    // Editor unloads BEFORE the flush. The fixture unloadDocument simulates
    // tab close / vault swap mid-debounce.
    documentStore.unloadDocument('Notes.md');

    await flushAllPendingFrontmatterWrites();

    // Post-fix: no IPC write should have fired for the .md file. (We may
    // still see `vault:read-file-text` for the hydrate step earlier in the
    // pipeline, but no `vault:write-existing-file-text` for the editor body.)
    const mdWrite = writes.find(
      (w) =>
        (w.channel === 'vault:write-existing-file-text' ||
          w.channel === 'vault:write-file-text') &&
        w.args[1] === 'Notes.md',
    );
    expect(mdWrite).toBeUndefined();
  });

  it('null note path: writes the fresh disk body, not the stale index content', async () => {
    // Prime the index with OLD body, then flip the mock so subsequent reads
    // return NEW body. With a null note path the scheduler used to fall through
    // to `vaultIndex.content` (the OLD parsed body), silently clobbering
    // any external edit that landed between the index parse and the write.
    let lastWriteContent = '';
    let diskContent = '---\ntitle: T\n---\nOLD body\n';
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 1 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: diskContent.length };
      if (
        (channel === 'vault:write-existing-file-text' ||
          channel === 'vault:write-file-text') &&
        args[1] === 'Notes.md'
      ) {
        lastWriteContent = args[2] as string;
      }
      return { success: true };
    });

    // Index parses OLD content; `vaultIndex.content` becomes "OLD body".
    await vaultIndexStore.applyChanges(['Notes.md']);

    // External editor (or another process) replaces the file with NEW
    // body. The index hasn't caught up yet — vaultIndex.content is stale.
    diskContent = '---\ntitle: T\n---\nNEW body\n';

    // Schedule the write with a null note path. Pre-fix the body would resolve
    // to `vaultIndex.content` = "OLD body"; post-fix we hydrate fresh
    // from disk and write the current "NEW body" so the external edit
    // survives.
    scheduleFrontmatterWrite('Notes.md', null);
    await flushAllPendingFrontmatterWrites();

    expect(lastWriteContent).toContain('NEW body');
    expect(lastWriteContent).not.toContain('OLD body');
  });
});
