import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';
import {
  activeRingotelProvider,
  type DeviceRow,
  type ProvisioningProvider,
  type PushReceipt
} from '#lib/server/provisioning/index.js';
import { storedCredentials } from '#lib/server/provisioning/ringotelUser.js';
import { serialQueue } from '#lib/server/serialQueue.js';

import { afterPropagation } from '../afterCommit.js';
import type { AuditCaller } from '../audit.js';
import { callerOf, outcomeChanges, recordOutcome } from '../outcomeLog.js';
import type { Context } from '../types.js';

const log = pino({ name: 'ringotel' });

// Every device push, one at a time (§10.4): each sends the device as the database holds it when
// its turn comes, so the last push Ringotel takes carries the last committed write. A device's
// deletion calls Ringotel in the same turns (`deleteInTurn`).
export const inTurn = serialQueue();

export type PushOutcome =
  | { outcome: 'pushed'; receipt: PushReceipt }
  | { outcome: 'refused' | 'skipped'; reason: string };

type PushTarget = {
  /** The operation whose write this push follows, e.g. `devices.create`. */
  trigger: string;
  deviceId: string;
  /** What stands whatever Ringotel answers, and how to push again. */
  failure: { what: string; retry: string };
};

export type Push = PushTarget & {
  /** Sends `device`, as stored when the push runs, through `provider`. */
  push: (
    provider: ProvisioningProvider,
    device: DeviceRow,
    db: Db
  ) => Promise<PushReceipt>;
};

/** The live device `deviceId` names, as stored now, or `undefined` once it is deleted. */
function storedDevice(
  db: Db,
  deviceId: string
): Promise<DeviceRow | undefined> {
  return db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', deviceId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

/**
 * The `ringotel.push` audit row (§5.7, §10.4): what Ringotel answered, attributed to the caller of
 * the operation it follows, so the answer outlives the logs and the result's warnings. A row that
 * cannot be written is logged, since the write it records has committed already.
 */
async function auditPush(
  db: Db,
  caller: AuditCaller,
  push: PushTarget,
  result: PushOutcome
): Promise<void> {
  const changes = outcomeChanges({
    outcome: result.outcome,
    trigger: push.trigger,
    ringotelUserId:
      result.outcome === 'pushed'
        ? (result.receipt?.remoteId ?? null)
        : undefined,
    reason: result.outcome === 'pushed' ? undefined : result.reason
  });
  await recordOutcome(db, {
    caller,
    operation: 'ringotel.push',
    entity: { kind: 'device', id: push.deviceId },
    changes
  }).catch((error: unknown) => {
    log.error(
      { error, deviceId: push.deviceId, outcome: result.outcome },
      'ringotel: the push outcome could not be audited'
    );
  });
}

/**
 * Runs the push against the tenant's Ringotel provider, never throwing. A Ringotel key that
 * cannot be used is a refusal like any other.
 */
async function attempt(
  db: Db,
  push: Push,
  device: DeviceRow
): Promise<PushOutcome> {
  try {
    const provider = await activeRingotelProvider(db);
    if (provider === null) {
      return { outcome: 'skipped', reason: 'Ringotel is not set up' };
    }
    return {
      outcome: 'pushed',
      receipt: await push.push(provider, device, db)
    };
  } catch (error) {
    const reason = errorMessage(error);
    return { outcome: 'refused', reason };
  }
}

/** The result's warning for `result`, or `null` where Ringotel took the push. */
function pushWarning(push: PushTarget, result: PushOutcome): string | null {
  if (result.outcome === 'pushed') {
    return null;
  }
  if (result.outcome === 'skipped') {
    return `${push.failure.what}: Ringotel is not set up, so nothing reached it; provisioning.ringotelSetup or provisioning.ringotelAdopt pushes the device when it runs`;
  }
  return `${push.failure.what}, but Ringotel refused it (${result.reason}); ${push.failure.retry}`;
}

/**
 * Runs `push` in its turn (`inTurn`) against the device as stored then, audits its outcome as
 * `caller`'s and returns its warning. A device deleted meanwhile is not pushed: its deletion is
 * the newer write, so the row records the skip and there is nothing to warn about.
 */
function pushInTurn(
  db: Db,
  caller: AuditCaller,
  push: PushTarget & {
    attempt: (db: Db, device: DeviceRow) => Promise<PushOutcome>;
  }
): Promise<string | null> {
  return inTurn(async () => {
    const device = await storedDevice(db, push.deviceId);
    const result: PushOutcome =
      device === undefined
        ? { outcome: 'skipped', reason: 'the device is deleted' }
        : await push.attempt(db, device);
    await auditPush(db, caller, push, result);
    return device === undefined ? null : pushWarning(push, result);
  });
}

/** Runs `push` in its turn now, as `caller`, and returns its warning (`pushInTurn`). */
export function runPush(
  db: Db,
  caller: AuditCaller,
  push: Push
): Promise<string | null> {
  return pushInTurn(db, caller, {
    ...push,
    attempt: (later, device) => attempt(later, push, device)
  });
}

/**
 * Pushes a `ringotel` device's change to Ringotel once its write has committed and Asterisk holds
 * it (§10.4): an activated Ringotel user registers against the PBX with its SIP credentials
 * before Ringotel accepts it, and fails with "Unauthorized" while Asterisk does not know them
 * yet, which inside the operation's transaction it never does. The stored write stands whatever
 * happens: a refusal becomes a warning of the operation's result naming Ringotel's reason and
 * `retry`, the way to try again; a stack without a Ringotel setup pushes nothing and warns that
 * `ringotelSetup` or `ringotelAdopt` will provision the device. Every outcome, success included,
 * is a `ringotel.push` audit row on the device.
 */
export function pushToRingotel(ctx: Context, push: Push): void {
  const caller = callerOf(ctx);
  afterPropagation(ctx, db => runPush(db, caller, push));
}

/** `provision`'s answer as the push's outcome, never throwing. */
async function provisioned(
  db: Db,
  device: DeviceRow,
  provision: (db: Db, device: DeviceRow) => Promise<string>
): Promise<PushOutcome> {
  try {
    return {
      outcome: 'pushed',
      receipt: { remoteId: await provision(db, device) }
    };
  } catch (error) {
    return { outcome: 'refused', reason: errorMessage(error) };
  }
}

/**
 * Provisions a device that existed before setup or adoption (§10.4) once their write has
 * committed and Asterisk holds it, as every other push: `provision` creates its Ringotel user and
 * returns its id; the outcome is a `ringotel.push` row and a refusal the result's warning. A
 * rolled-back setup or adoption has created no Ringotel user.
 */
export function pushExistingDevice(
  ctx: Context,
  push: PushTarget & {
    provision: (db: Db, device: DeviceRow) => Promise<string>;
  }
): void {
  const caller = callerOf(ctx);
  afterPropagation(ctx, db =>
    pushInTurn(db, caller, {
      ...push,
      attempt: (later, device) => provisioned(later, device, push.provision)
    })
  );
}

/**
 * `deviceId`'s stored credentials pushed again (`onCredentialsRotated`, which creates a Ringotel
 * user that is missing), after `trigger`: what restores a device's Ringotel user from the
 * database alone.
 */
export function storedCredentialsPush(trigger: string, deviceId: string): Push {
  return {
    trigger,
    deviceId,
    push: (provider, stored) =>
      provider.onCredentialsRotated(stored, storedCredentials(stored)),
    failure: {
      what: `device ${deviceId}'s credentials are stored`,
      retry: 'devices.rotate on the device pushes them again'
    }
  };
}
