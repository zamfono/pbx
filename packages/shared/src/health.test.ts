import { expect, test } from 'vitest';

import { healthDocument, healthHttpStatus } from './health.js';
import { HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from './httpStatus.js';

test('a health document reads as its worst check, and only fail answers 503', () => {
  const pass = healthDocument({ 'a:b': [{ status: 'pass' }] });
  const warn = healthDocument({
    'a:b': [{ status: 'pass' }],
    'c:d': [{ status: 'warn' }]
  });
  const fail = healthDocument({
    'a:b': [{ status: 'fail' }],
    'c:d': [{ status: 'warn' }]
  });
  expect([pass.status, warn.status, fail.status]).toEqual([
    'pass',
    'warn',
    'fail'
  ]);
  expect([pass, warn, fail].map(healthHttpStatus)).toEqual([
    HTTP_OK,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE
  ]);
  expect(healthDocument({}).status).toBe('pass');
});
