import { describe, it, expect } from 'vitest';
import { isPrivateUrl } from '../../main/utils/pathSecurity';

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
