import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE_CONTENT,
  newId,
  type CallerIdHeader,
  type Db,
  type TrunkTransport
} from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError, type Context } from '../types.js';
import { createInputSchema } from './_inputs.js';
import {
  liveTrunk,
  loadTrunkHosts,
  mapTrunkRow,
  replaceTrunkHosts,
  trunkWriteOutput
} from './_shared.js';
import { UNKNOWN_STATUS } from './_status.js';
import {
  assertClirAllowed,
  assertCredentialsConsistency,
  assertForwardedCallerIdAllowed,
  assertHasRegistrar,
  assertInboundAuthUsernameFree,
  assertNameAvailable,
  assertPaiHasIdentity,
  assertSrtpNeedsTls,
  assertTransportEnabled,
  emergencyTrunkWarnings,
  hostWarnings
} from './_writeChecks.js';
import {
  assertValidHosts,
  assertValidOutboundProxy,
  assertValidPassword,
  assertValidUsername
} from './hostValidation.js';

const inputSchema = createInputSchema;

type Input = z.infer<typeof inputSchema>;

/** The next `trunks.priority`, past every live trunk (§9.4 "Trunk order"); a new trunk appends. */
function nextPriority(liveTrunks: { priority: number }[]): number {
  return (
    liveTrunks.reduce((max, trunk) => Math.max(max, trunk.priority), 0) + 1
  );
}

/** `input`'s fields the operation resolves before writing the row: its defaults applied. */
type ResolvedCreate = {
  id: string;
  priority: number;
  transport: TrunkTransport;
  callerIdHeader: CallerIdHeader;
  /** Whether this auth mode carries credentials at all (§9.4 "Auth mode"); false nulls them out. */
  credentialsRequired: boolean;
};

/** The trunk's 0/1 switches, each at its new-trunk default unless `input` names it (§11.2). */
function switchColumns(
  input: Input
): Record<'inboundAuth' | 'srtp' | 'tlsVerify' | 'qualify', 0 | 1> {
  return {
    inboundAuth: input.inboundAuth === true ? 1 : 0,
    srtp: input.srtp === true ? 1 : 0,
    tlsVerify: input.tlsVerify === false ? 0 : 1,
    qualify: input.qualify === false ? 0 : 1
  };
}

/** Inserts `resolved.id`'s `trunks` row from `input` and its resolved defaults. */
async function insertTrunkRow(
  ctx: Context,
  input: Input,
  resolved: ResolvedCreate
): Promise<void> {
  const passwordEnc =
    resolved.credentialsRequired && input.password
      ? encrypt(keyringFromEnv(env), 'trunks.passwordEnc', input.password)
      : null;
  await ctx.db
    .insertInto('trunks')
    .values({
      id: resolved.id,
      name: input.name,
      priority: resolved.priority,
      emergency: input.emergency ? 1 : 0,
      authMode: input.authMode,
      username: resolved.credentialsRequired ? (input.username ?? null) : null,
      passwordEnc,
      ...switchColumns(input),
      transport: resolved.transport,
      diversion: input.diversion ?? 'off',
      forwardedCallerId: input.forwardedCallerId ?? 'own',
      outboundProxy: input.outboundProxy ?? null,
      registerExpiryS:
        input.authMode === 'registration'
          ? (input.registerExpiryS ?? null)
          : null,
      registerRetryS:
        input.authMode === 'registration'
          ? (input.registerRetryS ?? null)
          : null,
      inboundNumberFormat: input.inboundNumberFormat ?? 'e164',
      callerIdFormat: input.callerIdFormat ?? 'e164',
      callerIdHeader: resolved.callerIdHeader,
      clir:
        input.clir === undefined || input.clir === null
          ? null
          : Number(input.clir),
      codecsJson: input.codecs ? JSON.stringify(input.codecs) : null,
      maxChannels: input.maxChannels ?? null,
      createdAt: ctx.now
    })
    .execute();
}

