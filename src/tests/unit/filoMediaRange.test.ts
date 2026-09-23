/**
 * The Range-header parser is the part of the filo:// protocol handler that
 * actually decides whether to serve 200 / 206 / 416. The rest of the
 * handler is glue around `fs.createReadStream` + Electron's `protocol.handle`
 * and is exercised by the manual smoke test.
 *
 * Regression context: HTMLVideoElement issues `Range: bytes=…` requests for
 * seek/buffering. Before this parser existed the handler returned 200 with
 * the full body to every request, and Chromium silently abandoned video
 * playback on anything but the smallest files.
 */

import { describe, it, expect } from 'vitest';
import { parseRangeHeader } from '../../main/protocol/rangeHeader';

const TOTAL = 1000;

describe('parseRangeHeader', () => {
  it('returns null when no Range header is set', () => {
    expect(parseRangeHeader(null, TOTAL)).toBeNull();
    expect(parseRangeHeader('', TOTAL)).toBeNull();
  });

  it('parses a simple bytes=start-end range', () => {
    expect(parseRangeHeader('bytes=0-499', TOTAL)).toEqual({ start: 0, end: 499 });
    expect(parseRangeHeader('bytes=500-999', TOTAL)).toEqual({ start: 500, end: 999 });
  });

  it('treats bytes=start- as start-through-end', () => {
    expect(parseRangeHeader('bytes=200-', TOTAL)).toEqual({ start: 200, end: 999 });
  });

  it('treats bytes=-N as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-100', TOTAL)).toEqual({ start: 900, end: 999 });
  });

  it('clamps a too-large end to totalSize - 1', () => {
    expect(parseRangeHeader('bytes=0-9999', TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it('rejects out-of-bounds start', () => {
    expect(parseRangeHeader('bytes=1000-1500', TOTAL)).toBe('invalid');
    expect(parseRangeHeader('bytes=2000-', TOTAL)).toBe('invalid');
  });

  it('rejects end < start', () => {
    expect(parseRangeHeader('bytes=500-100', TOTAL)).toBe('invalid');
  });

  it('rejects multi-range syntax', () => {
    // HTMLVideoElement only ever sends single ranges in practice, and
    // returning the wrong slice for a multi-range request would be worse
    // than 416.
    expect(parseRangeHeader('bytes=0-100,200-300', TOTAL)).toBe('invalid');
  });

  it('rejects non-bytes units', () => {
    expect(parseRangeHeader('items=0-99', TOTAL)).toBe('invalid');
  });

  it('rejects a malformed Range header', () => {
    expect(parseRangeHeader('not-a-range', TOTAL)).toBe('invalid');
    expect(parseRangeHeader('bytes=', TOTAL)).toBe('invalid');
    expect(parseRangeHeader('bytes=--', TOTAL)).toBe('invalid');
  });

  it('rejects a zero-byte suffix request', () => {
    // bytes=-0 is ambiguous (RFC says "send 0 bytes from end"); both
    // major browsers treat it as malformed.
    expect(parseRangeHeader('bytes=-0', TOTAL)).toBe('invalid');
  });

  it('handles a single-byte range', () => {
    expect(parseRangeHeader('bytes=0-0', TOTAL)).toEqual({ start: 0, end: 0 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseRangeHeader('  bytes=0-99  ', TOTAL)).toEqual({ start: 0, end: 99 });
  });

  it('Audit-11 P1 — rejects every range form against a 0-byte file (→416)', () => {
    // A 0-byte file has no satisfiable byte range. The suffix form is the
    // dangerous one: `bytes=-N` computed `end = totalSize - 1 = -1`, which would
    // emit a malformed 206 `Content-Range: bytes 0--1/0`. RFC 7233 → 416.
    expect(parseRangeHeader('bytes=-100', 0)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-0', 0)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-499', 0)).toBe('invalid');
    // A request with no Range header still streams the empty body as a 200.
    expect(parseRangeHeader(null, 0)).toBeNull();
  });
});
