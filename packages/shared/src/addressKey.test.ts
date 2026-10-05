import { describe, expect, it } from 'vitest';

import { addressKey } from './addressKey.js';

describe('addressKey', () => {
  it('keeps an IPv4 address verbatim', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses an IPv6 address to its canonical /64 prefix', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  });

  it('compresses a zero run in the canonical /64 prefix', () => {
    expect(addressKey('2001:db8::1')).toBe('2001:db8::/64');
  });

  it('keeps an IPv4-mapped IPv6 address on its embedded IPv4 address', () => {
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:198.51.100.9')).toBe('198.51.100.9');
  });

  it('keeps an IPv4-compatible (deprecated) IPv6 address on its embedded IPv4 address', () => {
    expect(addressKey('::203.0.113.7')).toBe('203.0.113.7');
  });

  it('keeps an IPv4-translated (RFC 2765) IPv6 address on its embedded IPv4 address', () => {
    expect(addressKey('::ffff:0:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keeps an IPv4-mapped IPv6 address on its embedded IPv4 address when hex-spelled', () => {
    expect(addressKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('keeps the loopback address distinct from an IPv4-compatible address of the same bits', () => {
    expect(addressKey('::1')).toBe('::/64');
  });

  it('returns a shared key for an unparsable address', () => {
    expect(addressKey('not-an-ip')).toBe('unparsable');
  });

  it('keys an upper-case or zero-run IPv6 address by its canonical /64', () => {
    expect(addressKey('2001:DB8:0:0:1::1')).toBe('2001:db8::/64');
    expect(addressKey('2001:db8:0:1::')).toBe('2001:db8:0:1::/64');
  });

  it('keys a link-local address with a zone by its /64, the zone dropped', () => {
    expect(addressKey('fe80::1%eth0')).toBe('fe80::/64');
  });

  it('keeps distinct /64 prefixes for IPv6 addresses that differ beyond the prefix', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).not.toBe(
      addressKey('2001:db8:1:3:3:4:5:6')
    );
  });
});
