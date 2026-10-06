/**
 * A software WebAuthn authenticator for tests: an ES256 key pair that answers the options
 * `@simplewebauthn/server` generates with real `none`-attested registrations and real signed
 * assertions, so the library's own verification runs unmocked (§5.2 "Two-factor
 * authentication").
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign
} from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server';

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_MAP = 5;
const MAJOR_SHIFT = 32;
const ONE_BYTE = 24;
const TWO_BYTES = 25;
const BYTE_LIMIT = 256;

function head(major: number, length: number): Buffer {
  if (length < ONE_BYTE) {
    return Buffer.from([major * MAJOR_SHIFT + length]);
  }
  if (length < BYTE_LIMIT) {
    return Buffer.from([major * MAJOR_SHIFT + ONE_BYTE, length]);
  }
  const out = Buffer.alloc(3);
  out.writeUInt8(major * MAJOR_SHIFT + TWO_BYTES);
  out.writeUInt16BE(length, 1);
  return out;
}

/** The CBOR (RFC 8949) of `value`, for the few types an attestation object holds. */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value < 0
      ? head(MAJOR_NEGATIVE, -1 - value)
      : head(MAJOR_UNSIGNED, value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(MAJOR_TEXT, text.length), text]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([head(MAJOR_BYTES, value.length), value]);
  }
  return Buffer.concat([
    head(MAJOR_MAP, value.size),
    ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])
  ]);
}

// Authenticator data flags: user present, user verified, attested credential data included.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const AAGUID_BYTES = 16;
const COUNTER_BYTES = 4;
const CREDENTIAL_ID_BYTES = 16;
// COSE (RFC 9053): an EC2 key on P-256 for ES256.
const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const KTY_EC2 = 2;
const ALG_ES256 = -7;
const CRV_P256 = 1;

const b64url = (data: Buffer): string => data.toString('base64url');
const sha256 = (data: Buffer | string): Buffer =>
  createHash('sha256').update(data).digest();

/** One passkey on a software authenticator, for the origin and RP id it is used with. */
export class SoftAuthenticator {
  readonly #keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly #id = randomBytes(CREDENTIAL_ID_BYTES);
  readonly #origin: string;
  #counter = 0;

  constructor(origin: string) {
    this.#origin = origin;
  }

  #authData(rpId: string, flags: number, attested: Buffer): Buffer {
    const counter = Buffer.alloc(COUNTER_BYTES);
    counter.writeUInt32BE(this.#counter);
    return Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      counter,
      attested
    ]);
  }

  #clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.#origin,
        crossOrigin: false
      })
    );
  }

  /** The browser's response to registration `options`. */
  register(
    options: PublicKeyCredentialCreationOptionsJSON
  ): RegistrationResponseJSON {
    const jwk = this.#keys.publicKey.export({ format: 'jwk' });
    const coseKey = new Map<number, Cbor>([
      [COSE_KTY, KTY_EC2],
      [COSE_ALG, ALG_ES256],
      [COSE_CRV, CRV_P256],
      [COSE_X, Buffer.from(jwk.x ?? '', 'base64url')],
      [COSE_Y, Buffer.from(jwk.y ?? '', 'base64url')]
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.#id.length);
    const attested = Buffer.concat([
      Buffer.alloc(AAGUID_BYTES),
      idLength,
      this.#id,
      cbor(coseKey)
    ]);
    const authData = this.#authData(
      options.rp.id ?? '',
      FLAG_UP + FLAG_UV + FLAG_AT,
      attested
    );
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData]
      ])
    );
    return {
      id: b64url(this.#id),
      rawId: b64url(this.#id),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(
          this.#clientData('webauthn.create', options.challenge)
        ),
        attestationObject: b64url(attestationObject),
        transports: ['internal']
      },
      clientExtensionResults: {}
    };
  }

  /** The browser's response to sign-in `options`, its signature counter one up. */
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON
  ): AuthenticationResponseJSON {
    this.#counter += 1;
    const authData = this.#authData(
      options.rpId ?? '',
      FLAG_UP + FLAG_UV,
      Buffer.alloc(0)
    );
    const clientData = this.#clientData('webauthn.get', options.challenge);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.#keys.privateKey
    );
    return {
      id: b64url(this.#id),
      rawId: b64url(this.#id),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature)
      },
      clientExtensionResults: {}
    };
  }
}
