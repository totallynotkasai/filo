/**
 * Phase 7 — contract-level test for `assertIpcOk` envelope handling.
 *
 * For EVERY envelope-discriminated channel in `IpcChannelMap` (i.e. every
 * channel whose result type uses `IpcOk<…>` or `IpcSuccess<…>`), assert
 * that a `{ ok: false }` / `{ success: false }` stub return causes the
 * canonical caller path (`assertIpcOk`) to throw `IpcEnvelopeError`. The
 * test exercises both discriminators because the legacy `success`
 * channels predate the consolidation plan and `assertIpcOk` is tolerant
 * of either.
 *
 * Why this is necessary even with the static gate
 * (`scripts/check-ipc-envelope-usage.mjs`):
 *
 *   - The gate detects renderer callsites that ignore the envelope; it does
 *     NOT verify that `assertIpcOk` itself rejects the failure branch. If
 *     a future refactor accidentally widens `assertIpcOk` to silently
 *     return failure envelopes (e.g. losing the discriminant check), this
 *     test goes red across every channel — the failure mode is visible
 *     instead of becoming a generative new bug class.
 *
 *   - The gate's `ENVELOPE_CHANNELS` allowlist drifts from `IpcChannelMap`
 *     if a new channel is added but the gate isn't updated. The parity
 *     assertion below reads the gate's allowlist from disk and asserts it
 *     matches this test's inventory — drift in either direction trips a
 *     test failure.
 *
 * Channels that throw on failure (rather than envelope) — currently only
 * `tags:save` — are NOT envelope channels and are not asserted here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertIpcOk, IpcEnvelopeError } from '@shared/ipcEnvelope';

const ROOT = join(__dirname, '..', '..', '..');
const GATE_SCRIPT_PATH = join(ROOT, 'scripts', 'check-ipc-envelope-usage.mjs');

// Hand-maintained inventory — mirrors the gate script's `ENVELOPE_CHANNELS`.
// The parity test below scrapes the gate's list and asserts it matches.
// If you add a new envelope channel, update BOTH lists.
const OK_DISCRIMINATED: readonly string[] = [
  'vault:read-tree',
  'vault:init-config',
  'board:save',
  'board:create',
  'board:delete',
  'recovery:snapshot',
  'config:save',
  'config:save-workspace',
  'theme:save',
  'theme:delete',
];

const SUCCESS_DISCRIMINATED: readonly string[] = [
  'vault:create-folder',
  'vault:suggest-folder-name',
  'vault:rename',
  'vault:delete',
  'vault:watch',
  'vault:reconcile',
  'vault:copy-file',
  'vault:read-file-text',
  'vault:write-file-text',
  'vault:write-existing-file-text',
  'vault:write-file-binary',
  'vault:stat',
  'vault:set-open-on-launch',
  'media:save-audio',
  'media:read-file',
  'media:open-external',
  'link:fetch-metadata',
  'export:save',
  'font:import',
  'templates:layout:write',
  'templates:layout:rename',
  'templates:layout:delete',
];

const ALL_ENVELOPE_CHANNELS: readonly string[] = [
  ...OK_DISCRIMINATED,
  ...SUCCESS_DISCRIMINATED,
];

function readGateAllowlist(): Set<string> {
  const text = readFileSync(GATE_SCRIPT_PATH, 'utf-8');
  // The gate declares `const ENVELOPE_CHANNELS = new Set([ ... ])`.
  // Extract everything inside the Set literal so we can compare against
  // this file's inventory. The brace-balanced approach is tolerant of
  // comments inside the Set body.
  const startIdx = text.indexOf('ENVELOPE_CHANNELS = new Set([');
  if (startIdx < 0) {
    throw new Error('Could not locate ENVELOPE_CHANNELS Set literal in gate script');
  }
  const openIdx = text.indexOf('[', startIdx);
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  const body = text.slice(openIdx + 1, i);
  const channels = new Set<string>();
  // Strip line-comments before extracting string literals so a commented-
  // out channel doesn't show up as a real entry.
  const code = body.replace(/\/\/[^\n]*/g, '');
  const channelRe = /'([^']+)'|"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = channelRe.exec(code)) !== null) {
    channels.add(m[1] ?? m[2]);
  }
  return channels;
}

