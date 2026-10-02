import { z } from 'zod';

import { memberSchema } from '../members.js';

/**
 * The fields `ringGroups.create` takes and `ringGroups.update` takes each optionally (§10.1 step 5,
 * §11.2).
 */
export const ringGroupFields = {
  name: z.string().min(1),
  strategy: z
    .enum(['simultaneous', 'sequential', 'random'])
    .describe(
      'simultaneous rings every ringable member at once; sequential one at a time in member order; random one at a time in a shuffled order.'
    ),
  ringTimeoutS: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Seconds of ringing before the unanswered rule: in total for simultaneous, per member for sequential and random; 20 by default.'
    ),
  ringTotalS: z
    .number()
    .int()
    .positive()
    .nullish()
    .describe(
      'Overall cap in seconds for sequential and random; null: no cap.'
    ),
  skipBusy: z
    .boolean()
    .optional()
    .describe(
      'Skips members already in a call (on by default); off, they are rung on their other devices as call waiting.'
    ),
  allowReject: z
    .boolean()
    .optional()
    .describe(
      "A member's decline stops ringing all their devices, and the fallback fires early once everyone declined (on by default); off, a decline is ignored."
    ),
  greetingAudioId: z
    .string()
    .nullish()
    .describe('An audio asset played to the caller before ringing.'),
  mohAudioId: z
    .string()
    .nullish()
    .describe('An audio asset played instead of ringback while ringing.'),
  recordCalls: z
    .boolean()
    .optional()
    .describe(
      "Records the group's calls regardless of the answerer's own flag (see zamfono.help recording-consent)."
    ),
  mailboxEnabled: z
    .boolean()
    .optional()
    .describe(
      'Gives the group a voicemail box, where the call goes without an unanswered rule; off by default.'
    ),
  mailboxAudioId: z
    .string()
    .nullish()
    .describe("The group mailbox's greeting, an audio asset id."),
  members: z
    .array(memberSchema)
    .optional()
    .describe(
      'Users and user groups (nested ones flattened), in ring order; replaces the list as a whole.'
    )
};
