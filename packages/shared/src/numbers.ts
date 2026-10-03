import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';

import type { NumberFormat } from './columnValues.js';

/** International prefix `00`, the digit form of a leading `+` (§9.4 "Inbound number normalization"). */
const INTERNATIONAL_PREFIX = '00';

/** A string made only of digits with an optional leading `+`, the shape the trunk boundary can normalize. */
const DIGITS_WITH_OPTIONAL_PLUS = /^\+?[0-9]+$/u;

/** Whether `raw` is a number the trunk boundary normalizes, digits with an optional leading `+`
 *  (§9.4 "Inbound number normalization"), rather than a string it passes verbatim. */
export function isInboundNumber(raw: string): boolean {
  return DIGITS_WITH_OPTIONAL_PLUS.test(raw);
}

/** The calling code of a country, e.g. `'DE'` → `'49'`. */
export function callingCode(country: string): string {
  return getCountryCallingCode(country as CountryCode);
}

/**
 * Normalizes a called or calling party at the trunk boundary per `trunks.inbound_number_format`
 * (§9.4 "Inbound number normalization"). A leading `+` is already international; a leading `00` is
 * the international prefix and becomes `+`; under `national`, a leading `0` becomes `+` plus the
 * calling code of `country`. A value that is not digits-with-optional-`+` (a provider's verbatim
 * account string, or one carrying whitespace) passes through unchanged.
 */
export function normalizeInbound(
  raw: string,
  format: NumberFormat,
  country: string
): string {
  if (!DIGITS_WITH_OPTIONAL_PLUS.test(raw)) {
    return raw;
  }
  if (raw.startsWith('+')) {
    return raw;
  }
  if (raw.startsWith(INTERNATIONAL_PREFIX)) {
    return `+${raw.slice(INTERNATIONAL_PREFIX.length)}`;
  }
  if (format === 'national' && raw.startsWith('0')) {
    return `+${callingCode(country)}${raw.slice(1)}`;
  }
  return raw;
}

/**
 * Normalizes a dialled string to E.164 with the rules of `inbound_number_format = 'national'`
 * (§10.1 Outbound step 4): `+` or `00` is international, a leading `0` is national under `country`'s
 * calling code, and digits without either are incomplete.
 */
export function normalizeDialed(
  raw: string,
  country: string
): { kind: 'e164'; number: string } | { kind: 'incomplete' } {
  if (raw.startsWith('+')) {
    return { kind: 'e164', number: raw };
  }
  if (raw.startsWith(INTERNATIONAL_PREFIX)) {
    return {
      kind: 'e164',
      number: `+${raw.slice(INTERNATIONAL_PREFIX.length)}`
    };
  }
  if (raw.startsWith('0')) {
    return { kind: 'e164', number: `+${callingCode(country)}${raw.slice(1)}` };
  }
  return { kind: 'incomplete' };
}

export function isE164(value: string): boolean {
  return /^\+[0-9]+$/u.test(value);
}

/** The literal caller value for a withheld or absent number (§9.4 "Withheld caller"). */
export const ANONYMOUS = 'anonymous';
