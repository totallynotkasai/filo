import { describe, it, expect } from 'vitest';
import { isPrivateUrl, extractEmbeddedIPv4 } from '../../main/utils/pathSecurity';

/**
 * D.1 — IPv4-mapped IPv6 (`::ffff:1.2.3.4`) and IPv4-compatible IPv6
 * (`::1.2.3.4`) forms embed a dotted-quad inside the IPv6 hostname.
 * Without this regression guard, the previous broad `/^::ffff:/` check
 * either over-blocked legitimate public addresses or — once tightened —
 * silently let `::ffff:10.0.0.1` reach `link:fetch-metadata` /
 * `shell:open-external`.
 */
describe('isPrivateUrl — IPv4-mapped IPv6', () => {
  it('flags `::ffff:` embedded RFC-1918 (10.x)', () => {
    expect(isPrivateUrl('http://[::ffff:10.0.0.1]')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:10.0.0.1]:8080/x')).toBe(true);
  });

  it('flags `::ffff:` embedded loopback', () => {
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]')).toBe(true);
  });

  it('flags legacy `::N.N.N.N` IPv4-compat embedded private', () => {
    expect(isPrivateUrl('http://[::192.168.1.1]')).toBe(true);
    expect(isPrivateUrl('http://[::127.0.0.1]')).toBe(true);
  });

  it('does NOT flag `::ffff:` embedded public address', () => {
    expect(isPrivateUrl('http://[::ffff:8.8.8.8]')).toBe(false);
    expect(isPrivateUrl('http://[::ffff:1.1.1.1]')).toBe(false);
  });

  it('does NOT flag `::ffff:` embedded public with port', () => {
    expect(isPrivateUrl('http://[::ffff:8.8.8.8]:443/test')).toBe(false);
  });
});

/**
 * 3.1 — the bypass the dotted-quad guard above missed. Node's URL parser
 * canonicalises `::ffff:10.0.0.1` to its compressed HEX form `::ffff:a00:1`,
 * and an attacker can supply the hex form directly. The previous
 * `rawMapped` regex only matched a literal dotted-quad, so the hex
 * IPv4-mapped form, the IPv4-compatible `::` hex form, and NAT64
 * (`64:ff9b::/96`) all sailed past `isPrivateUrl` and auto-fired from a
 * Link Tile's `link:fetch-metadata` on mount. Verified end-to-end this
 * audit. The fix decodes the embedded v4 and classifies by THAT, so a
 * hex-encoded public address stays public (no over-block).
 */
describe('isPrivateUrl — hex-form IPv4-mapped / NAT64 IPv6 (3.1)', () => {
  it('flags hex-encoded `::ffff:` loopback (127.0.0.1)', () => {
    expect(isPrivateUrl('http://[::ffff:7f00:1]')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:7f00:1]:8080/admin')).toBe(true);
  });

  it('flags hex-encoded `::ffff:` RFC-1918 (10.0.0.1 / 192.168.0.1)', () => {
    expect(isPrivateUrl('http://[::ffff:a00:1]')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:c0a8:1]')).toBe(true);
  });

  it('flags NAT64 well-known-prefix embedded private (64:ff9b::/96)', () => {
    expect(isPrivateUrl('http://[64:ff9b::a00:1]')).toBe(true); // 10.0.0.1
    expect(isPrivateUrl('http://[64:ff9b::7f00:1]')).toBe(true); // 127.0.0.1
  });

  it('flags hex-encoded `::` IPv4-compatible embedded private', () => {
    expect(isPrivateUrl('http://[::c0a8:101]')).toBe(true); // 192.168.1.1
  });

  it('does NOT flag hex-encoded `::ffff:` public (8.8.8.8)', () => {
    expect(isPrivateUrl('http://[::ffff:808:808]')).toBe(false);
  });

  it('does NOT flag genuine public IPv6 (decode & classify keeps it allowed)', () => {
    expect(isPrivateUrl('http://[2001:db8::1]')).toBe(false);
    expect(isPrivateUrl('http://[2606:4700:4700::1111]')).toBe(false);
  });

  it('still flags genuine private IPv6 literals (ULA / loopback / link-local)', () => {
    expect(isPrivateUrl('http://[::1]')).toBe(true);
    expect(isPrivateUrl('http://[fc00::1]')).toBe(true);
    expect(isPrivateUrl('http://[fe80::1]')).toBe(true);
  });
});

describe('extractEmbeddedIPv4 (3.1)', () => {
  it('decodes IPv4-mapped, NAT64, and IPv4-compatible forms (hex + dotted)', () => {
    expect(extractEmbeddedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(extractEmbeddedIPv4('::ffff:a00:1')).toBe('10.0.0.1');
    expect(extractEmbeddedIPv4('::ffff:c0a8:1')).toBe('192.168.0.1');
    expect(extractEmbeddedIPv4('64:ff9b::a00:1')).toBe('10.0.0.1');
    expect(extractEmbeddedIPv4('::c0a8:101')).toBe('192.168.1.1');
    expect(extractEmbeddedIPv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(extractEmbeddedIPv4('::ffff:808:808')).toBe('8.8.8.8');
  });

  it('returns null for genuine (non-embedding) IPv6 and the unspecified address', () => {
    expect(extractEmbeddedIPv4('2001:db8::1')).toBeNull();
    expect(extractEmbeddedIPv4('fc00::1')).toBeNull();
    expect(extractEmbeddedIPv4('::')).toBeNull();
  });

  it('returns null for malformed / non-IPv6 input', () => {
    expect(extractEmbeddedIPv4('not-an-ip')).toBeNull();
    expect(extractEmbeddedIPv4('::ffff:zzzz:1')).toBeNull();
    expect(extractEmbeddedIPv4('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(extractEmbeddedIPv4('')).toBeNull();
  });
});
