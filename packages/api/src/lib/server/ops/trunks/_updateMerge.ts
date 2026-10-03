import * as env from '$app/env/private';

import type { TrunkAuthMode } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import type { Codec, TrunkRow, TrunkScalars } from './_shared.js';

/** The scalar fields of a `trunks.update` request the merge reads, plus its write-only password. */
export type MergeInput = Partial<TrunkScalars> & { password?: string };

/** A trunk's next scalar state, with the encrypted password it stores alongside. */
export type Merged = TrunkScalars & { passwordEnc: Buffer | null };

/** The row's stored password, or a freshly encrypted one when `input.password` was given. */
function mergedPasswordEnc(row: TrunkRow, input: MergeInput): Buffer | null {
  if (input.password === undefined) {
    return row.passwordEnc;
  }
  return encrypt(keyringFromEnv(env), input.password);
}

/** `row.clir` as the wire's tri-state boolean, unless `input` overrides it. */
function mergedClir(row: TrunkRow, input: MergeInput): boolean | null {
  if (input.clir !== undefined) {
    return input.clir;
  }
  if (row.clir === null) {
    return null;
  }
  return row.clir === 1;
}

/** `row.codecsJson` parsed to the wire shape, unless `input` overrides it. */
function mergedCodecs(row: TrunkRow, input: MergeInput): Codec[] | null {
  if (input.codecs !== undefined) {
    return input.codecs;
  }
  if (row.codecsJson === null) {
    return null;
  }
  return JSON.parse(row.codecsJson) as Codec[];
}

/** `row`'s value unless `input` sets this field, `undefined` meaning "keep it" — `null` clears it. */
function orRow<T>(input: T | null | undefined, row: T | null): T | null {
  return input === undefined ? row : input;
}

/** The trunk's next scalar state: every field input omits keeps `row`'s current value. */
export function mergeScalars(row: TrunkRow, input: MergeInput): Merged {
  const authMode: TrunkAuthMode = input.authMode ?? row.authMode;
  const inboundAuth = input.inboundAuth ?? row.inboundAuth === 1;
  const required = authMode === 'registration' || inboundAuth;
  return {
    name: input.name ?? row.name,
    emergency: input.emergency ?? row.emergency === 1,
    authMode,
    username: required ? orRow(input.username, row.username) : null,
    inboundAuth,
    passwordEnc: required ? mergedPasswordEnc(row, input) : null,
    transport: input.transport ?? row.transport,
    srtp: input.srtp ?? row.srtp === 1,
    tlsVerify: input.tlsVerify ?? row.tlsVerify === 1,
    qualify: input.qualify ?? row.qualify === 1,
    diversion: input.diversion ?? row.diversion,
    outboundProxy: orRow(input.outboundProxy, row.outboundProxy),
    registerExpiryS:
      authMode === 'registration'
        ? orRow(input.registerExpiryS, row.registerExpiryS)
        : null,
    registerRetryS:
      authMode === 'registration'
        ? orRow(input.registerRetryS, row.registerRetryS)
        : null,
    inboundNumberFormat: input.inboundNumberFormat ?? row.inboundNumberFormat,
    callerIdFormat: input.callerIdFormat ?? row.calleridFormat,
    callerIdHeader: input.callerIdHeader ?? row.calleridHeader,
    clir: mergedClir(row, input),
    codecs: mergedCodecs(row, input),
    maxChannels: orRow(input.maxChannels, row.maxChannels)
  };
}
