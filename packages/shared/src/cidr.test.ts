import { expect, test } from 'vitest';

import { addressRangesOverlap, isCidr, isSipBanAddress } from './cidr.js';

test.each([
  ['10.0.0.0/8', true],
  ['192.0.2.1/32', true],
  ['2001:db8::/32', true],
  ['2001:db8::/128', true],
  ['10.0.0.0/33', false],
  ['2001:db8::/129', false],
  ['10.0.0.0/', false],
  ['10.0.0.0/x', false],
  ['10.0.0.0', false],
  ['example.com/8', false]
])('isCidr(%s) is %s', (value, expected) => {
  expect(isCidr(value)).toBe(expected);
});

test.each([
  ['203.0.113.7', true],
  ['2001:db8:1:2::/64', true],
  ['203.0.113.0/24', false],
  ['2001:db8::1', false],
  ['2001:db8::/48', false],
  ['2001:DB8:1:2::/64', false],
  ['203.0.113.7 2026-10-05T00:00:00Z', false],
  ['', false]
])('isSipBanAddress(%s) is %s', (value, expected) => {
  expect(isSipBanAddress(value)).toBe(expected);
});

test.each([
  ['203.0.113.0/24', '203.0.113.7', true],
  ['203.0.113.7', '203.0.113.7', true],
  ['203.0.113.8', '203.0.113.7', false],
  ['10.1.2.3/8', '10.200.0.1', true],
  ['2001:db8::/48', '2001:db8:0:5::/64', true],
  ['2001:DB8:0:5::1', '2001:db8:0:5::/64', true],
  ['2001:db8:0:6::/64', '2001:db8:0:5::/64', false],
  ['203.0.113.7', '2001:db8:0:5::/64', false]
])('addressRangesOverlap(%s, %s) is %s', (left, right, expected) => {
  expect(addressRangesOverlap(left, right)).toBe(expected);
  expect(addressRangesOverlap(right, left)).toBe(expected);
});
