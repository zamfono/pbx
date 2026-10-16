import { z } from 'zod';

import {
  DEFAULT_SIP_HEADERS,
  DEFAULT_VONAGE_SAMPLE_RATE,
  isE164,
  TWILIO_SAMPLE_RATE,
  WEB_SOCKET_PROTOCOLS,
  WEB_SOCKET_SAMPLE_RATES,
  WEB_SOCKET_URL_MAX_LENGTH,
  type WebSocketProtocol,
  type WebSocketSampleRate
} from '@zamfono/shared';

import { sipHeadersSchema } from './sipHeaders.js';

/**
 * A `sip` target's request-URI user part (§9.4 "SIP targets"): RFC 3261's unreserved `.`, `_`,
 * `~`, `-` and the user-unreserved `+` beside letters and digits, a subset that needs no escaping
 * and cannot reach into the `PJSIP/<user>@<endpoint>` dial string; `forward_targets`' CHECK holds
 * the same.
 */
const SIP_USER_PATTERN = /^[A-Za-z0-9._~+-]{1,64}$/u;

/**
 * Whether an `external`, `sip` or `webSocket` target records the leg it answers on (§10.2
 * "Recording semantics"); admin-only like a `sip` target (`forwardTargets.ts`).
 */
const recordSchema = z
  .boolean()
  .default(false)
  .describe(
    'Records every call this target answers, whatever forwarded it; admin-only, left out false.'
  );

/** The URL a `webSocket` target connects to (§9.4 "WebSocket targets"); `forward_targets`' CHECK
 * holds the same. */
const webSocketUrlSchema = z
  .url({ protocol: /^wss?$/u, hostname: z.regexes.hostname })
  .max(WEB_SOCKET_URL_MAX_LENGTH)
  .describe(
    "The bot's WebSocket URL, wss:// (or ws://), at most 2048 characters; a token the bot checks goes in its query string."
  );

/** The sample rate a `webSocket` target speaks at (§9.4 "WebSocket targets"): `twilio` always 8000,
 * `vonage` the one given, 16000 unless given. */
export function webSocketSampleRate(target: {
  protocol: WebSocketProtocol;
  sampleRate?: WebSocketSampleRate | undefined;
}): WebSocketSampleRate {
  return (
    target.sampleRate ??
    (target.protocol === 'twilio'
      ? TWILIO_SAMPLE_RATE
      : DEFAULT_VONAGE_SAMPLE_RATE)
  );
}

/** A `webSocket` target (§9.4 "WebSocket targets"); a `twilio` one at a rate other than 8000 is
 * refused, and one without a rate gets its protocol's (`webSocketSampleRate`). */
const webSocketTargetSchema = z
  .strictObject({
    kind: z
      .literal('webSocket')
      .describe(
        'Hands the call to a voice bot over a WebSocket, which answers it; admin-only.'
      ),
    protocol: z
      .enum(WEB_SOCKET_PROTOCOLS)
      .describe(
        'twilio: Twilio Media Streams, JSON frames of base64 mu-law at 8 kHz; vonage: the Vonage Voice API WebSocket, binary 16-bit PCM (see zamfono.help forward-to-voice-bot).'
      ),
    url: webSocketUrlSchema,
    sampleRate: z
      .literal(WEB_SOCKET_SAMPLE_RATES)
      .optional()
      .describe(
        'The PCM sample rate in Hz: 8000, 16000 or 24000 for vonage, left out 16000; always 8000 for twilio.'
      ),
    record: recordSchema
  })
  .refine(
    target =>
      target.protocol !== 'twilio' ||
      webSocketSampleRate(target) === TWILIO_SAMPLE_RATE,
    { message: 'a twilio target is always 8000 Hz', path: ['sampleRate'] }
  )
  // A write left without the rate gets its protocol's, which it returns as every read does.
  .overwrite(target => ({
    ...target,
    sampleRate: webSocketSampleRate(target)
  }));

/**
 * The shared target vocabulary a ring group's forwarding rule or a menu's fallback/DTMF option
 * points at (§11.2 `forward_targets`). One of the union's kinds maps to exactly one of the
 * table's nine exclusive targets, `sip`'s and `webSocket`'s being their column sets; each is
 * strict, so a field of another kind, such as `record` on a `user` target, is refused rather
 * than dropped.
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
    webSocketTargetSchema,
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
    'Where the call goes: one of nine kinds, chosen by `kind` (see zamfono.help mental-model).'
  );
export type TargetSpec = z.infer<typeof targetSpecSchema>;
