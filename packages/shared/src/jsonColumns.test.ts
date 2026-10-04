import { describe, expect, it } from 'vitest';

import { codecsColumn, findMeColumn } from './jsonColumns.js';

describe('JSON columns', () => {
  it('decodes a stored value into its schema', () => {
    expect(codecsColumn.decode('["opus","alaw"]')).toEqual(['opus', 'alaw']);
  });

  it('refuses a value outside the schema and text that is not JSON', () => {
    expect(() => codecsColumn.decode('["g729"]')).toThrow();
    expect(() => codecsColumn.decode('[')).toThrow(/JSON/u);
  });

  it('reads a NULL find-me column as no legs', () => {
    expect(findMeColumn.decode(null)).toEqual([]);
    expect(findMeColumn.decode('[{"number":"+4930123","delayS":5}]')).toEqual([
      { number: '+4930123', delayS: 5 }
    ]);
  });
});
