/**
 * Helpers of the sign-in and security screens: the simulated authenticator app (secret, otpauth
 * URI, the code it shows, a QR code drawn from the URI), the SSO button label, and running an
 * `auth.*` operation as the person signing in — before the session names them.
 */
import { ApiError } from '#lib/api/errors.js';
import { call } from '#lib/api/ops/core.js';
import type { Settings, User } from '#lib/api/types.js';
import { t } from '#lib/i18n/index.svelte.js';
import { toast } from '#lib/state/ui.svelte.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 160 bits as base32 (§5.2): 32 characters. */
const SECRET_LENGTH = 32;
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;

/** FNV-1a, enough to derive stable demo values from a string. */
function hash(text: string, seed = 0x811c9dc5): number {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** A pseudo-random sequence seeded by `text` (mulberry32). */
function sequence(text: string): () => number {
  let state = hash(text);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A fresh authenticator secret: 160 random bits as base32. */
export function newTotpSecret(): string {
  const bytes = new Uint8Array(SECRET_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => BASE32[byte % BASE32.length]).join('');
}

/** The secret in groups of four, as people copy it by hand. */
export const groupedSecret = (secret: string): string =>
  secret.match(/.{1,4}/gu)?.join(' ') ?? secret;

/** The stand-in secret of an authenticator app set up before this demo started. */
export const existingSecret = (userId: string): string => {
  const next = sequence(`totp:${userId}`);
  return Array.from(
    { length: SECRET_LENGTH },
    () => BASE32[Math.floor(next() * BASE32.length)]
  ).join('');
};

/** `otpauth://totp/<issuer>:<email>`, the issuer being the company name (§5.2). */
export function otpauthUri(
  companyName: string,
  email: string,
  secret: string
): string {
  const issuer = encodeURIComponent(companyName);
  return `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/** The six digits the demo authenticator shows for `secret` at `now`, and the seconds left. */
export function demoTotp(
  secret: string,
  now: number
): { code: string; secondsLeft: number } {
  const step = Math.floor(now / TOTP_STEP_MS);
  const code = String(hash(`${secret}:${step}`) % 10 ** TOTP_DIGITS).padStart(
    TOTP_DIGITS,
    '0'
  );
  return {
    code,
    secondsLeft: Math.ceil((TOTP_STEP_MS - (now % TOTP_STEP_MS)) / 1000)
  };
}

const QR_SIZE = 29;
const FINDER = 7;

/**
 * A QR-shaped module grid for `text` (version 3, 29×29): the three finder patterns, the timing
 * lines and the alignment pattern are placed as a real code has them, the data modules are derived
 * from `text`. It looks like the code an authenticator scans; no scanner reads it.
 */
export function qrMatrix(text: string): boolean[][] {
  const next = sequence(text);
  const grid = Array.from({ length: QR_SIZE }, () =>
    Array.from({ length: QR_SIZE }, () => next() < 0.5)
  );
  const reserve = (row: number, col: number, dark: boolean): void => {
    const line = grid[row];
    if (line !== undefined && col >= 0 && col < QR_SIZE) {
      line[col] = dark;
    }
  };
  const finder = (top: number, left: number): void => {
    for (let row = -1; row <= FINDER; row += 1) {
      for (let col = -1; col <= FINDER; col += 1) {
        const ring = Math.max(Math.abs(row - 3), Math.abs(col - 3));
        if (top + row >= 0 && left + col >= 0 && top + row < QR_SIZE) {
          reserve(top + row, left + col, ring !== 2 && ring !== 4);
        }
      }
    }
  };
  finder(0, 0);
  finder(0, QR_SIZE - FINDER);
  finder(QR_SIZE - FINDER, 0);
  for (let index = FINDER + 1; index < QR_SIZE - FINDER - 1; index += 1) {
    reserve(6, index, index % 2 === 0);
    reserve(index, 6, index % 2 === 0);
  }
  const align = QR_SIZE - FINDER - 2;
  for (let row = -2; row <= 2; row += 1) {
    for (let col = -2; col <= 2; col += 1) {
      const ring = Math.max(Math.abs(row), Math.abs(col));
      reserve(align + row, align + col, ring !== 1);
    }
  }
  reserve(QR_SIZE - FINDER - 1, FINDER + 1, true);
  return grid;
}

/** The SSO button's provider name: `ssoLabel`, or the preset one (`ssoSettings.ts`). */
export function ssoName(
  settings: Pick<Settings, 'ssoProvider' | 'ssoLabel'>
): string | null {
  if (settings.ssoProvider === null) {
    return null;
  }
  if (settings.ssoProvider === 'microsoft') {
    return settings.ssoLabel ?? 'Microsoft';
  }
  if (settings.ssoProvider === 'google') {
    return settings.ssoLabel ?? 'Google';
  }
  return settings.ssoLabel ?? 'SSO';
}

export type AsResult<O> =
  { ok: true; value: O } | { ok: false; error: ApiError };

/**
 * Runs an `auth.*` operation as `user`, the person signing in: during the sign-in no session names
 * them yet, so the screen calls the operations layer with their identity directly.
 */
export function callAs<O>(
  user: Pick<User, 'id' | 'name' | 'role'>,
  name: string,
  input: unknown
): AsResult<O> {
  try {
    return {
      ok: true,
      value: call<O>(name, input, {
        actor: { id: user.id, name: user.name, role: user.role },
        channel: 'ui'
      })
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error };
    }
    throw error;
  }
}

/** The recovery codes as the downloaded `.txt` holds them: the company name, then one per line. */
export const recoveryCodesText = (
  companyName: string,
  codes: string[]
): string => `${companyName}\n\n${codes.join('\n')}\n`;

/** The identity provider's sign-in host, as the simulated account chooser's address bar shows it. */
export function ssoHost(
  settings: Pick<Settings, 'ssoProvider' | 'ssoIssuer'>
): string {
  if (settings.ssoProvider === 'microsoft') {
    return 'login.microsoftonline.com';
  }
  if (settings.ssoProvider === 'google') {
    return 'accounts.google.com';
  }
  try {
    return new URL(settings.ssoIssuer ?? '').host;
  } catch {
    return settings.ssoIssuer ?? '';
  }
}

/** The success toast of a changed second factor: what changed, and that the API mailed the person
 * about it (`mfaChanged`). */
export function mfaChangedToast(
  title: string,
  email: string | null,
  operation: string
): void {
  toast({
    tone: 'success',
    title,
    body: email === null ? null : t('auth.toast.mailed', { email }),
    operation
  });
}
