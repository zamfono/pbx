import {
  HTTP_UNPROCESSABLE_CONTENT,
  type TrunkAuthMode
} from '@zamfono/shared';

import { OpError } from '../types.js';
import type { HostInput } from './_shared.js';
import { assertValidPassword, assertValidUsername } from './hostValidation.js';

/** The credential and registration fields of a `trunks.update` request these checks read. */
export type CredentialInput = {
  username?: string | null;
  password?: string | null;
  registerExpiryS?: number | null;
  registerRetryS?: number | null;
};

/**
 * Throws 422 when `input` explicitly sets a non-null `username`/`password` on a merged trunk
 * whose auth mode carries no credentials — `mergeScalars` always nulls both in that case, so this
 * checks the raw input rather than the merge, mirroring create's refusal for the same input.
 */
export function assertNoStrayCredentials(
  required: boolean,
  input: CredentialInput
): void {
  const usernameGiven = input.username !== undefined && input.username !== null;
  const passwordGiven = input.password !== undefined && input.password !== null;
  if (!required && (usernameGiven || passwordGiven)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'username and password are only accepted for registration auth or inbound auth'
    );
  }
}

/**
 * Throws 422 when `input` explicitly sets a non-null `registerExpiryS`/`registerRetryS` on a
 * merged trunk whose auth mode is `ip`, mirroring the `trunks` CHECK constraint of §11.2.
 */
export function assertNoStrayRegistrationFields(
  authMode: TrunkAuthMode,
  input: CredentialInput
): void {
  const expiryGiven =
    input.registerExpiryS !== undefined && input.registerExpiryS !== null;
  const retryGiven =
    input.registerRetryS !== undefined && input.registerRetryS !== null;
  if (authMode !== 'registration' && (expiryGiven || retryGiven)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'registerExpiryS and registerRetryS are only accepted for registration auth'
    );
  }
}

/** Throws 422 for a raw `input.username`/`input.password` unsafe to interpolate into config. */
export function assertValidCredentialFields(input: CredentialInput): void {
  if (input.username !== undefined && input.username !== null) {
    assertValidUsername(input.username);
  }
  if (input.password !== undefined && input.password !== null) {
    assertValidPassword(input.password);
  }
}

/**
 * Where a trunk's password can go (§9.4): every host it dials or registers to, by host and port
 * (a null port resolves through SRV, so it is a destination of its own), and its outbound proxy.
 * An inbound-only host is never sent anything, so it is not one.
 */
export function passwordDestinations(
  hosts: readonly HostInput[],
  outboundProxy: string | null
): Set<string> {
  const destinations = hosts
    .filter(host => host.direction !== 'inbound')
    .map(host => `host ${host.host} ${host.port ?? ''}`);
  if (outboundProxy !== null) {
    destinations.push(`proxy ${outboundProxy}`);
  }
  return new Set(destinations);
}

/**
 * Throws 422 when `after` names a destination `before` did not, for an update that keeps the
 * stored password (§5.4): the password must not follow the trunk to a registrar or proxy it was
 * not given for. Removing a destination, reordering hosts or changing an inbound-only one needs
 * no password.
 */
export function assertPasswordFollowsDestinations(
  before: Set<string>,
  after: Set<string>
): void {
  if ([...after].some(dest => !before.has(dest))) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'a new outbound host or outboundProxy needs the trunk password again'
    );
  }
}
