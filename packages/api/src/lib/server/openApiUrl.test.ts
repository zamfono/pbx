import { describe, expect, it } from 'vitest';

import { openApiUrl } from './openApiUrl.js';

describe('openApiUrl (§10.3, §6.3 "Host control")', () => {
  it('serves the variant with host control at the document’s own path, and only there', () => {
    expect(openApiUrl('/api/v1/openapi.json', true)).toBe(
      '/api/v1/openapi-host-control.json'
    );
    expect(openApiUrl('/api/v1/openapi.json?x=1', true)).toBe(
      '/api/v1/openapi-host-control.json?x=1'
    );
    expect(openApiUrl('/api/v1/openapi.json', false)).toBe(
      '/api/v1/openapi.json'
    );
    expect(openApiUrl('/api/v1/users', true)).toBe('/api/v1/users');
  });

  it('answers the variant’s own path 404, with host control or without', () => {
    expect(
      openApiUrl('/api/v1/openapi-host-control.json', true)
    ).toBeUndefined();
    expect(
      openApiUrl('/api/v1/openapi-host-control.json', false)
    ).toBeUndefined();
  });
});
