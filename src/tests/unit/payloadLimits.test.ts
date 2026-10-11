/**
 * IPC payload size-cap regression guard.
 *
 * Every write-shaped IPC handler now caps its payload via
 * `assertPayloadByteSize` before reaching the disk write. The tests below
 * pin the helper's contract — the per-channel application sites are
 * covered indirectly through the existing ipcPayloadSchemas + envelope
 * suites.
 */

import { describe, it, expect } from 'vitest';
import {
  assertPayloadByteSize,
  jsonPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
} from '../../main/utils/payloadLimits';

describe('PAYLOAD_LIMITS — sanity check on the constants', () => {
  it('every cap is a positive integer measured in bytes', () => {
    for (const [key, value] of Object.entries(PAYLOAD_LIMITS)) {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
      expect(value, `${key} must be positive`).toBeGreaterThan(0);
      expect(Number.isInteger(value), `${key} must be an integer`).toBe(true);
    }
  });

  it('Markdown / board / template caps are at least 1 MB', () => {
    const MB = 1024 * 1024;
    expect(PAYLOAD_LIMITS.MARKDOWN).toBeGreaterThanOrEqual(MB);
    expect(PAYLOAD_LIMITS.BOARD).toBeGreaterThanOrEqual(MB);
    expect(PAYLOAD_LIMITS.TEMPLATE).toBeGreaterThanOrEqual(MB);
  });
});

describe('assertPayloadByteSize', () => {
  it('passes silently when byteLength === maxBytes', () => {
    expect(() => assertPayloadByteSize(100, 100, 'edge')).not.toThrow();
  });

  it('passes silently when byteLength < maxBytes', () => {
    expect(() => assertPayloadByteSize(50, 100, 'under')).not.toThrow();
  });

  it('passes silently for an empty payload', () => {
    expect(() => assertPayloadByteSize(0, 100, 'empty')).not.toThrow();
  });

  it('throws PayloadTooLargeError once byteLength exceeds the cap', () => {
    expect(() => assertPayloadByteSize(101, 100, 'over')).toThrow(
      PayloadTooLargeError,
    );
  });

  it('error carries the label, byteLength, and cap for diagnostic logging', () => {
    let caught: unknown;
    try {
      assertPayloadByteSize(500, 200, 'board:save');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    const e = caught as PayloadTooLargeError;
    expect(e.byteLength).toBe(500);
    expect(e.maxBytes).toBe(200);
    expect(e.message).toContain('board:save');
    expect(e.message).toContain('500');
    expect(e.message).toContain('200');
    expect(e.code).toBe('FILE_TOO_LARGE');
  });
});

describe('jsonPayloadByteSize', () => {
  it('returns 0 for nullish input', () => {
    expect(jsonPayloadByteSize(null)).toBe(0);
    expect(jsonPayloadByteSize(undefined)).toBe(0);
  });

  it('uses Buffer.byteLength when given a pre-stringified string (no double-encode)', () => {
    const raw = JSON.stringify({ a: 1 });
    expect(jsonPayloadByteSize(raw)).toBe(Buffer.byteLength(raw, 'utf-8'));
  });

  it('JSON.stringifies non-string input and measures UTF-8 byte length', () => {
    const obj = { greeting: 'héllo', list: [1, 2, 3] };
    const expected = Buffer.byteLength(JSON.stringify(obj), 'utf-8');
    expect(jsonPayloadByteSize(obj)).toBe(expected);
  });

  it('counts multi-byte characters by UTF-8 byte length, not character count', () => {
    // "日本" is 6 bytes in UTF-8 (3 each) but 2 characters; the cap is byte-based.
    const obj = { label: '日本' };
    const json = JSON.stringify(obj);
    expect(jsonPayloadByteSize(obj)).toBe(Buffer.byteLength(json, 'utf-8'));
    expect(jsonPayloadByteSize(obj)).toBeGreaterThan(json.length); // multi-byte
  });
});
