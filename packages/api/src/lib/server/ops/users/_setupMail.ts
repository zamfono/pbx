import { originFromEnv } from '#lib/server/stackAddress.js';

const SET_PASSWORD_PATH = '/auth/set-password';

/**
 * The absolute `https://<FQDN>/auth/set-password?token=` link a setup or reset mail carries (§5.2,
 * §10.2 "Mail"), the path the page is mounted at.
 */
export function setupLinkFor(token: string): string {
  return `${originFromEnv()}${SET_PASSWORD_PATH}?token=${token}`;
}
