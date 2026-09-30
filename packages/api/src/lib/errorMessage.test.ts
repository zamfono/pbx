import { describe, expect, it } from 'vitest';

import { errorMessage } from './errorMessage.js';

describe('errorMessage', () => {
  it("reads an Error's message", () => {
    expect(errorMessage(new Error('refused'))).toBe('refused');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('timeout')).toBe('timeout');
    expect(errorMessage(42)).toBe('42');
  });
});
