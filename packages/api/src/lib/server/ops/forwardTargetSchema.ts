import { z } from 'zod';

import {
  ALWAYS_FORBIDDEN_REASON,
  DEFAULT_SIP_HEADERS,
  DEFAULT_VONAGE_SAMPLE_RATE,
  isAlwaysForbiddenLiteral,
  isE164,
  TWILIO_SAMPLE_RATE,
  WEB_SOCKET_PROTOCOLS,
  WEB_SOCKET_SAMPLE_RATES,
  WEB_SOCKET_URL_MAX_LENGTH,
  type SipHeaderTemplate,
  type WebSocketProtocol,
  type WebSocketSampleRate
} from '@zamfono/shared';

import { sipHeadersSchema } from './sipHeaders.js';
import { timeoutSeconds } from './timeoutInput.js';

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

/** How long an `external` or `sip` target rings before it counts as not working (§10.1 step 7). */
const ringTimeoutSchema = timeoutSeconds
  .nullable()
  .default(null)
  .describe(
    'Seconds the target may ring, across every route and host it is tried on, before the call goes to its fallback, else ends unanswered (480); null rings until the far end decides.'
  );

/** The URL a `webSocket` target connects to (§9.4 "WebSocket targets"); `forward_targets`' CHECK
 * holds the same. An address literal no connection could reach is refused at once (§3.1
 * "Outbound targets"). */
const webSocketUrlSchema = z
  .url({ protocol: /^wss?$/u, hostname: z.regexes.hostname })
  .max(WEB_SOCKET_URL_MAX_LENGTH)
  .refine(url => !isAlwaysForbiddenLiteral(URL.parse(url)?.hostname ?? ''), {
    message: ALWAYS_FORBIDDEN_REASON
  })
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

/** A `webSocket` target (§9.4 "WebSocket targets"); its sample rate is checked and filled in on
 * the union (`targetSpecSchema`), whose own type its fallback nests. */
const webSocketTargetSchema = z.strictObject({
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
  record: recordSchema,
  get fallback(): FallbackSchema {
    // eslint-disable-next-line no-use-before-define -- a fallback nests the union this kind is in
    return fallbackSchema();
  }
});

/** An `external`, `sip` or `webSocket` target's `fallback`: where the call goes when the target
 * does not work, any target, itself with a fallback of its own (§10.1 step 7). */
type FallbackSchema = z.ZodType<TargetSpec | null>;

let builtFallbackSchema: FallbackSchema | undefined;

/** `FallbackSchema`, built once on first use, since the union it nests is still being defined
 * where the kinds name it; one instance, so a JSON Schema export sees the recursion. */
function fallbackSchema(): FallbackSchema {
  // eslint-disable-next-line no-use-before-define -- called only once the union is defined
  builtFallbackSchema ??= targetSpecSchema
    .nullable()
    .default(null)
    .describe(
      'Where the call goes when this target does not work (no route or trunk, a failure or refusal, the ring timeout, a bot that cannot be reached): any target, which may have a fallback of its own; null ends the call as without one.'
    )
    .meta({ id: 'ForwardTargetFallback' });
  return builtFallbackSchema;
}

/**
 * The shared target vocabulary a ring group's forwarding rule or a menu's fallback/DTMF option
 * points at (§11.2 `forward_targets`). One of the union's kinds maps to exactly one of the
 * table's nine exclusive targets, `sip`'s and `webSocket`'s being their column sets; each is
 * strict, so a field of another kind, such as `record` on a `user` target, is refused rather
 * than dropped.
 */
export const targetSpecSchema: z.ZodType<TargetSpec> = z
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
    z
      .strictObject({
        kind: z
          .literal('external')
          .describe('Dials an external number through the outbound routes.'),
        external: z
          .string()
          .refine(isE164, 'external must be E.164')
          .describe('The number to dial, E.164 such as +4930123456.'),
        ringTimeoutS: ringTimeoutSchema,
        record: recordSchema,
        get fallback(): FallbackSchema {
          return fallbackSchema();
        }
      })
      .meta({ id: 'ExternalTarget' }),
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
      ringTimeoutS: ringTimeoutSchema,
      record: recordSchema,
      get fallback(): FallbackSchema {
        return fallbackSchema();
      }
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
  // A `twilio` target at a rate other than 8000 is refused, and one without a rate gets its
  // protocol's (`webSocketSampleRate`), which it returns as every read does.
  .refine(
    target =>
      target.kind !== 'webSocket' ||
      target.protocol !== 'twilio' ||
      webSocketSampleRate(target) === TWILIO_SAMPLE_RATE,
    { message: 'a twilio target is always 8000 Hz', path: ['sampleRate'] }
  )
  .overwrite(target =>
    target.kind === 'webSocket'
      ? { ...target, sampleRate: webSocketSampleRate(target) }
      : target
  )
  // Named, since a fallback nests it: a JSON Schema export refers to it as `$defs/ForwardTarget`,
  // which the OpenAPI document lifts into its components (`openapi.ts`).
  .meta({ id: 'ForwardTarget' })
  .describe(
    'Where the call goes: one of nine kinds, chosen by `kind` (see zamfono.help mental-model).'
  );
/**
 * What a `user` reads in place of a target an admin set on their own forwarding rule, OOO rule or
 * opening hours (§10.3 "Forward targets"), a chain holding a `sip` or `webSocket` target, or an
 * `external` one that records, anywhere in it: its kind alone, never its number, URL, token or
 * headers. Sent back unchanged in the same place, it keeps the admin's target as it is.
 */
export const managedTargetSchema = z
  .strictObject({
    managed: z.literal(true),
    kind: z.enum(['external', 'sip', 'webSocket'])
  })
  .meta({ id: 'ManagedForwardTarget' })
  .describe(
    "A target an admin set, as a user reads it: send it back unchanged in the same place to keep the admin's target, or send another target, or leave the rule out, to replace or remove it."
  );
export type ManagedTarget = z.infer<typeof managedTargetSchema>;

/** A target a `user` may read and write in its masked form (`managedTargetSchema`): their own
 * forwarding rule's, OOO rule's and opening hours' closed one. */
export const ownTargetSchema = z.union([managedTargetSchema, targetSpecSchema]);
export type OwnTarget = ManagedTarget | TargetSpec;

/** What `targetSpecSchema` parses to, written out since its fallback nests it (`fallbackSchema`).
 * `ringTimeoutS` and `fallback` are always set on a parsed or read target; a target built in code
 * may leave them out for `null`. */
export type TargetSpec =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | {
      kind: 'external';
      external: string;
      ringTimeoutS?: number | null;
      record: boolean;
      fallback?: TargetSpec | null;
    }
  | {
      kind: 'sip';
      trunkId: string;
      user: string;
      headers: SipHeaderTemplate[];
      ringTimeoutS?: number | null;
      record: boolean;
      fallback?: TargetSpec | null;
    }
  | {
      kind: 'webSocket';
      protocol: WebSocketProtocol;
      url: string;
      sampleRate?: WebSocketSampleRate;
      record: boolean;
      fallback?: TargetSpec | null;
    }
  | { kind: 'mailboxUser'; userId: string }
  | { kind: 'mailboxRingGroup'; ringGroupId: string }
  | { kind: 'announcement'; audioId: string }
  | { kind: 'menu'; menuId: string };
