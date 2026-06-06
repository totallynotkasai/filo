import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { assertSafeFilename } from '../../main/utils/pathSecurity';
import { sanitizeFilename } from '../../main/vault/filenameUtils';
import { computeMoveIntoFolderTarget } from '@renderer/lib/vault/moveIntoFolder';

/**
 * Audit-9 Phase 5 — A9-V1 verification.
 *
 * The uncommitted Audit-8 L1 work widened the Windows reserved-name guard:
 *   - added the `$`-bearing device names CONIN$ / CONOUT$ / CLOCK$ to
 *     `RESERVED_WINDOWS_NAMES`;
 *   - trimmed the stem before the reserved-name compare, because Windows
 *     strips leading/trailing spaces off the name component (` CON.md` /
 *     `CON .md` still open the CON device).
 *
 * A9-V1 asks: do these additions reject a PRE-EXISTING legitimate vault file on
 * rename/move? They must NOT — they may only block creating *new* unsafe names.
 *
 * The move path is the sharp edge. `vaultStore.moveIntoFolder` PRESERVES the
 * source filename (`computeMoveIntoFolderTarget`), then routes through
 * `vault:rename`, whose only name guard is
 * `assertSafeFilename(basename(newPath), { forCreation: true })`
 * ([vault.ipc.ts](src/main/ipc/vault.ipc.ts)) — the STRICTEST form, enforced on
 * every platform. So a false positive in the widened guard would reject a benign
 * pre-existing file the moment the user drags it into a folder. (An in-place
 * rename validates only the NEW basename; the OLD name is intentionally not
 * re-validated — that invariant is pinned by the POSIX platform-gating tests in
 * `pathSecurity.test.ts`.)
 *
 * This file enumerates benign files whose stems sit NEXT TO a reserved name (or
 * exercise the stem-trim / `$`-device additions) and asserts the widened guard
 * leaves them alone, with negative controls proving the boundary still bites the
 * real device names.
 */

// Benign — stems near a device name, or exercising the trim / `$` additions,
// but NOT actual Windows devices. Each must clear `{ forCreation: true }`.
const BENIGN_NEAR_MISS: readonly string[] = [
  'money$.md', // stem MONEY$ — `$` is legal; not a device stem
  'cache$.json', // stem CACHE$
  'CONIN.md', // no `$` → not CONIN$
  'CONOUT.md', // no `$` → not CONOUT$
  'CONINNER$.md', // superstring of CONIN$
  'CLOCK.md', // no `$` → not CLOCK$
  'CLOCKS.md',
  'CLOCKWORK.md',
  'Clock Tower.md', // interior space survives the stem-trim → "CLOCK TOWER"
  'CLOCK $.md', // interior space → stem "CLOCK $" ≠ CLOCK$
  'Console.md', // merely contains CON
  'controller.md',
  'aux-data.json', // merely contains AUX
  'Report .md', // stem "Report " trims to REPORT — the trim fires, result benign
  'money$ backup.md', // stem trims to "MONEY$ BACKUP"
  'COM0.md', // only COM1..9 are reserved
  'COM10.md',
  'LPT0.md',
  'LPT10.md',
];

// Negative controls — the Audit-8 L1 additions that MUST still reject at
// creation, so the boundary is provably placed (not "everything passes").
const RESERVED_AT_CREATION: readonly { name: string; re: RegExp }[] = [
  { name: 'CONIN$.md', re: /CONIN\$/ },
  { name: 'CONOUT$.txt', re: /CONOUT\$/ },
  { name: 'CLOCK$.log', re: /CLOCK\$/ },
  { name: ' CON.md', re: /CON/ }, // leading space trimmed → CON
  { name: 'CON .md', re: /CON/ }, // trailing-in-stem space trimmed → CON
];

const FORCE = { forCreation: true } as const;

