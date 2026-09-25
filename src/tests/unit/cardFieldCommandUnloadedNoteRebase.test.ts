/**
 * UpdateCardFieldCommand on a note no view has open (a Kanban card whose note
 * was never loaded). Its undo/redo must rebase on the file as it stands, not
 * blindly restore the pre-edit value: a field another program changed between
 * execute and undo keeps that value (with an "Apply anyway" toast), and the
 * inverse is recomputed from disk on first execute so a stale index can't
 * make undo restore the wrong value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const card = (priority: string): string => `---\npriority: ${priority}\n---\nbody content\n`;

describe('UpdateCardFieldCommand on an unloaded note — rebase on undo', () => {
  let vault: MemoryVault;

  const cardWrites = (): string[] =>
    vault.writes.filter(([, rel]) => rel === 'Card.md').map(([, , text]) => text);

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Card.md': card('low') });
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('undo preserves an external edit to the same field (skips the conflicting key)', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe(card('high'));

    vault.writeExternally('Card.md', card('critical'));
    const before = cardWrites().length;
    await cmd.undo();
    await noteStore.flushAll();

    for (const text of cardWrites().slice(before)) expect(text).not.toContain('priority: low');
    expect(vault.read('Card.md')).toBe(card('critical'));
    const conflictToast = uiStore.toasts.find((t) => /External edit changed/i.test(t.text));
    expect(conflictToast).toBeDefined();
    expect(conflictToast?.text).toContain('priority');
  });

  it('recomputes the inverse from disk so a stale index inverse cannot mis-restore', async () => {
    // The caller built its inverse from a stale index that had no priority;
    // the file has `priority: high`.
    vault.writeExternally('Card.md', card('high'));
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'low' }, { priority: '' });
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe(card('low'));
    expect(uiStore.toasts.find((t) => /External edit changed/i.test(t.text))).toBeUndefined();

    await cmd.undo();
    await noteStore.flushAll();
    // The true prior value, not the stale '' (which would drop the key).
    expect(vault.read('Card.md')).toBe(card('high'));
  });

  it('an undo whose every field conflicts writes nothing and does not mark the board dirty', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();

    const markDirtySpy = vi.spyOn(boardCacheStore, 'markDirty');
    vault.writeExternally('Card.md', card('critical'));
    const before = cardWrites().length;
    await cmd.undo();
    await noteStore.flushAll();

    expect(cardWrites().slice(before)).toEqual([]);
    expect(markDirtySpy).not.toHaveBeenCalled();
    markDirtySpy.mockRestore();
  });

  it('undo without a conflict applies the inverse cleanly', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe(card('low'));
  });
});
