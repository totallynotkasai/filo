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
 * Phase 6.1.R5 — BOM-preserving property writes.
 *
 * The bug class: a caller sniffs the BOM byte from in-memory content
 * that has ALREADY been BOM-stripped (gray-matter / js-yaml /
 * parseMarkdownFile), so `hadBom` is permanently `false`. The hydrate
 * stamps `fileState` with the wrong BOM state, the next gateway write
 * assembles without the BOM byte, and the user's Notepad-saved `.md`
 * loses its `EF BB BF` prefix on the first PropertiesPopup save.
 *
 * The fix routes the hydrate through `readMarkdownForHydrate(vaultRoot,
 * relPath)` — the canonical disk-read gateway — which reads the raw
 * bytes, detects the BOM from the actual byte sequence, and seeds
 * `fileState` with the correct `hadBom`. This test pins the contract:
 * a BOM'd file's first gateway write through the PropertiesPopup-style
 * code path emits the BOM byte intact.
 */

describe('Phase 6.1.R5 — BOM preservation across a hydrate + write cycle', () => {
  let writes: Array<{ channel: string; args: unknown[] }>;
  let diskFiles: Map<string, string>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearFileStateForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    writes = [];
    diskFiles = new Map();
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        const rel = args[1] as string;
        const content = diskFiles.get(rel);
        if (content === undefined) return { success: false, code: 'ENOENT' };
        return { success: true, content, mtimeMs: 100, size: content.length };
      }
      if (channel === 'vault:write-existing-file-text') {
        const rel = args[1] as string;
        const content = args[2] as string;
        diskFiles.set(rel, content);
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

  it('readMarkdownForHydrate seeds hadBom=true for a BOM-prefixed file', async () => {
    const relPath = 'Notes.md';
    const BOM = '﻿';
    const onDisk = `${BOM}---\ntitle: B\n---\nbody\n`;
    diskFiles.set(relPath, onDisk);

    expect(isHydrated(relPath)).toBe(false);
    const hydrate = await readMarkdownForHydrate('/vault', relPath);
    expect(hydrate.hadBom).toBe(true);
    expect(isHydrated(relPath)).toBe(true);
  });

  it('a write through the gateway re-emits the BOM for a previously-BOM-hydrated file', async () => {
    const relPath = 'BomNotes.md';
    const BOM = '﻿';
    const onDisk = `${BOM}---\ntitle: B\n---\nbody\n`;
    diskFiles.set(relPath, onDisk);

    // Hydrate as the PropertiesPopup-fix flow does — fresh disk read.
    await readMarkdownForHydrate('/vault', relPath);

    // Write new frontmatter through the gateway. The first byte of the
    // emitted file must still be U+FEFF.
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { title: 'B', status: 'updated' },
      body: 'body\n',
      callerId: 'properties-popup:test',
      notePath: null,
    });

    const final = diskFiles.get(relPath);
    expect(final).toBeDefined();
    expect(final!.charCodeAt(0)).toBe(0xfeff);
  });

  it('the legacy in-memory sniff would have lost the BOM — guard against the regression', async () => {
    const relPath = 'WouldLoseBom.md';
    const BOM = '﻿';
    diskFiles.set(relPath, `${BOM}---\ntitle: B\n---\nbody\n`);

    // Simulate the legacy bug: hydrate from a BOM-stripped in-memory copy
    // (gray-matter's `content` field) rather than via the disk-read
    // gateway. `parseMarkdownFile` on the body-only string yields
    // hadBom: false because the BOM was already stripped.
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { title: 'B' },
      body: 'body\n',
      callerId: 'properties-popup:legacy',
      notePath: null,
    });

    // With the legacy false-flag hydrate the BOM is lost. The regression
    // assertion here is intentionally inverted: we EXPECT loss in this
    // legacy path, so anyone tempted to revert the R5 fix sees the cost.
    const final = diskFiles.get(relPath);
    expect(final).toBeDefined();
    expect(final!.charCodeAt(0)).not.toBe(0xfeff);
  });
});
