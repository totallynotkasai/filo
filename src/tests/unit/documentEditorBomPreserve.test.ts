import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  markHydrated,
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
 * Phase 6.1.R5 (follow-up) — DocumentEditor body-only adopt must not clobber a
 * disk-sourced BOM.
 *
 * The R5 pass fixed PropertiesPopup and TextTile's sibling-adopt paths but
 * MISSED `DocumentEditor.svelte`'s equivalent fast-path. When a `.md` file is
 * open in both a backing TextTile and a Document view, the TextTile hydrates
 * from disk first (`readMarkdownForHydrate` → `markHydrated(rel, true)` for a
 * BOM'd file). The DocumentEditor then adopts the in-memory body-only copy and
 * — pre-fix — called `markHydrated(filename, parseMarkdownFile(docState.body).hadBom)`
 * UNCONDITIONALLY. `docState.body` is body-only by contract, so that `hadBom`
 * is permanently `false`; the unconditional mark downgraded the file's
 * `hadBom` from the sibling's correct `true` to `false`, and the next save
 * dropped the `EF BB BF` prefix.
 *
 * The fix mirrors TextTile's adopt idiom: `if (!isHydrated(rel)) markHydrated(rel, false)`
 * — i.e. never downgrade a file that a disk read already marked. These tests
 * pin the contract at the gateway the fix relies on: the guarded adopt keeps
 * the BOM; the pre-fix unconditional mark loses it.
 */

describe('Phase 6.1.R5 (follow-up) — DocumentEditor adopt preserves a sibling-hydrated BOM', () => {
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
      if (channel === 'vault:write-existing-file-text') {
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
    __resetDirtyTrackingForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('the guarded body-only adopt leaves a disk-sourced hadBom=true intact → write keeps the BOM', async () => {
    const relPath = 'SharedBom.md';
    const BOM = '﻿';
    diskFiles.set(relPath, `${BOM}---\ntitle: B\n---\nbody\n`);

    // 1) The backing TextTile opens first and hydrates from disk (authoritative
    //    BOM detection from the raw bytes).
    await readMarkdownForHydrate('/vault', relPath);
    expect(isHydrated(relPath)).toBe(true);

    // 2) "Expand to Document" mounts DocumentEditor for the same file. Its
    //    body-only adopt fast-path runs the R5-fixed guard verbatim — only mark
    //    when NOT already hydrated. The file IS hydrated, so this SKIPS and the
    //    sibling's hadBom=true survives.
    if (relPath && !isHydrated(relPath)) markHydrated(relPath, false);

    // 3) A later save through the gateway must re-emit the BOM.
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { title: 'B', status: 'updated' },
      body: 'body\n',
      callerId: 'document-editor:test',
      docId: null,
    });

    const final = diskFiles.get(relPath);
    expect(final).toBeDefined();
    expect(final!.charCodeAt(0)).toBe(0xfeff);
  });

  it('the pre-fix UNCONDITIONAL markHydrated(false) would have dropped the BOM — regression guard', async () => {
    const relPath = 'WouldLoseBom.md';
    const BOM = '﻿';
    diskFiles.set(relPath, `${BOM}---\ntitle: B\n---\nbody\n`);

    // Sibling disk hydrate marks hadBom=true …
    await readMarkdownForHydrate('/vault', relPath);
    expect(isHydrated(relPath)).toBe(true);

    // … but the PRE-FIX DocumentEditor:309 marked unconditionally with the
    // body-only (always-false) hadBom, downgrading the flag.
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { title: 'B' },
      body: 'body\n',
      callerId: 'document-editor:legacy',
      docId: null,
    });

    // Inverted assertion: the legacy unconditional mark loses the BOM. Anyone
    // tempted to drop the `!isHydrated` guard in DocumentEditor sees the cost.
    const final = diskFiles.get(relPath);
    expect(final).toBeDefined();
    expect(final!.charCodeAt(0)).not.toBe(0xfeff);
  });
});
