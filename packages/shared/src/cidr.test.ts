import { expect, test } from 'vitest';

import { isCidr } from './cidr.js';

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