/** Inserts the catch-all route (no callers, no numbers) that the first trunk brings with it (§9.4). */
async function insertCatchAllRoute(
  db: Db,
  trunkId: string,
  now: string
): Promise<void> {
  await db
    .insertInto('outboundRoutes')
    .values({
      id: newId(),
      priority: 1,
      trunkId,
      callerIdDidId: null,
      createdAt: now
    })
    .execute();
}

/**
 * Throws 422 when `registerExpiryS`/`registerRetryS` is given for an `ip` trunk, mirroring the
 * `trunks` CHECK constraint of §11.2 (`auth_mode = 'registration' OR (register_expiry_s IS NULL
 * AND register_retry_s IS NULL)`) as a refusal rather than a silent coercion.
 */
function assertNoStrayRegistrationFields(input: Input): void {
  if (
    input.authMode !== 'registration' &&
    (input.registerExpiryS !== undefined || input.registerRetryS !== undefined)
  ) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'registerExpiryS and registerRetryS are only accepted for registration auth'
    );
  }
}

function recordCreateChanges(ctx: Context, input: Input): void {
  recordChange(ctx, { field: 'name', from: null, to: input.name });
  recordChange(ctx, { field: 'emergency', from: null, to: input.emergency });
  if (input.username !== undefined || input.password !== undefined) {
    recordChange(ctx, { field: 'password', from: null, to: input.password });
  }
  recordChange(ctx, { field: 'hosts', from: null, to: input.hosts });
}

export const create = defineOperation({
  name: 'trunks.create',
  description:
    'Creates a SIP trunk to a PSTN or SIP provider with its ordered host list; the first trunk also gets the catch-all outbound route.',
  input: inputSchema,
  output: trunkWriteOutput,
  problems: [HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, out) => ({ kind: 'trunk', id: out.trunk.id }),
  run: async (ctx, input) => {
    const transport = input.transport ?? 'udp';
    const callerIdHeader = input.callerIdHeader ?? 'from';
    const required =
      input.authMode === 'registration' || input.inboundAuth === true;
    assertTransportEnabled(transport);
    assertSrtpNeedsTls(input.srtp === true, transport);
    assertClirAllowed(input.clir ?? null, callerIdHeader);
    assertForwardedCallerIdAllowed({
      forwardedCallerId: input.forwardedCallerId ?? 'own',
      callerIdHeader,
      diversion: input.diversion ?? 'off'
    });
    assertCredentialsConsistency(
      required,
      input.username !== undefined,
      input.password !== undefined
    );
    assertNoStrayRegistrationFields(input);
    assertPaiHasIdentity(callerIdHeader, input.username ?? null);
    assertValidHosts(input.hosts);
    assertHasRegistrar(input.authMode, input.hosts);
    assertValidOutboundProxy(input.outboundProxy);
    if (input.username !== undefined) {
      assertValidUsername(input.username);
    }
    if (input.password !== undefined) {
      assertValidPassword(input.password);
    }
    await assertNameAvailable(ctx.db, input.name);
    if (input.inboundAuth === true && input.username !== undefined) {
      await assertInboundAuthUsernameFree(ctx.db, input.username);
    }

    const liveTrunks = await ctx.db
      .selectFrom('trunks')
      .select('priority')
      .where('deletedAt', 'is', null)
      .execute();
    const isFirstTrunk = liveTrunks.length === 0;

    const id = newId();
    await insertTrunkRow(ctx, input, {
      id,
      priority: nextPriority(liveTrunks),
      transport,
      callerIdHeader,
      credentialsRequired: required
    });
    await replaceTrunkHosts(ctx.db, id, input.hosts);
    if (isFirstTrunk) {
      await insertCatchAllRoute(ctx.db, id, ctx.now);
    }

    recordCreateChanges(ctx, input);
    propagate(ctx, ['pjsip']);

    const row = await liveTrunk(ctx.db, id);
    const hosts = await loadTrunkHosts(ctx.db, id);
    const trunk = mapTrunkRow(row, hosts, UNKNOWN_STATUS);
    return {
      trunk,
      warnings: [
        ...hostWarnings(input.hosts),
        ...(await emergencyTrunkWarnings(ctx.db))
      ]
    };
  }
});
