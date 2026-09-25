import { callingCode } from '@zamfono/shared';

/**
 * Whether `country` is an ISO 3166-1 alpha-2 code libphonenumber knows (§11.4 `country`): the
 * national-number rules of §9.4 resolve the tenant's calling code from it, and a code outside that
 * set, such as `UK` for `GB`, has none. Shared by `settings.update` and the first-boot seed.
 */
export function isKnownCountry(country: string): boolean {
  try {
    callingCode(country);
    return true;
  } catch {
    return false;
  }
}