describe('Phase 7 contract — IPC envelope failure surfacing', () => {
  describe.each(OK_DISCRIMINATED)('ok-discriminated channel %s', (channel) => {
    it('assertIpcOk throws IpcEnvelopeError on { ok: false }', () => {
      expect(() => assertIpcOk({ ok: false, error: 'simulated', code: 'EFOO' }, channel)).toThrow(
        IpcEnvelopeError,
      );
    });

    it('preserves the error message and channel name on throw', () => {
      try {
        assertIpcOk({ ok: false, error: 'simulated', code: 'EFOO' }, channel);
        throw new Error('expected assertIpcOk to throw, but it did not');
      } catch (err) {
        expect(err).toBeInstanceOf(IpcEnvelopeError);
        const e = err as IpcEnvelopeError;
        expect(e.channel).toBe(channel);
        expect(e.message).toBe('simulated');
        expect(e.code).toBe('EFOO');
      }
    });

    it('passes through unchanged on { ok: true }', () => {
      const result = { ok: true, path: '/whatever' };
      expect(assertIpcOk(result, channel)).toBe(result);
    });
  });

  describe.each(SUCCESS_DISCRIMINATED)('success-discriminated channel %s', (channel) => {
    it('assertIpcOk throws IpcEnvelopeError on { success: false }', () => {
      expect(() =>
        assertIpcOk({ success: false, error: 'simulated', code: 'EBAR' }, channel),
      ).toThrow(IpcEnvelopeError);
    });

    it('preserves the error message and channel name on throw', () => {
      try {
        assertIpcOk({ success: false, error: 'simulated', code: 'EBAR' }, channel);
        throw new Error('expected assertIpcOk to throw, but it did not');
      } catch (err) {
        expect(err).toBeInstanceOf(IpcEnvelopeError);
        const e = err as IpcEnvelopeError;
        expect(e.channel).toBe(channel);
        expect(e.message).toBe('simulated');
        expect(e.code).toBe('EBAR');
      }
    });

    it('passes through unchanged on { success: true }', () => {
      const result = { success: true, path: '/whatever' };
      expect(assertIpcOk(result, channel)).toBe(result);
    });
  });

  describe('drift parity — gate allowlist mirrors this test\'s inventory', () => {
    it('ENVELOPE_CHANNELS in check-ipc-envelope-usage.mjs matches the test inventory', () => {
      const gateList = readGateAllowlist();
      const inventory = new Set(ALL_ENVELOPE_CHANNELS);
      const onlyInGate = [...gateList].filter((c) => !inventory.has(c)).sort();
      const onlyInInventory = [...inventory].filter((c) => !gateList.has(c)).sort();
      expect({ onlyInGate, onlyInInventory }).toEqual({
        onlyInGate: [],
        onlyInInventory: [],
      });
    });
  });

  describe('non-envelope failure handling', () => {
    it('bare results (null, string, number, boolean, array) pass through assertIpcOk untouched', () => {
      // assertIpcOk is intentionally tolerant of bare-result channels —
      // many handlers return `string | null` or `boolean` and only the
      // envelope ones get the `{ ok | success: false }` discriminator.
      expect(assertIpcOk(null, 'bare:null')).toBe(null);
      expect(assertIpcOk('payload', 'bare:string')).toBe('payload');
      expect(assertIpcOk(42, 'bare:number')).toBe(42);
      expect(assertIpcOk(true, 'bare:bool')).toBe(true);
      const arr = ['a', 'b'];
      expect(assertIpcOk(arr, 'bare:array')).toBe(arr);
    });

    it('objects without ok/success keys pass through (defensive)', () => {
      const result = { foo: 'bar' };
      expect(assertIpcOk(result, 'unknown:channel')).toBe(result);
    });

    it('falls back to "<channel> reported failure" when no error string is present', () => {
      try {
        assertIpcOk({ ok: false }, 'recovery:snapshot');
        throw new Error('expected assertIpcOk to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(IpcEnvelopeError);
        expect((err as IpcEnvelopeError).message).toBe('recovery:snapshot reported failure');
      }
    });
  });
});