describe('A9-V1 — widened reserved-name guard does not over-reject benign names', () => {
  it('clears every benign near-miss name under the strictest (creation) guard', () => {
    for (const name of BENIGN_NEAR_MISS) {
      expect(() => assertSafeFilename(name, FORCE), name).not.toThrow();
    }
  });

  it('the move target (preserved source name) of each benign file also clears the guard', () => {
    // Models vaultStore.moveIntoFolder: the source name is preserved into the
    // destination folder, then vault:rename re-validates basename(newPath) with
    // `{ forCreation: true }`. A widened-guard false positive would surface here.
    for (const name of BENIGN_NEAR_MISS) {
      const target = computeMoveIntoFolderTarget(name, 'Archive');
      expect(target, name).toBe(`Archive/${name}`);
      expect(() => assertSafeFilename(basename(target as string), FORCE), name).not.toThrow();
    }
  });

  it('still rejects the genuine device names at creation (boundary control)', () => {
    for (const { name, re } of RESERVED_AT_CREATION) {
      expect(() => assertSafeFilename(name, FORCE), name).toThrow(re);
    }
  });
});

describe('A9-V1 — sanitizeFilename handles the new `$` device names', () => {
  it('prefixes CONIN$ / CONOUT$ / CLOCK$ so the sanitised result clears the guard', () => {
    expect(sanitizeFilename('CONIN$')).toBe('_CONIN$');
    expect(sanitizeFilename('CONOUT$.txt')).toBe('_CONOUT$.txt');
    expect(sanitizeFilename('clock$.md')).toBe('_clock$.md');
    // The sanitised output must itself clear the creation guard.
    expect(() => assertSafeFilename(sanitizeFilename('CLOCK$'), FORCE)).not.toThrow();
  });

  it('leaves a benign `$` name untouched', () => {
    expect(sanitizeFilename('money$.md')).toBe('money$.md');
    expect(sanitizeFilename('CONINNER$.md')).toBe('CONINNER$.md');
  });
});

// ── Integration: the real `vault:rename` handler moves a benign pre-existing
// file without rejection, and still blocks a device-name target. ─────────────
const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('A9-V1 — vault:rename moves a benign pre-existing file (real handler)', () => {
  let vaultDir: string;
  let renameHandler: (...args: unknown[]) => Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const h = handlers.get('vault:rename');
    if (!h) throw new Error('vault:rename handler not registered');
    renameHandler = h as (...args: unknown[]) => Promise<unknown>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-a9v1-rename-'));
    vaultRegistry.setCurrentVault(vaultDir);
    await fs.mkdir(join(vaultDir, 'Archive'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('moves money$.md (a `$`-stem file) into a subfolder', async () => {
    await fs.writeFile(join(vaultDir, 'money$.md'), '# budget\n');
    const result = (await renameHandler(
      {},
      vaultDir,
      join(vaultDir, 'money$.md'),
      join(vaultDir, 'Archive', 'money$.md'),
    )) as { success: boolean };
    expect(result).toEqual({ success: true });
    await expect(fs.access(join(vaultDir, 'Archive', 'money$.md'))).resolves.toBeUndefined();
  });

  it('moves "Clock Tower.md" (stem trims to CLOCK TOWER, not CLOCK$) into a subfolder', async () => {
    await fs.writeFile(join(vaultDir, 'Clock Tower.md'), '# notes\n');
    const result = (await renameHandler(
      {},
      vaultDir,
      join(vaultDir, 'Clock Tower.md'),
      join(vaultDir, 'Archive', 'Clock Tower.md'),
    )) as { success: boolean };
    expect(result).toEqual({ success: true });
    await expect(
      fs.access(join(vaultDir, 'Archive', 'Clock Tower.md')),
    ).resolves.toBeUndefined();
  });

  it('still rejects a rename whose TARGET is a genuine device name (boundary control)', async () => {
    await fs.writeFile(join(vaultDir, 'notes.md'), '# x\n');
    const result = (await renameHandler(
      {},
      vaultDir,
      join(vaultDir, 'notes.md'),
      join(vaultDir, 'CLOCK$.md'),
    )) as { success: boolean; code?: string; error?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_FILENAME');
    expect(result.error).toMatch(/CLOCK\$/);
    // The source is untouched — the rejection happens before any fs op.
    await expect(fs.access(join(vaultDir, 'notes.md'))).resolves.toBeUndefined();
  });
});
