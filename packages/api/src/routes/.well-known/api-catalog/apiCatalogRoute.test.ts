import { describe, expect, it } from 'vitest';

import { GET } from './+server.js';

describe('GET /.well-known/api-catalog', () => {
  it('links the OpenAPI document and /healthz from the API as absolute URLs on the FQDN', async () => {
    const response = GET();

    expect(response.headers.get('content-type')).toBe(
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
    );
    expect(response.headers.has('link')).toBe(false);
    expect(await response.json()).toEqual({
      linkset: [
        {
          anchor: 'https://pbx.test/api/v1',
          'service-desc': [
            {
              href: 'https://pbx.test/api/v1/openapi.json',
              type: 'application/vnd.oai.openapi+json'
            }
          ],
          status: [
            {
              href: 'https://pbx.test/healthz',
              type: 'application/health+json'
            }
          ]
        }
      ]
    });
  });
});
