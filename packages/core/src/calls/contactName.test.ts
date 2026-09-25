import { describe, expect, it } from 'vitest';

import { formatCallerId } from './contactName.js';

describe('formatCallerId (§10.2 "Phone book")', () => {
  it("puts the contact's name before the number", () => {
    expect(formatCallerId('+4311234567', 'Huber GmbH')).toBe(
      '"Huber GmbH" <+4311234567>'
    );
  });

  it('keeps the bare number for a caller the phone book does not know', () => {
    expect(formatCallerId('+4311234567', '')).toBe('+4311234567');
    expect(formatCallerId('anonymous', '')).toBe('anonymous');
  });

  it('drops what would end the quoted name early', () => {
    expect(formatCallerId('+4311234567', 'A "B" \\ C')).toBe(
      '"A B  C" <+4311234567>'
    );
    expect(formatCallerId('+4311234567', '""')).toBe('+4311234567');
  });
});
