import { z } from 'zod';

import { DEFAULT_SIP_HEADERS, isE164 } from '@zamfono/shared';

import { sipHeadersSchema } from './sipHeaders.js';

/**
 * A `sip` target's request-URI user part (§9.4 "SIP targets"): RFC 3261's unreserved `.`, `_`,
 * `~`, `-` and the user-unreserved `+` beside letters and digits, a subset that needs no escaping
 * and cannot reach into the `PJSIP/<user>@<endpoint>` dial string; `forward_targets`' CHECK holds
 * the same.
 */
const SIP_USER_PATTERN = /^[A-Za-z0-9._~+-]{1,64}$/u;

/**
 * Whether an `external` or `sip` target records the trunk leg it answers on (§10.2 "Recording
 * semantics"); admin-only like a `sip` target (`forwardTargets.ts`).
 */
const recordSchema = z
  .boolean()
  .default(false)
  .describe(
    'Records every call this target answers, whatever forwarded it; admin-only, left out false.'
  );

/**
 * The shared target vocabulary a ring group's forwarding rule or a menu's fallback/DTMF option
 * points at (§11.2 `forward_targets`). One of the union's variants maps to exactly one of the
 * table's eight exclusive targets, `sip`'s being its column pair; each is strict, so a field of
 * another kind, such as `record` on a `user` target, is refused rather than dropped.
 */
export const targetSpecSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z
        .literal('user')
        .describe('Rings a user through the routing pipeline.'),
      userId: z.string()
    }),
    z.strictObject({
      kind: z
        .literal('ringGroup')
        .describe('Rings a ring group through the routing pipeline.'),
      ringGroupId: z.string()
    }),
    z.strictObject({
      kind: z
        .literal('external')
        .describe('Dials an external number through the outbound routes.'),
      external: z
        .string()
        .refine(isE164, 'external must be E.164')
        .describe('The number to dial, E.164 such as +4930123456.'),
      record: recordSchema
    }),
    z.strictObject({
      kind: z
        .literal('sip')
        .describe(
          "Dials a SIP address at one trunk's hosts, bypassing the outbound routes; admin-only."
        ),
      trunkId: z
        .string()
        .describe('The trunk whose outbound hosts are dialled.'),
      user: z
        .string()
        .regex(SIP_USER_PATTERN, 'user must be 1-64 of A-Z a-z 0-9 . _ ~ + -')
        .describe('The request URI user part: sip:<user>@<trunk host>.'),
      // §9.4 "Header templates": left out on a write, the defaults, which the write returns as
      // every read does.
      headers: sipHeadersSchema
        .default(() => [...DEFAULT_SIP_HEADERS])
        .describe(
          'Custom X- headers the leg sends, values with {{placeholder}} substitutions; left out, X-Zamfono-Caller and X-Zamfono-Did (see zamfono.help forward-to-ai-agent).'
        ),
      record: recordSchema
    }),
    z.strictObject({
      kind: z
        .literal('mailboxUser')
        .describe("Deposits the caller in a user's mailbox without ringing."),
      userId: z.string()
    }),
    z.strictObject({
      kind: z
        .literal('mailboxRingGroup')
        .describe(
          "Deposits the caller in a ring group's mailbox without ringing."
        ),
      ringGroupId: z.string()
    }),
    z.strictObject({
      kind: z
        .literal('announcement')
        .describe('Plays an audio asset and ends the call.'),
      audioId: z.string().describe('The audio asset to play (audio.list).')
    }),
    z.strictObject({
      kind: z
        .literal('menu')
        .describe("Plays a menu's greeting and collects DTMF."),
      menuId: z.string()
    })
  ])
  .describe(
    'Where the call goes: one of eight kinds, chosen by `kind` (see zamfono.help mental-model).'
  );
export type TargetSpec = z.infer<typeof targetSpecSchema>;
