import { expect, it } from 'vitest';

import { internalAuthorization, isValidBearer } from './bearer.js';

it.each([
  ['Bearer s3cret', 's3cret', true],
  [null, 's3cret', false],
  ['', 's3cret', false],
  ['Bearer wrong!', 's3cret', false],
  ['Bearer s3cret2', 's3cret', false],
  ['bearer s3cret', 's3cret', false],
  ['s3cret', 's3cret', false],
  ['Bearer ', '', false]
])('isValidBearer(%s, %s) is %s', (authorization, token, expected) => {
  expect(isValidBearer(authorization, token)).toBe(expected);
});

it('builds the header an internal request carries', () => {
  const { authorization } = internalAuthorization('s3cret');
  expect(isValidBearer(authorization, 's3cret')).toBe(true);
});
