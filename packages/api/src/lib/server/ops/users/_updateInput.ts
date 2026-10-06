/** `users.update`'s input (§10.3 "Users") and the row values it resolves to. */
import { z } from 'zod';

import { findMeSchema, USER_ROLES } from '@zamfono/shared';

import { logLevelInputFields } from '../settings/logLevel.js';
import {
  EMAIL_DESCRIPTION,
  EXTENSION_DESCRIPTION,
  userCallFields,
  type UserRow
} from './_shared.js';

export const updateInputSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    email: z.email().nullable().optional().describe(EMAIL_DESCRIPTION),
    role: z
      .enum(USER_ROLES)
      .optional()
      .describe(
        'owner and admin configure the stack (only an owner writes owner-only settings), user only their own self-service fields; the last owner cannot be demoted.'
      ),
    extension: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(EXTENSION_DESCRIPTION),
    ...userCallFields,
    mailboxAudioId: z
      .string()
      .nullable()
      .optional()
      .describe('The personal voicemail greeting, an audio asset id.'),
    callerIdDidId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The DID presented on the user's outbound calls; null presents the main number, settings.mainDidId (see zamfono.help numbers)."
      ),
    findMe: findMeSchema.optional(),
    ...logLevelInputFields
  })
  .strict();
export type UpdateInput = z.infer<typeof updateInputSchema>;

/** The `users` columns `users.update` writes from its scalar fields. */
export type ResolvedFields = Pick<
  UserRow,
  | 'name'
  | 'email'
  | 'role'
  | 'ringTimeoutS'
  | 'clir'
  | 'rejectAnonymous'
  | 'recordCalls'
  | 'notifyMissedCalls'
  | 'mailboxEnabled'
  | 'mailboxAudioId'
  | 'mailboxMaxMessages'
  | 'callerIdDidId'
  | 'findMeJson'
>;

/** A nullable wire boolean's next column value: unchanged while absent, else `null` or 0/1. */
function nextNullableFlag(
  input: boolean | null | undefined,
  before: number | null
): number | null {
  if (input === undefined) {
    return before;
  }
  return input === null ? null : Number(input);
}

/** `input`'s scalar column values, `before`'s own where `input` omits the field. */
export function resolvedFields(
  before: UserRow,
  input: UpdateInput
): ResolvedFields {
  return {
    name: input.name ?? before.name,
    email: input.email === undefined ? before.email : input.email,
    role: input.role ?? before.role,
    ringTimeoutS: input.ringTimeoutS ?? before.ringTimeoutS,
    clir: nextNullableFlag(input.clir, before.clir),
    rejectAnonymous: nextNullableFlag(
      input.rejectAnonymous,
      before.rejectAnonymous
    ),
    recordCalls:
      input.recordCalls === undefined
        ? before.recordCalls
        : Number(input.recordCalls),
    notifyMissedCalls:
      input.notifyMissedCalls === undefined
        ? before.notifyMissedCalls
        : Number(input.notifyMissedCalls),
    mailboxEnabled:
      input.mailboxEnabled === undefined
        ? before.mailboxEnabled
        : Number(input.mailboxEnabled),
    mailboxAudioId:
      input.mailboxAudioId === undefined
        ? before.mailboxAudioId
        : input.mailboxAudioId,
    mailboxMaxMessages:
      input.mailboxMaxMessages === undefined
        ? before.mailboxMaxMessages
        : input.mailboxMaxMessages,
    callerIdDidId:
      input.callerIdDidId === undefined
        ? before.callerIdDidId
        : input.callerIdDidId,
    findMeJson:
      input.findMe === undefined
        ? before.findMeJson
        : JSON.stringify(input.findMe)
  };
}
