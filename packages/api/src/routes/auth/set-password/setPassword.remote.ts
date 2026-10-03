import { redirect } from '@sveltejs/kit';
import { form } from '$app/server';
import { z } from 'zod';

import { HTTP_SEE_OTHER } from '@zamfono/shared';

import { MIN_PASSWORD_LENGTH } from '#lib/auth/passwordPolicy.js';
import { format } from '#lib/i18n/index.js';
import { loadBranding } from '#lib/server/auth/branding.js';
import { redeemPasswordReset } from '#lib/server/auth/passwordReset.js';
import { getDb } from '#lib/server/db.js';

// Where a set password lands: this same page's confirmation (`+page.server.ts`'s `done`), reached
// by a redirect because the link it came from no longer redeems once it has been used.
const PASSWORD_SET_LOCATION = '/auth/set-password?done';

/** The leading underscore keeps the password out of the re-rendered page: SvelteKit repopulates
 *  a non-enhanced submission's fields from the submitted values, and skips the underscored ones.
 *  Any submission reaches the handler, which leaves validation to `redeemPasswordReset`, the
 *  same function `POST /auth/reset` runs. */
const SetPasswordPayloadSchema = z.object({
  token: z.string().catch(''),
  _password: z.string().catch('')
});

/** A refused submission's message, rendered above the form (§5.2). */
export type SetPasswordRefusal = { message: string };

/**
 * The set-password form (§5.2 "Authentication pages": the target of the setup and reset mail
 * links), over the same `redeemPasswordReset` as `POST /auth/reset`. A set password redirects to
 * the page's confirmation; a refusal re-renders the form with its message, the password box
 * empty.
 */
export const setPassword = form(
  SetPasswordPayloadSchema,
  async ({ token, _password: password }): Promise<SetPasswordRefusal> => {
    const db = getDb();
    const outcome = await redeemPasswordReset(db, { token, password });
    if (outcome.kind === 'passwordSet') {
      redirect(HTTP_SEE_OTHER, PASSWORD_SET_LOCATION);
    }
    const dict = (await loadBranding(db)).dictionary.setPassword;
    const tooShort =
      outcome.kind === 'invalidRequest' &&
      password.length < MIN_PASSWORD_LENGTH;
    return {
      message: tooShort
        ? format(dict.tooShort, { min: String(MIN_PASSWORD_LENGTH) })
        : dict.invalid
    };
  }
);
