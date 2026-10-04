import type { Updateable } from 'kysely';
import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  type DB,
  type LogLevelColumns
} from '@zamfono/shared';

import { recordChange, recordFieldChanges } from '../audit.js';
import { propagate } from '../propagate.js';
import { logLevelWire, resolveLogLevel } from '../settings/logLevel.js';
import { defineOperation, type Context } from '../types.js';
import { updateInputSchema } from './_inputs.js';
import {
  hostsToWire,
  liveTrunk,
  loadTrunkHosts,
  mapTrunkRow,
  replaceTrunkHosts,
  scalarsFromRow,
  trunkWriteOutput,
  type HostWire,
  type TrunkRow
} from './_shared.js';
import {
  assertNoStrayCredentials,
  assertNoStrayRegistrationFields,
  assertValidCredentialFields
} from './_updateChecks.js';
import { mergeScalars, type Merged } from './_updateMerge.js';
import {
  assertClirAllowed,
  assertCredentialsConsistency,
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
  assertValidOutboundProxy
} from './hostValidation.js';

const inputSchema = updateInputSchema;

type Input = z.infer<typeof inputSchema>;

/** Every check a merged update must pass before the row is written (§9.4, §11.2). */
async function assertUpdateAllowed(
  ctx: Context,
  merged: Merged,
  input: Input
): Promise<void> {
  const credentialsRequired =
    merged.authMode === 'registration' || merged.inboundAuth;
  // A trunk stays editable on a transport switched off since (§9.4 "Signaling"); only a write
  // that names the transport is refused it.
  if (input.transport !== undefined) {
    assertTransportEnabled(input.transport);
  }
  assertSrtpNeedsTls(merged.srtp, merged.transport);
  assertClirAllowed(merged.clir, merged.callerIdHeader);
  assertCredentialsConsistency(
    credentialsRequired,
    merged.username !== null,
    merged.passwordEnc !== null
  );
  assertNoStrayCredentials(credentialsRequired, input);
  assertNoStrayRegistrationFields(merged.authMode, input);
  assertPaiHasIdentity(merged.callerIdHeader, merged.username);
  if (input.hosts) {
    assertValidHosts(input.hosts);
  }
  if (merged.authMode === 'registration') {
    assertHasRegistrar(
      merged.authMode,
      input.hosts ?? (await loadTrunkHosts(ctx.db, input.id))
    );
  }
  if (input.outboundProxy !== undefined) {
    assertValidOutboundProxy(input.outboundProxy);
  }
  assertValidCredentialFields(input);
  if (input.name !== undefined) {
    await assertNameAvailable(ctx.db, input.name, input.id);
  }
  if (merged.inboundAuth && merged.username !== null) {
    await assertInboundAuthUsernameFree(ctx.db, merged.username, input.id);
  }
}

/** The `trunks` column values a merged update writes, with its diagnostics override (§7). */
function trunkColumns(
  merged: Merged,
  logLevel: LogLevelColumns | undefined
): Updateable<DB['trunks']> {
  return {
    name: merged.name,
    emergency: merged.emergency ? 1 : 0,
    authMode: merged.authMode,
    username: merged.username,
    passwordEnc: merged.passwordEnc,
    inboundAuth: merged.inboundAuth ? 1 : 0,
    transport: merged.transport,
    srtp: merged.srtp ? 1 : 0,
    tlsVerify: merged.tlsVerify ? 1 : 0,
    qualify: merged.qualify ? 1 : 0,
    diversion: merged.diversion,
    outboundProxy: merged.outboundProxy,
    registerExpiryS: merged.registerExpiryS,
    registerRetryS: merged.registerRetryS,
    inboundNumberFormat: merged.inboundNumberFormat,
    callerIdFormat: merged.callerIdFormat,
    callerIdHeader: merged.callerIdHeader,
    clir: merged.clir === null ? null : Number(merged.clir),
    codecsJson: merged.codecs ? JSON.stringify(merged.codecs) : null,
    maxChannels: merged.maxChannels,
    ...logLevel
  };
}

/**
 * Records the write-only `password` field when the update stores a new one or drops the stored
 * one: neither carries a `from` to revert to, so `recordChange` masks the field and marks the
 * whole entry non-undoable (§5.4, §5.8).
 */
function recordPasswordChange(
  ctx: Context,
  row: TrunkRow,
  merged: Merged,
  input: Input
): void {
  const dropped = row.passwordEnc !== null && merged.passwordEnc === null;
  if (typeof input.password === 'string' || dropped) {
    recordChange(ctx, {
      field: 'password',
      from: null,
      to: input.password ?? null
    });
  }
}

export const update = defineOperation({
  name: 'trunks.update',
  description:
    'Updates a SIP trunk; hosts replace the list as a whole, password is write-only.',
  input: inputSchema,
  output: trunkWriteOutput,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: input => ({ kind: 'trunk', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveTrunk(ctx.db, input.id);
    const merged = mergeScalars(row, input);
    await assertUpdateAllowed(ctx, merged, input);
    const logLevel = resolveLogLevel(ctx, row, input);
    const hostsBefore: HostWire[] | undefined = input.hosts
      ? hostsToWire(await loadTrunkHosts(ctx.db, input.id))
      : undefined;

    await ctx.db
      .updateTable('trunks')
      .set(trunkColumns(merged, logLevel))
      .where('id', '=', input.id)
      .execute();
    if (input.hosts) {
      await replaceTrunkHosts(ctx.db, input.id, input.hosts);
    }

    const updatedRow = await liveTrunk(ctx.db, input.id);
    recordFieldChanges(
      ctx,
      { ...scalarsFromRow(row), ...logLevelWire(row) },
      { ...scalarsFromRow(updatedRow), ...logLevelWire(updatedRow) }
    );
    recordPasswordChange(ctx, row, merged, input);
    if (hostsBefore) {
      recordChange(ctx, { field: 'hosts', from: hostsBefore, to: input.hosts });
    }
    propagate(ctx, ['pjsip']);

    const hosts = await loadTrunkHosts(ctx.db, input.id);
    const trunk = mapTrunkRow(updatedRow, hosts, {
      status: 'unknown',
      statusChangedAt: null
    });
    return {
      trunk,
      warnings: [
        ...(input.hosts ? hostWarnings(input.hosts) : []),
        ...(await emergencyTrunkWarnings(ctx.db))
      ]
    };
  }
});
