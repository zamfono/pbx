import { z } from 'zod';

import { newId, type Db } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  AUTH_MODES,
  CALLERID_HEADERS,
  CODECS,
  hostInputSchema,
  loadTrunkHosts,
  loadTrunkRow,
  mapTrunkRow,
  NUMBER_FORMATS,
  replaceTrunkHosts,
  STATUS_UNPROCESSABLE_ENTITY,
  TRANSPORTS,
  type CallerIdHeader,
  type Transport,
  type TrunkWire
} from './_shared.js';
import {
  assertClirAllowed,
  assertCredentialsConsistency,
  assertInboundAuthUsernameFree,
  assertNameAvailable,
  assertPaiHasIdentity,
  assertTransportEnabled,
  hostWarnings
} from './_writeChecks.js';
import {
  assertValidHosts,
  assertValidOutboundProxy,
  assertValidPassword,
  assertValidUsername
} from './hostValidation.js';

const inputSchema = z
  .object({
    name: z.string().min(1),
    authMode: z.enum(AUTH_MODES),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    inboundAuth: z.boolean().optional(),
    transport: z.enum(TRANSPORTS).optional(),
    outboundProxy: z.string().min(1).optional(),
    registerExpiryS: z.number().int().positive().optional(),
    registerRetryS: z.number().int().positive().optional(),
    inboundNumberFormat: z.enum(NUMBER_FORMATS).optional(),
    callerIdFormat: z.enum(NUMBER_FORMATS).optional(),
    callerIdHeader: z.enum(CALLERID_HEADERS).optional(),
    clir: z.boolean().nullable().optional(),
    codecs: z.array(z.enum(CODECS)).min(1).optional(),
    maxChannels: z.number().int().positive().optional(),
    hosts: z.array(hostInputSchema).min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Output = { trunk: TrunkWire; warnings: string[] };

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
  transport: Transport;
  callerIdHeader: CallerIdHeader;
  /** Whether this auth mode carries credentials at all (§9.4 "Auth mode"); false nulls them out. */
  credentialsRequired: boolean;
};

/** Inserts `resolved.id`'s `trunks` row from `input` and its resolved defaults. */
async function insertTrunkRow(
  ctx: Context,
  input: Input,
  resolved: ResolvedCreate
): Promise<void> {
  const passwordEnc =
    resolved.credentialsRequired && input.password
      ? encrypt(keyringFromEnv(process.env), input.password)
      : null;
  await ctx.db
    .insertInto('trunks')
    .values({
      id: resolved.id,
      name: input.name,
      priority: resolved.priority,
      authMode: input.authMode,
      username: resolved.credentialsRequired ? (input.username ?? null) : null,
      passwordEnc,
      inboundAuth: input.inboundAuth === true ? 1 : 0,
      transport: resolved.transport,
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
      calleridFormat: input.callerIdFormat ?? 'e164',
      calleridHeader: resolved.callerIdHeader,
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
      calleridDidId: null,
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
      STATUS_UNPROCESSABLE_ENTITY,
      'registerExpiryS and registerRetryS are only accepted for registration auth'
    );
  }
}

function recordCreateChanges(ctx: Context, input: Input): void {
  recordChange(ctx, { field: 'name', from: null, to: input.name });
  if (input.username !== undefined || input.password !== undefined) {
    recordChange(ctx, { field: 'password', from: null, to: input.password });
  }
  recordChange(ctx, { field: 'hosts', from: null, to: input.hosts });
}

export const create = defineOperation<Input, Output>({
  name: 'trunks.create',
  description: 'Creates a SIP trunk and its ordered host list.',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, out) => ({ kind: 'trunk', id: out.trunk.id }),
  run: async (ctx, input) => {
    const transport = input.transport ?? 'udp';
    const callerIdHeader = input.callerIdHeader ?? 'from';
    const required =
      input.authMode === 'registration' || input.inboundAuth === true;
    assertTransportEnabled(transport);
    assertClirAllowed(input.clir ?? null, callerIdHeader);
    assertCredentialsConsistency(
      required,
      input.username !== undefined,
      input.password !== undefined
    );
    assertNoStrayRegistrationFields(input);
    assertPaiHasIdentity(callerIdHeader, input.username ?? null);
    assertValidHosts(input.hosts);
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

    const row = await loadTrunkRow(ctx.db, id);
    if (!row) {
      throw new Error('trunks.create: trunk vanished after insert');
    }
    const hosts = await loadTrunkHosts(ctx.db, id);
    const trunk = mapTrunkRow(row, hosts, {
      status: 'unknown',
      statusChangedAt: null
    });
    return { trunk, warnings: hostWarnings(input.hosts) };
  }
});
