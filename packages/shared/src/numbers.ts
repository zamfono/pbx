// The full metadata: `isValid()` checks the real number patterns, which the default (min)
// metadata only approximates.
import {
  getCountryCallingCode,
  Metadata,
  parseDigits,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber
} from 'libphonenumber-js/max';

import type { NumberFormat } from './columnValues.js';

export { isSupportedCountry, type CountryCode } from 'libphonenumber-js/max';

/** A string made only of digits with an optional leading `+`, the shape the trunk boundary can normalize. */
const DIGITS_WITH_OPTIONAL_PLUS = /^\+?[0-9]+$/u;

/** Whether `raw` is a number the trunk boundary normalizes, digits with an optional leading `+`
 *  (§9.4 "Inbound number normalization"), rather than a string it passes verbatim. */
export function isInboundNumber(raw: string): boolean {
  return DIGITS_WITH_OPTIONAL_PLUS.test(raw);
}

/** The calling code of a country, e.g. `'DE'` → `'49'`. */
export function callingCode(country: CountryCode): string {
  return getCountryCallingCode(country);
}

/** Whether `raw` starts with `country`'s own international prefix (`00`, `011`, `0011` …). */
function hasIddPrefix(raw: string, country: CountryCode): boolean {
  const metadata = new Metadata();
  metadata.selectNumberingPlan(country);
  const idd = metadata.numberingPlan?.IDDPrefix();
  return idd !== undefined && new RegExp(`^(?:${idd})`, 'u').test(raw);
}

/**
 * The trunk prefix `parsed` is dialled with within its country: its national format's digits
 * ahead of the national number, `0` for `+4989123456` (`089123456`), nothing for an Italian
 * number, which keeps its `0` in the national number, or a NANP one, dialled with ten digits.
 */
function trunkPrefix(parsed: PhoneNumber): string {
  const national = parseDigits(parsed.formatNational());
  return national.endsWith(parsed.nationalNumber)
    ? national.slice(0, national.length - parsed.nationalNumber.length)
    : '';
}

/**
 * `raw`, digits with an optional leading `+`, in the international form as dialled in `country`
 * (§9.4 "Inbound number normalization", §10.1 step 4): a leading `+` is already international;
 * otherwise a valid number dialled with the country's own international prefix, or a national one
 * dialled with its trunk prefix (Germany's `0`), bare where the country dials none (Italy, the US's
 * ten digits). `null` for anything else.
 */
function internationalForm(raw: string, country: CountryCode): string | null {
  if (!DIGITS_WITH_OPTIONAL_PLUS.test(raw)) {
    return null;
  }
  if (raw.startsWith('+')) {
    return raw;
  }
  const parsed = parsePhoneNumberFromString(raw, country);
  if (parsed?.isValid() !== true) {
    return null;
  }
  return hasIddPrefix(raw, country) || raw.startsWith(trunkPrefix(parsed))
    ? parsed.number
    : null;
}

/**
 * Normalizes a called or calling party at the trunk boundary per `trunks.inbound_number_format`
 * (§9.4 "Inbound number normalization"): `e164` takes `+digits` as they are; `national` reads the
 * number as dialled in `country`. Anything else passes through unchanged: a provider's verbatim
 * account string, a number carrying whitespace, or one that is no valid number dialled that way.
 */
export function normalizeInbound(
  raw: string,
  format: NumberFormat,
  country: CountryCode
): string {
  return format === 'national' ? (internationalForm(raw, country) ?? raw) : raw;
}

/**
 * Normalizes a dialled string to E.164 as dialled in `country` (§10.1 Outbound step 4): what does
 * not parse to a valid number dialled that way is incomplete.
 */
export function normalizeDialed(
  raw: string,
  country: CountryCode
): { kind: 'e164'; number: string } | { kind: 'incomplete' } {
  const number = internationalForm(raw, country);
  return number === null ? { kind: 'incomplete' } : { kind: 'e164', number };
}

/**
 * `number` (E.164) as dialled within `country` (§9.4 "Caller-ID" `national`): a valid number
 * of the country's calling code in its national digits (`+4989123` → `089123`, `+390612345678` →
 * `0612345678`, `+12125551234` → `2125551234`); any other number unchanged.
 */
export function nationalForm(number: string, country: CountryCode): string {
  const parsed = parsePhoneNumberFromString(number);
  return parsed?.countryCallingCode === callingCode(country) && parsed.isValid()
    ? parseDigits(parsed.formatNational())
    : number;
}

export function isE164(value: string): boolean {
  return /^\+[0-9]+$/u.test(value);
}

/** The literal caller value for a withheld or absent number (§9.4 "Withheld caller"). */
export const ANONYMOUS = 'anonymous';
