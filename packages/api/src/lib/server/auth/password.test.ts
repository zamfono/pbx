import { describe, expect, it } from 'vitest';

import { UNSET_PASSWORD_HASH_PREFIX } from '../seed.js';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('round-trips a password through hash and verify', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(
      verifyPassword(hash, 'correct horse battery staple')
    ).resolves.toBe(true);
  });

  it('rejects the wrong password against a real hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('rejects without throwing for a null hash (SSO-only user)', async () => {
    await expect(verifyPassword(null, 'anything')).resolves.toBe(false);
  });

  it("rejects without throwing for seed.ts's unset-password placeholder", async () => {
    const placeholder = `${UNSET_PASSWORD_HASH_PREFIX}deadbeef`;
    await expect(verifyPassword(placeholder, 'anything')).resolves.toBe(false);
  });
});
