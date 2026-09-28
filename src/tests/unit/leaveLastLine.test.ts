/**
 * What a save or a leave sees before the views unmount, and the last line
 * behind it.
 *
 * - Every registered component flush runs, and one that throws doesn't stop
 *   the others.
 * - A change still queued when a vault is let go as saved (a note, or a board
 *   / `.filo/` write the swap would cancel) is kept in `.filo/recovery/` and
 *   the crash sentinel stays set, instead of being reset away. Leaving with
 *   rescue copies already kept adds no second copy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { flushDirtyFlagSentinel } from '@renderer/lib/vault/dirtyFlagRecovery';
import {
  registerComponentFlush,
  flushAllComponents,
  __resetComponentFlushesForTests,
} from '@renderer/lib/boards/componentFlush';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
// Registers the `leftBehind` pre-swap handler.
import '@renderer/stores/vaultLeaveGuard';

const NOTE = '---\ntitle: Plan\n---\nOriginal\n';

let calls: Array<{ channel: string; args: unknown[] }>;

function installVault(): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel === 'vault:read-file-text') {
      return { success: true, content: NOTE, mtimeMs: 5, size: NOTE.length, encoding: 'utf-8' };
    }
    if (channel === 'recovery:keep-unsaved') {
      const items = args[1] as Array<{ relPath: string }>;
      return { ok: true, dir: '.filo/recovery/1-unsaved', kept: items.map((i) => i.relPath), failed: [] };
    }
    return { success: true };
  });
}

describe('component flushes', () => {
  afterEach(() => __resetComponentFlushesForTests());

  it('runs every registered flush, past one that throws, and forgets an unregistered one', async () => {
    const ran: string[] = [];
    registerComponentFlush('a', () => {
      ran.push('a');
      throw new Error('boom');
    });
    registerComponentFlush('b', async () => {
      ran.push('b');
    });
    const off = registerComponentFlush('c', () => {
      ran.push('c');
    });
    off();
    await flushAllComponents();
    expect(ran).toEqual(['a', 'b']);
  });
});

describe('a note change left queued when the vault is let go', () => {
  beforeEach(async () => {
    calls = [];
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    noteStore.__resetForTests();
    installVault();
    noteStore.acquire('Plan.md', 'view-1');
    await noteStore.get('Plan.md')?.loaded;
    noteStore.setBody('Plan.md', 'Typed after the save\n', 'view-1');
  });
  afterEach(() => {
    noteStore.__resetForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
    __resetVaultIdentityForTests();
  });

  it('is kept in .filo/recovery and the sentinel is set again when the leave was clean', async () => {
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: null, saveOutgoing: true });
    await flushDirtyFlagSentinel();

    const kept = calls.find((c) => c.channel === 'recovery:keep-unsaved');
    expect(kept?.args[0]).toBe('/vault');
    const items = kept?.args[1] as Array<{ relPath: string; text: string }>;
    expect(items.map((i) => i.relPath)).toEqual(['Plan.md']);
    expect(items[0].text).toContain('Typed after the save');
    // The sentinel is written after it was cleared, so reopening offers recovery.
    const sentinel = calls.filter((c) => typeof c.args[1] === 'string' && (c.args[1] as string).startsWith('.filo/.dirty'));
    expect(sentinel.at(-1)?.channel).toBe('vault:write-file-text');
    // Nothing is written over the note itself.
    expect(calls.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(false);
  });

  it('adds no second copy when the user left with rescue copies already kept', async () => {
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: null, saveOutgoing: false });
    expect(calls.some((c) => c.channel === 'recovery:keep-unsaved')).toBe(false);
  });
});

describe('a .filo/ or board write left queued when the vault is let go', () => {
  beforeEach(() => {
    calls = [];
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    noteStore.__resetForTests();
    installVault();
  });
  afterEach(() => {
    setActiveVaultPath('');
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
  });

  it('is copied before the swap cancels it, and the sentinel stays set', async () => {
    const tags = JSON.stringify({ version: 1, tags: {}, fileTags: { 'photo.png': ['trip'] } });
    // A reconcile queued this after the save before leaving: still debounced.
    scheduleMiscWrite('tags', () => ({
      vaultRoot: '/vault',
      path: '.filo/tags.json',
      json: tags,
      write: async () => {
        calls.push({ channel: 'tags-written', args: [] });
      },
    }));
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: null, saveOutgoing: true });
    await flushDirtyFlagSentinel();
    await new Promise((r) => setTimeout(r, 400));

    const kept = calls.find((c) => c.channel === 'recovery:keep-unsaved');
    const items = (kept?.args[1] ?? []) as Array<{ relPath: string; text: string }>;
    expect(items).toContainEqual({ relPath: '_filo__tags.json', text: `${tags}\n` });
    // The write itself was cancelled with the swap, not fired into it.
    expect(calls.some((c) => c.channel === 'tags-written')).toBe(false);
    // Never cleared: every sentinel call writes it, none deletes it.
    const sentinel = calls.filter((c) => typeof c.args[1] === 'string' && (c.args[1] as string).includes('.filo/.dirty'));
    expect(sentinel.length).toBeGreaterThan(0);
    expect(sentinel.map((c) => c.channel).filter((ch) => ch !== 'vault:write-file-text')).toEqual([]);
  });
});
