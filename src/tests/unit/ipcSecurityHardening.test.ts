import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Security & IPC hardening.
 *
 *   - media:open-external runs the DNS-resolution SSRF check its sibling
 *     link:fetch-metadata enforces (a public hostname that RESOLVES to a
 *     private range is refused, not handed to the OS browser).
 *   - dialog:open-file is gated on an active vault (no vault → null, no
 *     approval minted), and every picked path is registered as an approved
 *     copy source BOUND to the active vault.
 *   - tags:load / tags:save resolve a typed `{ ok: false, code }` envelope on
 *     error instead of letting the rejection cross IPC as an opaque string.
 *   - the app-origin CSP drops the dev-only `ws://localhost:*` in packaged
 *     builds.
 *
 * The handlers are driven directly with mocked electron / dns primitives so we
 * can assert the dangerous path is refused. Bite-verify: revert the
 * open-external `else` DNS branch → the rebinding spec goes green-through
 * (failure); revert the dialog:open-file gate → the no-vault spec returns a
 * path; revert the tags try/catch → the envelope specs see a thrown rejection.
 */

const mockState = vi.hoisted(() => ({
  openExternalCalls: [] as string[],
  openPathCalls: [] as string[],
  showOpenDialog: { canceled: true, filePaths: [] as string[] },
  activeVault: null as string | null,
  dnsResult: [] as Array<{ address: string; family: number }>,
  dnsError: null as Error | null,
  handlers: new Map<string, (...a: unknown[]) => unknown | Promise<unknown>>(),
  onHandlers: new Map<string, (...a: unknown[]) => unknown | Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) => {
      mockState.handlers.set(ch, fn);
    },
    on: (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) => {
      mockState.onHandlers.set(ch, fn);
    },
    once: () => {},
    removeListener: () => {},
  },
  shell: {
    openExternal: async (u: string) => {
      mockState.openExternalCalls.push(u);
    },
    openPath: async (p: string) => {
      mockState.openPathCalls.push(p);
      return '';
    },
  },
  dialog: {
    showOpenDialog: async () => mockState.showOpenDialog,
    showMessageBox: async () => ({ response: 0 }),
  },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [] },
}));

vi.mock('dns', () => ({
  lookup: (
    _hostname: string,
    options: unknown,
    callback?: (e: Error | null, r?: unknown) => void,
  ) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      e: Error | null,
      r?: unknown,
    ) => void;
    if (mockState.dnsError) cb(mockState.dnsError);
    else cb(null, mockState.dnsResult);
  },
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => mockState.activeVault,
}));

const { registerMediaHandlers } = await import('../../main/ipc/media.ipc');
const { registerDialogHandlers } = await import('../../main/ipc/dialog.ipc');
const { registerTagsHandlers } = await import('../../main/ipc/tags.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { isApprovedCopySource, __resetApprovedSourcesForTests } = await import(
  '../../main/services/approvedSources'
);
const { buildAppContentSecurityPolicy } = await import('../../main/utils/contentSecurityPolicy');

type Handler = (...a: unknown[]) => unknown | Promise<unknown>;
function handler(channel: string): Handler {
  const h = mockState.handlers.get(channel);
  if (!h) throw new Error(`handler not registered: ${channel}`);
  return h;
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  registerMediaHandlers();
  registerDialogHandlers();
  registerTagsHandlers();
});

beforeEach(() => {
  mockState.openExternalCalls.length = 0;
  mockState.openPathCalls.length = 0;
  mockState.showOpenDialog = { canceled: true, filePaths: [] };
  mockState.activeVault = null;
  mockState.dnsResult = [];
  mockState.dnsError = null;
  vaultRegistry.setCurrentVault(null);
  __resetApprovedSourcesForTests();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vaultRegistry.setCurrentVault(null);
});

// ── media:open-external DNS-resolution SSRF check ───────────────────────────
describe('media:open-external DNS SSRF parity', () => {
  const callOpen = async (target: string) =>
    (await handler('media:open-external')({}, target)) as { success: boolean; error?: string };

  it('refuses a public hostname that RESOLVES to a private IP (DNS rebinding)', async () => {
    // Static isPrivateUrl can't catch this — the name looks public; only the
    // A-record resolution exposes the 10.x target.
    mockState.dnsResult = [{ address: '10.0.0.5', family: 4 }];
    const result = await callOpen('https://evil.example.com/path');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private/i);
    expect(mockState.openExternalCalls).toEqual([]);
  });

  it('refuses a public hostname resolving to the cloud-metadata IP (169.254.169.254)', async () => {
    mockState.dnsResult = [{ address: '169.254.169.254', family: 4 }];
    const result = await callOpen('https://metadata.attacker.test/');
    expect(result.success).toBe(false);
    expect(mockState.openExternalCalls).toEqual([]);
  });

  it('opens a public hostname that resolves to a public IP (no false block)', async () => {
    mockState.dnsResult = [{ address: '93.184.216.34', family: 4 }];
    const target = 'https://example.com/page';
    const result = await callOpen(target);
    expect(result.success).toBe(true);
    expect(mockState.openExternalCalls).toEqual([target]);
  });

  it('still routes mailto: without a DNS check (no hostname to resolve)', async () => {
    mockState.dnsResult = [{ address: '10.0.0.5', family: 4 }]; // would block if consulted
    const result = await callOpen('mailto:hi@example.com');
    expect(result.success).toBe(true);
    expect(mockState.openExternalCalls).toEqual(['mailto:hi@example.com']);
  });
});

