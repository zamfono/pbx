import * as env from '$app/env/private';
import type { Transaction } from 'kysely';

import {
  codecsColumn,
  featureCodesColumn,
  type Codec,
  type DB
} from '@zamfono/shared';

import {
  plainSipTransports,
  SIP_PLAIN_PORT,
  SIP_TLS_PORT,
  type PlainSipTransport
} from '#lib/server/stackAddress.js';

import { loadSettings } from '../settings/_shared.js';
import { userExtension } from '../users/_extensions.js';
import { liveUser } from '../users/_shared.js';
import type { DeviceRow } from './_shared.js';

/** A `manual` device's connection settings (§10.4 "`manual`"), what a phone set up by hand asks for. */
export type ConnectionSettings = {
  /** The SIP server to register with: the stack's FQDN. */
  server: string;
  /** The SIP domain (realm): the stack's FQDN. */
  domain: string;
  /** The SIP transports the device may use, any one of them: `tls`, or the enabled plain ones. */
  transport: ('tls' | PlainSipTransport)[];
  /** 5061 for `tls`, 5060 for `udp` and `tcp`. */
  port: number;
  /** The SIP username, also the authentication username. */
  username: string;
  password: string;
  /** The user's extension. */
  extension: string;
  /** The user's name, the caller ID the phone shows. */
  displayName: string;
  /** SDES-SRTP, mandatory, for a `tls` device; none for a `plain` one. */
  mediaEncryption: 'srtp' | 'none';
  /** `settings.codecs_json` in order of preference. */
  codecs: Codec[];
  /** The own-voicemail feature code (§9.3). */
  voicemailCode: string;
};

/** `device`'s connection settings with its plaintext `password`, every value read from its source. */
export async function connectionSettings(
  db: Transaction<DB>,
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
