import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markDirty,
  markClean,
  checkRecovery,
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
  it('checkRecovery treats zero-byte .filo/.dirty as dirty (M5)', async () => {
    const stub = installIpcStub();
    stub.responses.set('vault:read-file-text', { success: true, content: '' });
    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect(status.reason).toBe('sentinel-unreadable');
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
});
