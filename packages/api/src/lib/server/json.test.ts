import { describe, expect, it } from 'vitest';

import { tryParseJson, tryReadJson } from './json.js';

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"ids":[1]}')).toEqual({ ids: [1] });
  });

  it('is undefined for invalid JSON', () => {
    expect(tryParseJson('{"ids":')).toBeUndefined();
  });
});

describe('tryReadJson', () => {
  it('reads a JSON body', async () => {
    expect(await tryReadJson(new Response('[1]'))).toEqual([1]);
  });

  it('is undefined for a body that is not JSON', async () => {
    expect(await tryReadJson(new Response('nope'))).toBeUndefined();
  });
});
