import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, keyringFromEnv } from './secretbox.js';

const KEY_BYTE_LENGTH = 32;
const NONCE_BYTE_LENGTH = 24;
const TAG_BYTE_LENGTH = 16;

/** A valid `SECRETBOX_KEY`-shaped value for `generation`, with a fresh random key. */
function keySpec(generation: number): string {
  return `${generation}:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
}

describe('secretbox', () => {
  it('round-trips a plaintext through encrypt and decrypt', () => {
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const blob = encrypt(kr, 'hunter2');
    expect(decrypt(kr, blob).toString('utf8')).toBe('hunter2');
  });

  it('lays out the blob as version(1) || nonce(24) || ciphertext', () => {
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(3) });
    const plain = 'a somewhat longer secret value';
    const blob = encrypt(kr, plain);
    expect(blob[0]).toBe(3);
    expect(blob.length).toBe(
      1 + NONCE_BYTE_LENGTH + plain.length + TAG_BYTE_LENGTH
    );
  });

  it('decrypts a blob written under the previous generation', () => {
    const previousSpec = keySpec(1);
    const previousRing = keyringFromEnv({ SECRETBOX_KEY: previousSpec });
    const blob = encrypt(previousRing, 'rotated');

    const currentRing = keyringFromEnv({
      SECRETBOX_KEY: keySpec(2),
      SECRETBOX_KEY_PREVIOUS: previousSpec
    });
    expect(decrypt(currentRing, blob).toString('utf8')).toBe('rotated');
  });

  it('throws for a blob under a generation the keyring does not hold', () => {
    const staleRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    const blob = encrypt(staleRing, 'lost');
    const currentRing = keyringFromEnv({ SECRETBOX_KEY: keySpec(2) });
    expect(() => decrypt(currentRing, blob)).toThrow(
      'secretbox: unknown key generation 1'
    );
  });

  it('throws for a blob shorter than version + nonce + tag', () => {
    const kr = keyringFromEnv({ SECRETBOX_KEY: keySpec(1) });
    expect(() => decrypt(kr, Buffer.alloc(0))).toThrow(
      'secretbox: malformed blob'
    );
    expect(() => decrypt(kr, Buffer.alloc(10))).toThrow(
      'secretbox: malformed blob'
    );
  });

  it('rejects a key with a garbage character that would otherwise decode', () => {
    const validKey = randomBytes(KEY_BYTE_LENGTH).toString('base64');
    const corrupted = `!${validKey.slice(1)}`;
    expect(() => keyringFromEnv({ SECRETBOX_KEY: `1:${corrupted}` })).toThrow(
      'secretbox: malformed SECRETBOX_KEY'
    );
  });

  it('rejects a generation operand that is not a bare integer', () => {
    const key = randomBytes(KEY_BYTE_LENGTH).toString('base64');
    for (const generation of ['', ' 1', '1e1', '01', '0x1', '-1']) {
      expect(() =>
        keyringFromEnv({ SECRETBOX_KEY: `${generation}:${key}` })
      ).toThrow('secretbox: malformed SECRETBOX_KEY');
    }
  });

  it("refuses a previous key with the current key's generation", () => {
    expect(() =>
      keyringFromEnv({
        SECRETBOX_KEY: keySpec(1),
        SECRETBOX_KEY_PREVIOUS: keySpec(1)
      })
    ).toThrow(
      'secretbox: SECRETBOX_KEY_PREVIOUS has the generation of SECRETBOX_KEY'
    );
  });
});
