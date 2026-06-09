import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markDirty,
  markClean,
  checkRecovery,
  __resetDirtyRecoveryDedupeForTests,
  __getLaunchIdForTests,
} from '@renderer/lib/vault/dirtyFlagRecovery';
import {
  onError,
  __resetErrorBusForTests,
  type ReportedError,
} from '@renderer/lib/utils/errorBus';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

type IpcStub = {
  writes: Array<{ channel: string; args: unknown[] }>;
  responses: Map<string, unknown>;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

function installIpcStub(): IpcStub {
  const stub: IpcStub = {
    writes: [],
    responses: new Map(),
    invoke: async (channel, ...args) => {
      stub.writes.push({ channel, args });
      if (stub.responses.has(channel)) return stub.responses.get(channel);
      return { success: true };
    },
  };
  // Catchall delegates to stub.invoke by reference, so reassigning stub.invoke
  // mid-test is picked up automatically — no reinstall needed.
  installFiloMock((channel: string, ...args: unknown[]) => stub.invoke(channel, ...args));
  return stub;
}

describe('dirtyFlagRecovery', () => {
  beforeEach(() => {
    installIpcStub();
    // Audit-8 L3 — the per-session unreadable-sentinel dedupe is module state;
    // reset it so each test starts fresh (and the per-test toast-count
    // assertions below stay accurate).
    __resetDirtyRecoveryDedupeForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
  });

  it('markDirty writes a JSON sentinel to .filo/.dirty', async () => {
    const stub = installIpcStub();
    await markDirty('/vault');
    const write = stub.writes.find((w) => w.channel === 'vault:write-file-text');
    expect(write).toBeDefined();
    expect(write?.args[0]).toBe('/vault');
    expect(write?.args[1]).toBe('.filo/.dirty');
    const body = JSON.parse(write?.args[2] as string);
    expect(typeof body.dirtyAt).toBe('number');
  });

  it('markDirty with empty vaultRoot is a no-op', async () => {
    const stub = installIpcStub();
    await markDirty('');
    expect(stub.writes).toHaveLength(0);
  });

  it('markClean deletes the sentinel at the absolute sentinel path', async () => {
    const stub = installIpcStub();
    await markClean('/vault');
    const del = stub.writes.find((w) => w.channel === 'vault:delete');
    expect(del).toBeDefined();
    // Phase 25 L6 — vault:delete now takes (vaultRoot, itemPath).
    expect(del?.args[0]).toBe('/vault');
    expect(del?.args[1]).toBe('/vault/.filo/.dirty');
  });

  it('markClean swallows ENOENT errors (sentinel may not exist)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:delete', undefined);
    stub.invoke = async (channel, ..._args) => {
      stub.writes.push({ channel, args: _args });
      // Phase 31 A1.6 — use the real Node ENOENT shape so the `.code === 'ENOENT'`
      // swallow branch in markClean matches; otherwise the error path surfaces
      // via reportError (which is correct production behaviour for non-ENOENT).
      const err = new Error('ENOENT: no such file');
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    };
    await expect(markClean('/vault')).resolves.toBeUndefined();
  });

  it('checkRecovery returns needsRecovery=true when sentinel exists', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({ dirtyAt: 1700000000000 }),
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.dirtyAt).toBe(1700000000000);
  });

  it('checkRecovery returns needsRecovery=false when sentinel read returns ENOENT', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: false, code: 'ENOENT' });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it('checkRecovery flags sentinel-unreadable on non-ENOENT read failure and surfaces a toast', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: false,
      code: 'EACCES',
      error: 'permission denied',
    });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    const status = await checkRecovery('/vault');

    expect(status.needsRecovery).toBe(true);
    expect(status.reason).toBe('sentinel-unreadable');
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.check');
  });

  it('checkRecovery returns needsRecovery=false on a missing-code success:false (back-compat)', async () => {
    // Older IPC mocks emit { success: false } without a `code` field. Treat
    // those as unreadable rather than ENOENT — the spec is "only ENOENT is
    // the clean signal" and the absence of a code is itself ambiguous.
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: false });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.reason).toBe('sentinel-unreadable');
  });

  it('checkRecovery tolerates malformed sentinel JSON (still flags recovery)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: 'not-json',
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.dirtyAt).toBeUndefined();
  });

  it('checkRecovery flags sentinel-unreadable when invoke throws', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.invoke = async () => {
      throw new Error('boom');
    };
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    const status = await checkRecovery('/vault');

    expect(status.needsRecovery).toBe(true);
    expect(status.reason).toBe('sentinel-unreadable');
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.check');
  });

  // Audit-14 1.3 — a per-launch session id distinguishes a sentinel THIS
  // process wrote (e.g. a migration-repair write during open) from a genuine
  // prior-crash breadcrumb, so a legacy-vault open doesn't surface a spurious
  // Recovery modal.
  it('markDirty stamps the current launchId (1.3)', async () => {
    const stub = installIpcStub();
    await markDirty('/vault', ['x.md']);
    const write = stub.writes.find((w) => w.channel === 'vault:write-file-text');
    const body = JSON.parse(write?.args[2] as string);
    expect(body.launchId).toBe(__getLaunchIdForTests());
  });

  it('checkRecovery SUPPRESSES a sentinel stamped by the current launch (1.3)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({
        dirtyAt: 1700000000000,
        launchId: __getLaunchIdForTests(),
        pendingPaths: ['boards/just-repaired.board.json'],
      }),
    });
    const status = await checkRecovery('/vault');
    // This launch wrote it — not a prior crash, so no recovery prompt.
    expect(status.needsRecovery).toBe(false);
  });

  it('checkRecovery STILL prompts for a sentinel from a prior launch (1.3)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({
        dirtyAt: 1700000000000,
        launchId: 'a-different-prior-session-id',
        pendingPaths: ['Notes.md'],
      }),
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toEqual(['Notes.md']);
  });

  it('checkRecovery prompts for a legacy sentinel with no launchId (1.3 back-compat)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({ dirtyAt: 1700000000000, pendingPaths: ['Old.md'] }),
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toEqual(['Old.md']);
  });

  it('markDirty persists pendingPaths when provided', async () => {
    const stub = installIpcStub();
    await markDirty('/vault', ['boards/a.board.json', 'boards/b.board.json']);
    const write = stub.writes.find((w) => w.channel === 'vault:write-file-text');
    expect(write).toBeDefined();
    const body = JSON.parse(write?.args[2] as string);
    expect(body.pendingPaths).toEqual([
      'boards/a.board.json',
      'boards/b.board.json',
    ]);
  });

  it('markDirty omits pendingPaths when the list is empty or absent', async () => {
    const stub = installIpcStub();
    await markDirty('/vault');
    await markDirty('/vault', []);
    for (const w of stub.writes) {
      if (w.channel !== 'vault:write-file-text') continue;
      const body = JSON.parse(w.args[2] as string);
      expect(body.pendingPaths).toBeUndefined();
    }
  });

  it('checkRecovery surfaces pendingPaths from the sentinel', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({
        dirtyAt: 1700000000000,
        pendingPaths: ['Notes.md', 'boards/plan.board.json'],
      }),
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toEqual(['Notes.md', 'boards/plan.board.json']);
  });

  it('checkRecovery omits pendingPaths when the sentinel has none', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({ dirtyAt: 1700000000000 }),
    });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.pendingPaths).toBeUndefined();
  });

  it('checkRecovery drops non-string entries from pendingPaths', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: true,
      content: JSON.stringify({
        dirtyAt: 1700000000000,
        pendingPaths: ['a.md', 42, null, 'b.md'],
      }),
    });
    const status = await checkRecovery('/vault');
    expect(status.pendingPaths).toEqual(['a.md', 'b.md']);
  });

  it('markDirty surfaces sentinel-write failures via errorBus (silent failure would mask a crash)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.invoke = async (channel, ..._args) => {
      stub.writes.push({ channel, args: _args });
      throw new Error('EACCES');
    };
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await markDirty('/vault');

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.mark');
  });

  it('markDirty surfaces envelope-failure ({ok:false}) via errorBus (A1.6)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:write-file-text', { ok: false, code: 'EACCES', error: 'denied' });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await markDirty('/vault');

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.mark');
  });

  it('markClean surfaces non-ENOENT envelope-failure via errorBus (A1.6)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:delete', { ok: false, code: 'EACCES', error: 'denied' });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await markClean('/vault');

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.clean');
  });

  it('markClean swallows envelope-ENOENT silently (sentinel already gone)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:delete', { ok: false, code: 'ENOENT' });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await markClean('/vault');

    expect(errors).toHaveLength(0);
  });

  it('checkRecovery fires recovery:snapshot on EACCES so the prior sentinel bytes survive the new session (A2.4)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: false,
      code: 'EACCES',
      error: 'permission denied',
    });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await checkRecovery('/vault');
    // Allow the fire-and-forget `recovery:snapshot` to settle.
    await new Promise((r) => setTimeout(r, 0));

    const snap = stub.writes.find((w) => w.channel === 'recovery:snapshot');
    expect(snap).toBeDefined();
    expect(snap?.args[0]).toBe('/vault');
    expect(snap?.args[1]).toBe('.filo/.dirty');
    // The errorBus toast still fires so the user knows manual recovery may be needed.
    expect(errors).toHaveLength(1);
  });

  // 6.4.M5 — a zero-byte `.filo/.dirty` is evidence of a crash mid-flush
  // (markDirty created the file but the JSON payload write didn't land).
  // The legacy code treated zero-byte as "cleanly absent", silently hiding
  // the crash from the user. Treat it as dirty with the sentinel-unreadable
  // reason flag so the recovery UI surfaces the same "investigate manually"
  // copy it shows for an EACCES read.
  //
  // Audit-7 M4 — the `sentinel-unreadable` reason is gated OUT of the
  // recovery modal, so the zero-byte case must surface a toast (via
  // reportError) like the EACCES branch — otherwise the strongest
  // mid-write-crash signal reaches neither the modal nor any notification.
  it('checkRecovery treats zero-byte .filo/.dirty as dirty AND surfaces a toast (M5/M4)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: true, content: '' });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    const status = await checkRecovery('/vault');

    expect(status.needsRecovery).toBe(true);
    expect(status.reason).toBe('sentinel-unreadable');
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('dirtyFlag.check');
  });

  it('checkRecovery does NOT fire recovery:snapshot on ENOENT (clean steady state)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: false, code: 'ENOENT' });
    await checkRecovery('/vault');
    await new Promise((r) => setTimeout(r, 0));
    const snap = stub.writes.find((w) => w.channel === 'recovery:snapshot');
    expect(snap).toBeUndefined();
  });

  // Audit-8 L3 — a read-only/locked share can't read OR clear the sentinel, so
  // the unreadable-sentinel toast must surface ONCE per vault per session, not
  // on every open. The status itself is unchanged on every call (still flags
  // recovery); only the repeat toast + snapshot are suppressed.
  it('checkRecovery surfaces the unreadable-sentinel toast once per vault per session', async () => {
    __resetErrorBusForTests();
    __resetDirtyRecoveryDedupeForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', {
      success: false,
      code: 'EACCES',
      error: 'permission denied',
    });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    const first = await checkRecovery('/vault');
    const second = await checkRecovery('/vault');
    await new Promise((r) => setTimeout(r, 0));

    // Both opens still report the same unreadable status…
    expect(first.reason).toBe('sentinel-unreadable');
    expect(second.reason).toBe('sentinel-unreadable');
    // …but the toast + snapshot fire only on the first open this session.
    expect(errors).toHaveLength(1);
    expect(
      stub.writes.filter((w) => w.channel === 'recovery:snapshot'),
    ).toHaveLength(1);
  });

  it('checkRecovery still surfaces independently for a different vault root', async () => {
    __resetErrorBusForTests();
    __resetDirtyRecoveryDedupeForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: false, code: 'EACCES' });
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    await checkRecovery('/vaultA');
    await checkRecovery('/vaultA'); // suppressed (same vault)
    await checkRecovery('/vaultB'); // distinct vault → surfaces again
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(2);
    expect(
      stub.writes.filter((w) => w.channel === 'recovery:snapshot'),
    ).toHaveLength(2);
  });
});
