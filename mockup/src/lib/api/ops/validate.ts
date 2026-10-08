/**
 * Input checks shared by the operations, with the API's rules (§10.3, §11.2) and i18n codes under
 * `errors.*`. Each throws a 422 naming the field.
 */
import { invalid } from '../errors';
import type { Db } from '../types';

export const E164 = /^\+[1-9]\d{6,14}$/u;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const IPV6 = /^[0-9a-f:]+$/iu;

export function requireText(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(field, 'required', `${field} is required`);
  }
  return value.trim();
}

/** A number as people type it, normalised to E.164 with the tenant country (DE: 0 → +49). */
export function normaliseNumber(db: Db, value: string): string {
  const compact = value.replace(/[\s()/.-]/gu, '');
  if (compact.startsWith('+')) {
    return compact;
  }
  if (compact.startsWith('00')) {
    return `+${compact.slice(2)}`;
  }
  if (compact.startsWith('0') && db.settings.country === 'DE') {
    return `+49${compact.slice(1)}`;
  }
  return compact;
}

export function requireE164(field: string, value: unknown, db?: Db): string {
  const text = requireText(field, value);
  const number = db === undefined ? text : normaliseNumber(db, text);
  if (!E164.test(number)) {
    throw invalid(field, 'e164', `${field} must be E.164`, { value: text });
  }
  return number;
}

export function requireInt(
  field: string,
  value: unknown,
  min: number,
  max: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw invalid(field, 'range', `${field} must be an integer ${min}–${max}`, {
      min,
      max
    });
  }
  return value;
}

/** A timeout in seconds, 1–86400 (`timeoutInput.ts`). */
export const requireTimeout = (field: string, value: unknown): number =>
  requireInt(field, value, 1, 86_400);

export function isIpOrCidr(value: string): boolean {
  const [address = '', prefix] = value.split('/');
  const ipOk =
    IPV4.test(address) || (address.includes(':') && IPV6.test(address));
  if (!ipOk) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return (
    Number.isInteger(bits) &&
    bits >= 0 &&
    bits <= (address.includes(':') ? 128 : 32)
  );
}

/** An extension: exactly `extLength` digits, free across users, ring groups and parking, not an
 * emergency number (§11.2). `except` is the holder being edited. */
export function requireFreeExtension(
  db: Db,
  field: string,
  value: unknown,
  except?: { kind: 'user' | 'ringGroup'; id: string }
): string {
  const ext = requireText(field, value);
  const length = db.settings.extLength;
  if (!new RegExp(`^\\d{${length}}$`, 'u').test(ext)) {
    throw invalid(
      field,
      'extensionLength',
      `extension must be ${length} digits`,
      { length }
    );
  }
  if (db.settings.emergencyNumbers.includes(ext)) {
    throw invalid(
      field,
      'extensionEmergency',
      'extension is an emergency number',
      { ext }
    );
  }
  const user = db.users.find(
    candidate =>
      candidate.deletedAt === null &&
      candidate.extension === ext &&
      !(except?.kind === 'user' && except.id === candidate.id)
  );
  const group = db.ringGroups.find(
    candidate =>
      candidate.deletedAt === null &&
      candidate.ext === ext &&
      !(except?.kind === 'ringGroup' && except.id === candidate.id)
  );
  if (
    user !== undefined ||
    group !== undefined ||
    db.parkingSlots.includes(ext)
  ) {
    throw invalid(field, 'extensionTaken', `extension ${ext} is taken`, {
      ext,
      holder: user?.name ?? group?.name ?? 'Parking'
    });
  }
  return ext;
}
