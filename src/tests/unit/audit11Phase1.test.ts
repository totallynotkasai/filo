/**
 * Audit-11 Phase 1 — the two HIGH-severity fixes.
 *
 * FILO-UR-1 (silent data loss): an orphan card/task field edit (no contentId, no
 * open Document editor) used to build a CLEANED whole frontmatter object —
 * `{ ...baseFm, ...patch }` then a loop dropping every empty/null key — and hand
 * that to the write. A present-but-empty disk key (`aliases:` / `cssclasses:`,
 * ubiquitous in imported Obsidian vaults) was therefore deleted and the
 * source-preserving CST engine spliced it out of the file. It fired on BOTH
 * execute and undo. The fix threads a FrontmatterDelta so the gateway reads disk
 * in-chain and rewrites ONLY the changed keys, emitting every untouched key
 * (including the empty ones) byte-for-byte.
 *
 * R1 (correctness): `DocumentEditor` derived its doc from the GLOBAL active tab,
 * so two split panes showing different Document boards both mirrored the active
 * tab. The fix makes it pane-scoped via a `tabId` prop threaded from BoardRouter.
 *
 * Both reded before the fix:
 *  - FILO-UR-1 reds when `commit` reverts to the merge + clean-loop (the empty
 *    keys vanish from the written bytes).
 *  - R1 reds when DocumentEditor reverts to `$derived(tabStore.activeTab)`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { BoardType } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// ── FILO-UR-1 ──────────────────────────────────────────────────────────────

interface Captured {
  channel: string;
  args: unknown[];
}

describe('FILO-UR-1 — orphan field edit preserves present-but-empty / datetime / comment keys', () => {
  let calls: Captured[];

  // Disk FM carries the failure-triggering shapes: a leading comment, two
  // present-but-empty keys, a datetime, and the `priority` the user will edit.
  const INITIAL = [
    '---',
    '# notes about this card',
    'aliases:',
    'cssclasses:',
    'created: 2024-01-15T09:30:00',
    'priority: low',
    '---',
    'The card body.',
  ].join('\n');

  function installMutableDisk(initial: string): void {
    let disk = initial;
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: disk, mtimeMs: 1, size: disk.length };
      }
      if (channel === 'vault:stat') {
        return { success: true, mtimeMs: 1, size: disk.length };
      }
      if (channel === 'vault:write-existing-file-text') {
        disk = args[2] as string;
        return { success: true };
      }
      return undefined;
    });
  }

  function lastWrite(): string {
    const write = calls
      .filter((c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md')
      .pop();
    expect(write, 'orphan FM edit must reach disk').toBeDefined();
    return write?.args[2] as string;
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    calls = [];
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    installMutableDisk(INITIAL);
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
  });

  it('keeps the empty keys / datetime / comment across BOTH execute and undo', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );

    await cmd.execute();
    const afterExecute = lastWrite();
    // The edit applied.
    expect(afterExecute).toContain('priority: high');
    expect(afterExecute).not.toMatch(/priority:\s*low/);
    // FILO-UR-1 core: the untouched present-but-empty keys must NOT be stripped.
    expect(afterExecute).toMatch(/^aliases:\s*$/m);
    expect(afterExecute).toMatch(/^cssclasses:\s*$/m);
    // The datetime + comment + body survive verbatim (source-preserving).
    expect(afterExecute).toContain('created: 2024-01-15T09:30:00');
    expect(afterExecute).toContain('# notes about this card');
    expect(afterExecute).toContain('The card body.');

    await cmd.undo();
    const afterUndo = lastWrite();
    // Undo restored priority — and STILL preserved the empty keys (pre-fix the
    // bug fired on undo too, since the inverse patch also ran the clean-loop).
    expect(afterUndo).toMatch(/priority:\s*low/);
    expect(afterUndo).toMatch(/^aliases:\s*$/m);
    expect(afterUndo).toMatch(/^cssclasses:\s*$/m);
    expect(afterUndo).toContain('created: 2024-01-15T09:30:00');
    expect(afterUndo).toContain('# notes about this card');
  });

  it('clearing one field leaves the OTHER present-but-empty keys intact', async () => {
    // Edit clears priority; aliases:/cssclasses: are untouched and must survive.
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: '' },
      { priority: 'low' },
    );
    await cmd.execute();
    const written = lastWrite();
    expect(written).not.toMatch(/priority:\s*low/);
    expect(written).toMatch(/^aliases:\s*$/m);
    expect(written).toMatch(/^cssclasses:\s*$/m);
    expect(written).toContain('created: 2024-01-15T09:30:00');
  });
});

// ── R1 ─────────────────────────────────────────────────────────────────────

describe('R1 — DocumentEditor is pane-scoped, not bound to the global active tab', () => {
  const docEditorSrc = readFileSync(
    join(process.cwd(), 'src/renderer/components/boards/DocumentEditor.svelte'),
    'utf8',
  );
  const routerSrc = readFileSync(
    join(process.cwd(), 'src/renderer/components/boards/BoardRouter.svelte'),
    'utf8',
  );

  it('DocumentEditor derives docId from the pane tabId, never the global active tab', () => {
    // Declares the pane prop and derives its tab from `tabId`.
    expect(docEditorSrc).toMatch(/let\s*\{\s*tabId\s*\}\s*:/);
    expect(docEditorSrc).toMatch(/tabStore\.tabs\.find\(/);
    // Must NOT resurrect the global-tab derivation that R1 fixed.
    expect(docEditorSrc).not.toMatch(/\$derived\(\s*tabStore\.activeTab\s*\)/);
  });

  it('BoardRouter threads the pane tabId down to the rendered board', () => {
    expect(routerSrc).toMatch(/<ActiveBoardComponent\s+\{tabId\}/);
  });

  it('two document panes resolve their OWN docId independent of which tab is active', () => {
    tabStore.closeAll();
    // Mirrors DocumentEditor's derivation: docId = tabs.find(id === tabId)?.boardId.
    const paneDocId = (tabId: string): string =>
      tabStore.tabs.find((t) => t.id === tabId)?.boardId ?? '';

    const tabA = tabStore.open('docA', 'Doc A', 'document' as BoardType);
    const tabB = tabStore.open('docB', 'Doc B', 'document' as BoardType);

    // Opening B made it the global active tab.
    expect(tabStore.activeTab?.boardId).toBe('docB');
    // Each pane still resolves its OWN doc (pre-fix, pane A would read 'docB').
    expect(paneDocId(tabA.id)).toBe('docA');
    expect(paneDocId(tabB.id)).toBe('docB');

    // Re-activating A must not change what pane B resolves.
    tabStore.open('docA', 'Doc A', 'document' as BoardType);
    expect(tabStore.activeTab?.boardId).toBe('docA');
    expect(paneDocId(tabB.id)).toBe('docB');

    tabStore.closeAll();
  });
});
