import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { OpError } from '../types.js';
import { type AuthMode } from './_shared.js';
import { assertValidPassword, assertValidUsername } from './hostValidation.js';

/** The credential and registration fields of a `trunks.update` request these checks read. */
export type CredentialInput = {
  username?: string | null;
  password?: string;
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
  const passwordGiven = input.password !== undefined;
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
  authMode: AuthMode,
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
  if (input.password !== undefined) {
    assertValidPassword(input.password);
  }
}
