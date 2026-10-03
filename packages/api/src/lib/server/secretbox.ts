// `sodium-native` is CommonJS and assigns its exports dynamically, so Node's ESM named-export
// detection finds none of them: a namespace import leaves every constant and function undefined
// once this module is bundled for the `server.ts` entry. The default import is the CommonJS
// `module.exports` itself.
import sodium from 'sodium-native';

// §5.4: every secretbox blob is version(1) || nonce(24) || ciphertext, where the version
// byte is the generation of the key it was written under.
const VERSION_LENGTH = 1;
const NONCE_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const TAG_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
const KEY_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const KEY_ENCODING = 'base64';
const MIN_GENERATION = 0;
const MAX_GENERATION = 255;
const MIN_BLOB_LENGTH = VERSION_LENGTH + NONCE_LENGTH + TAG_LENGTH;
// The base64 encoding of exactly 32 bytes: 43 alphabet characters and one pad.
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/u;
// A generation is a bare non-negative integer: no sign, no leading zero, no whitespace.
const GENERATION = /^(?:0|[1-9][0-9]*)$/u;

export type Keyring = {
  current: { generation: number; key: Buffer };
  previous?: { generation: number; key: Buffer };
};

type KeySpec = { generation: number; key: Buffer };

/**
 * Parses a `SECRETBOX_KEY`-shaped value, `"<generation>:<base64 32 bytes>"`.
 * Throws `Error('secretbox: malformed <name>')` when the generation or the key is invalid.
 */
function parseKeySpec(name: string, value: string): KeySpec {
  const separatorIndex = value.indexOf(':');
  const malformed = new Error(`secretbox: malformed ${name}`);
  if (separatorIndex === -1) {
    throw malformed;
  }
  const generationOperand = value.slice(0, separatorIndex);
  const encodedKey = value.slice(separatorIndex + 1);
  if (
    !GENERATION.test(generationOperand) ||
    !BASE64_32_BYTES.test(encodedKey)
  ) {
    throw malformed;
  }
  const generation = Number(generationOperand);
  if (generation < MIN_GENERATION || generation > MAX_GENERATION) {
    throw malformed;
  }
  const key = Buffer.from(encodedKey, KEY_ENCODING);
  if (key.length !== KEY_LENGTH) {
    throw malformed;
  }
  return { generation, key };
}

/** Reads `SECRETBOX_KEY` and, if set, `SECRETBOX_KEY_PREVIOUS` into a `Keyring` (§5.4). */
export function keyringFromEnv(env: {
  SECRETBOX_KEY: string;
  SECRETBOX_KEY_PREVIOUS?: string | undefined;
}): Keyring {
  const current = parseKeySpec('SECRETBOX_KEY', env.SECRETBOX_KEY);
  const previousValue = env.SECRETBOX_KEY_PREVIOUS;
  if (previousValue === undefined) {
    return { current };
  }
  return {
    current,
    previous: parseKeySpec('SECRETBOX_KEY_PREVIOUS', previousValue)
  };
}

/** The key for `generation`, from `current` or `previous`. Throws when neither matches. */
function keyForGeneration(kr: Keyring, generation: number): Buffer {
  if (kr.current.generation === generation) {
    return kr.current.key;
  }
  if (kr.previous?.generation === generation) {
    return kr.previous.key;
  }
  throw new Error(`secretbox: unknown key generation ${generation}`);
}

/** Encrypts `plain` under the keyring's current key into a `version || nonce || ciphertext` blob. */
export function encrypt(kr: Keyring, plain: string | Buffer): Buffer {
  const message =
    typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const nonce = Buffer.alloc(NONCE_LENGTH);
  sodium.randombytes_buf(nonce);
  const ciphertext = Buffer.alloc(message.length + TAG_LENGTH);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext,
    message,
    null,
    null,
    nonce,
    kr.current.key
  );
  return Buffer.concat([
    Buffer.from([kr.current.generation]),
    nonce,
    ciphertext
  ]);
}

/** Decrypts a `version || nonce || ciphertext` blob, picking the key its version byte names. */
export function decrypt(kr: Keyring, blob: Buffer): Buffer {
  if (blob.length < MIN_BLOB_LENGTH) {
    throw new Error('secretbox: malformed blob');
  }
  const generation = blob.readUInt8(0);
  const key = keyForGeneration(kr, generation);
  const nonce = blob.subarray(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH);
  const ciphertext = blob.subarray(VERSION_LENGTH + NONCE_LENGTH);
  const plain = Buffer.alloc(ciphertext.length - TAG_LENGTH);
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    plain,
    null,
    ciphertext,
    null,
    nonce,
    key
  );
  return plain;
}
