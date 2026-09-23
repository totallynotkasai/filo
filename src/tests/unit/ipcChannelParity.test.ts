/**
 * Guards the contract that every channel registered by an `ipcMain.handle`
 * in `src/main/ipc/*.ipc.ts` is also declared in the `IpcChannel` union in
 * `src/shared/types.ts`.
 *
 * The renderer indexes `window.filo.invoke` by `IpcChannel`. A handler that
 * exists on the main side without a matching union literal silently loses
 * autocomplete and type-checking on the renderer side; the call still works
 * at runtime, so the drift is invisible until someone renames the channel
 * and the literal-typed call site is the only thing that should have
 * stopped them.
 *
 * Pure static scan — no IPC bus is wired up here. Reads files from disk,
 * pulls the regex matches, diffs the sets. No app code is imported.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const IPC_DIR = resolve(__dirname, '../../main/ipc');
const SHARED_TYPES = resolve(__dirname, '../../shared/types.ts');

function readIpcFiles(): { file: string; source: string }[] {
  return readdirSync(IPC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      source: readFileSync(join(IPC_DIR, name), 'utf-8'),
    }));
}

function extractRegisteredChannels(source: string): string[] {
  // Matches `ipcMain.handle('channel-name'` — single- or double-quoted.
  const re = /ipcMain\.handle\(\s*(['"])([^'"]+)\1/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push(match[2]);
  }
  return out;
}

function extractUnionMembers(typesSource: string): string[] {
  // Find the `type IpcChannel = ` block and harvest every quoted literal
  // inside it. We stop scanning at the first `;` that terminates the type.
  const startIdx = typesSource.indexOf('type IpcChannel');
  if (startIdx === -1) {
    throw new Error('Could not find `type IpcChannel` in shared/types.ts');
  }
  const endIdx = typesSource.indexOf(';', startIdx);
  if (endIdx === -1) {
    throw new Error('Could not find terminator for IpcChannel union');
  }
  const block = typesSource.slice(startIdx, endIdx);
  const re = /['"]([^'"]+)['"]/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    out.push(match[1]);
  }
  return out;
}

describe('IPC channel parity', () => {
  const ipcFiles = readIpcFiles();
  const typesSource = readFileSync(SHARED_TYPES, 'utf-8');
  const unionMembers = new Set(extractUnionMembers(typesSource));

  const registered = new Set<string>();
  for (const { source } of ipcFiles) {
    for (const channel of extractRegisteredChannels(source)) {
      registered.add(channel);
    }
  }

  it('finds at least the core vault handlers (sanity check)', () => {
    expect(registered.has('vault:read-file-text')).toBe(true);
    expect(registered.has('board:save')).toBe(true);
    expect(unionMembers.has('vault:read-file-text')).toBe(true);
  });

  it('declares every registered handler in the IpcChannel union', () => {
    const missing = [...registered].filter((channel) => !unionMembers.has(channel));
    expect(missing, `Channels registered in main/ipc but missing from IpcChannel union: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not leave orphan literals in the IpcChannel union (handlers removed without union cleanup)', () => {
    // Some union members are main → renderer broadcasts (`webContents.send`)
    // or renderer → main one-way messages (`ipcMain.on`), not `handle` calls.
    // Allowlist those so the diff stays meaningful.
    const broadcastOnly = new Set<string>([
      'vault:files-changed',
      'vault:tree-updated',
      'vault:file-renamed',
      'vault:watcher-failed',
      // Phase 3 / 3.1 — supervisor state machine, see fileWatcher.ts.
      'vault:watcher-state',
      'vault:tree-too-large',
      'vault:sync-conflict', // Audit-19 ERR-3 / EXT-2
      'app:flush-and-quit',
      'app:ready-to-quit',
      // 6.2.H4 — renderer → main one-way cancel signal; main listens
      // via ipcMain.once inside the close/before-quit handlers.
      'app:cancel-quit',
      // Audit-4 DI-04 — renderer → main quit heartbeat; same ipcMain.once
      // registration in main.ts (not an ipcMain.handle in src/main/ipc).
      'app:quit-awaiting-user',
      // Audit5 2.1 — renderer → main periodic drain heartbeat; registered via
      // ipcMain.on in main.ts (not an ipcMain.handle in src/main/ipc).
      'app:drain-heartbeat',
      // Audit-12 S1 — preload-internal approved-source registration; registered
      // via ipcMain.on in dialog.ipc.ts (not an ipcMain.handle), fired by the
      // preload's getPathForFile through a direct ipcRenderer.send.
      'vault:register-source-path',
    ]);
    const orphans = [...unionMembers].filter(
      (channel) => !registered.has(channel) && !broadcastOnly.has(channel),
    );
    expect(orphans, `Channels in IpcChannel union with no matching ipcMain.handle (likely stale after handler removal): ${orphans.join(', ')}`).toEqual([]);
  });
});
