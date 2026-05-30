/**
 * Per-channel payload validation (Phase 11.4 / P1-20).
 *
 * Pins the contract enforced by `validateIpcPayload`: every renderer→main
 * channel has an explicit schema, the schema rejects shape-mismatched args
 * before they reach `ipcRenderer.invoke`, and channels without an explicit
 * entry fall through as `ok` rather than crash.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  IPC_PAYLOAD_SCHEMAS,
  validateIpcPayload,
} from '../../shared/ipcSchemas';

const IPC_DIR = resolve(__dirname, '../../main/ipc');

function listRegisteredChannels(): string[] {
  const re = /ipcMain\.(?:handle|on|once)\(\s*(['"])([^'"]+)\1/g;
  const channels = new Set<string>();
  for (const name of readdirSync(IPC_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(join(IPC_DIR, name), 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      channels.add(match[2]);
    }
  }
  return [...channels].sort();
}

describe('validateIpcPayload — schema coverage', () => {
  it('has a schema for every renderer→main channel registered in main/ipc', () => {
    const registered = listRegisteredChannels();
    const schemaKeys = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS));
    const missing = registered.filter((c) => !schemaKeys.has(c));
    expect(
      missing,
      `Channels registered in main/ipc but missing from IPC_PAYLOAD_SCHEMAS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('falls through cleanly for an unknown channel (no schema means no opinion)', () => {
    expect(validateIpcPayload('not-a-real-channel', [])).toEqual({ ok: true });
  });
});

describe('validateIpcPayload — happy paths accept correctly-shaped args', () => {
  it('accepts vault:read-tree with a single string vault path', () => {
    expect(validateIpcPayload('vault:read-tree', ['/vault'])).toEqual({ ok: true });
  });

  it('accepts vault:write-file-text with (vault, relPath, content)', () => {
    expect(
      validateIpcPayload('vault:write-file-text', ['/vault', 'Notes.md', 'hello']),
    ).toEqual({ ok: true });
  });

  it('accepts vault:copy-file with 2 args (omitted destFolder)', () => {
    expect(
      validateIpcPayload('vault:copy-file', ['C:/source.png', '/vault']),
    ).toEqual({ ok: true });
  });

  it('accepts vault:copy-file with 3 args (explicit destFolder)', () => {
    expect(
      validateIpcPayload('vault:copy-file', [
        'C:/source.png',
        '/vault',
        'attachments',
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects vault:copy-file with extra trailing args (Phase 3 / 3.6)', () => {
    // Pre-3.6, `.rest(optionalString)` allowed any number of trailing
    // strings to slip through validation. The explicit 2-or-3-tuple
    // union models the two real call shapes and rejects anything else.
    const result = validateIpcPayload('vault:copy-file', [
      'C:/source.png',
      '/vault',
      'attachments',
      'unexpected-extra',
    ]);
    expect(result.ok).toBe(false);
  });

  it('accepts no-arg channels (vault:select, vault:list-recents, font:list-system)', () => {
    expect(validateIpcPayload('vault:select', [])).toEqual({ ok: true });
    expect(validateIpcPayload('vault:list-recents', [])).toEqual({ ok: true });
    expect(validateIpcPayload('font:list-system', [])).toEqual({ ok: true });
  });

  it('accepts media:read-file with (vaultRoot, relativePath) — Phase 21 M2', () => {
    expect(
      validateIpcPayload('media:read-file', ['/vault', 'attachments/cover.png']),
    ).toEqual({ ok: true });
  });
});

describe('validateIpcPayload — rejects malformed payloads', () => {
  it('rejects vault:write-file-text when content is an object', () => {
    const r = validateIpcPayload('vault:write-file-text', [
      '/vault',
      'Notes.md',
      { not: 'a string' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects vault:write-file-text when vault root is a number', () => {
    const r = validateIpcPayload('vault:write-file-text', [
      42,
      'Notes.md',
      'content',
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects vault:rename when called with one arg', () => {
    const r = validateIpcPayload('vault:rename', ['/vault/a']);
    expect(r.ok).toBe(false);
  });

  it('rejects board:save when relativePath is not a string', () => {
    const r = validateIpcPayload('board:save', ['/vault', null, {}]);
    expect(r.ok).toBe(false);
  });

  it('rejects shell:show-item-in-folder when path is an array', () => {
    const r = validateIpcPayload('shell:show-item-in-folder', [
      ['array', 'of', 'strings'],
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects no-arg channels invoked with extra args (vault:list-recents)', () => {
    const r = validateIpcPayload('vault:list-recents', ['stray-arg']);
    expect(r.ok).toBe(false);
  });

  it('rejects single-arg media:read-file invocations (Phase 21 M2)', () => {
    // Pre-M2 the channel accepted a single absolute-path string; the new
    // tuple is `[vaultRoot, relativePath]`. A bare one-arg call must fail.
    const r = validateIpcPayload('media:read-file', ['/vault/cover.png']);
    expect(r.ok).toBe(false);
  });
});
