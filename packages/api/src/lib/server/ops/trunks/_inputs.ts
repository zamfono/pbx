import { z } from 'zod';

import {
  CALLERID_HEADERS,
  codecsSchema,
  DIVERSION_POLICIES,
  NUMBER_FORMATS,
  TRUNK_AUTH_MODES,
  TRUNK_TRANSPORTS
} from '@zamfono/shared';

import { logLevelInputFields } from '../settings/logLevel.js';
import { timeoutSeconds } from '../timeoutInput.js';
import { hostInputSchema } from './_shared.js';

/**
 * What each trunk field means (§9.4), one sentence each, which `trunks.create` and
 * `trunks.update` hand to their tool and OpenAPI schemas alike (§10.5).
 */
const FIELD = {
  emergency:
    "Whether this provider carries emergency calls to the company's registered address; emergency calls try only such trunks (see zamfono.help emergency-calls).",
  authMode:
    "registration: the stack registers with username and password; ip: the provider whitelists the stack's address and nothing registers.",
  username:
    'The provider account name, for registration and digest auth; callerIdHeader pai needs one.',
  password: 'The provider account password; write-only, read as passwordSet.',
  inboundAuth:
    "Challenges the provider's INVITEs and identifies the trunk by its username, so it needs no inbound hosts; either auth mode.",
  transport: 'SIP signalling transport: udp (default), tcp or tls.',
  srtp: 'Encrypts the media with SDES-SRTP, for a provider that requires it; tls trunks only.',
  tlsVerify:
    "On a tls trunk, checks that the provider's certificate chains to a public CA and names the host; default true, false only for a self-signed certificate.",
  qualify:
    "Probes an ip trunk's first host with OPTIONS every 60 seconds for its status; default true; false, for an endpoint that answers none, reads unmonitored and is always tried.",
  diversion:
    'What a call forwarded out over this trunk tells the far end about who forwarded it: off (default) nothing, last the newest forward, all every forward.',
  outboundProxy:
    'A SIP outbound proxy every request goes through, such as sip:proxy.example.com;lr.',
  registerExpiryS: 'Registration expiry in seconds; registration trunks only.',
  registerRetryS:
    'Seconds between registration retries after a failure; registration trunks only.',
  inboundNumberFormat:
    'How the provider sends numbers: e164 (default; + and digits, anything else verbatim) or national (as dialled in settings.country, with its own international and trunk prefixes); see zamfono.help numbers.',
  callerIdFormat:
    'How the presented caller number is sent: e164 (default) or national.',
  callerIdHeader:
    'Where the presented number goes: from (default) in From; pai in P-Asserted-Identity with From the account identity (needs username); both in From and P-Asserted-Identity.',
  clir: 'Withholds the caller number on calls over this trunk; null inherits settings.clir; true needs callerIdHeader pai or both.',
  codecs:
    "The trunk's ordered codec offer; left out or null: the tenant's settings.codecs.",
  maxChannels:
    'Concurrent calls the provider sells on the trunk; an outbound call past it falls through to the next route; left out or null: unlimited.',
  hosts:
    'The ordered host list: where calls and registration go and where the provider sends from, each by its direction.'
};

/** `POST /trunks`'s body (§10.3 Trunks). */
export const createInputSchema = z
  .object({
    name: z.string().min(1),
    // Required, so every trunk carries the admin's explicit choice (§9.4 "Emergency trunks").
    emergency: z.boolean().describe(FIELD.emergency),
    authMode: z.enum(TRUNK_AUTH_MODES).describe(FIELD.authMode),
    username: z.string().min(1).optional().describe(FIELD.username),
    password: z.string().min(1).optional().describe(FIELD.password),
    inboundAuth: z.boolean().optional().describe(FIELD.inboundAuth),
    transport: z.enum(TRUNK_TRANSPORTS).optional().describe(FIELD.transport),
    srtp: z.boolean().optional().describe(FIELD.srtp),
    // Default true: a new TLS trunk checks the provider's certificate (§9.4 "Signaling").
    tlsVerify: z.boolean().optional().describe(FIELD.tlsVerify),
    // Default true: a new `ip` trunk's contact is probed for its status (§9.4 "Provisioning and
    // status"); false for an endpoint that answers no OPTIONS.
    qualify: z.boolean().optional().describe(FIELD.qualify),
    // Default 'off': a new trunk's forwarded legs carry no `Diversion` until the admin opts in
    // (§9.4 "Forwarded calls").
    diversion: z.enum(DIVERSION_POLICIES).optional().describe(FIELD.diversion),
    outboundProxy: z.string().min(1).optional().describe(FIELD.outboundProxy),
    registerExpiryS: timeoutSeconds.optional().describe(FIELD.registerExpiryS),
    registerRetryS: timeoutSeconds.optional().describe(FIELD.registerRetryS),
    inboundNumberFormat: z
      .enum(NUMBER_FORMATS)
      .optional()
      .describe(FIELD.inboundNumberFormat),
    callerIdFormat: z
      .enum(NUMBER_FORMATS)
      .optional()
      .describe(FIELD.callerIdFormat),
    callerIdHeader: z
      .enum(CALLERID_HEADERS)
      .optional()
      .describe(FIELD.callerIdHeader),
    clir: z.boolean().nullable().optional().describe(FIELD.clir),
    codecs: codecsSchema.optional().describe(FIELD.codecs),
    maxChannels: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(FIELD.maxChannels),
    hosts: z.array(hostInputSchema).min(1).describe(FIELD.hosts)
  })
  .strict();

/** `PATCH /trunks/{id}`'s body (§10.3 Trunks): every field optional, `null` clearing a nullable one. */
export const updateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    emergency: z.boolean().optional().describe(FIELD.emergency),
    authMode: z.enum(TRUNK_AUTH_MODES).optional().describe(FIELD.authMode),
    username: z.string().min(1).nullable().optional().describe(FIELD.username),
    password: z.string().min(1).nullable().optional().describe(FIELD.password),
    inboundAuth: z.boolean().optional().describe(FIELD.inboundAuth),
    transport: z.enum(TRUNK_TRANSPORTS).optional().describe(FIELD.transport),
    srtp: z.boolean().optional().describe(FIELD.srtp),
    tlsVerify: z.boolean().optional().describe(FIELD.tlsVerify),
    qualify: z.boolean().optional().describe(FIELD.qualify),
    diversion: z.enum(DIVERSION_POLICIES).optional().describe(FIELD.diversion),
    outboundProxy: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(FIELD.outboundProxy),
    registerExpiryS: timeoutSeconds
      .nullable()
      .optional()
      .describe(FIELD.registerExpiryS),
    registerRetryS: timeoutSeconds
      .nullable()
      .optional()
      .describe(FIELD.registerRetryS),
    inboundNumberFormat: z
      .enum(NUMBER_FORMATS)
      .optional()
      .describe(FIELD.inboundNumberFormat),
    callerIdFormat: z
      .enum(NUMBER_FORMATS)
      .optional()
      .describe(FIELD.callerIdFormat),
    callerIdHeader: z
      .enum(CALLERID_HEADERS)
      .optional()
      .describe(FIELD.callerIdHeader),
    clir: z.boolean().nullable().optional().describe(FIELD.clir),
    codecs: codecsSchema.nullable().optional().describe(FIELD.codecs),
    maxChannels: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(FIELD.maxChannels),
    hosts: z
      .array(hostInputSchema)
      .min(1)
      .optional()
      .describe(`${FIELD.hosts} Replaces the list as a whole.`),
    ...logLevelInputFields
  })
  .strict();
