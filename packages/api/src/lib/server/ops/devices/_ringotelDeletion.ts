import pino from 'pino';

import { activeRingotelProvider } from '#lib/server/provisioning/index.js';

import { callerOf } from '../outcomeLog.js';
import { onRollback } from '../rollbackHooks.js';
import type { Context } from '../types.js';
import { inTurn, runPush, storedCredentialsPush } from './_ringotelPush.js';
import type { DeviceRow } from './_shared.js';

const log = pino({ name: 'ringotel' });

/**
 * Deletes the Ringotel user of each of `devices` that a provisioning provider holds (§10.4
 * "Configuration and lifecycle"): the `prepare` of a deletion, before its transaction opens,
 * while the owner's `extensions` row the provider resolves the remote user by still exists.
 *
 * The calls take the device pushes' turn (`inTurn`), after any push already queued, and keep it
 * until the deletion's `run` calls the returned `release`, inside its transaction: a push queued
 * meanwhile reads its device only once the deletion committed, so it cannot re-create the user.
 * Should the deletion not commit, its rollback releases the turn and pushes each device's stored
 * credentials, so a device that stays live keeps its Ringotel user.
 */
export async function releaseRingotelUsers(
  ctx: Context,
  devices: DeviceRow[]
): Promise<() => void> {
  const provisioned = devices.filter(device => device.kind === 'ringotel');
  const provider =
    provisioned.length === 0 ? null : await activeRingotelProvider(ctx.db);
  if (provider === null) {
    return () => undefined;
  }
  const removed = Promise.withResolvers<undefined>();
  const settled = Promise.withResolvers<undefined>();
  // A refusal reaches the caller through `removed`, so the turn itself never rejects.
  inTurn(async () => {
    try {
      for (const device of provisioned) {
        // eslint-disable-next-line no-await-in-loop -- one Ringotel request at a time: no roster-sized burst against the provider's API
        await provider.onDeviceDeleted(device);
      }
    } catch (error) {
      removed.reject(error);
      return;
    }
    removed.resolve(undefined);
    await settled.promise;
  }).catch(() => undefined);
  await removed.promise;
  const caller = callerOf(ctx);
  const release = (): void => {
    settled.resolve(undefined);
  };
  onRollback(ctx, async () => {
    release();
    const warnings = await Promise.all(
      provisioned.map(device =>
        runPush(ctx.db, caller, storedCredentialsPush(ctx.operation, device.id))
      )
    );
    for (const warning of warnings.filter(found => found !== null)) {
      log.error(
        { warning },
        'ringotel: a rolled-back deletion could not restore a Ringotel user'
      );
    }
  });
  return release;
}
