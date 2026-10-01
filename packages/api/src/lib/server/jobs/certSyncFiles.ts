/**
 * The certificate files on both sides of the sync (§6.4 "TLS certificates"): the fixed copy the
 * `proxy` image's `cert_obtained` hook writes to `caddy-data` (images/proxy/zamfono-cert-hook),
 * and the fixed copy on the `asterisk-config` volume that `transport-tls` reads. `certSync.ts`
 * decides when to copy; this file finds, reads and writes the files.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';

import { writeFileAtomically } from '../propagation.js';

const DEFAULT_CADDY_DATA_DIR = '/caddy-data';
// The fixed pair the hook writes (images/proxy/zamfono-cert-hook) and this reads: §6.4 "`api`
// reads only the hook's copy, never Caddy's own certificate store, whose layout is internal to
// Caddy". `TLS_CERT_FILENAME` is also the fixed pair `transport-tls` reads on the
// `asterisk-config` volume (§6.4: "the file path in its configuration never changes");
// `images/asterisk/conf/pjsip.conf.tmpl` names `tls/cert.pem` and `tls/privkey.pem` there — the
// same two filenames, on a different volume.
export const TLS_CERT_FILENAME = 'cert.pem';
const TLS_KEY_FILENAME = 'privkey.pem';
// Owner-only: the private key is the stack's SIP-TLS key, on a volume both `api` and `asterisk`
// mount (§6.3).
const TLS_KEY_MODE = 0o600;

/** `CADDY_DATA_DIR` (§6.3, the read-only `caddy-data` mount), read at call time for tests. */
export function caddyDataDirFromEnv(): string {
  return env.CADDY_DATA_DIR ?? DEFAULT_CADDY_DATA_DIR;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The hook's copy of the certificate/key pair under `caddyDataDir` (§6.4: `zamfono/cert.pem` and
 * `zamfono/privkey.pem`, images/proxy/zamfono-cert-hook), `null` while neither file exists yet —
 * a fresh stack whose first certificate Caddy has not obtained, or notified, yet.
 */
export async function findCaddyCert(
  caddyDataDir: string
): Promise<{ crt: string; key: string } | null> {
  const dir = path.join(caddyDataDir, 'zamfono');
  const crt = path.join(dir, TLS_CERT_FILENAME);
  const key = path.join(dir, TLS_KEY_FILENAME);
  if (!(await pathExists(crt)) || !(await pathExists(key))) {
    return null;
  }
  return { crt, key };
}

/**
 * Whether `key` is the private key of the leaf certificate `crt` starts with. The hook replaces
 * its two files with two renames, so a pass that reads between them sees the new chain with the
 * old key; installing that pair would break `transport-tls` until the next renewal, since a later
 * pass compares the chain alone and would find it up to date.
 */
export function isMatchingPair(crt: Buffer, key: Buffer): boolean {
  try {
    return new X509Certificate(crt).checkPrivateKey(createPrivateKey(key));
  } catch {
    return false;
  }
}

/** Writes the chain and key a pass read and checked onto the volume as the fixed pair `transport-tls` reads, the key owner-only. */
export async function copyCertificate(
  genDir: string,
  pair: { crt: Buffer; key: Buffer }
): Promise<void> {
  const tlsDir = path.join(genDir, 'tls');
  await mkdir(tlsDir, { recursive: true });
  await writeFileAtomically(path.join(tlsDir, TLS_CERT_FILENAME), pair.crt);
  await writeFileAtomically(
    path.join(tlsDir, TLS_KEY_FILENAME),
    pair.key,
    TLS_KEY_MODE
  );
}
