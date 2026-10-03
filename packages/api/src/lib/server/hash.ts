import { createHash } from 'node:crypto';

/** SHA-256 hex of `data`: the only form a refresh or reset token is stored in (§5.2, §11.2), and
 * what tells whether a certificate changed. */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 7636 S256: `BASE64URL(SHA256(verifier))`. */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
