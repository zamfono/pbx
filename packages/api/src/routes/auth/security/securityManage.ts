import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import { z } from 'zod';

import { mfaMethods, nowIso } from '@zamfono/shared';

import type { Dictionary } from '#lib/i18n/index.js';
import { loadBranding } from '#lib/server/auth/branding.js';
import { registerPasskey } from '#lib/server/auth/mfa/passkeys.js';
import { issueRecoveryCodes } from '#lib/server/auth/mfa/recoveryCodes.js';
import { issuer, totpSetup } from '#lib/server/auth/mfa/secondFactorSteps.js';
import { updateSecuritySession } from '#lib/server/auth/mfa/securitySession.js';
import { hasMfa } from '#lib/server/auth/mfa/status.js';
import { matchTotp, newTotpSecret } from '#lib/server/auth/mfa/totp.js';
import { removeTotp, saveTotp } from '#lib/server/auth/mfa/totpCredential.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import {
  added,
  NOTHING,
  removed,
  sessionUser,
  type ManageResult,
  type SignedIn
} from './securityAccount.js';

// A new authenticator accepts any step for its first code.
const NO_STEP_YET = -1;
const MAX_PASSKEY_NAME = 100;

/** The security page's management form: one action per button, with the fields it reads. */
export const ManagePayloadSchema = z.object({
  action: z.enum([
    'totpStart',
    'totpConfirm',
    'totpRemove',
    'passkeyAdd',
    'codes'
  ]),
  code: z.string().catch(''),
  passkey: z.string().catch(''),
  passkeyName: z.string().catch('')
});

export type ManagePayload = z.infer<typeof ManagePayloadSchema>;

type Action = (
  event: RequestEvent,
  signed: SignedIn & { dict: Dictionary },
  payload: ManagePayload
) => Promise<ManageResult>;

/** Each management action: its button's `action` value and what it does. */
const ACTIONS: Record<ManagePayload['action'], Action> = {
  totpStart: async (event, { session, user }) => {
    const secret = newTotpSecret();
    updateSecuritySession(event.cookies, { ...session, totpSecret: secret });
    return {
      ...NOTHING,
      totpSetup: totpSetup(await issuer(), user.email, secret)
    };
  },
  totpConfirm: async (event, { session, user, dict }, { code }) => {
    const { userId, totpSecret: secret } = session;
    const step =
      secret === null
        ? null
        : matchTotp(secret, code.trim(), Date.now(), NO_STEP_YET);
    if (secret === null || step === null) {
      return {
        ...NOTHING,
        totpSetup:
          secret === null
            ? null
            : totpSetup(await issuer(), user.email, secret),
        error: dict.mfa.invalidCode
      };
    }
    updateSecuritySession(event.cookies, { ...session, totpSecret: null });
    const kr = keyringFromEnv(env);
    const result = await added(
      getDb(),
      userId,
      async (trx, now) => {
        await saveTotp(trx, kr, { userId, secret, step }, now);
        return true;
      },
      { kind: 'added' }
    );
    return result ?? NOTHING;
  },
  totpRemove: async (_event, { user, dict }) =>
    removed(
      user,
      async trx => removeTotp(trx, user.id),
      { kind: 'removed' },
      dict.security
    ),
  passkeyAdd: async (_event, { session, dict }, payload) => {
    const { userId, challenge } = session;
    const name =
      payload.passkeyName.trim().slice(0, MAX_PASSKEY_NAME) ||
      dict.mfa.passkeyDefaultName;
    const result =
      challenge === null
        ? null
        : await added(
            getDb(),
            userId,
            async (trx, now) =>
              registerPasskey(
                trx,
                { userId, challenge, name },
                payload.passkey,
                now
              ),
            { kind: 'added', passkeyName: name }
          );
    return result ?? { ...NOTHING, error: dict.mfa.passkeyFailed };
  },
  codes: async (_event, { user, dict }) => {
    const db = getDb();
    if (!hasMfa(await mfaMethods(db, user.id))) {
      return { ...NOTHING, error: dict.security.codesNeedMethod };
    }
    return {
      ...NOTHING,
      codes: await issueRecoveryCodes(db, user.id, nowIso())
    };
  }
};

/** The security page's management form (§5.2 "Two-factor authentication"). */
export async function manageSubmit(
  event: RequestEvent,
  payload: ManagePayload
): Promise<ManageResult> {
  const signed = await sessionUser(event);
  const { dictionary } = await loadBranding(getDb());
  return ACTIONS[payload.action](
    event,
    { ...signed, dict: dictionary },
    payload
  );
}

/** A passkey's own removal form, by its id among the user's passkeys. */
export async function removePasskeySubmit(
  event: RequestEvent,
  id: string
): Promise<ManageResult> {
  const { user } = await sessionUser(event);
  const db = getDb();
  const passkey = await db
    .selectFrom('webauthnCredentials')
    .select('name')
    .where('id', '=', id)
    .where('userId', '=', user.id)
    .executeTakeFirst();
  if (passkey === undefined) {
    return NOTHING;
  }
  const { dictionary } = await loadBranding(db);
  return removed(
    user,
    async trx => {
      await trx
        .deleteFrom('webauthnCredentials')
        .where('id', '=', id)
        .execute();
    },
    { kind: 'removed', passkeyName: passkey.name },
    dictionary.security
  );
}
