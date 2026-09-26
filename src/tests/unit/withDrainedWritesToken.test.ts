/**
 * `withDrainedWrites` nesting is explicit: an op receives a `DrainToken`, and
 * only a call that passes it on (`{ within: token }`) runs inside that op's
 * drain. Any other call made while a drained op runs waits for that op to
 * finish, then runs its own drain, so it never runs undrained alongside a
 * long op (the tag sweep's loop, a delete cascade).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  withDrainedWrites,
  trashVaultPath,
  __resetDrainGuardForTests,
  type DrainToken,
} from '@renderer/lib/vault/vaultOperations';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

let events: string[] = [];

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!check()) throw new Error('not yet'); });
}

beforeEach(() => {
  __resetVaultIdentityForTests();
  __resetDrainGuardForTests();
  restoreFiloDefault();
  beginVaultGeneration('/vault');
  events = [];
  // Each drain shows up as one board flush.
  vi.spyOn(boardCacheStore, 'flushAllDirty').mockImplementation(async () => {
    events.push('drain');
    return { failed: [] };
  });
  vi.spyOn(noteStore, 'flushAll').mockResolvedValue({ failed: [], rawNotSaved: [] });
});

afterEach(() => {
  __resetDrainGuardForTests();
  __resetVaultIdentityForTests();
  restoreFiloDefault();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('withDrainedWrites — a call without the token waits for the running op', () => {
  it('a sibling arriving during a long op drains after that op finishes, then runs', async () => {
    const outerGate = gate();
    const outer = withDrainedWrites(async () => {
      events.push('outer:start');
      await outerGate.wait;
      events.push('outer:end');
    });
    await until(() => events.includes('outer:start'));

    const sibling = withDrainedWrites(async () => {
      events.push('sibling');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).not.toContain('sibling');

    outerGate.open();
    await Promise.all([outer, sibling]);
    expect(events).toEqual(['drain', 'outer:start', 'outer:end', 'drain', 'sibling']);
  });

  it('a sibling queued behind an op is refused when the vault changed meanwhile', async () => {
    const outerGate = gate();
    const outer = withDrainedWrites(async () => {
      events.push('outer:start');
      await outerGate.wait;
    });
    await until(() => events.includes('outer:start'));
    const siblingOp = vi.fn(async () => 'sibling');
    const sibling = withDrainedWrites(siblingOp);

    beginVaultGeneration('/other-vault');
    outerGate.open();
    const [outerRes, siblingRes] = await Promise.allSettled([outer, sibling]);

    expect(outerRes.status).toBe('fulfilled');
    expect(siblingRes.status).toBe('rejected');
    expect(siblingOp).not.toHaveBeenCalled();
  });

  it('a call for a newly opened vault does not wait for the previous vault\'s op', async () => {
    const outerGate = gate();
    const outer = withDrainedWrites(async () => {
      events.push('outer:start');
      await outerGate.wait;
    });
    await until(() => events.includes('outer:start'));

    beginVaultGeneration('/other-vault');
    await withDrainedWrites(async () => { events.push('new-vault op'); });
    expect(events).toEqual(['drain', 'outer:start', 'drain', 'new-vault op']);

    outerGate.open();
    await outer;
  });
});

describe('withDrainedWrites — a nested call with the token', () => {
  it('runs at once, inside the outer drain, with no second drain', async () => {
    await withDrainedWrites(async (drain) => {
      events.push('outer');
      await withDrainedWrites(async () => { events.push('inner'); }, { within: drain });
      events.push('outer:after');
    });
    expect(events).toEqual(['drain', 'outer', 'inner', 'outer:after']);
  });

  it('the IPC helpers take the token too', async () => {
    installFiloMock({
      'vault:trash-move': async () => {
        events.push('trash-move');
        return { success: true, trashId: 't1', kind: 'file' };
      },
    });
    await withDrainedWrites(async (drain) => {
      const result = await trashVaultPath('/vault', 'Notes.md', drain);
      expect(result.success).toBe(true);
    });
    expect(events).toEqual(['drain', 'trash-move']);
  });

  it('a token whose op has finished is ignored: the call runs its own drain', async () => {
    let kept: DrainToken | undefined;
    await withDrainedWrites(async (drain) => { kept = drain; });
    await withDrainedWrites(async () => { events.push('later'); }, { within: kept });
    expect(events).toEqual(['drain', 'drain', 'later']);
  });

  it('the running op is released only once a nested call it started has settled', async () => {
    const innerGate = gate();
    let inner: Promise<void> | undefined;
    const outer = withDrainedWrites(async (drain) => {
      // Started but not awaited: the op returns while it is still running.
      inner = withDrainedWrites(async () => {
        events.push('inner:start');
        await innerGate.wait;
        events.push('inner:end');
      }, { within: drain });
    });
    await until(() => events.includes('inner:start'));
    const sibling = withDrainedWrites(async () => { events.push('sibling'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).not.toContain('sibling');

    innerGate.open();
    await Promise.all([outer, inner, sibling]);
    expect(events).toEqual(['drain', 'inner:start', 'inner:end', 'drain', 'sibling']);
  });
});

describe('withDrainedWrites — dev watchdog', () => {
  it('warns when a queued call has waited more than 30 s (a missing token deadlocks)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outerGate = gate();
    const outer = withDrainedWrites(async () => {
      events.push('outer:start');
      await outerGate.wait;
    });
    for (let i = 0; i < 20 && !events.includes('outer:start'); i++) await Promise.resolve();
    expect(events).toContain('outer:start');
    const sibling = withDrainedWrites(async () => undefined);

    vi.advanceTimersByTime(29_000);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/30 s/);

    vi.useRealTimers();
    outerGate.open();
    await Promise.all([outer, sibling]);
  });
});
