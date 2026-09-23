import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  markDirty,
  markClean,
  checkRecovery,
  flushDirtyFlagSentinel,
  __resetRecoveryStashForTests,
  __resetDirtyRecoveryDedupeForTests,
} from '@renderer/lib/vault/dirtyFlagRecovery';
import { __setMachineIdentityForTests } from '@renderer/lib/vault/machineIdentity';
import { __resetLegacySentinelFlagsForTests } from '@renderer/lib/vault/machineSentinels';
import { readPendingRewrite } from '@renderer/lib/vault/tagRewriteSentinel';
import { surveyForeignSentinels, foreignSentinelsStore } from '@renderer/stores/foreignSentinels.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { beginVaultGeneration, captureVaultIdentity } from '@renderer/lib/vault/vaultIdentity';
import { TEST_MACHINE_IDENTITY } from '../helpers/testMachine';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 EXT-6 (plan D5) — `.filo/` syncs to every machine, and with ONE
 * shared `.filo/.dirty` machine B's clean shutdown deleted machine A's crash
 * breadcrumb (A then never showed its recovery prompt) and B prompted for A's
 * unflushed files, whose data only exists on A. Sentinels are now per machine.
 */

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

/** A synced `.filo/` shared by both machines: rel path → content. */
function installSharedFilo(files: Map<string, string>, calls: Array<{ channel: string; rel: string }>): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    const raw = String(args[1] ?? '');
    const rel = raw.replace(/^\/vault\//, '');
    calls.push({ channel, rel });
    if (channel === 'vault:write-file-text') {
      files.set(rel, String(args[2]));
      return { success: true };
    }
    if (channel === 'vault:read-file-text') {
      const c = files.get(rel);
      return c === undefined ? { success: false, code: 'ENOENT' } : { success: true, content: c };
    }
    if (channel === 'vault:delete') {
      return files.delete(rel) ? { success: true } : { success: false, code: 'ENOENT' };
    }
    if (channel === 'recovery:list-sentinels') {
      return {
        success: true,
        entries: [...files.keys()]
          .filter((k) => k.startsWith('.filo/'))
          .map((k) => {
            const m = /\.([0-9a-f]{12})(?:\.json)?$/.exec(k);
            const kind = k.includes('.dirty') ? 'dirty' : k.includes('tag-rewrite') ? 'tag-rewrite' : k.includes('rename-cascade') ? 'rename-cascade' : 'quit-failure';
            return { kind, machineId: m ? m[1] : null, hostname: m?.[1] === A ? 'LAPTOP-A' : undefined, relPath: k, mtimeMs: 0 };
          }),
      };
    }
    return { success: true };
  });
}

describe('per-machine crash sentinels (Audit-19 EXT-6)', () => {
  let files: Map<string, string>;
  let calls: Array<{ channel: string; rel: string }>;

  beforeEach(() => {
    files = new Map();
    calls = [];
    __resetRecoveryStashForTests();
    __resetDirtyRecoveryDedupeForTests();
    __resetLegacySentinelFlagsForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    installSharedFilo(files, calls);
  });
  afterEach(() => {
    __setMachineIdentityForTests(TEST_MACHINE_IDENTITY);
    restoreFiloDefault();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  it("machine B's clean shutdown never deletes machine A's crash sentinel (bite)", async () => {
    __setMachineIdentityForTests({ machineId: A, hostname: 'LAPTOP-A' });
    await markDirty('/vault', ['Notes.md']);
    await flushDirtyFlagSentinel();
    expect(files.has(`.filo/.dirty.${A}`)).toBe(true);

    __setMachineIdentityForTests({ machineId: B, hostname: 'DESK-B' });
    await markClean('/vault');
    await flushDirtyFlagSentinel();

    expect(files.has(`.filo/.dirty.${A}`)).toBe(true); // A's breadcrumb survives
    expect(calls.filter((c) => c.channel === 'vault:delete').map((c) => c.rel)).toEqual([`.filo/.dirty.${B}`]);
  });

  it("machine B does NOT prompt for machine A's unflushed files (their data is on A)", async () => {
    files.set(`.filo/.dirty.${A}`, JSON.stringify({ dirtyAt: 1, pendingPaths: ['Notes.md'], launchId: 'x' }));
    __setMachineIdentityForTests({ machineId: B, hostname: 'DESK-B' });
    expect((await checkRecovery('/vault')).needsRecovery).toBe(false);
  });

  it('a LEGACY shared sentinel prompts once, then is consumed by the next markClean', async () => {
    files.set('.filo/.dirty', JSON.stringify({ dirtyAt: 1, pendingPaths: ['Old.md'], launchId: 'old-build' }));
    const first = await checkRecovery('/vault');
    expect(first.needsRecovery).toBe(true);
    expect(first.pendingPaths).toEqual(['Old.md']);
    await markClean('/vault'); // the user's Dismiss
    await flushDirtyFlagSentinel();
    expect(files.has('.filo/.dirty')).toBe(false);
    expect((await checkRecovery('/vault')).needsRecovery).toBe(false);
  });

  it('new code never writes a legacy name', async () => {
    await markDirty('/vault', ['A.md']);
    await flushDirtyFlagSentinel();
    const writes = calls.filter((c) => c.channel === 'vault:write-file-text').map((c) => c.rel);
    expect(writes).toEqual([`.filo/.dirty.${TEST_MACHINE_IDENTITY.machineId}`]);
  });

  it("a foreign tag-rewrite is never resumed; one info toast when it is over an hour old", async () => {
    files.set(`.filo/tag-rewrite-pending.${A}.json`, JSON.stringify({ timestamp: 1, oldName: 'a', newName: 'b', plan: ['x.md'] }));
    expect((await readPendingRewrite('/vault')).payload).toBeUndefined(); // not this machine's

    beginVaultGeneration('/vault');
    await surveyForeignSentinels('/vault', captureVaultIdentity(), 2 * 60 * 60 * 1000);
    await surveyForeignSentinels('/vault', captureVaultIdentity(), 2 * 60 * 60 * 1000);
    const toasts = uiStore.toasts.filter((t) => t.text.includes('LAPTOP-A'));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.text).toMatch(/won't resume another machine's operation/);
    expect(foreignSentinelsStore.list.map((s) => s.machineId)).toEqual([A]);
  });
});
