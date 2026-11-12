import { describe, expect, it } from 'vitest';

import { ownerName } from './_updater.js';

describe('ownerName (§6.3 "Updates")', () => {
  it('passes a plain name on as it is', () => {
    expect(ownerName('Olga Owner')).toBe('Olga Owner');
  });

  it('turns control characters into spaces', () => {
    expect(ownerName('Olga\tOwner\n')).toBe('Olga Owner');
  });

  it('cuts at 200 bytes of UTF-8, between characters', () => {
    const name = ownerName('Ж'.repeat(150));
    expect(Buffer.byteLength(name)).toBe(200);
    expect(name).toBe('Ж'.repeat(100));
  });

  it('names an owner where nothing printable is left', () => {
    expect(ownerName('\u0000\u0001')).toBe('an owner');
  });
});
