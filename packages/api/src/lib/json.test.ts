import { describe, expect, it } from 'vitest';

import { tryParseJson } from './json.js';

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":[1]}')).toEqual({ a: [1] });
  });

  it('is undefined for invalid JSON', () => {
    expect(tryParseJson('{"a":')).toBeUndefined();
  });
});
