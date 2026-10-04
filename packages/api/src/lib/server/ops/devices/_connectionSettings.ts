import * as env from '$app/env/private';
import { z } from 'zod';

import {
  codecsColumn,
  codecsSchema,
  featureCodesColumn,
  type Db
} from '@zamfono/shared';

import {
  plainSipTransports,
  SIP_PLAIN_PORT,
  SIP_TLS_PORT
} from '#lib/server/stackAddress.js';

import { loadSettings } from '../settings/_shared.js';
import { userExtension } from '../users/_extensions.js';
import { liveUser } from '../users/_shared.js';
import type { DeviceRow } from './_shared.js';

/** A `manual` device's connection settings (§10.4 "`manual`"), what a phone set up by hand asks for. */
export const connectionSettingsOut = z.object({
  server: z
    .string()
    .describe("The SIP server to register with: the stack's FQDN."),
  domain: z.string().describe("The SIP domain (realm): the stack's FQDN."),
  transport: z
    .array(z.enum(['tls', 'udp', 'tcp']))
    .describe(
      'The SIP transports the device may use, any one of them: tls, or the enabled plain ones.'
    ),
  port: z.number().describe('5061 for tls, 5060 for udp and tcp.'),
  username: z
    .string()
    .describe('The SIP username, also the authentication username.'),
  password: z.string(),
  extension: z.string().describe("The user's extension."),
  displayName: z
    .string()
    .describe("The user's name, the caller ID the phone shows."),
  mediaEncryption: z
    .enum(['srtp', 'none'])
    .describe('SDES-SRTP, mandatory, for a tls device; none for a plain one.'),
  codecs: codecsSchema.describe('The codecs in order of preference.'),
  voicemailCode: z.string().describe('The own-voicemail feature code.')
});
export type ConnectionSettings = z.infer<typeof connectionSettingsOut>;

/** `device`'s connection settings with its plaintext `password`, every value read from its source. */
export async function connectionSettings(
  db: Db,
  device: DeviceRow,
  password: string
): Promise<ConnectionSettings> {
  const user = await liveUser(db, device.userId);
  const extension = await userExtension(db, device.userId);
  const settings = await loadSettings(db);
  const fqdn = env.FQDN;
  const tls = device.transport === 'tls';
  return {
    server: fqdn,
    domain: fqdn,
    transport: tls ? ['tls'] : plainSipTransports(env),
    port: tls ? SIP_TLS_PORT : SIP_PLAIN_PORT,
    username: device.sipUsername,
    password,
    extension,
    displayName: user.name,
    mediaEncryption: tls ? 'srtp' : 'none',
    codecs: codecsColumn.decode(settings.codecsJson),
    voicemailCode: featureCodesColumn.decode(settings.featureCodesJson)
      .ownVoicemail
  };
}
