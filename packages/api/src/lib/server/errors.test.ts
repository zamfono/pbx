import { describe, expect, it } from 'vitest';

import { attempt, errorMessage } from './errors.js';

describe('errorMessage', () => {
  it("reads an Error's message", () => {
    expect(errorMessage(new Error('refused'))).toBe('refused');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('timeout')).toBe('timeout');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('attempt', () => {
  it("returns fn's value, or undefined when it throws", () => {
    expect(attempt(() => 1)).toBe(1);
    const fails = (): number => {
      throw new Error('missing');
    };
    expect(attempt(fails)).toBeUndefined();
  });
});