// ── dialog:open-file active-vault gate + bound approval ──────────────────────
describe('dialog:open-file vault gate + approval binding', () => {
  const PICKED =
    process.platform === 'win32' ? 'D:\\Photos\\holiday.jpg' : '/mnt/usb/holiday.jpg';
  const VAULT = process.platform === 'win32' ? 'C:\\Users\\me\\Vault' : '/home/me/Vault';

  const callPick = async () => (await handler('dialog:open-file')({}, undefined)) as string[] | null;

  it('returns null and mints no approval when no vault is open', async () => {
    mockState.showOpenDialog = { canceled: false, filePaths: [PICKED] };
    // vaultRegistry is null (beforeEach) — the gate fails closed.
    const result = await callPick();
    expect(result).toBeNull();
    // Nothing was registered, so the path is not an approved source for any vault.
    vaultRegistry.setCurrentVault(VAULT);
    expect(isApprovedCopySource(VAULT, PICKED)).toBe(false);
  });

  it('registers the picked path as an approved source bound to the active vault', async () => {
    vaultRegistry.setCurrentVault(VAULT);
    mockState.showOpenDialog = { canceled: false, filePaths: [PICKED] };
    const result = await callPick();
    expect(result).toEqual([PICKED]);
    expect(isApprovedCopySource(VAULT, PICKED)).toBe(true);
  });

  it('a path picked under vault A is NOT approved after swapping to vault B', async () => {
    const VAULT_A = process.platform === 'win32' ? 'C:\\Users\\me\\A' : '/home/me/A';
    const VAULT_B = process.platform === 'win32' ? 'C:\\Users\\me\\B' : '/home/me/B';
    vaultRegistry.setCurrentVault(VAULT_A);
    mockState.showOpenDialog = { canceled: false, filePaths: [PICKED] };
    await callPick();
    expect(isApprovedCopySource(VAULT_A, PICKED)).toBe(true);

    // Swap to vault B WITHOUT clearing the registry — the per-source binding
    // alone must reject the cross-vault reuse (clearApprovedSources is a
    // separate defence-in-depth layer, not relied on here).
    vaultRegistry.setCurrentVault(VAULT_B);
    expect(isApprovedCopySource(VAULT_B, PICKED)).toBe(false);
  });
});

// ── tags:load / tags:save envelope on error ─────────────────────────────────
describe('tags channels return an envelope on error', () => {
  it('tags:save returns { ok:false, code:NO_ACTIVE_VAULT } with no vault open (no throw)', async () => {
    // No active vault → assertActiveVault throws → wrapped in the envelope.
    const result = (await handler('tags:save')({}, '/some/vault', '{"v":1}')) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: 'NO_ACTIVE_VAULT' });
  });

  it('tags:load returns { ok:false, code:NO_ACTIVE_VAULT } with no vault open (no throw)', async () => {
    const result = (await handler('tags:load')({}, '/some/vault')) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: 'NO_ACTIVE_VAULT' });
  });

  it('tags:save rejects a vaultRoot that does not match the active vault', async () => {
    vaultRegistry.setCurrentVault(
      process.platform === 'win32' ? 'C:\\Users\\me\\Vault' : '/home/me/Vault',
    );
    const result = (await handler('tags:save')({}, '/some/OTHER/vault', '{"v":1}')) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: 'NO_ACTIVE_VAULT' });
  });
});

// ── packaged CSP drops ws://localhost:* ─────────────────────────────────────
describe('app CSP omits ws://localhost in packaged builds', () => {
  it('dev build keeps the Vite HMR websocket in connect-src', () => {
    const csp = buildAppContentSecurityPolicy(false);
    expect(csp).toContain("connect-src 'self' ws://localhost:*");
  });

  it('packaged build drops ws:// from connect-src entirely', () => {
    const csp = buildAppContentSecurityPolicy(true);
    expect(csp).not.toContain('ws://');
    expect(csp).toContain("connect-src 'self';");
  });

  it('both builds keep the rest of the policy identical', () => {
    const dev = buildAppContentSecurityPolicy(false);
    const prod = buildAppContentSecurityPolicy(true);
    // Only connect-src differs; the framing + script directives are stable.
    for (const csp of [dev, prod]) {
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain('frame-src https:');
    }
    expect(dev.replace(" ws://localhost:*", '')).toBe(prod);
  });
});
