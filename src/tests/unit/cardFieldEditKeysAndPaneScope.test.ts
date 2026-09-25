/**
 * Two HIGH-severity fixes.
 *
 * Card field edit (silent data loss): a card/task field edit on a note no view
 * has loaded used to build a CLEANED whole frontmatter object and hand that to
 * the write, so a present-but-empty disk key (`aliases:` / `cssclasses:`,
 * ubiquitous in imported Obsidian vaults) was deleted. It fired on BOTH execute
 * and undo. The edit is a FrontmatterDelta applied to a fresh read of the file,
 * so ONLY the changed keys are rewritten and every untouched key (including the
 * empty ones) is emitted byte-for-byte.
 *
 * Pane scoping: `DocumentEditor` derived its doc from the GLOBAL active tab,
 * so two split panes showing different Document boards both mirrored the active
 * tab. It is pane-scoped via a `tabId` prop threaded from BoardRouter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

// ── Card field edit ────────────────────────────────────────────────────────

describe('a card field edit preserves present-but-empty / datetime / comment keys', () => {
  let vault: MemoryVault;

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

  function lastWrite(): string {
    const write = vault.writes.filter(([, rel]) => rel === 'Card.md').pop();
    expect(write, 'card FM edit must reach disk').toBeDefined();
    return write?.[2] ?? '';
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Card.md': INITIAL });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
  });

  it('keeps the empty keys / datetime / comment across BOTH execute and undo', async () => {
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );

    await cmd.execute();
    await noteStore.flushAll();
    const afterExecute = lastWrite();
    // The edit applied.
    expect(afterExecute).toContain('priority: high');
    expect(afterExecute).not.toMatch(/priority:\s*low/);
    // The untouched present-but-empty keys must NOT be stripped.
    expect(afterExecute).toMatch(/^aliases:\s*$/m);
    expect(afterExecute).toMatch(/^cssclasses:\s*$/m);
    // The datetime + comment + body survive verbatim (source-preserving).
    expect(afterExecute).toContain('created: 2024-01-15T09:30:00');
    expect(afterExecute).toContain('# notes about this card');
    expect(afterExecute).toContain('The card body.');

    await cmd.undo();
    await noteStore.flushAll();
    const afterUndo = lastWrite();
    // Undo restored priority and STILL preserved the empty keys.
    expect(afterUndo).toMatch(/priority:\s*low/);
    expect(afterUndo).toMatch(/^aliases:\s*$/m);
    expect(afterUndo).toMatch(/^cssclasses:\s*$/m);
    expect(afterUndo).toContain('created: 2024-01-15T09:30:00');
    expect(afterUndo).toContain('# notes about this card');
  });

  it('clearing one field leaves the OTHER present-but-empty keys intact', async () => {
    // Edit clears priority; aliases:/cssclasses: are untouched and must survive.
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'Card.md',
      { priority: '' },
      { priority: 'low' },
    );
    await cmd.execute();
    await noteStore.flushAll();
    const written = lastWrite();
    expect(written).not.toMatch(/priority:\s*low/);
    expect(written).toMatch(/^aliases:\s*$/m);
    expect(written).toMatch(/^cssclasses:\s*$/m);
    expect(written).toContain('created: 2024-01-15T09:30:00');
  });
});

// ── Pane scoping ───────────────────────────────────────────────────────────

describe('DocumentEditor is pane-scoped, not bound to the global active tab', () => {
  const docEditorSrc = readFileSync(
    join(process.cwd(), 'src/renderer/components/boards/DocumentEditor.svelte'),
    'utf8',
  );
  const routerSrc = readFileSync(
    join(process.cwd(), 'src/renderer/components/boards/BoardRouter.svelte'),
    'utf8',
  );

  it('DocumentEditor derives its note from the pane tabId, never the global active tab', () => {
    // Declares the pane prop and derives its tab from `tabId`.
    expect(docEditorSrc).toMatch(/let\s*\{\s*tabId\s*\}\s*:/);
    expect(docEditorSrc).toMatch(/tabStore\.tabs\.find\(/);
    // Must NOT resurrect the global-tab derivation.
    expect(docEditorSrc).not.toMatch(/\$derived\(\s*tabStore\.activeTab\s*\)/);
  });

  it('BoardRouter threads the pane tabId down to the rendered board', () => {
    expect(routerSrc).toMatch(/<ActiveBoardComponent\s+\{tabId\}/);
  });

  it('two document panes resolve their OWN note independent of which tab is active', () => {
    tabStore.closeAll();
    // Mirrors DocumentEditor's derivation: notePath = tabs.find(id === tabId)?.notePath.
    const paneNotePath = (tabId: string): string =>
      tabStore.tabs.find((t) => t.id === tabId)?.notePath ?? '';

    const tabA = tabStore.openNote('A.md', 'Doc A');
    const tabB = tabStore.openNote('B.md', 'Doc B');

    // Opening B made it the global active tab.
    expect(tabStore.activeTab?.notePath).toBe('B.md');
    // Each pane still resolves its OWN note (pane A must not read 'B.md').
    expect(paneNotePath(tabA.id)).toBe('A.md');
    expect(paneNotePath(tabB.id)).toBe('B.md');

    // Re-activating A must not change what pane B resolves.
    tabStore.openNote('A.md', 'Doc A');
    expect(tabStore.activeTab?.notePath).toBe('A.md');
    expect(paneNotePath(tabB.id)).toBe('B.md');

    tabStore.closeAll();
  });
});
