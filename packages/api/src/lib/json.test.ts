import { describe, expect, it } from 'vitest';

import { tryParseJson, tryReadJson } from './json.js';

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":[1]}')).toEqual({ a: [1] });
  });

  it('is undefined for invalid JSON', () => {
    expect(tryParseJson('{"a":')).toBeUndefined();
  });
});

describe('tryReadJson', () => {
  it('reads a JSON body', async () => {
    const request = new Request('http://x/', { method: 'POST', body: '[1]' });
    expect(await tryReadJson(request)).toEqual([1]);
  });

  it('is undefined for a body that is not JSON', async () => {
    const request = new Request('http://x/', { method: 'POST', body: 'nope' });
    expect(await tryReadJson(request)).toBeUndefined();
  });
});
