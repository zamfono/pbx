import * as env from '$app/env/private';

import { HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { stackDomain, stackOrigin } from '#lib/server/stackAddress.js';

import { OpError } from '../types.js';

const SET_PASSWORD_PATH = '/auth/set-password';

/**
 * The absolute `https://<FQDN>/auth/set-password?token=` link a setup or reset mail carries (§5.2,
 * §10.2 "Mail"), the path the page is mounted at; throws `OpError(503)` while `FQDN` is unset,
 * since a relative link would not open from a mail client and the admin has nothing usable to
 * pass on either (§10.2 "Without a relay").
 */
export function setupLinkFor(token: string): string {
  const fqdn = stackDomain(env);
  if (fqdn === null) {
    throw new OpError(
      HTTP_SERVICE_UNAVAILABLE,
      'FQDN is not configured for this deployment'
    );
  }
  return `${stackOrigin(fqdn)}${SET_PASSWORD_PATH}?token=${token}`;
}
